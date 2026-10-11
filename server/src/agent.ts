import type { HttpBindings } from "@hono/node-server";
import { Hono, type Context } from "hono";
import { newId, newToken, normalizeCode, sha256 } from "./codes.js";
import { config } from "./config.js";
import { all, getInvite, getSession, one, run, type InviteRow } from "./db.js";
import {
  addEvent, completeInvite, endSession, isAlive, isTerminal, publishInvite, publishSession,
  sessionFromAuth,
} from "./lifecycle.js";

export const agent = new Hono<{ Bindings: HttpBindings }>();

const EVENT_TYPES = ["status", "tool_call", "tool_result", "assistant", "error", "report", "instruction"];
const LIVE_STATUSES = ["connecting", "working", "idle"];
const MAX_FAILS = 5;
const FAIL_WINDOW_MS = 10 * 60_000;

const failures = new Map<string, number[]>();

function clientIp(c: Context<{ Bindings: HttpBindings }>) {
  return (
    c.req.header("x-gig-client-ip") || // set by the Worker front door
    c.req.header("cf-connecting-ip") ||
    c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ||
    c.env?.incoming?.socket?.remoteAddress ||
    "unknown"
  );
}

function recentFailures(ip: string) {
  const cutoff = Date.now() - FAIL_WINDOW_MS;
  const list = (failures.get(ip) ?? []).filter((t) => t > cutoff);
  if (list.length) failures.set(ip, list);
  else failures.delete(ip);
  return list.length;
}

function recordFailure(ip: string) {
  recentFailures(ip);
  failures.set(ip, [...(failures.get(ip) ?? []), Date.now()]);
}

function whyNotRedeemable(i: InviteRow, now = Date.now()): string | null {
  if (i.status === "revoked") return "this code has been revoked";
  if (i.status === "expired" || (i.expires_at !== null && i.expires_at <= now)) return "this code has expired";
  if (i.status === "completed") return "this code has already been used";
  if (i.max_redemptions !== null && i.redemptions >= i.max_redemptions) return "this code has already been used";
  return null;
}

/** Cap every string, then fall back to a preview if the JSON is still too big. */
function clip(v: unknown, max: number, depth = 0): unknown {
  if (typeof v === "string") return v.length > max ? v.slice(0, max) + "…" : v;
  if (depth > 5) return null;
  if (Array.isArray(v)) return v.slice(0, 50).map((x) => clip(x, max, depth + 1));
  if (v && typeof v === "object") {
    return Object.fromEntries(
      Object.entries(v).slice(0, 50).map(([k, x]) => [k, clip(x, max, depth + 1)]),
    );
  }
  return v;
}

function sanitize(type: string, data: unknown): object {
  const obj = data && typeof data === "object" && !Array.isArray(data) ? data : {};
  const max = type === "tool_call" ? 1000 : 2000;
  const clipped = clip(obj, max) as object;
  const json = JSON.stringify(clipped);
  return json.length > 4096 ? { truncated: true, preview: json.slice(0, 3500) } : clipped;
}

const readJson = async (c: Context) =>
  ((await c.req.json().catch(() => null)) ?? {}) as Record<string, any>;

agent.post("/redeem", async (c) => {
  const ip = clientIp(c);
  if (recentFailures(ip) >= MAX_FAILS) {
    return c.json({ error: "too many failed attempts, try again later" }, 429);
  }
  const b = await readJson(c);
  const code = normalizeCode(typeof b.code === "string" ? b.code : "");
  const invite =
    code.length === 8 ? one<InviteRow>("SELECT * FROM invites WHERE code_hash = ?", sha256(code)) : undefined;
  if (!invite) {
    recordFailure(ip);
    return c.json({ error: "invalid code" }, 401);
  }
  const reason = whyNotRedeemable(invite);
  if (reason) return c.json({ error: reason }, 403);

  const m = b.machine && typeof b.machine === "object" ? b.machine : null;
  const machine = m
    ? JSON.stringify(Object.fromEntries(
        ["hostname", "platform", "release", "arch", "username"].map((k) => [k, String(m[k] ?? "")]),
      ))
    : null;

  const now = Date.now();
  const sessionId = newId();
  const token = newToken();
  run(
    `INSERT INTO sessions (id, invite_id, token_hash, machine, status, last_heartbeat, started_at)
     VALUES (?, ?, ?, ?, 'connecting', ?, ?)`,
    sessionId, invite.id, sha256(token), machine, now, now,
  );
  run(
    "UPDATE invites SET redemptions = redemptions + 1, status = CASE WHEN status = 'pending' THEN 'active' ELSE status END WHERE id = ?",
    invite.id,
  );
  addEvent(sessionId, "status", { status: "connecting", text: "Recipient connected" });
  publishInvite(invite.id);
  publishSession(sessionId);

  return c.json({
    session_id: sessionId,
    session_token: token,
    task: invite.task,
    working_dir: invite.working_dir,
    model: invite.model,
    v1_base_url: `${config.publicUrl}/v1`,
    heartbeat_ms: config.heartbeatMs,
  });
});

