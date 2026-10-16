import { randomBytes } from "node:crypto";
import { Hono } from "hono";
import { displayCode, newCode, newId, normalizeCode, sha256 } from "./codes.js";
import { config } from "./config.js";
import { all, one, run, toInvite } from "./db.js";
import { ServiceError, revokeInvite, str, usageOf, type Owner } from "./jobs.js";

/**
 * Operator accounts: the identity agents/tools use to create and manage jobs.
 * Distinct from ADMIN_TOKEN (dashboard owner) and from recipient session tokens.
 * An account is created only by a human approving an enrollment (or, later, an OAuth consent) with the admin token.
 */

export const SCOPES = ["jobs:read", "jobs:write"] as const;
export type Scope = (typeof SCOPES)[number];

export interface Operator extends Owner {
  name: string;
  status: "active" | "revoked";
  created_at: number;
  revoked_at: number | null;
}
export interface TokenInfo { id: string; prefix: string; scopes: Scope[]; expires_at: number | null }
export interface OperatorAuth { operator: Operator; token: TokenInfo }

const DEFAULTS = { max_active_jobs: 3, max_jobs_per_day: 20, max_ttl_hours: 72 };
const ENROLL_TTL_MS = 15 * 60_000;
const ENROLL_INTERVAL_S = 3;
const MAX_ENROLL_PER_IP_HOUR = 10;
const MAX_PENDING_ENROLLMENTS = 50;
const DEFAULT_TOKEN_DAYS = 90;
const TOUCH_MS = 60_000;

export const newOperatorToken = () => `hgo_${randomBytes(24).toString("base64url")}`;

const toOperator = (r: any): Operator => ({
  id: r.id, name: r.name, status: r.status,
  max_active_jobs: Number(r.max_active_jobs), max_jobs_per_day: Number(r.max_jobs_per_day),
  max_ttl_hours: Number(r.max_ttl_hours),
  allowed_models: r.allowed_models ? (JSON.parse(r.allowed_models) as string[]) : null,
  created_at: Number(r.created_at), revoked_at: r.revoked_at == null ? null : Number(r.revoked_at),
});

const parseScopes = (raw: string) => raw.split(" ").filter((s): s is Scope => (SCOPES as readonly string[]).includes(s));

const bad = (message: string) => new ServiceError(400, "invalid_request", message);

function scopesFrom(v: unknown, fallback: Scope[]): Scope[] {
  if (v === undefined || v === null) return fallback;
  if (!Array.isArray(v) || !v.length || v.some((s) => !(SCOPES as readonly string[]).includes(s))) {
    throw bad(`scopes must be a non-empty subset of: ${SCOPES.join(", ")}`);
  }
  return [...new Set(v)] as Scope[];
}

function intIn(v: unknown, name: string, min: number, max: number, fallback?: number) {
  if (v === undefined || v === null || v === "") {
    if (fallback === undefined) throw bad(`${name} is required`);
    return fallback;
  }
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw bad(`${name} must be an integer from ${min} to ${max}`);
  return n;
}

function modelsFrom(v: unknown): string[] | null {
  if (v === undefined || v === null) return null;
  if (!Array.isArray(v) || !v.length || v.some((m) => typeof m !== "string" || !config.models.includes(m))) {
    throw bad(`allowed_models must be a non-empty subset of: ${config.models.join(", ")}`);
  }
  return [...new Set(v as string[])];
}

// ---------- authentication ----------

/** Resolve `Authorization: Bearer hgo_...` to a live operator + token, or null. */
export async function authenticateOperator(header: string | undefined): Promise<OperatorAuth | null> {
  const token = header?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
  if (!token?.startsWith("hgo_")) return null;
  const now = Date.now();
  const r = await one(
    `SELECT t.id AS token_id, t.prefix, t.scopes, t.expires_at AS token_expires_at, t.last_used_at, o.*
     FROM operator_tokens t JOIN operators o ON o.id = t.operator_id
     WHERE t.token_hash = $1 AND t.revoked_at IS NULL AND o.status = 'active'`,
    [sha256(token)],
  );
  if (!r) return null;
  if (r.token_expires_at != null && Number(r.token_expires_at) <= now) return null;
  if (r.last_used_at == null || now - Number(r.last_used_at) > TOUCH_MS) {
    await run("UPDATE operator_tokens SET last_used_at = $2 WHERE id = $1", [r.token_id, now]);
  }
  return {
    operator: toOperator(r),
    token: {
      id: r.token_id, prefix: r.prefix, scopes: parseScopes(r.scopes),
      expires_at: r.token_expires_at == null ? null : Number(r.token_expires_at),
    },
  };
}

