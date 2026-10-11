import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { config } from "./config.js";

mkdirSync(dirname(config.dbPath), { recursive: true });
export const db = new DatabaseSync(config.dbPath);
db.exec("PRAGMA journal_mode = WAL");

db.exec(`
CREATE TABLE IF NOT EXISTS invites (
  id TEXT PRIMARY KEY, code_hash TEXT NOT NULL UNIQUE, label TEXT NOT NULL, email TEXT,
  task TEXT NOT NULL, working_dir TEXT NOT NULL, model TEXT NOT NULL,
  expiry_policy TEXT NOT NULL, expires_at INTEGER, max_redemptions INTEGER,
  redemptions INTEGER NOT NULL DEFAULT 0, failed_attempts INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY, invite_id TEXT NOT NULL REFERENCES invites(id), token_hash TEXT NOT NULL UNIQUE,
  machine TEXT, status TEXT NOT NULL, status_text TEXT, report TEXT,
  last_heartbeat INTEGER NOT NULL, started_at INTEGER NOT NULL, ended_at INTEGER,
  tokens_in INTEGER NOT NULL DEFAULT 0, tokens_out INTEGER NOT NULL DEFAULT 0,
  actions INTEGER NOT NULL DEFAULT 0, kill_requested INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, ts INTEGER NOT NULL,
  type TEXT NOT NULL, data TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS events_session ON events(session_id, id);
CREATE TABLE IF NOT EXISTS instructions (
  id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, text TEXT NOT NULL,
  delivered INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_invite ON sessions(invite_id);
`);

export interface InviteRow {
  id: string; code_hash: string; label: string; email: string | null; task: string;
  working_dir: string; model: string; expiry_policy: "one_use" | "on_complete" | "ttl";
  expires_at: number | null; max_redemptions: number | null; redemptions: number;
  failed_attempts: number; status: "pending" | "active" | "completed" | "expired" | "revoked";
  created_at: number;
}

export interface SessionRow {
  id: string; invite_id: string; token_hash: string; machine: string | null;
  status: "connecting" | "working" | "idle" | "done" | "failed" | "killed";
  status_text: string | null; report: string | null; last_heartbeat: number;
  started_at: number; ended_at: number | null; tokens_in: number; tokens_out: number;
  actions: number; kill_requested: number;
}

export interface EventRow { id: number; session_id: string; ts: number; type: string; data: string }

export const one = <T>(sql: string, ...p: SQLInputValue[]) =>
  db.prepare(sql).get(...p) as unknown as T | undefined;
export const all = <T>(sql: string, ...p: SQLInputValue[]) =>
  db.prepare(sql).all(...p) as unknown as T[];
export const run = (sql: string, ...p: SQLInputValue[]) => db.prepare(sql).run(...p);

export const getInvite = (id: string) => one<InviteRow>("SELECT * FROM invites WHERE id = ?", id);
export const getSession = (id: string) => one<SessionRow>("SELECT * FROM sessions WHERE id = ?", id);

export const inviteJson = (r: InviteRow) => ({
  id: r.id, label: r.label, task: r.task, working_dir: r.working_dir, model: r.model,
  expiry_policy: r.expiry_policy, expires_at: r.expires_at, max_redemptions: r.max_redemptions,
  redemptions: r.redemptions, failed_attempts: r.failed_attempts, status: r.status,
  created_at: r.created_at,
});

export const sessionJson = (r: SessionRow) => ({
  id: r.id, invite_id: r.invite_id, machine: r.machine ? JSON.parse(r.machine) : null,
  status: r.status, status_text: r.status_text, report: r.report,
  last_heartbeat: r.last_heartbeat, started_at: r.started_at, ended_at: r.ended_at,
  tokens_in: r.tokens_in, tokens_out: r.tokens_out, actions: r.actions,
});

export const eventJson = (r: EventRow) => ({
  id: r.id, session_id: r.session_id, ts: r.ts, type: r.type, data: JSON.parse(r.data),
});
