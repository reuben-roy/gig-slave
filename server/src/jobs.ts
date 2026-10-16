import { createHash } from "node:crypto";
import { displayCode, newCode, newId, sha256 } from "./codes.js";
import { config } from "./config.js";
import {
  addEvent, all, eventJson, getInvite, inviteJson, one, run, sessionJson, toEvent, toInvite, toSession,
  type InviteRow, type SessionRow,
} from "./db.js";
import { isAlive, killSession } from "./lifecycle.js";

/**
 * Job (= invite + its sessions) operations shared by the dashboard admin API and the operator API/MCP.
 * `owner` scopes every call to one operator account's own jobs and applies its limits; without it the caller is the admin.
 */

export class ServiceError extends Error {
  constructor(readonly status: 400 | 401 | 403 | 404 | 409 | 410 | 422 | 429, readonly code: string, message: string) {
    super(message);
  }
}

export interface Owner {
  id: string;
  max_active_jobs: number;
  max_jobs_per_day: number;
  max_ttl_hours: number;
  allowed_models: string[] | null;
}

const POLICIES = ["one_use", "on_complete", "ttl"];
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const IDEM_RE = /^[A-Za-z0-9_.:-]{1,128}$/;
const DEFAULT_OPERATOR_TTL_HOURS = 24;
const DAY_MS = 86_400_000;

export const commandFor = (code: string) => `npx gigagent ${code}`;

export const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");

function webhookOk(raw: string, allowLoopback: boolean) {
  try {
    const u = new URL(raw);
    if (u.protocol === "https:") return true;
    return allowLoopback && u.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname);
  } catch {
    return false;
  }
}

const bad = (message: string) => new ServiceError(400, "invalid_request", message);

export interface CreatedJob {
  invite: InviteRow;
  /** Null when this call replayed an earlier idempotent create (the code is only ever shown once). */
  code: string | null;
  replayed: boolean;
}

export async function createInvite(
  b: Record<string, unknown>,
  opts: { owner?: Owner; idemKey?: string } = {},
): Promise<CreatedJob> {
  const { owner, idemKey } = opts;
  const label = str(b.label);
  const task = str(b.task);
  if (!label) throw bad("label is required");
  if (!task) throw bad("task is required");

  const policy = b.expiry_policy as string;
  if (!POLICIES.includes(policy)) throw bad("expiry_policy must be one_use, on_complete or ttl");

  // Operator jobs always expire (default 24h) so an unclaimed code can't hold a slot forever.
  let hours: number | null = null;
  const rawHours = b.ttl_hours;
  if (rawHours !== undefined && rawHours !== null && rawHours !== "") {
    hours = Number(rawHours);
    if (!Number.isFinite(hours) || hours <= 0) throw bad("ttl_hours must be > 0 for ttl policy");
  } else if (policy === "ttl") {
    throw bad("ttl_hours must be > 0 for ttl policy");
  } else if (owner) {
    hours = Math.min(DEFAULT_OPERATOR_TTL_HOURS, owner.max_ttl_hours);
  }
  if (policy !== "ttl" && !owner) hours = null;
  if (owner && hours !== null && hours > owner.max_ttl_hours) {
    throw new ServiceError(403, "limit_exceeded", `ttl_hours exceeds this account's limit of ${owner.max_ttl_hours}`);
  }

  const model = str(b.model) || config.defaultModel;
  if (!config.models.includes(model)) throw bad(`model must be one of: ${config.models.join(", ")}`);
  if (owner?.allowed_models && !owner.allowed_models.includes(model)) {
    throw new ServiceError(403, "model_not_allowed", `this account may only use: ${owner.allowed_models.join(", ")}`);
  }

  let maxRedemptions: number | null = policy === "one_use" ? 1 : null;
  if (b.max_redemptions !== undefined && b.max_redemptions !== null && b.max_redemptions !== "") {
    const n = Number(b.max_redemptions);
    if (!Number.isInteger(n) || n < 1) throw bad("max_redemptions must be a positive integer");
    maxRedemptions = n;
  }

  const notifyEmail = str(b.notify_email) || null;
  // Operator accounts can't make the server email arbitrary addresses (the owner's sender reputation) or call plain-http/loopback URLs.
  if (owner && notifyEmail) throw bad("notify_email is not available to operator accounts; use notify_webhook");
  if (notifyEmail && (notifyEmail.length > 254 || !EMAIL_RE.test(notifyEmail))) {
    throw bad("notify_email must be a valid email address");
  }
  const notifyWebhook = str(b.notify_webhook) || null;
  if (notifyWebhook && (notifyWebhook.length > 2000 || !webhookOk(notifyWebhook, !owner))) {
    throw bad("notify_webhook must be an https:// URL");
  }
  const workingDir = str(b.working_dir) || "~/Desktop";

  let idemHash: string | null = null;
  if (owner && idemKey) {
    if (!IDEM_RE.test(idemKey)) throw bad("idempotency key must be 1-128 characters of A-Z a-z 0-9 _ . : -");
    idemHash = createHash("sha256")
      .update(JSON.stringify([label, task, workingDir, model, policy, hours, maxRedemptions, notifyEmail, notifyWebhook]))
      .digest("hex");
    const replay = await findIdempotent(owner.id, idemKey, idemHash);
    if (replay) return replay;
  }

  let code = newCode();
  while (await one("SELECT 1 FROM invites WHERE code_hash = $1", [sha256(code)])) code = newCode();

  const id = newId();
  const now = Date.now();
  const inserted = await run(
    `INSERT INTO invites (id, code_hash, label, task, working_dir, model, expiry_policy, expires_at,
       max_redemptions, notify_email, notify_webhook, operator_id, idem_key, idem_hash, status, created_at, updated_at)
     SELECT $1::text, $2::text, $3::text, $4::text, $5::text, $6::text, $7::text, $8::bigint,
       $9::int, $10::text, $11::text, $12::text, $13::text, $14::text, 'pending', $15::bigint, $15::bigint
     WHERE $12::text IS NULL OR (
       (SELECT COUNT(*) FROM invites WHERE operator_id = $12::text AND status IN ('pending', 'active')
          AND (expires_at IS NULL OR expires_at > $15::bigint)) < $16::int
       AND (SELECT COUNT(*) FROM invites WHERE operator_id = $12::text AND created_at > $15::bigint - $17::bigint) < $18::int)
     ON CONFLICT DO NOTHING`,
    [
      id, sha256(code), label, task, workingDir, model, policy,
      hours === null ? null : now + Math.round(hours * 3_600_000),
      maxRedemptions, notifyEmail, notifyWebhook,
      owner?.id ?? null, owner && idemKey ? idemKey : null, idemHash, now,
      owner?.max_active_jobs ?? 0, DAY_MS, owner?.max_jobs_per_day ?? 0,
    ],
  );
  if (!inserted) {
    // Lost an idempotency race, or a limit blocked the insert.
    if (owner && idemKey && idemHash) {
      const replay = await findIdempotent(owner.id, idemKey, idemHash);
      if (replay) return replay;
    }
    const u = await usageOf(owner!.id);
    if (u.active_jobs >= owner!.max_active_jobs) {
      throw new ServiceError(429, "limit_exceeded", `active job limit reached (${owner!.max_active_jobs}); stop or finish a job first`);
    }
    throw new ServiceError(429, "limit_exceeded", `daily job limit reached (${owner!.max_jobs_per_day} per 24h)`);
  }
  return { invite: (await getInvite(id))!, code: displayCode(code), replayed: false };
}