async function mintToken(operatorId: string, scopes: Scope[], ttlDays: number | null) {
  const token = newOperatorToken();
  const now = Date.now();
  await run(
    `INSERT INTO operator_tokens (id, operator_id, token_hash, prefix, scopes, created_at, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [newId(), operatorId, sha256(token), token.slice(0, 12), scopes.join(" "), now, ttlDays ? now + ttlDays * 86_400_000 : null],
  );
  return token;
}

// ---------- enrollment (device-style approval) ----------

export async function startEnrollment(nameRaw: unknown, scopesRaw: unknown, ip: string) {
  const name = str(nameRaw).slice(0, 80);
  if (!name) throw bad("name is required (what is this agent or tool called?)");
  const scopes = scopesFrom(scopesRaw, [...SCOPES]);
  const now = Date.now();
  const recent = await one<{ n: string }>("SELECT COUNT(*) AS n FROM enrollments WHERE ip = $1 AND created_at > $2", [ip, now - 3_600_000]);
  const pending = await one<{ n: string }>("SELECT COUNT(*) AS n FROM enrollments WHERE status = 'pending' AND expires_at > $1", [now]);
  if (Number(recent?.n) >= MAX_ENROLL_PER_IP_HOUR || Number(pending?.n) >= MAX_PENDING_ENROLLMENTS) {
    throw new ServiceError(429, "rate_limited", "too many enrollment requests, try again later");
  }
  let userCode = newCode();
  while (await one("SELECT 1 FROM enrollments WHERE user_code = $1", [userCode])) userCode = newCode();
  const deviceSecret = `hgd_${randomBytes(24).toString("base64url")}`;
  await run(
    `INSERT INTO enrollments (id, user_code, device_hash, name, scopes, status, ip, created_at, expires_at)
     VALUES ($1, $2, $3, $4, $5, 'pending', $6, $7, $8)`,
    [newId(), userCode, sha256(deviceSecret), name, scopes.join(" "), ip, now, now + ENROLL_TTL_MS],
  );
  const code = displayCode(userCode);
  return {
    user_code: code,
    device_secret: deviceSecret,
    verification_url: `${config.publicUrl}/connect?code=${code}`,
    expires_in: ENROLL_TTL_MS / 1000,
    interval: ENROLL_INTERVAL_S,
  };
}

const enrollmentJson = (r: any) => ({
  user_code: displayCode(r.user_code), name: r.name, scopes: parseScopes(r.scopes), status: r.status,
  created_at: Number(r.created_at), expires_at: Number(r.expires_at),
});

export async function pendingEnrollments() {
  const rows = await all("SELECT * FROM enrollments WHERE status = 'pending' AND expires_at > $1 ORDER BY created_at", [Date.now()]);
  return rows.map(enrollmentJson);
}

async function pendingByCode(raw: string) {
  const r = await one("SELECT * FROM enrollments WHERE user_code = $1", [normalizeCode(raw)]);
  if (!r) throw new ServiceError(404, "not_found", "no such enrollment code");
  if (r.status !== "pending" || Number(r.expires_at) <= Date.now()) {
    throw new ServiceError(409, "not_pending", "this enrollment was already handled or has expired");
  }
  return r;
}

/** A human approves: creates the operator account. The agent collects its token with the device secret. */
export async function approveEnrollment(userCode: string, b: Record<string, unknown>) {
  const e = await pendingByCode(userCode);
  const scopes = scopesFrom(b.scopes, parseScopes(e.scopes)).filter((s) => parseScopes(e.scopes).includes(s));
  if (!scopes.length) throw bad("granted scopes must be within the requested scopes");
  const limits = {
    max_active_jobs: intIn(b.max_active_jobs, "max_active_jobs", 1, 20, DEFAULTS.max_active_jobs),
    max_jobs_per_day: intIn(b.max_jobs_per_day, "max_jobs_per_day", 1, 200, DEFAULTS.max_jobs_per_day),
    max_ttl_hours: intIn(b.max_ttl_hours, "max_ttl_hours", 1, 720, DEFAULTS.max_ttl_hours),
  };
  const models = modelsFrom(b.allowed_models);
  const ttlDays = intIn(b.token_ttl_days, "token_ttl_days", 1, 365, DEFAULT_TOKEN_DAYS);
  const name = str(b.name).slice(0, 80) || e.name;

  const id = newId();
  await run(
    `INSERT INTO operators (id, name, status, max_active_jobs, max_jobs_per_day, max_ttl_hours, allowed_models, created_at)
     VALUES ($1, $2, 'active', $3, $4, $5, $6, $7)`,
    [id, name, limits.max_active_jobs, limits.max_jobs_per_day, limits.max_ttl_hours, models && JSON.stringify(models), Date.now()],
  );
  const claimed = await run(
    `UPDATE enrollments SET status = 'approved', operator_id = $2, scopes = $3, token_ttl_days = $4
     WHERE id = $1 AND status = 'pending' AND expires_at > $5`,
    [e.id, id, scopes.join(" "), ttlDays, Date.now()],
  );
  if (!claimed) {
    await run("DELETE FROM operators WHERE id = $1", [id]);
    throw new ServiceError(409, "not_pending", "this enrollment was already handled or has expired");
  }
  return { operator_id: id, name, scopes, ...limits, allowed_models: models, token_ttl_days: ttlDays };
}

export async function denyEnrollment(userCode: string) {
  const e = await pendingByCode(userCode);
  await run("UPDATE enrollments SET status = 'denied' WHERE id = $1 AND status = 'pending'", [e.id]);
}

/** The agent polls with its device secret. The token is released exactly once. */
export async function collectEnrollment(deviceSecret: unknown) {
  if (typeof deviceSecret !== "string" || !deviceSecret.startsWith("hgd_")) {
    throw new ServiceError(401, "invalid_device_secret", "device_secret is invalid");
  }
  const e = await one("SELECT * FROM enrollments WHERE device_hash = $1", [sha256(deviceSecret)]);
  if (!e) throw new ServiceError(401, "invalid_device_secret", "device_secret is invalid");
  if (e.status === "denied") throw new ServiceError(403, "denied", "a human denied this enrollment");
  if (e.status === "collected") throw new ServiceError(410, "already_collected", "the token for this enrollment was already collected");
  if (e.status === "pending") {
    if (Number(e.expires_at) <= Date.now()) throw new ServiceError(410, "expired", "this enrollment expired before it was approved");
    return { status: "pending" as const, interval: ENROLL_INTERVAL_S };
  }
  // approved: release the token once
  const claimed = await run("UPDATE enrollments SET status = 'collected' WHERE id = $1 AND status = 'approved'", [e.id]);
  if (!claimed) throw new ServiceError(410, "already_collected", "the token for this enrollment was already collected");
  const scopes = parseScopes(e.scopes);
  const token = await mintToken(e.operator_id, scopes, Number(e.token_ttl_days) || null);
  const operator = toOperator((await one("SELECT * FROM operators WHERE id = $1", [e.operator_id]))!);
  return { status: "approved" as const, token, scopes, operator: operatorJson(operator) };
}

// ---------- views & revocation ----------

export const operatorJson = (o: Operator) => ({
  id: o.id, name: o.name, status: o.status,
  limits: {
    max_active_jobs: o.max_active_jobs, max_jobs_per_day: o.max_jobs_per_day,
    max_ttl_hours: o.max_ttl_hours, allowed_models: o.allowed_models ?? config.models,
  },
  created_at: o.created_at, revoked_at: o.revoked_at,
});

export async function listOperators() {
  const ops = (await all("SELECT * FROM operators ORDER BY created_at DESC")).map(toOperator);
  const tokens = await all("SELECT * FROM operator_tokens ORDER BY created_at");
  return Promise.all(
    ops.map(async (o) => ({
      ...operatorJson(o),
      usage: await usageOf(o.id),
      tokens: tokens.filter((t) => t.operator_id === o.id).map((t) => ({
        id: t.id, prefix: t.prefix, scopes: parseScopes(t.scopes), created_at: Number(t.created_at),
        expires_at: t.expires_at == null ? null : Number(t.expires_at),
        last_used_at: t.last_used_at == null ? null : Number(t.last_used_at),
        revoked_at: t.revoked_at == null ? null : Number(t.revoked_at),
      })),
    })),
  );
}

async function operatorById(id: string) {
  const r = await one("SELECT * FROM operators WHERE id = $1", [id]);
  if (!r) throw new ServiceError(404, "not_found", "operator not found");
  return toOperator(r);
}

/** Disable an account: all tokens stop working at once; its unfinished jobs are stopped unless told otherwise. */
export async function revokeOperator(id: string, stopJobs = true) {
  await operatorById(id);
  const now = Date.now();
  await run("UPDATE operators SET status = 'revoked', revoked_at = COALESCE(revoked_at, $2) WHERE id = $1", [id, now]);
  await run("UPDATE operator_tokens SET revoked_at = $2 WHERE operator_id = $1 AND revoked_at IS NULL", [id, now]);
  if (stopJobs) {
    const live = (await all("SELECT * FROM invites WHERE operator_id = $1 AND status IN ('pending', 'active')", [id])).map(toInvite);
    for (const invite of live) await revokeInvite(invite);
  }
}

export async function revokeToken(operatorId: string, tokenId: string) {
  const n = await run(
    "UPDATE operator_tokens SET revoked_at = $3 WHERE id = $2 AND operator_id = $1 AND revoked_at IS NULL",
    [operatorId, tokenId, Date.now()],
  );
  if (!n) throw new ServiceError(404, "not_found", "token not found or already revoked");
}

export async function updateLimits(id: string, b: Record<string, unknown>) {
  const o = await operatorById(id);
  if (o.status !== "active") throw new ServiceError(409, "revoked", "operator is revoked");
  const next = {
    max_active_jobs: intIn(b.max_active_jobs, "max_active_jobs", 1, 20, o.max_active_jobs),
    max_jobs_per_day: intIn(b.max_jobs_per_day, "max_jobs_per_day", 1, 200, o.max_jobs_per_day),
    max_ttl_hours: intIn(b.max_ttl_hours, "max_ttl_hours", 1, 720, o.max_ttl_hours),
  };
  const models = "allowed_models" in b ? modelsFrom(b.allowed_models) : o.allowed_models;
  await run(
    "UPDATE operators SET max_active_jobs = $2, max_jobs_per_day = $3, max_ttl_hours = $4, allowed_models = $5 WHERE id = $1",
    [id, next.max_active_jobs, next.max_jobs_per_day, next.max_ttl_hours, models && JSON.stringify(models)],
  );
}

// ---------- admin routes (mounted under /api, so ADMIN_TOKEN auth applies) ----------

const body = async (c: { req: { json: () => Promise<unknown> } }) =>
  ((await c.req.json().catch(() => null)) ?? {}) as Record<string, unknown>;

export const operatorAdmin = new Hono();

operatorAdmin.get("/operators", async (c) => c.json({ operators: await listOperators() }));
operatorAdmin.get("/enrollments", async (c) => c.json({ enrollments: await pendingEnrollments() }));
operatorAdmin.post("/enrollments/:code/approve", async (c) =>
  c.json({ ok: true, operator: await approveEnrollment(c.req.param("code"), await body(c)) }),
);
operatorAdmin.post("/enrollments/:code/deny", async (c) => {
  await denyEnrollment(c.req.param("code"));
  return c.json({ ok: true });
});
operatorAdmin.post("/operators/:id/revoke", async (c) => {
  const b = await body(c);
  await revokeOperator(c.req.param("id"), b.stop_jobs !== false);
  return c.json({ ok: true });
});
operatorAdmin.post("/operators/:id/limits", async (c) => {
  await updateLimits(c.req.param("id"), await body(c));
  return c.json({ ok: true });
});
operatorAdmin.post("/operators/:id/tokens/:tokenId/revoke", async (c) => {
  await revokeToken(c.req.param("id"), c.req.param("tokenId"));
  return c.json({ ok: true });
});
