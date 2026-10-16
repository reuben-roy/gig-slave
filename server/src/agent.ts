import type { HttpBindings } from "@hono/node-server";
import { Hono, type Context } from "hono";
import { newId, newToken, normalizeCode, sha256 } from "./codes.js";
import { config } from "./config.js";
import {
  addEvent, addEvents, all, ensureSchema, one, run, toInvite,
  type InviteRow, type Result,
} from "./db.js";
import { completeInvite, endSession, isAlive, sessionFromAuth } from "./lifecycle.js";
import { notifySession } from "./notify.js";
import { FAIL_WINDOW_MS, maybeSweep } from "./sweeper.js";

type Auth = NonNullable<Awaited<ReturnType<typeof sessionFromAuth>>>;
type Env = { Bindings: HttpBindings; Variables: { auth: Auth } };
export const agent = new Hono<Env>();

const EVENT_TYPES = ["status", "tool_call", "tool_result", "assistant", "error", "report", "instruction"];
const LIVE_STATUSES = ["connecting", "working", "idle"];
const MAX_FAILS = 5;

export function clientIp(c: Context<any>) {
  const h = (name: string) => c.req.header(name)?.trim() || "";
  const xff = h("x-forwarded-for").split(",")[0]?.trim() || "";
  const socket = c.env?.incoming?.socket?.remoteAddress || "";
  // On Vercel the platform sets x-real-ip / x-forwarded-for; x-gig-client-ip is ignored because anyone can send it.
  if (config.onVercel) return h("x-real-ip") || xff || socket || "unknown";
  // Self-hosted: x-gig-client-ip is set by the Cloudflare Worker front door.
  return h("x-gig-client-ip") || h("cf-connecting-ip") || h("x-real-ip") || xff || socket || "unknown";
}

async function recentFailures(ip: string) {
  const r = await one<{ n: string }>(
    "SELECT COUNT(*) AS n FROM redeem_failures WHERE ip = $1 AND ts > $2",
    [ip, Date.now() - FAIL_WINDOW_MS],
  );
  return Number(r?.n ?? 0);
}

const recordFailure = (ip: string) =>
  run("INSERT INTO redeem_failures (ip, ts) VALUES ($1, $2)", [ip, Date.now()]);

function whyNotRedeemable(i: InviteRow, now = Date.now()): string | null {
  if (i.status === "revoked") return "this code has been revoked";
  if (i.status === "expired" || (i.expires_at !== null && i.expires_at <= now)) return "this code has expired";
  if (i.status === "completed") return "this code has already been used";
  if (i.max_redemptions !== null && i.redemptions >= i.max_redemptions) return "this code has already been used";
  return null;
}

const MAX_EVENT_JSON = 4096;
const encLen = (v: unknown) => JSON.stringify(v).length;

/** Cap every string and bound array/object sizes (shape-preserving). */
function clip(v: unknown, max: number, depth = 0): unknown {
  if (typeof v === "string") return v.length > max ? v.slice(0, max) + "…" : v;
  if (depth > 5) return null;
  if (Array.isArray(v)) return v.slice(0, 50).map((x) => clip(x, max, depth + 1));
  if (v && typeof v === "object") {
    return Object.fromEntries(
      Object.entries(v).slice(0, 50).map(([k, x]) => [k.slice(0, 100), clip(x, max, depth + 1)]),
    );
  }
  return v;
}

/** Collect [parent, key] slots of every string leaf (arrays/objects, bounded depth). */
function stringSlots(v: unknown, out: { o: any; k: string | number }[] = [], depth = 0) {
  if (depth > 6 || !v || typeof v !== "object") return out;
  const o = v as any;
  for (const k of Array.isArray(o) ? o.keys() : Object.keys(o)) {
    if (typeof o[k] === "string") out.push({ o, k });
    else stringSlots(o[k], out, depth + 1);
  }
  return out;
}

/**
 * Never replaces an event with a placeholder: the event keeps its shape (tool, ok, status, ...).
 * While the encoded JSON is over the cap, the longest string leaf is truncated (halved, then to what fits),
 * so output / text / args values / message shrink first and small fields (tool, status, ok) are untouched.
 */
