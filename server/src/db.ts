import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { config } from "./config.js";

/**
 * One async Postgres layer for both runtimes:
 *  - DATABASE_URL set  -> Neon (@neondatabase/serverless Pool)
 *  - otherwise         -> embedded PGlite at PGLITE_DIR ("memory://" for in-memory)
 * All SQL uses $1 placeholders. Every helper awaits ensureSchema() first.
 */
interface Driver {
  query(sql: string, params: unknown[]): Promise<{ rows: any[]; rowCount: number }>;
  exec(sql: string): Promise<void>;
  close(): Promise<void>;
}

async function createDriver(): Promise<Driver> {
  if (config.databaseUrl) {
    const { Pool } = await import("@neondatabase/serverless");
    const pool = new Pool({ connectionString: config.databaseUrl, max: 5 });
    pool.on("error", (e: Error) => console.error("pg pool error:", e.message));
    return {
      async query(sql, params) {
        const r = await pool.query(sql, params as any[]);
        return { rows: r.rows, rowCount: r.rowCount ?? 0 };
      },
      async exec(sql) {
        await pool.query(sql);
      },
      close: () => pool.end(),
    };
  }
  const { PGlite } = await import("@electric-sql/pglite");
  const dir = config.pgliteDir;
  if (!dir.startsWith("memory:") && !dir.startsWith("idb:")) mkdirSync(dirname(dir), { recursive: true });
  const pg = new PGlite(dir);
  await pg.waitReady;
  return {
    async query(sql, params) {
      const r = await pg.query(sql, params as any[]);
      return { rows: r.rows as any[], rowCount: r.affectedRows ?? r.rows.length };
    },
    async exec(sql) {
      await pg.exec(sql);
    },
    close: () => pg.close(),
  };
}

const SCHEMA = `
SELECT pg_advisory_xact_lock(814253901);
CREATE TABLE IF NOT EXISTS invites (
  id TEXT PRIMARY KEY, seq BIGSERIAL, code_hash TEXT NOT NULL UNIQUE, label TEXT NOT NULL,
  task TEXT NOT NULL, working_dir TEXT NOT NULL, model TEXT NOT NULL,
  expiry_policy TEXT NOT NULL, expires_at BIGINT, max_redemptions INTEGER,
  redemptions INTEGER NOT NULL DEFAULT 0, failed_attempts INTEGER NOT NULL DEFAULT 0, -- always 0: codes are random, so failed attempts are rate-limited per IP (redeem_failures), never per invite
  notify_email TEXT, notify_webhook TEXT,
  status TEXT NOT NULL, created_at BIGINT NOT NULL, updated_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS invites_updated ON invites(updated_at);
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY, seq BIGSERIAL, invite_id TEXT NOT NULL REFERENCES invites(id),
  token_hash TEXT NOT NULL UNIQUE,
  machine TEXT, status TEXT NOT NULL, status_text TEXT, report TEXT, result TEXT,
  last_heartbeat BIGINT NOT NULL, started_at BIGINT NOT NULL, ended_at BIGINT,
  tokens_in BIGINT NOT NULL DEFAULT 0, tokens_out BIGINT NOT NULL DEFAULT 0,
  actions INTEGER NOT NULL DEFAULT 0, kill_requested BOOLEAN NOT NULL DEFAULT FALSE,
  notified BOOLEAN NOT NULL DEFAULT FALSE, updated_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_invite ON sessions(invite_id);
CREATE INDEX IF NOT EXISTS sessions_updated ON sessions(updated_at);
CREATE TABLE IF NOT EXISTS events (
  id BIGSERIAL PRIMARY KEY, session_id TEXT NOT NULL, ts BIGINT NOT NULL,
  type TEXT NOT NULL, data TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS events_session ON events(session_id, id);
CREATE TABLE IF NOT EXISTS instructions (
  id BIGSERIAL PRIMARY KEY, session_id TEXT NOT NULL, text TEXT NOT NULL,
  delivered BOOLEAN NOT NULL DEFAULT FALSE, created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS instructions_session ON instructions(session_id, delivered);
CREATE TABLE IF NOT EXISTS redeem_failures (ip TEXT NOT NULL, ts BIGINT NOT NULL);
CREATE INDEX IF NOT EXISTS redeem_failures_ip ON redeem_failures(ip, ts);
-- Operator API (docs/operator-api-contract.md). Additive; unused unless OPERATOR_API_ENABLED / token routes are used.
CREATE TABLE IF NOT EXISTS operator_tokens (
  id TEXT PRIMARY KEY, secret_hash TEXT NOT NULL, label TEXT NOT NULL, scopes TEXT NOT NULL,
  limits TEXT NOT NULL DEFAULT '{}', created_at BIGINT NOT NULL, created_by TEXT NOT NULL,
  expires_at BIGINT, last_used_at BIGINT, revoked_at BIGINT
);
CREATE TABLE IF NOT EXISTS operator_audit (
  id BIGSERIAL PRIMARY KEY, ts BIGINT NOT NULL, actor TEXT NOT NULL, token_id TEXT, action TEXT NOT NULL,
  target_type TEXT, target_id TEXT, status INTEGER NOT NULL, ok BOOLEAN NOT NULL,
  ip TEXT, client TEXT, detail TEXT
);
CREATE INDEX IF NOT EXISTS operator_audit_token ON operator_audit(token_id, action, ts);
CREATE INDEX IF NOT EXISTS operator_audit_ts ON operator_audit(ts);
CREATE TABLE IF NOT EXISTS idempotency_keys (
  actor_key TEXT NOT NULL, idem_key TEXT NOT NULL, body_hash TEXT NOT NULL,
  invite_id TEXT, created_at BIGINT NOT NULL, PRIMARY KEY (actor_key, idem_key)
);
`;

