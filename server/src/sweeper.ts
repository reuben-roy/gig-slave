import { config } from "./config.js";
import { all, run, type InviteRow, type SessionRow } from "./db.js";
import { addEvent, endSession, isTerminal, killSession, publishInvite } from "./lifecycle.js";

export function sweep(now = Date.now()) {
  const overdue = all<InviteRow>(
    "SELECT * FROM invites WHERE expires_at IS NOT NULL AND expires_at < ? AND status IN ('pending', 'active')",
    now,
  );
  for (const invite of overdue) {
    run("UPDATE invites SET status = 'expired' WHERE id = ?", invite.id);
    for (const s of all<SessionRow>("SELECT * FROM sessions WHERE invite_id = ?", invite.id)) {
      if (!isTerminal(s.status)) killSession(s.id, "Invite expired");
    }
    publishInvite(invite.id);
  }

  const lost = all<SessionRow>(
    "SELECT * FROM sessions WHERE status NOT IN ('done', 'failed', 'killed') AND last_heartbeat < ?",
    now - config.lostAfterMs,
  );
  for (const s of lost) {
    if (endSession(s.id, "failed", "Lost connection", { log: false })) {
      addEvent(s.id, "error", { message: "Lost connection: no heartbeat from the recipient's computer" });
    }
  }
}

export function startSweeper() {
  const timer = setInterval(() => {
    try {
      sweep();
    } catch (e) {
      console.error("sweeper error:", e);
    }
  }, 10_000);
  timer.unref();
  return timer;
}