function sanitize(type: string, data: unknown): object {
  const obj = data && typeof data === "object" && !Array.isArray(data) ? data : {};
  const max = type === "tool_call" ? 1000 : 2000;
  const clipped = clip(obj, max) as object;
  let size = encLen(clipped);
  if (size <= MAX_EVENT_JSON) return clipped;

  // Water-fill: find the largest per-string cap L (binary search) so that the encoded event fits.
  // Short fields (tool, status, ok, ...) are below any sensible L and stay untouched; only the big ones shrink.
  const slots = stringSlots(clipped).map((sl) => ({ ...sl, orig: sl.o[sl.k] as string }));
  const apply = (L: number) => {
    for (const sl of slots) sl.o[sl.k] = sl.orig.length > L ? sl.orig.slice(0, L) + "…" : sl.orig;
    return encLen(clipped);
  };
  let lo = 8;
  let hi = Math.max(8, ...slots.map((sl) => sl.orig.length));
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (apply(mid) <= MAX_EVENT_JSON) lo = mid;
    else hi = mid - 1;
  }
  size = apply(lo);
  // Last resort (thousands of tiny strings): drop the longest keys' values, still keeping the type's known fields.
  if (size > MAX_EVENT_JSON && !Array.isArray(clipped)) {
    const rec = clipped as Record<string, unknown>;
    for (const k of Object.keys(rec).reverse()) {
      if (size <= MAX_EVENT_JSON) break;
      if (["tool", "ok", "status", "text", "message", "success"].includes(k)) continue;
      delete rec[k];
      size = encLen(rec);
    }
  }
  return clipped;
}

const cap = (v: unknown, n: number) => (typeof v === "string" ? v.slice(0, n) : "");

/** Validate/clip the agent's structured result; synthesize one from the report when it is missing. */
function normalizeResult(raw: unknown, success: boolean, report: string): Result {
  const r = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, any>) : null;
  if (!r) return { success, summary: report, answer: null, findings: [], changes: [] };
  const findings = (Array.isArray(r.findings) ? r.findings : [])
    .filter((f: any) => f && typeof f === "object" && f.label != null && f.value != null)
    .slice(0, 50)
    .map((f: any) => ({ label: cap(String(f.label), 200), value: cap(String(f.value), 2000) }));
  const changes = (Array.isArray(r.changes) ? r.changes : [])
    .filter((c: unknown) => typeof c === "string" && c.trim())
    .slice(0, 200)
    .map((c: string) => cap(c, 1000));
  const answer = typeof r.answer === "string" && r.answer.trim() ? cap(r.answer, 20_000) : null;
  return {
    success,
    summary: cap(r.summary, 20_000) || report,
    answer,
    findings,
    changes,
  };
}

const readJson = async (c: Context) =>
  ((await c.req.json().catch(() => null)) ?? {}) as Record<string, any>;

agent.post("/redeem", async (c) => {
  await ensureSchema();
  const ip = clientIp(c);
  if ((await recentFailures(ip)) >= MAX_FAILS) {
    return c.json({ error: "too many failed attempts, try again later" }, 429);
  }
  const b = await readJson(c);
  const code = normalizeCode(typeof b.code === "string" ? b.code : "");
  const row = code.length === 8 ? await one("SELECT * FROM invites WHERE code_hash = $1", [sha256(code)]) : undefined;
  if (!row) {
    await recordFailure(ip);
    return c.json({ error: "invalid code" }, 401);
  }
  const invite = toInvite(row);
  const reason = whyNotRedeemable(invite);
  if (reason) return c.json({ error: reason }, 403);

  const m = b.machine && typeof b.machine === "object" ? b.machine : null;
  const machine = m
    ? JSON.stringify(Object.fromEntries(
        ["hostname", "platform", "release", "arch", "username"].map((k) => [k, String(m[k] ?? "").slice(0, 200)]),
      ))
    : null;

  const now = Date.now();
  // Atomic claim so two simultaneous redemptions cannot both use up a one_use code.
  const claimed = await run(
    `UPDATE invites SET redemptions = redemptions + 1,
       status = CASE WHEN status = 'pending' THEN 'active' ELSE status END, updated_at = $2
     WHERE id = $1 AND status IN ('pending', 'active')
       AND (max_redemptions IS NULL OR redemptions < max_redemptions)
       AND (expires_at IS NULL OR expires_at > $2)`,
    [invite.id, now],
  );
  if (!claimed) return c.json({ error: "this code has already been used" }, 403);

  const sessionId = newId();
  const token = newToken();
  await run(
    `INSERT INTO sessions (id, invite_id, token_hash, machine, status, last_heartbeat, started_at, updated_at)
     VALUES ($1, $2, $3, $4, 'connecting', $5, $5, $5)`,
    [sessionId, invite.id, sha256(token), machine, now],
  );
  await addEvent(sessionId, "status", { status: "connecting", text: "Recipient connected" });

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
  const auth = await sessionFromAuth(c.req.header("authorization"));
  if (!auth) return c.json({ error: "unauthorized" }, 401);
  await maybeSweep();
  c.set("auth", auth);
  await next();
});