async function findIdempotent(operatorId: string, key: string, hash: string): Promise<CreatedJob | null> {
  const row = await one("SELECT * FROM invites WHERE operator_id = $1 AND idem_key = $2", [operatorId, key]);
  if (!row) return null;
  const invite = toInvite(row);
  if (invite.idem_hash !== hash) {
    throw new ServiceError(422, "idempotency_conflict", "this idempotency key was already used with different job parameters");
  }
  return { invite, code: null, replayed: true };
}

export async function usageOf(operatorId: string) {
  const r = await one<{ active: string; today: string }>(
    `SELECT COUNT(*) FILTER (WHERE status IN ('pending', 'active') AND (expires_at IS NULL OR expires_at > $2)) AS active,
            COUNT(*) FILTER (WHERE created_at > $2 - $3::bigint) AS today
     FROM invites WHERE operator_id = $1`,
    [operatorId, Date.now(), DAY_MS],
  );
  return { active_jobs: Number(r?.active ?? 0), jobs_today: Number(r?.today ?? 0) };
}

export type JobState = "waiting_for_recipient" | "running" | "succeeded" | "failed" | "stopped" | "expired";

/** One word for agents: collapses invite + session statuses. */
export function jobState(invite: InviteRow, sessions: SessionRow[]): JobState {
  const live = sessions.find((s) => ["connecting", "working", "idle"].includes(s.status));
  if (live) return "running";
  const last = [...sessions].sort((a, b) => b.started_at - a.started_at)[0];
  if (last?.status === "done") return "succeeded";
  if (last?.status === "failed") return "failed";
  if (last?.status === "killed" || invite.status === "revoked") return "stopped";
  if (invite.status === "expired") return "expired";
  return "waiting_for_recipient";
}

async function sessionsByInvite(ids: string[]) {
  const byInvite = new Map<string, SessionRow[]>();
  if (!ids.length) return byInvite;
  const rows = (await all("SELECT * FROM sessions WHERE invite_id = ANY($1::text[]) ORDER BY started_at, seq", [ids])).map(toSession);
  for (const s of rows) byInvite.set(s.invite_id, [...(byInvite.get(s.invite_id) ?? []), s]);
  return byInvite;
}

