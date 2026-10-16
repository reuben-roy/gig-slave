import { config } from "./config.js";
import { addEvent, all, run, toSession } from "./db.js";
import { endSession, killSession } from "./lifecycle.js";
import { notifySession } from "./notify.js";

export const FAIL_WINDOW_MS = 10 * 60_000;
/** Pruning old rate-limit rows is housekeeping; once per 10 minutes per instance is plenty. */
const PRUNE_EVERY_MS = 10 * 60_000;
let lastPrune = 0;

/**
 * Expire overdue invites, fail sessions that stopped heartbeating, prune old rate-limit rows.
 * `prune: false` skips the rate-limit cleanup (the lazy sweeper passes it except once per PRUNE_EVERY_MS).
 */
export async function sweep(now = Date.now(), opts: { prune?: boolean } = {}) {
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

  if (opts.prune !== false) await run("DELETE FROM redeem_failures WHERE ts < $1", [now - FAIL_WINDOW_MS]);
}

let last = 0;
let running: Promise<void> | null = null;

/**
 * Throttled lazy sweep (default: at most once per 5s per instance). Never throws.
 * `everyMs` lets low-urgency callers (an idle dashboard stream) ask for a slower cadence; a sweep that
 * already ran recently for any other caller satisfies them. `clock` is injectable for tests.
 */
export function maybeSweep(everyMs = 5000, clock: () => number = Date.now): Promise<void> {
  const now = clock();
  if (running) return running;
  if (now - last < everyMs) return Promise.resolve();
  last = now;
  const prune = now - lastPrune >= PRUNE_EVERY_MS;
  if (prune) lastPrune = now;
  running = sweep(Date.now(), { prune })
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