agent.post("/events", async (c) => {
  const { session } = c.get("auth");
  const b = await readJson(c);
  const events: any[] = Array.isArray(b.events) ? b.events.slice(0, 500) : [];
  const now = Date.now();
  let status: string | null = null;
  let statusText: string | null = null;
  let actions = 0;

  const rows: { type: string; data: unknown; ts: number }[] = [];
  for (const e of events) {
    if (!e || !EVENT_TYPES.includes(e.type)) continue;
    const data = sanitize(e.type, e.data) as Record<string, any>;
    rows.push({ type: e.type, data, ts: Number.isFinite(e.ts) ? e.ts : now });
    if (e.type === "tool_call") actions++;
    if (e.type === "status") {
      if (LIVE_STATUSES.includes(data.status)) status = data.status;
      if (typeof data.text === "string") statusText = data.text;
    }
  }
  await addEvents(session.id, rows);

  // Terminal sessions keep their status; updated_at only moves on a meaningful change.
  await run(
    `UPDATE sessions SET
       updated_at = CASE WHEN $2::int > 0
         OR (status NOT IN ('done', 'failed', 'killed') AND (
              ($3::text IS NOT NULL AND status IS DISTINCT FROM $3::text)
           OR ($4::text IS NOT NULL AND status_text IS DISTINCT FROM $4::text)))
         THEN $1::bigint ELSE updated_at END,
       actions = actions + $2::int,
       last_heartbeat = $1::bigint,
       status = CASE WHEN status IN ('done', 'failed', 'killed') THEN status ELSE COALESCE($3::text, status) END,
       status_text = CASE WHEN status IN ('done', 'failed', 'killed') THEN status_text ELSE COALESCE($4::text, status_text) END
     WHERE id = $5`,
    [now, actions, status, statusText, session.id],
  );
  return c.json({ ok: true });
});

agent.post("/heartbeat", async (c) => {
  const { session, invite } = c.get("auth");
  const b = await readJson(c);
  const now = Date.now();
  const status = LIVE_STATUSES.includes(b.status) ? (b.status as string) : null;
  const statusText = typeof b.status_text === "string" ? b.status_text : null;
  // last_heartbeat always moves; updated_at only when the visible status changed.
  await run(
    `UPDATE sessions SET
       updated_at = CASE WHEN status NOT IN ('done', 'failed', 'killed') AND (
              ($3::text IS NOT NULL AND status IS DISTINCT FROM $3::text)
           OR ($4::text IS NOT NULL AND status_text IS DISTINCT FROM $4::text))
         THEN $1::bigint ELSE updated_at END,
       last_heartbeat = $1::bigint,
       status = CASE WHEN status IN ('done', 'failed', 'killed') THEN status ELSE COALESCE($3::text, status) END,
       status_text = CASE WHEN status IN ('done', 'failed', 'killed') THEN status_text ELSE COALESCE($4::text, status_text) END
     WHERE id = $2`,
    [now, session.id, status, statusText],
  );
  const alive = isAlive(session, invite, now);
  let pending: { id: number; text: string }[] = [];
  if (alive) {
    pending = (
      await all(
        `UPDATE instructions SET delivered = TRUE
         WHERE session_id = $1 AND delivered = FALSE RETURNING id, text`,
        [session.id],
      )
    )
      .map((r) => ({ id: Number(r.id), text: r.text as string }))
      .sort((a, b) => a.id - b.id);
  }
  return c.json({ kill: !alive || session.kill_requested, instructions: pending });
});

agent.post("/complete", async (c) => {
  const { session } = c.get("auth");
  const b = await readJson(c);
  const success = b.success === true;
  const rawResult = b.result && typeof b.result === "object" ? b.result : null;
  const reportIn = typeof b.report === "string" ? b.report : "";
  const result = normalizeResult(rawResult, success, cap(reportIn || (rawResult as any)?.summary, 20_000));
  const report = rawResult ? result.summary : cap(reportIn, 20_000);

  const ended = await endSession(session.id, success ? "done" : "failed", success ? "Finished" : "Failed", {
    log: false, report, result,
  });
  // The first report wins; a late or duplicate /complete (e.g. after a kill or Ctrl+C) is ignored.
  if (!ended) return c.json({ ok: true });
  await addEvent(session.id, "report", { text: report, success, result });
  if (success) {
    const invite = (await one("SELECT expiry_policy, id FROM invites WHERE id = $1", [session.invite_id])) as
      | { expiry_policy: string; id: string }
      | undefined;
    if (invite?.expiry_policy === "on_complete") await completeInvite(invite.id);
  }
  await notifySession(session.id);
  return c.json({ ok: true });
});
