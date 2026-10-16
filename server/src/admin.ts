import { timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { displayCode, newCode, newId, sha256 } from "./codes.js";
import { config, modelOptions } from "./config.js";
import {
  addEvent, all, ensureSchema, eventJson, getInvite, getSession, inviteJson, one, run, sessionJson,
  toEvent, toInvite, toSession,
} from "./db.js";
import { isAlive, isTerminal, killSession } from "./lifecycle.js";
import { runFeed } from "./stream.js";
import { maybeSweep, sweep } from "./sweeper.js";

export const admin = new Hono();

const POLICIES = ["one_use", "on_complete", "ttl"];
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function secretOk(given: string | undefined, secret: string) {
  if (!given || !secret) return false;
  return timingSafeEqual(Buffer.from(sha256(given)), Buffer.from(sha256(secret)));
}

admin.use("*", async (c, next) => {
  const bearer = c.req.header("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
  const query = c.req.path.endsWith("/stream") ? c.req.query("token") : undefined;
  const isCron = c.req.path.endsWith("/cron/sweep");
  const ok =
    (c as any).get("opAuthed") === true || // set only by operatorAuth.gate after scope checks
    secretOk(bearer ?? query, config.adminToken) || (isCron && secretOk(bearer, config.cronSecret));
  if (!ok) return c.json({ error: "unauthorized" }, 401);
  await ensureSchema();
  await maybeSweep();
  await next();
});

const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");

function webhookOk(raw: string) {
  try {
    const u = new URL(raw);
    if (u.protocol === "https:") return true;
    return u.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname);
  } catch {
    return false;
  }
}

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
  return c.json({ ok: true });
});

admin.post("/invites", async (c) => {
  const b = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!b || typeof b !== "object") return c.json({ error: "invalid JSON body" }, 400);

  const label = str(b.label);
  const task = str(b.task);
  if (!label) return c.json({ error: "label is required" }, 400);
  if (!task) return c.json({ error: "task is required" }, 400);

  const policy = b.expiry_policy as string;
  if (!POLICIES.includes(policy)) {
    return c.json({ error: "expiry_policy must be one_use, on_complete or ttl" }, 400);
  }
  let expiresAt: number | null = null;
  if (policy === "ttl") {
    const hours = Number(b.ttl_hours);
    if (!Number.isFinite(hours) || hours <= 0) {
      return c.json({ error: "ttl_hours must be > 0 for ttl policy" }, 400);
    }
    expiresAt = Date.now() + Math.round(hours * 3_600_000);
  }

  const model = str(b.model) || config.defaultModel;
  if (!config.models.includes(model)) {
    return c.json({ error: `model must be one of: ${config.models.join(", ")}` }, 400);
  }

  let maxRedemptions: number | null = policy === "one_use" ? 1 : null;
  if (b.max_redemptions !== undefined && b.max_redemptions !== null && b.max_redemptions !== "") {
    const n = Number(b.max_redemptions);
    if (!Number.isInteger(n) || n < 1) return c.json({ error: "max_redemptions must be a positive integer" }, 400);
    maxRedemptions = n;
  }

  const notifyEmail = str(b.notify_email) || null;
  if (notifyEmail && (notifyEmail.length > 254 || !EMAIL_RE.test(notifyEmail))) {
    return c.json({ error: "notify_email must be a valid email address" }, 400);
  }
  const notifyWebhook = str(b.notify_webhook) || null;
  if (notifyWebhook && (notifyWebhook.length > 2000 || !webhookOk(notifyWebhook))) {
    return c.json({ error: "notify_webhook must be an https:// URL" }, 400);
  }

  let code = newCode();
  while (await one("SELECT 1 FROM invites WHERE code_hash = $1", [sha256(code)])) code = newCode();

  const id = newId();
  const now = Date.now();
  await run(
    `INSERT INTO invites (id, code_hash, label, task, working_dir, model, expiry_policy,
       expires_at, max_redemptions, notify_email, notify_webhook, status, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'pending', $12, $12)`,
    [
      id, sha256(code), label, task, str(b.working_dir) || "~/Desktop", model, policy,
      expiresAt, maxRedemptions, notifyEmail, notifyWebhook, now,
    ],
  );
  const shown = displayCode(code);
  return c.json(
    { invite: inviteJson((await getInvite(id))!), code: shown, command: `npx gigagent ${shown}` },
    201,
  );
});

admin.get("/invites", async (c) => {
  // Newest 200 invites only; sessions are fetched for just those.
  const rows = await all("SELECT * FROM invites ORDER BY created_at DESC, seq DESC LIMIT 200");
  const ids = rows.map((r) => r.id as string);
  const sessions = ids.length
    ? (await all("SELECT * FROM sessions WHERE invite_id = ANY($1::text[]) ORDER BY started_at, seq", [ids])).map(toSession)
    : [];
  const byInvite = new Map<string, ReturnType<typeof sessionJson>[]>();
  for (const s of sessions) {
    const list = byInvite.get(s.invite_id) ?? [];
    list.push(sessionJson(s));
    byInvite.set(s.invite_id, list);
  }
  const invites = rows.map(toInvite).map((i) => ({ ...inviteJson(i), sessions: byInvite.get(i.id) ?? [] }));
  return c.json({ invites });
});

admin.post("/invites/:id/revoke", async (c) => {
  const invite = await getInvite(c.req.param("id"));
  if (!invite) return c.json({ error: "invite not found" }, 404);
  await run("UPDATE invites SET status = 'revoked', updated_at = $2 WHERE id = $1", [invite.id, Date.now()]);
  const live = await all(
    "SELECT id FROM sessions WHERE invite_id = $1 AND status NOT IN ('done', 'failed', 'killed')",
    [invite.id],
  );
  for (const s of live) await killSession(s.id, "Invite revoked");
  return c.json({ ok: true });
});

admin.get("/sessions/:id/events", async (c) => {
  const id = c.req.param("id");
  if (!(await getSession(id))) return c.json({ error: "session not found" }, 404);
  const after = Number(c.req.query("after")) || 0;
  const rows = await all(
    "SELECT * FROM events WHERE session_id = $1 AND id > $2 ORDER BY id LIMIT 5000",
    [id, after],
  );
  return c.json({ events: rows.map((r) => eventJson(toEvent(r))) });
});

admin.post("/sessions/:id/instructions", async (c) => {
  const session = await getSession(c.req.param("id"));
  if (!session) return c.json({ error: "session not found" }, 404);
  const b = (await c.req.json().catch(() => null)) as { text?: unknown } | null;
  const text = str(b?.text);
  if (!text) return c.json({ error: "text is required" }, 400);
  const invite = (await getInvite(session.invite_id))!;
  if (!isAlive(session, invite)) return c.json({ error: "session is not alive" }, 409);
  await run("INSERT INTO instructions (session_id, text, created_at) VALUES ($1, $2, $3)", [
    session.id, text, Date.now(),
  ]);
  await addEvent(session.id, "instruction", { text });
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
