import { sha256 } from "./codes.js";
import {
  addEvent, all, getInvite, one, run, toSession,
  type InviteRow, type Result, type SessionRow,
} from "./db.js";

const TERMINAL = ["done", "failed", "killed"];
export const isTerminal = (status: string) => TERMINAL.includes(status);

export { addEvent };

export function isAlive(s: SessionRow, i: InviteRow, now = Date.now()) {
  return (
    !isTerminal(s.status) &&
    i.status !== "expired" && i.status !== "revoked" &&
    (i.expires_at === null || i.expires_at > now)
  );
}

export async function sessionFromAuth(header: string | undefined) {
  const token = header?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
  if (!token) return null;
  const s = await one("SELECT * FROM sessions WHERE token_hash = $1", [sha256(token)]);
  if (!s) return null;
  const session = toSession(s);
  const invite = await getInvite(session.invite_id);
  return invite ? { session, invite } : null;
}

/** Move an invite to completed (only from pending/active). */
export async function completeInvite(inviteId: string) {
  await run(
    "UPDATE invites SET status = 'completed', updated_at = $2 WHERE id = $1 AND status IN ('pending', 'active')",
    [inviteId, Date.now()],
  );
}

/** Put a live session into a terminal state. Returns false if it was already terminal. */
export async function endSession(
  id: string,
  status: "done" | "failed" | "killed",
  text: string,
  opts: { log?: boolean; report?: string | null; result?: Result | null } = {},
) {
  const now = Date.now();
  const rows = await all<{ invite_id: string }>(
    `UPDATE sessions SET status = $1, status_text = $2, ended_at = $3, updated_at = $3,
       kill_requested = kill_requested OR $4::boolean,
       report = COALESCE($5::text, report), result = COALESCE($6::text, result)
     WHERE id = $7 AND status NOT IN ('done', 'failed', 'killed') RETURNING invite_id`,
    [
      status, text, now, status === "killed", opts.report ?? null,
      opts.result ? JSON.stringify(opts.result) : null, id,
    ],
  );
  if (!rows.length) return false;
  if (opts.log !== false) await addEvent(id, "status", { status, text });
  const invite = await getInvite(rows[0].invite_id);
  if (invite?.expiry_policy === "one_use") await completeInvite(invite.id);
  return true;
}

export const killSession = (id: string, text = "Stopped by operator") =>
  endSession(id, "killed", text);

export async function liveSessionsOf(inviteId: string) {
  const rows = await all(
    "SELECT * FROM sessions WHERE invite_id = $1 AND status NOT IN ('done', 'failed', 'killed')",
    [inviteId],
  );
  return rows.map(toSession);
}
