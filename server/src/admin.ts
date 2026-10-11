import { timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { bus } from "./bus.js";
import { displayCode, newCode, newId, sha256 } from "./codes.js";
import { config } from "./config.js";
import {
  all, eventJson, getInvite, getSession, inviteJson, one, run, sessionJson,
  type EventRow, type InviteRow, type SessionRow,
} from "./db.js";
import { addEvent, isAlive, isTerminal, killSession, publishInvite } from "./lifecycle.js";

export const admin = new Hono();

const POLICIES = ["one_use", "on_complete", "ttl"];

function tokenOk(given: string | undefined) {
  if (!given) return false;
  const a = Buffer.from(sha256(given));
  const b = Buffer.from(sha256(config.adminToken!));
  return timingSafeEqual(a, b);
}

admin.use("*", async (c, next) => {
  const bearer = c.req.header("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
  const query = c.req.path.endsWith("/stream") ? c.req.query("token") : undefined;
  if (!tokenOk(bearer ?? query)) return c.json({ error: "unauthorized" }, 401);
  await next();
});

const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");

admin.get("/config", (c) =>
  c.json({ models: config.models, default_model: config.defaultModel, public_url: config.publicUrl }),
);

admin.post("/invites", async (c) => {
  const b = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!b || typeof b !== "object") return c.json({ error: "invalid JSON body" }, 400);

  const label = str(b.label);
  const task = str(b.task);
  if (!label) return c.json({ error: "label is required" }, 400);
  if (!task) return c.json({ error: "task is required" }, 400);

  const policy = b.expiry_policy as InviteRow["expiry_policy"];
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
  if (b.max_redemptions !== undefined && b.max_redemptions !== null) {
    const n = Number(b.max_redemptions);
    if (!Number.isInteger(n) || n < 1) return c.json({ error: "max_redemptions must be a positive integer" }, 400);
    maxRedemptions = n;
  }

  let code = newCode();
  while (one("SELECT 1 FROM invites WHERE code_hash = ?", sha256(code))) code = newCode();

  const id = newId();
  run(
    `INSERT INTO invites (id, code_hash, label, email, task, working_dir, model, expiry_policy,
       expires_at, max_redemptions, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
    id, sha256(code), label, str(b.email) || null, task, str(b.working_dir) || "~/Desktop",
    model, policy, expiresAt, maxRedemptions, Date.now(),
  );
  publishInvite(id);
  const shown = displayCode(code);
  return c.json(
    { invite: inviteJson(getInvite(id)!), code: shown, command: `npx gig-slave ${shown}` },
    201,
  );
});

admin.get("/invites", (c) => {
  const sessions = all<SessionRow>("SELECT * FROM sessions ORDER BY started_at");
  const byInvite = new Map<string, ReturnType<typeof sessionJson>[]>();
  for (const s of sessions) {
    const list = byInvite.get(s.invite_id) ?? [];
    list.push(sessionJson(s));
    byInvite.set(s.invite_id, list);
  }
  const invites = all<InviteRow>("SELECT * FROM invites ORDER BY created_at DESC, rowid DESC").map(
    (i) => ({ ...inviteJson(i), sessions: byInvite.get(i.id) ?? [] }),
  );
  return c.json({ invites });
});

admin.post("/invites/:id/revoke", (c) => {
  const invite = getInvite(c.req.param("id"));
  if (!invite) return c.json({ error: "invite not found" }, 404);
  run("UPDATE invites SET status = 'revoked' WHERE id = ?", invite.id);
  for (const s of all<SessionRow>("SELECT * FROM sessions WHERE invite_id = ?", invite.id)) {
    if (!isTerminal(s.status)) killSession(s.id, "Invite revoked");
  }
  publishInvite(invite.id);
  return c.json({ ok: true });
});

admin.get("/sessions/:id/events", (c) => {
  const id = c.req.param("id");
  if (!getSession(id)) return c.json({ error: "session not found" }, 404);
  const after = Number(c.req.query("after")) || 0;
  const rows = all<EventRow>(
    "SELECT * FROM events WHERE session_id = ? AND id > ? ORDER BY id LIMIT 5000",
    id, after,
  );
  return c.json({ events: rows.map(eventJson) });
});

admin.post("/sessions/:id/instructions", async (c) => {
  const session = getSession(c.req.param("id"));
  if (!session) return c.json({ error: "session not found" }, 404);
  const b = (await c.req.json().catch(() => null)) as { text?: unknown } | null;
  const text = str(b?.text);
  if (!text) return c.json({ error: "text is required" }, 400);
  const invite = getInvite(session.invite_id)!;
  if (!isAlive(session, invite)) return c.json({ error: "session is not alive" }, 409);
  run("INSERT INTO instructions (session_id, text, created_at) VALUES (?, ?, ?)", session.id, text, Date.now());
  addEvent(session.id, "instruction", { text });
  return c.json({ ok: true });
});

admin.post("/sessions/:id/kill", (c) => {
  const session = getSession(c.req.param("id"));
  if (!session) return c.json({ error: "session not found" }, 404);
  killSession(session.id);
  return c.json({ ok: true });
});

admin.get("/stream", (c) =>
  streamSSE(c, async (stream) => {
    let open = true;
    const send = (name: string) => (payload: unknown) => {
      if (open) stream.writeSSE({ event: name, data: JSON.stringify(payload) }).catch(() => {});
    };
    const handlers = { event: send("event"), session: send("session"), invite: send("invite") };
    for (const [name, fn] of Object.entries(handlers)) bus.on(name, fn);
    stream.onAbort(() => {
      open = false;
    });
    try {
      await stream.write(": connected\n\n");
      while (open) {
        await stream.sleep(15_000);
        if (open) await stream.write(": ping\n\n");
      }
    } catch {
      // client went away
    } finally {
      open = false;
      for (const [name, fn] of Object.entries(handlers)) bus.off(name, fn);
    }
  }),
);
