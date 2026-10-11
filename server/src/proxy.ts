import { Hono } from "hono";
import { config } from "./config.js";
import { run } from "./db.js";
import { isAlive, publishSession, sessionFromAuth } from "./lifecycle.js";

type Auth = NonNullable<ReturnType<typeof sessionFromAuth>>;
export const proxy = new Hono<{ Variables: { auth: Auth } }>();

const err = (message: string) => ({ error: { message } });

proxy.use("*", async (c, next) => {
  const auth = sessionFromAuth(c.req.header("authorization"));
  if (!auth || !isAlive(auth.session, auth.invite)) return c.json(err("session expired"), 403);
  run("UPDATE sessions SET last_heartbeat = ? WHERE id = ?", Date.now(), auth.session.id);
  c.set("auth", auth);
  await next();
});

proxy.get("/models", (c) => {
  const { invite } = c.get("auth");
  return c.json({ object: "list", data: [{ id: invite.model, object: "model" }] });
});

/** Pass bytes through untouched while scanning for a `usage` object. */
function usageTap(isSse: boolean, onUsage: (inTok: number, outTok: number) => void) {
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
    flush() {
      try {
        if (isSse) {
          buf += decoder.decode();
          scanLines(true);
        } else {
          usage = JSON.parse(buf + decoder.decode()).usage ?? null;
        }
        if (usage) onUsage(Number(usage.prompt_tokens) || 0, Number(usage.completion_tokens) || 0);
      } catch {
        // ignore
      }
    },
  });
}

proxy.post("/chat/completions", async (c) => {
  const { session, invite } = c.get("auth");
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body !== "object") return c.json(err("invalid JSON body"), 400);

  Object.assign(body, config.upstreamExtraBody);
  body.model = invite.model;
  if (body.stream && !body.stream_options?.include_usage) {
    body.stream_options = { ...body.stream_options, include_usage: true };
  }

  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  if (config.upstreamApiKey) headers.authorization = `Bearer ${config.upstreamApiKey}`;

  let upstream: Response;
  try {
    upstream = await fetch(`${config.upstreamBaseUrl}/chat/completions`, {
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

  const tap = usageTap(contentType.includes("text/event-stream"), (inTok, outTok) => {
    run(
      "UPDATE sessions SET tokens_in = tokens_in + ?, tokens_out = tokens_out + ? WHERE id = ?",
      inTok, outTok, session.id,
    );
    publishSession(session.id);
  });
  return new Response(upstream.body.pipeThrough(tap), {
    status: upstream.status,
    headers: { "content-type": contentType },
  });
});