/** Dashboard shape: invite + sessions. */
export async function listInvites(opts: { operatorId?: string; limit?: number } = {}) {
  const rows = (
    await all(
      `SELECT * FROM invites WHERE ($1::text IS NULL OR operator_id = $1::text)
       ORDER BY created_at DESC, seq DESC LIMIT $2`,
      [opts.operatorId ?? null, opts.limit ?? 200],
    )
  ).map(toInvite);
  const sessions = await sessionsByInvite(rows.map((r) => r.id));
  return rows.map((i) => ({ ...inviteJson(i), sessions: (sessions.get(i.id) ?? []).map(sessionJson) }));
}

/** Operator shape: the dashboard shape plus a single `state`, the live session id and the latest structured result. */
export async function jobView(invite: InviteRow, sessions?: SessionRow[]) {
  const ss = sessions ?? (await sessionsByInvite([invite.id])).get(invite.id) ?? [];
  const json = ss.map(sessionJson);
  const finished = [...json].reverse().find((s) => s.result);
  return {
    ...inviteJson(invite),
    state: jobState(invite, ss),
    active_session_id: ss.find((s) => ["connecting", "working", "idle"].includes(s.status))?.id ?? null,
    result: finished?.result ?? null,
    sessions: json,
  };
}

export async function listJobs(operatorId: string, opts: { state?: string; limit?: number } = {}) {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  // A state filter looks through the newest 200 jobs, so "running" isn't hidden behind 50 finished ones.
  const rows = (
    await all("SELECT * FROM invites WHERE operator_id = $1 ORDER BY created_at DESC, seq DESC LIMIT $2", [
      operatorId, opts.state ? 200 : limit,
    ])
  ).map(toInvite);
  const sessions = await sessionsByInvite(rows.map((r) => r.id));
  const views = await Promise.all(rows.map((i) => jobView(i, sessions.get(i.id) ?? [])));
  return opts.state ? views.filter((v) => v.state === opts.state).slice(0, limit) : views;
}

/** Returns the invite, or 404 if it doesn't exist or belongs to another operator (existence isn't revealed). */
export async function inviteFor(id: string, owner?: Owner) {
  const invite = await getInvite(id);
  if (!invite || (owner && invite.operator_id !== owner.id)) throw new ServiceError(404, "not_found", "job not found");
  return invite;
}

export async function revokeInvite(invite: InviteRow) {
  await run("UPDATE invites SET status = 'revoked', updated_at = $2 WHERE id = $1", [invite.id, Date.now()]);
  const live = await all(
    "SELECT id FROM sessions WHERE invite_id = $1 AND status NOT IN ('done', 'failed', 'killed')",
    [invite.id],
  );
  for (const s of live) await killSession(s.id, "Invite revoked");
}

export async function sessionEvents(sessionId: string, after: number, limit = 5000) {
  const rows = await all(
    "SELECT * FROM events WHERE session_id = $1 AND id > $2 ORDER BY id LIMIT $3",
    [sessionId, after, limit],
  );
  return rows.map((r) => eventJson(toEvent(r)));
}

/** Newest events across a job's sessions (oldest first within the page). */
export async function jobEvents(inviteId: string, after: number, limit: number) {
  const rows = await all(
    `SELECT e.* FROM events e JOIN sessions s ON s.id = e.session_id
     WHERE s.invite_id = $1 AND e.id > $2 ORDER BY e.id LIMIT $3`,
    [inviteId, after, limit],
  );
  return rows.map((r) => eventJson(toEvent(r)));
}

export async function sendInstruction(session: SessionRow, invite: InviteRow, text: string) {
  if (!isAlive(session, invite)) throw new ServiceError(409, "not_running", "session is not alive");
  await run("INSERT INTO instructions (session_id, text, created_at) VALUES ($1, $2, $3)", [
    session.id, text, Date.now(),
  ]);
  await addEvent(session.id, "instruction", { text });
}

export async function liveSession(inviteId: string) {
  const r = await one(
    "SELECT * FROM sessions WHERE invite_id = $1 AND status NOT IN ('done', 'failed', 'killed') ORDER BY started_at DESC LIMIT 1",
    [inviteId],
  );
  return r ? toSession(r) : undefined;
}

/** Replace the code of a job nobody has redeemed yet (the old code stops working). */
export async function reissueCode(invite: InviteRow) {
  const code = newCode();
  const changed = await run(
    `UPDATE invites SET code_hash = $2, updated_at = $3
     WHERE id = $1 AND status = 'pending' AND redemptions = 0 AND (expires_at IS NULL OR expires_at > $3)`,
    [invite.id, sha256(code), Date.now()],
  );
  if (!changed) throw new ServiceError(409, "not_reissuable", "only a job that is still waiting for its recipient can get a new code");
  return displayCode(code);
}
