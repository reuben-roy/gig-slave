import { bus } from "./bus.js";
import { sha256 } from "./codes.js";
import {
  eventJson, getInvite, getSession, inviteJson, one, run, sessionJson,
  type EventRow, type InviteRow, type SessionRow,
} from "./db.js";

const TERMINAL = ["done", "failed", "killed"];
export const isTerminal = (status: string) => TERMINAL.includes(status);

export function publishSession(id: string) {
  const s = getSession(id);
  if (s) bus.emit("session", sessionJson(s));
}

export function publishInvite(id: string) {
  const i = getInvite(id);
  if (i) bus.emit("invite", inviteJson(i));
}

export function addEvent(sessionId: string, type: string, data: unknown, ts = Date.now()) {
  const r = run(
    "INSERT INTO events (session_id, ts, type, data) VALUES (?, ?, ?, ?)",
    sessionId, ts, type, JSON.stringify(data),
  );
  const row: EventRow = {
    id: Number(r.lastInsertRowid), session_id: sessionId, ts, type, data: JSON.stringify(data),
  };
  bus.emit("event", eventJson(row));
}

export function isAlive(s: SessionRow, i: InviteRow, now = Date.now()) {
  return (
    !isTerminal(s.status) &&
    i.status !== "expired" && i.status !== "revoked" &&
    (i.expires_at === null || i.expires_at > now)
  );
}

export function sessionFromAuth(header: string | undefined) {
  const token = header?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
  if (!token) return null;
  const session = one<SessionRow>("SELECT * FROM sessions WHERE token_hash = ?", sha256(token));
  const invite = session && getInvite(session.invite_id);
  return session && invite ? { session, invite } : null;
}

/** Move an invite to completed (only from pending/active). */
export function completeInvite(inviteId: string) {
  const r = run(
    "UPDATE invites SET status = 'completed' WHERE id = ? AND status IN ('pending', 'active')",
    inviteId,
  );
  if (r.changes) publishInvite(inviteId);
}

/** Put a live session into a terminal state. Returns false if it was already terminal. */
export function endSession(
  id: string,
  status: "done" | "failed" | "killed",
  text: string,
  opts: { log?: boolean } = {},
) {
  const r = run(
    `UPDATE sessions SET status = ?, status_text = ?, ended_at = ?, kill_requested = kill_requested OR ?
     WHERE id = ? AND status NOT IN ('done', 'failed', 'killed')`,
    status, text, Date.now(), status === "killed" ? 1 : 0, id,
  );
  if (!r.changes) return false;
  const s = getSession(id)!;
  if (opts.log !== false) addEvent(id, "status", { status, text });
  const invite = getInvite(s.invite_id);
  if (invite?.expiry_policy === "one_use") completeInvite(invite.id);
  publishSession(id);
  return true;
}

export const killSession = (id: string, text = "Stopped by operator") =>
  endSession(id, "killed", text);