let driverPromise: Promise<Driver> | null = null;
let schemaPromise: Promise<void> | null = null;

const driver = () => (driverPromise ??= createDriver());

/** Idempotent, memoized; every query helper awaits it. A failed attempt is retried on the next call. */
export function ensureSchema(): Promise<void> {
  schemaPromise ??= (async () => {
    const d = await driver();
    await d.exec(SCHEMA);
  })().catch(async (e) => {
    // Close the failed driver (pool / PGlite) before the next call creates a fresh one.
    const failed = driverPromise;
    schemaPromise = null;
    driverPromise = null;
    await (await failed?.catch(() => null))?.close().catch(() => {});
    throw e;
  });
  return schemaPromise;
}

/** Statement counter (excludes the one-time schema bootstrap). Used by tests and the usage measurement script. */
export const dbStats = { queries: 0 };

export async function query(sql: string, params: unknown[] = []) {
  await ensureSchema();
  dbStats.queries++;
  return (await driver()).query(sql, params);
}
export async function all<T = any>(sql: string, params: unknown[] = []): Promise<T[]> {
  return (await query(sql, params)).rows as T[];
}
export async function one<T = any>(sql: string, params: unknown[] = []): Promise<T | undefined> {
  return (await query(sql, params)).rows[0] as T | undefined;
}
/** Returns the number of affected rows. */
export async function run(sql: string, params: unknown[] = []): Promise<number> {
  return (await query(sql, params)).rowCount;
}
export async function closeDb() {
  if (!driverPromise) return;
  const d = await driverPromise.catch(() => null);
  driverPromise = null;
  schemaPromise = null;
  await d?.close().catch(() => {});
}

// ---------- rows (int8 comes back as string from Postgres drivers; convert to JS numbers) ----------

const num = (v: unknown): number => Number(v);
const numOrNull = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

export interface InviteRow {
  id: string; code_hash: string; label: string; task: string; working_dir: string; model: string;
  expiry_policy: "one_use" | "on_complete" | "ttl"; expires_at: number | null;
  max_redemptions: number | null; redemptions: number;
  /** Always 0. Kept for API shape; failed redeems are counted per client IP in redeem_failures, not per invite. */
  failed_attempts: number;
  notify_email: string | null; notify_webhook: string | null;
  status: "pending" | "active" | "completed" | "expired" | "revoked";
  created_at: number; updated_at: number;
}

