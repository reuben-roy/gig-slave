import { config } from "./config.js";
import { addEvent, all, run, toSession } from "./db.js";
import { endSession, killSession } from "./lifecycle.js";
import { notifySession } from "./notify.js";

export const FAIL_WINDOW_MS = 10 * 60_000;

/** Expire overdue invites, fail sessions that stopped heartbeating, prune old rate-limit rows. */
export async function sweep(now = Date.now()) {
  const expired = await all<{ id: string }>(
    `UPDATE invites SET status = 'expired', updated_at = $1
     WHERE expires_at IS NOT NULL AND expires_at < $1 AND status IN ('pending', 'active') RETURNING id`,
    [now],
  );
  for (const invite of expired) {
    const live = await all(
      "SELECT id FROM sessions WHERE invite_id = $1 AND status NOT IN ('done', 'failed', 'killed')",
      [invite.id],
    );
    for (const s of live) await killSession(s.id, "Invite expired");
  }

  const lost = (
    await all(
      "SELECT * FROM sessions WHERE status NOT IN ('done', 'failed', 'killed') AND last_heartbeat < $1",
      [now - config.lostAfterMs],
    )
  ).map(toSession);
  for (const s of lost) {
    if (await endSession(s.id, "failed", "Lost connection", { log: false })) {
      await addEvent(s.id, "error", { message: "Lost connection: no heartbeat from the recipient's computer" });
      await notifySession(s.id);
    }
  }

  await run("DELETE FROM redeem_failures WHERE ts < $1", [now - FAIL_WINDOW_MS]);
}

let last = 0;
let running: Promise<void> | null = null;

/** Throttled lazy sweep (at most once per 5s per instance). Never throws. */
export function maybeSweep(): Promise<void> {
  const now = Date.now();
  if (running) return running;
  if (now - last < 5000) return Promise.resolve();
  last = now;
  running = sweep(now)
    .catch((e) => console.error("sweep error:", (e as Error).message))
    .finally(() => {
      running = null;
    });
  return running;
}

/** Local Node only: periodic sweep. */
export function startSweeper(intervalMs = 10_000) {
  const timer = setInterval(() => {
    sweep().catch((e) => console.error("sweeper error:", (e as Error).message));
  }, intervalMs);
  timer.unref();
  return timer;
}