agent.use("*", async (c, next) => {
  if (!sessionFromAuth(c.req.header("authorization"))) return c.json({ error: "unauthorized" }, 401);
  await next();
});

agent.post("/events", async (c) => {
  const { session } = sessionFromAuth(c.req.header("authorization"))!;
  const b = await readJson(c);
  const events: any[] = Array.isArray(b.events) ? b.events.slice(0, 500) : [];
  const now = Date.now();
  let status: string | null = null;
  let statusText: string | null = null;
  let actions = 0;

  for (const e of events) {
    if (!e || !EVENT_TYPES.includes(e.type)) continue;
    const data = sanitize(e.type, e.data) as Record<string, any>;
    addEvent(session.id, e.type, data, Number.isFinite(e.ts) ? e.ts : now);
    if (e.type === "tool_call") actions++;
    if (e.type === "status") {
      if (LIVE_STATUSES.includes(data.status)) status = data.status;
      if (typeof data.text === "string") statusText = data.text;
    }
  }

  const fresh = getSession(session.id)!;
  const live = !isTerminal(fresh.status);
  run(
    `UPDATE sessions SET actions = actions + ?, last_heartbeat = ?,
       status = ?, status_text = ? WHERE id = ?`,
    actions, now,
    live && status ? status : fresh.status,
    live && statusText !== null ? statusText : fresh.status_text,
    session.id,
  );
  publishSession(session.id);
  return c.json({ ok: true });
});

agent.post("/heartbeat", async (c) => {
  const { session, invite } = sessionFromAuth(c.req.header("authorization"))!;
  const b = await readJson(c);
  const live = !isTerminal(session.status);
  run(
    "UPDATE sessions SET last_heartbeat = ?, status = ?, status_text = ? WHERE id = ?",
    Date.now(),
    live && LIVE_STATUSES.includes(b.status) ? b.status : session.status,
    live && typeof b.status_text === "string" ? b.status_text : session.status_text,
    session.id,
  );
  const alive = isAlive(session, invite);
  const pending = alive
    ? all<{ id: number; text: string }>(
        "SELECT id, text FROM instructions WHERE session_id = ? AND delivered = 0 ORDER BY id",
        session.id,
      )
    : [];
  for (const p of pending) run("UPDATE instructions SET delivered = 1 WHERE id = ?", p.id);
  publishSession(session.id);
  return c.json({ kill: !alive || session.kill_requested === 1, instructions: pending });
});

agent.post("/complete", async (c) => {
  const { session } = sessionFromAuth(c.req.header("authorization"))!;
  const b = await readJson(c);
  const success = b.success === true;
  const report = (typeof b.report === "string" ? b.report : "").slice(0, 20_000);

  const ended = endSession(session.id, success ? "done" : "failed", success ? "Finished" : "Failed", {
    log: false,
  });
  // The first report wins; a late or duplicate /complete (e.g. after a kill or Ctrl+C) is ignored.
  if (!ended) return c.json({ ok: true });
  run("UPDATE sessions SET report = ? WHERE id = ?", report, session.id);
  addEvent(session.id, "report", { text: report, success });
  if (success) {
    const invite = getInvite(session.invite_id)!;
    if (invite.expiry_policy === "on_complete") completeInvite(invite.id);
  }
  publishSession(session.id);
  return c.json({ ok: true });
});
