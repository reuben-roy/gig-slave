import { timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { sha256 } from "./codes.js";
import { config, modelOptions } from "./config.js";
import { ensureSchema, getInvite, getSession, inviteJson } from "./db.js";
import {
  commandFor, createInvite, inviteFor, listInvites, revokeInvite, sendInstruction, sessionEvents, str,
} from "./jobs.js";
import { isTerminal, killSession } from "./lifecycle.js";
import { runFeed } from "./stream.js";
import { oauthAdmin, pruneOauth } from "./oauth.js";
import { operatorAdmin } from "./operators.js";
import { maybeSweep, sweep } from "./sweeper.js";

export const admin = new Hono();

function secretOk(given: string | undefined, secret: string) {
  if (!given || !secret) return false;
  return timingSafeEqual(Buffer.from(sha256(given)), Buffer.from(sha256(secret)));
}

admin.use("*", async (c, next) => {
  const bearer = c.req.header("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
  const query = c.req.path.endsWith("/stream") ? c.req.query("token") : undefined;
  const isCron = c.req.path.endsWith("/cron/sweep");
  const ok =
    secretOk(bearer ?? query, config.adminToken) || (isCron && secretOk(bearer, config.cronSecret));
  if (!ok) return c.json({ error: "unauthorized" }, 401);
  await ensureSchema();
  await maybeSweep();
  await next();
});

admin.route("/", operatorAdmin);
admin.route("/", oauthAdmin);

admin.get("/config", (c) =>
  c.json({
    models: config.models,
    model_options: modelOptions(),
    default_model: config.defaultModel,
    public_url: config.publicUrl,
    notifications: { email: Boolean(config.resendApiKey), webhook: true },
  }),
);

admin.get("/cron/sweep", async (c) => {
  await sweep();
  await pruneOauth();
  return c.json({ ok: true });
});

admin.post("/invites", async (c) => {
  const b = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!b || typeof b !== "object") return c.json({ error: "invalid JSON body" }, 400);
  const { invite, code } = await createInvite(b);
  return c.json({ invite: inviteJson(invite), code, command: commandFor(code!) }, 201);
});

admin.get("/invites", async (c) => c.json({ invites: await listInvites() }));

admin.post("/invites/:id/revoke", async (c) => {
  await revokeInvite(await inviteFor(c.req.param("id")));
  return c.json({ ok: true });
});

admin.get("/sessions/:id/events", async (c) => {
  const id = c.req.param("id");
  if (!(await getSession(id))) return c.json({ error: "session not found" }, 404);
  return c.json({ events: await sessionEvents(id, Number(c.req.query("after")) || 0) });
});

admin.post("/sessions/:id/instructions", async (c) => {
  const session = await getSession(c.req.param("id"));
  if (!session) return c.json({ error: "session not found" }, 404);
  const b = (await c.req.json().catch(() => null)) as { text?: unknown } | null;
  const text = str(b?.text);
  if (!text) return c.json({ error: "text is required" }, 400);
  await sendInstruction(session, (await getInvite(session.invite_id))!, text);
  return c.json({ ok: true });
});

admin.post("/sessions/:id/kill", async (c) => {
  const session = await getSession(c.req.param("id"));
  if (!session) return c.json({ error: "session not found" }, 404);
  if (!isTerminal(session.status)) await killSession(session.id);
  return c.json({ ok: true });
});

// ---------- SSE (adaptive database polling, see stream.ts; works the same on Vercel and locally) ----------

admin.get("/stream", (c) => {
  c.header("Cache-Control", "no-cache, no-transform");
  c.header("X-Accel-Buffering", "no");
  return streamSSE(c, async (stream) => {
    let open = true;
    stream.onAbort(() => {
      open = false;
    });
    c.req.raw.signal.addEventListener("abort", () => {
      open = false;
    });

    try {
      await stream.write("retry: 1000\n\n");
      await runFeed({
        write: (event, id, payload) => stream.write(`id: ${id}\nevent: ${event}\ndata: ${JSON.stringify(payload)}\n\n`),
        ping: () => stream.write(": ping\n\n"),
        sleep: (ms) => stream.sleep(ms),
        isOpen: () => open,
        deadline: Date.now() + config.streamMaxMs,
      });
    } catch {
      // client went away
    }
  });
});
