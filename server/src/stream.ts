import { eventJson, inviteJson, one, all, sessionJson, toEvent, toInvite, toSession } from "./db.js";
import { maybeSweep } from "./sweeper.js";

/**
 * Change feed behind GET /api/stream.
 *
 * Why polling: a Vercel function cannot share in-memory pub/sub across instances, and Postgres LISTEN/NOTIFY
 * needs a long-lived direct connection (not available through Neon's pooled endpoint, and holding one open
 * would keep the database compute awake anyway). So the feed polls, but cheaply:
 *
 *  - ONE statement per tick (`poll`): new events, recently-updated sessions and invites, and whether any
 *    session is live, in a single round trip. It used to be three statements per tick at a fixed 700 ms.
 *  - The delay between ticks follows activity: fast while a job is live or something changed recently, slower
 *    when quiet, slowest after minutes of nothing. The quiet clock survives reconnects (it starts from the
 *    newest `updated_at` in the database, not from the moment the stream opened).
 *  - The dashboard closes the stream altogether when its tab is hidden or unattended
 *    (public/assets/stream-policy.js), so an idle operator costs nothing.
 *  - Cursors come from the database. Row queries look `overlapMs` behind the cursor and dedupe, so rows that
 *    commit slightly out of order (two instances writing `updated_at` a few ms apart) are still delivered.
 *  - The lazy sweeper runs at its normal cadence only while a session is live (lost-connection detection),
 *    otherwise once a minute (it only expires invites then).
 */

export interface Tuning {
  /** Poll delay while a session is live or something changed within `hotWindowMs`. */
  hotMs: number;
  /** Poll delay once quiet for `hotWindowMs`. */
  coolMs: number;
  /** Poll delay once quiet for `idleAfterMs`. */
  idleMs: number;
  hotWindowMs: number;
  idleAfterMs: number;
  /** Lazy sweep cadence while a session is live (lost-connection detection) / otherwise (invite expiry display). */
  sweepLiveMs: number;
  sweepIdleMs: number;
  pingMs: number;
  /** Row queries look this far behind the cursor to catch out-of-order commits. */
  overlapMs: number;
}

export const DEFAULT_TUNING: Tuning = {
  hotMs: 700, // same responsiveness as before for a live job (the CLI flushes events once per second)
  coolMs: 3000,
  idleMs: 8000,
  hotWindowMs: 30_000,
  idleAfterMs: 5 * 60_000,
  sweepLiveMs: 5000,
  sweepIdleMs: 60_000,
  pingMs: 15_000,
  overlapMs: 2000,
};

export interface FeedIo {
  /** Write one SSE message. */
  write(event: string, id: number | string, payload: unknown): Promise<unknown>;
  /** Write a keep-alive comment. */
  ping(): Promise<unknown>;
  sleep(ms: number): Promise<unknown>;
  isOpen(): boolean;
  /** Absolute time (per `now`) after which the feed ends and the client reconnects. */
  deadline: number;
  now?: () => number;
  tuning?: Partial<Tuning>;
}

/**
 * Where the database is "now": used once per stream to fix the cursors. Also returns the (id, updated_at) of rows
 * inside the overlap window, so the first polls do not replay what the client's refetch already shows.
 */
async function startState(overlapMs: number) {
  const r = await one(
    `WITH s AS (SELECT COALESCE(MAX(updated_at), 0) AS m FROM sessions),
          i AS (SELECT COALESCE(MAX(updated_at), 0) AS m FROM invites)
     SELECT
       (SELECT COALESCE(MAX(id), 0) FROM events) AS ev,
       (SELECT m FROM s) AS ses,
       (SELECT m FROM i) AS inv,
       EXISTS (SELECT 1 FROM sessions WHERE status NOT IN ('done', 'failed', 'killed')) AS live,
       (SELECT COALESCE(json_agg(json_build_array(id, updated_at)), '[]'::json)
          FROM sessions WHERE updated_at > (SELECT m FROM s) - $1) AS ses_seen,
       (SELECT COALESCE(json_agg(json_build_array(id, updated_at)), '[]'::json)
          FROM invites WHERE updated_at > (SELECT m FROM i) - $1) AS inv_seen`,
    [overlapMs],
  );
  const pairs = (v: unknown): [string, number][] => (typeof v === "string" ? JSON.parse(v) : (v as [string, number][]));
  return {
    ev: Number(r.ev),
    ses: Number(r.ses),
    inv: Number(r.inv),
    live: r.live === true || r.live === "t",
    sesSeen: pairs(r.ses_seen),
    invSeen: pairs(r.inv_seen),
  };
}