export interface SessionRow {
  id: string; invite_id: string; token_hash: string; machine: string | null;
  status: "connecting" | "working" | "idle" | "done" | "failed" | "killed";
  status_text: string | null; report: string | null; result: string | null;
  last_heartbeat: number; started_at: number; ended_at: number | null;
  tokens_in: number; tokens_out: number; actions: number;
  kill_requested: boolean; notified: boolean; updated_at: number;
}

export interface EventRow { id: number; session_id: string; ts: number; type: string; data: string }

export interface Result {
  success: boolean;
  summary: string;
  answer: string | null;
  findings: { label: string; value: string }[];
  changes: string[];
}

export const toInvite = (r: any): InviteRow => ({
  ...r,
  expires_at: numOrNull(r.expires_at),
  max_redemptions: numOrNull(r.max_redemptions),
  redemptions: num(r.redemptions),
  failed_attempts: num(r.failed_attempts),
  created_at: num(r.created_at),
  updated_at: num(r.updated_at),
});

export const toSession = (r: any): SessionRow => ({
  ...r,
  last_heartbeat: num(r.last_heartbeat),
  started_at: num(r.started_at),
  ended_at: numOrNull(r.ended_at),
  tokens_in: num(r.tokens_in),
  tokens_out: num(r.tokens_out),
  actions: num(r.actions),
  kill_requested: r.kill_requested === true || r.kill_requested === "t",
  notified: r.notified === true || r.notified === "t",
  updated_at: num(r.updated_at),
});

export const toEvent = (r: any): EventRow => ({
  id: num(r.id), session_id: r.session_id, ts: num(r.ts), type: r.type, data: r.data,
});

export const getInvite = async (id: string) => {
  const r = await one("SELECT * FROM invites WHERE id = $1", [id]);
  return r ? toInvite(r) : undefined;
};
export const getSession = async (id: string) => {
  const r = await one("SELECT * FROM sessions WHERE id = $1", [id]);
  return r ? toSession(r) : undefined;
};

export const parseResult = (raw: string | null): Result | null => {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as Result;
  } catch {
    return null;
  }
};

export const inviteJson = (r: InviteRow) => ({
  id: r.id, label: r.label, task: r.task, working_dir: r.working_dir, model: r.model,
  expiry_policy: r.expiry_policy, expires_at: r.expires_at, max_redemptions: r.max_redemptions,
  redemptions: r.redemptions, failed_attempts: r.failed_attempts,
  notify_email: r.notify_email, notify_webhook: r.notify_webhook,
  status: r.status, created_at: r.created_at,
});

export const sessionJson = (r: SessionRow) => ({
  id: r.id, invite_id: r.invite_id, machine: r.machine ? JSON.parse(r.machine) : null,
  status: r.status, status_text: r.status_text, report: r.report, result: parseResult(r.result),
  last_heartbeat: r.last_heartbeat, started_at: r.started_at, ended_at: r.ended_at,
  tokens_in: r.tokens_in, tokens_out: r.tokens_out, actions: r.actions,
});

export const eventJson = (r: EventRow) => ({
  id: r.id, session_id: r.session_id, ts: r.ts, type: r.type, data: JSON.parse(r.data),
});

/** Append events (one multi-row INSERT). ts defaults to now. */
export async function addEvents(
  sessionId: string,
  items: { type: string; data: unknown; ts?: number }[],
) {
  if (!items.length) return;
  const now = Date.now();
  const params: unknown[] = [];
  const values = items.map((e, i) => {
    params.push(sessionId, e.ts ?? now, e.type, JSON.stringify(e.data));
    return `($${i * 4 + 1}, $${i * 4 + 2}, $${i * 4 + 3}, $${i * 4 + 4})`;
  });
  await run(`INSERT INTO events (session_id, ts, type, data) VALUES ${values.join(", ")}`, params);
}

export const addEvent = (sessionId: string, type: string, data: unknown, ts?: number) =>
  addEvents(sessionId, [{ type, data, ts }]);
