import { Hono } from "hono";
import { config, isGatewayModel } from "./config.js";
import { run } from "./db.js";
import { isAlive, sessionFromAuth } from "./lifecycle.js";
import { maybeSweep } from "./sweeper.js";

type Auth = NonNullable<Awaited<ReturnType<typeof sessionFromAuth>>>;
export const proxy = new Hono<{ Variables: { auth: Auth } }>();

const err = (message: string) => ({ error: { message } });

const MAX_BODY_BYTES = 2 * 1024 * 1024;
const MAX_OUTPUT_TOKENS = 16_000;

/** Read the request body as JSON, refusing anything over MAX_BODY_BYTES without buffering the excess. */
async function readBoundedJson(req: Request): Promise<{ tooLarge: true } | { body: unknown }> {
  const declared = Number(req.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return { tooLarge: true };
  if (!req.body) return { body: null };
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BODY_BYTES) {
      await reader.cancel().catch(() => {});
      return { tooLarge: true };
    }
    chunks.push(value);
  }
  try {
    return { body: JSON.parse(Buffer.concat(chunks).toString("utf8")) };
  } catch {
    return { body: null };
  }
}

const clampTokens = (v: unknown) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), MAX_OUTPUT_TOKENS) : MAX_OUTPUT_TOKENS;
};

proxy.use("*", async (c, next) => {
  const auth = await sessionFromAuth(c.req.header("authorization"));
  if (!auth || !isAlive(auth.session, auth.invite)) return c.json(err("session expired"), 403);
  if (auth.session.tokens_in + auth.session.tokens_out > config.sessionTokenBudget) {
    return c.json(err("token budget exceeded"), 403);
  }
  await maybeSweep(); // throttled lazy sweep, only for authenticated requests
  // Proof of life only: deliberately does not touch updated_at (no SSE noise).
  await run("UPDATE sessions SET last_heartbeat = $1 WHERE id = $2", [Date.now(), auth.session.id]);
  c.set("auth", auth);
  await next();
});

proxy.get("/models", (c) => {
  const { invite } = c.get("auth");
  return c.json({ object: "list", data: [{ id: invite.model, object: "model" }] });
});

/** Pass bytes through untouched while scanning for a `usage` object. */
function usageTap(isSse: boolean, onUsage: (inTok: number, outTok: number) => Promise<void>) {
  const decoder = new TextDecoder();
  let buf = "";
  let usage: any = null;

  const scanLines = (final: boolean) => {
    const lines = buf.split("\n");
    buf = final ? "" : (lines.pop() ?? "");
    for (const line of lines) {
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === "[DONE]" || !payload.includes('"usage"')) continue;
      try {
        const u = JSON.parse(payload).usage;
        if (u) usage = u;
      } catch {
        // partial or non-JSON line
      }
    }
  };

  return new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, ctrl) {
      ctrl.enqueue(chunk);
      try {
        if (isSse) {
          buf += decoder.decode(chunk, { stream: true });
          scanLines(false);
        } else if (buf.length < 4_000_000) {
          buf += decoder.decode(chunk, { stream: true });
        }
      } catch {
        // usage parsing is best-effort
      }
    },
    async flush() {
      try {
        if (isSse) {
          buf += decoder.decode();
          scanLines(true);
        } else {
          usage = JSON.parse(buf + decoder.decode()).usage ?? null;
        }
      } catch {
        usage = null;
      }
      // Awaited so a serverless function is not frozen before the counters are written.
      if (usage) {
        await onUsage(Number(usage.prompt_tokens) || 0, Number(usage.completion_tokens) || 0).catch(() => {});
      }
    },
  });
}

async function gatewayToken(): Promise<string> {
  if (config.gatewayApiKey) return config.gatewayApiKey;
  if (config.onVercel) {
    const { getVercelOidcToken } = await import("@vercel/oidc");
    return getVercelOidcToken();
  }
  return "";
}

proxy.post("/chat/completions", async (c) => {
  const { session, invite } = c.get("auth");
  const read = await readBoundedJson(c.req.raw);
  if ("tooLarge" in read) return c.json(err("request body too large (max 2 MB)"), 413);
  const body = read.body as Record<string, any> | null;
  if (!body || typeof body !== "object" || Array.isArray(body)) return c.json(err("invalid JSON body"), 400);

  // Abuse bounds: cap output tokens, a single choice only.
  if ("max_tokens" in body) body.max_tokens = clampTokens(body.max_tokens);
  if ("max_completion_tokens" in body) body.max_completion_tokens = clampTokens(body.max_completion_tokens);
  body.n = 1;

  const viaGateway = isGatewayModel(invite.model);
  Object.assign(body, viaGateway ? config.gatewayExtraBody : config.upstreamExtraBody);
  body.model = invite.model;
  if (body.stream && !body.stream_options?.include_usage) {
    body.stream_options = { ...body.stream_options, include_usage: true };
  }

  const headers: Record<string, string> = {
    "content-type": "application/json",
    "http-referer": config.publicUrl,
    "x-title": "Hired Gun",
  };
  let url: string;
  if (viaGateway) {
    url = `${config.gatewayBaseUrl}/chat/completions`;
    let token = "";
    try {
      token = await gatewayToken();
    } catch (e) {
      return c.json(err(`AI Gateway auth failed: ${(e as Error).message}`), 502);
    }
    if (!token) return c.json(err("AI_GATEWAY_API_KEY is not configured on the server"), 502);
    headers.authorization = `Bearer ${token}`;
  } else {
    url = `${config.upstreamBaseUrl}/chat/completions`;
    if (config.upstreamApiKey) headers.authorization = `Bearer ${config.upstreamApiKey}`;
  }

  let upstream: Response;
  try {
    upstream = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: c.req.raw.signal,
    });
  } catch (e) {
    return c.json(err(`upstream unreachable: ${(e as Error).message}`), 502);
  }

  const contentType = upstream.headers.get("content-type") ?? "application/json";
  if (!upstream.body) return new Response(null, { status: upstream.status });

  const tap = usageTap(contentType.includes("text/event-stream"), async (inTok, outTok) => {
    await run(
      "UPDATE sessions SET tokens_in = tokens_in + $1, tokens_out = tokens_out + $2, updated_at = $4 WHERE id = $3",
      [inTok, outTok, session.id, Date.now()],
    );
  });
  return new Response(upstream.body.pipeThrough(tap), {
    status: upstream.status,
    headers: { "content-type": contentType, "cache-control": "no-cache, no-transform" },
  });
});