/** The per-tick statement. Index-bound on every table, so an unchanged database returns only the `live` row. */
async function poll(eventCursor: number, since: { sessions: number; invites: number }) {
  const rows = await all<{ k: string; j: any }>(
    `SELECT 'event' AS k, to_jsonb(e) AS j FROM (SELECT * FROM events WHERE id > $1 ORDER BY id LIMIT 500) e
     UNION ALL
     SELECT 'session', to_jsonb(s) FROM (SELECT * FROM sessions WHERE updated_at > $2 ORDER BY updated_at LIMIT 200) s
     UNION ALL
     SELECT 'invite', to_jsonb(i) FROM (SELECT * FROM invites WHERE updated_at > $3 ORDER BY updated_at LIMIT 200) i
     UNION ALL
     SELECT 'live', to_jsonb(EXISTS (SELECT 1 FROM sessions WHERE status NOT IN ('done', 'failed', 'killed')))`,
    [eventCursor, since.sessions, since.invites],
  );
  const parse = (j: unknown) => (typeof j === "string" ? JSON.parse(j) : j);
  const out = {
    events: [] as ReturnType<typeof toEvent>[],
    sessions: [] as ReturnType<typeof toSession>[],
    invites: [] as ReturnType<typeof toInvite>[],
    live: false,
  };
  for (const r of rows) {
    const j = parse(r.j);
    if (r.k === "event") out.events.push(toEvent(j));
    else if (r.k === "session") out.sessions.push(toSession(j));
    else if (r.k === "invite") out.invites.push(toInvite(j));
    else out.live = j === true;
  }
  out.events.sort((a, b) => a.id - b.id);
  out.sessions.sort((a, b) => a.updated_at - b.updated_at);
  out.invites.sort((a, b) => a.updated_at - b.updated_at);
  return out;
}

/** Poll delay for the current state. */
export function pollDelay(t: Tuning, live: boolean, quietForMs: number): number {
  if (live || quietForMs < t.hotWindowMs) return t.hotMs;
  return quietForMs < t.idleAfterMs ? t.coolMs : t.idleMs;
}

export async function runFeed(io: FeedIo): Promise<void> {
  const t: Tuning = { ...DEFAULT_TUNING, ...io.tuning };
  const now = io.now ?? Date.now;

  // Start from "now": clients re-fetch current state when they see `ready`. It is sent only after the cursors
  // are fixed, so nothing that changes after the client's refetch can fall between the refetch and the stream.
  const start = await startState(t.overlapMs);
  let eventCursor = start.ev;
  let sessionCursor = start.ses;
  let inviteCursor = start.inv;
  let live = start.live;
  const seenSessions = new Map<string, number>(start.sesSeen.map(([id, ts]) => [id, Number(ts)]));
  const seenInvites = new Map<string, number>(start.invSeen.map(([id, ts]) => [id, Number(ts)]));
  await io.write("ready", eventCursor, { cursor: eventCursor, live });

  // Quiet clock: time of the newest change already in the database, so reconnecting does not look like activity.
  let lastChange = Math.min(now(), Math.max(start.ses, start.inv));
  let lastWrite = now();
  let failures = 0;
  let firstTick = true;

  while (io.isOpen() && now() < io.deadline) {
    try {
      // Sweep first so a state change it causes (lost connection, expiry) shows up in this tick's poll.
      await maybeSweep(live ? t.sweepLiveMs : t.sweepIdleMs, now);

      const r = await poll(eventCursor, {
        sessions: sessionCursor - t.overlapMs,
        invites: inviteCursor - t.overlapMs,
      });
      live = r.live;
      let sent = false;

      for (const e of r.events) {
        eventCursor = e.id;
        await io.write("event", e.id, eventJson(e));
        sent = true;
      }
      for (const s of r.sessions) {
        sessionCursor = Math.max(sessionCursor, s.updated_at);
        if (seenSessions.get(s.id) === s.updated_at) continue;
        seenSessions.set(s.id, s.updated_at);
        await io.write("session", s.updated_at, sessionJson(s));
        sent = true;
      }
      for (const i of r.invites) {
        inviteCursor = Math.max(inviteCursor, i.updated_at);
        if (seenInvites.get(i.id) === i.updated_at) continue;
        seenInvites.set(i.id, i.updated_at);
        await io.write("invite", i.updated_at, inviteJson(i));
        sent = true;
      }
      for (const [m, cur] of [[seenSessions, sessionCursor], [seenInvites, inviteCursor]] as const) {
        for (const [k, ts] of m) if (ts < cur - 3 * t.overlapMs) m.delete(k);
      }
      if (sent) {
        lastChange = now();
        lastWrite = lastChange;
      }
      failures = 0;
    } catch (e) {
      if (!io.isOpen()) break;
      console.error("stream poll error:", (e as Error).message);
      if (++failures >= 5) break;
    }

    if (now() - lastWrite >= t.pingMs) {
      await io.ping();
      lastWrite = now();
    }
    // The first tick after `ready` is always quick: whatever the operator did right after connecting shows up
    // at once and, if it is activity, switches the cadence to hot. It costs one extra statement per connection.
    await io.sleep(firstTick ? t.hotMs : pollDelay(t, live, now() - lastChange));
    firstTick = false;
  }
}
