// The change feed behind /api/stream, driven directly with a virtual clock and a fake sleep, so an hour of idle
// polling runs in milliseconds and every database statement is counted exactly.
// The sweeper throttle shares the virtual clock, so this file must not share a process with real-clock tests
// (node --test runs each file in its own process).
import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { loadServer } from "./helpers.mjs";

const s = await loadServer();
const { runFeed, DEFAULT_TUNING, pollDelay } = s.feed;
const HOUR = 3_600_000;

let vt = Date.now(); // one continuous virtual timeline across tests

/** Run the feed on the virtual clock. `script(tick)` may change the database between ticks. */
async function drive({ ticks, script, tuning }) {
  const log = { msgs: [], sleeps: [], stmtsPerTick: [], startedAt: vt };
  let n = 0;
  let q = s.queries();
  await runFeed({
    write: async (event, id, payload) => { log.msgs.push({ event, id, payload }); },
    ping: async () => { log.msgs.push({ event: "ping" }); },
    sleep: async (ms) => {
      log.sleeps.push(ms);
      log.stmtsPerTick.push(s.queries() - q);
      vt += ms;
      n++;
      if (script) await script(n);
      q = s.queries();
    },
    isOpen: () => n < ticks,
    deadline: Infinity,
    now: () => vt,
    tuning,
  });
  log.endedAt = vt;
  return log;
}

const sessionRow = (id, inviteId, over = {}) =>
  s.db.run(
    `INSERT INTO sessions (id, invite_id, token_hash, status, last_heartbeat, started_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $5, $6)`,
    [id, inviteId, "h-" + id, over.status ?? "working", over.last_heartbeat ?? Date.now(), over.updated_at ?? Date.now()],
  );

beforeEach(async () => {
  for (const t of ["events", "instructions", "sessions", "invites", "redeem_failures"]) await s.db.run(`DELETE FROM ${t}`);
});

test("pollDelay: fast when live or recently active, slower when quiet, slowest when idle", () => {
  const t = DEFAULT_TUNING;
  assert.equal(pollDelay(t, true, 10 * HOUR), t.hotMs, "a live job is always hot");
  assert.equal(pollDelay(t, false, 1000), t.hotMs);
  assert.equal(pollDelay(t, false, t.hotWindowMs + 1), t.coolMs);
  assert.equal(pollDelay(t, false, t.idleAfterMs + 1), t.idleMs);
  assert.ok(t.hotMs <= 1000, "live jobs stay responsive");
});

test("idle: one poll statement per tick at the slowest cadence, >10x fewer statements than the old loop", async () => {
  const q0 = s.queries();
  const log = await drive({ ticks: 450 }); // 450 x 8 s = 1 virtual hour
  const total = s.queries() - q0;
  assert.equal(log.sleeps[0], DEFAULT_TUNING.hotMs, "first tick after ready is quick");
  assert.deepEqual([...new Set(log.sleeps.slice(1))], [DEFAULT_TUNING.idleMs]);
  // A tick is one poll, plus at most one sweep (<= 3 statements, only at the sweep cadence).
  assert.ok(Math.max(...log.stmtsPerTick.slice(1)) <= 4, `max statements in a tick: ${Math.max(...log.stmtsPerTick.slice(1))}`);
  const perHour = (total / (log.endedAt - log.startedAt)) * HOUR;
  const oldPerHour = (3 / 0.7) * 3600 + (3 / 5) * 3600; // 3 selects every 700 ms + a 3-statement sweep every 5 s
  console.log(`# idle: ${perHour.toFixed(0)} statements/hour (previous loop: ~${oldPerHour.toFixed(0)})`);
  assert.ok(perHour < 1300, `idle cost ${perHour.toFixed(0)}/h`);
  assert.ok(perHour * 10 < oldPerHour);
});

test("sweeps keep running while idle (invites must still expire), about once a minute", async () => {
  const before = s.queries();
  const log = await drive({ ticks: 450 });
  const sweepStatements = s.queries() - before - log.sleeps.length - 1; // minus polls and the start query
  assert.ok(sweepStatements >= 2 * 50, `sweeper still runs: ${sweepStatements}`);
  assert.ok(sweepStatements <= 3 * 70, `but not on every poll: ${sweepStatements}`);
});

test("the quiet clock survives a reconnect: an old database does not make a new stream hot", async () => {
  await s.createInvite("old");
  await s.db.run("UPDATE invites SET updated_at = $1", [Date.now() - 20 * 60_000]);
  const log = await drive({ ticks: 2 });
  assert.equal(log.sleeps[1], DEFAULT_TUNING.idleMs);
});

test("ready is the first message, carries the cursor, and nothing from before it is replayed", async () => {
  const inv = await s.createInvite("replay-check");
  await sessionRow("sess-replay", inv.invite.id, { status: "done", updated_at: Date.now() - 60_000 });
  await s.db.addEvent("sess-replay", "status", { status: "working", text: "before" });
  const log = await drive({ ticks: 3 });
  assert.equal(log.msgs[0].event, "ready");
  assert.equal(typeof log.msgs[0].payload.cursor, "number");
  assert.deepEqual(log.msgs.filter((m) => ["event", "session", "invite"].includes(m.event)), []);
});

test("a live job keeps the cadence hot; its events arrive once, in order, on the next tick", async () => {
  const inv = await s.createInvite("hot");
  await sessionRow("sess-hot", inv.invite.id, { status: "working" });
  const log = await drive({
    ticks: 8,
    script: async (n) => {
      if (n === 3) {
        await s.db.addEvent("sess-hot", "tool_call", { tool: "bash", args: { command: "first" } });
        await s.db.addEvent("sess-hot", "tool_call", { tool: "bash", args: { command: "second" } });
      }
    },
  });
  assert.ok(log.sleeps.every((ms) => ms === DEFAULT_TUNING.hotMs), "live => hot on every tick");
  const cmds = log.msgs.filter((m) => m.event === "event").map((m) => m.payload.data.args.command);
  assert.deepEqual(cmds, ["first", "second"]);
  assert.ok(log.stmtsPerTick.slice(1).every((n) => n <= 3), "one poll per tick, plus at most a sweep");
});

test("activity wakes an idle feed, then it cools back down", async () => {
  const log = await drive({
    ticks: 120,
    script: async (n) => { if (n === 5) await s.createInvite("wake"); },
  });
  assert.ok(log.msgs.some((m) => m.event === "invite" && m.payload.label === "wake"), "delivered to the open stream");
  assert.equal(log.sleeps[4], DEFAULT_TUNING.idleMs, "idle before the change");
  assert.equal(log.sleeps[5], DEFAULT_TUNING.hotMs, "hot right after it");
  assert.equal(log.sleeps.at(-1), DEFAULT_TUNING.coolMs, "second tier once quiet for 30 s");
});

test("rows that commit slightly out of order (inside the overlap window) are still delivered, once", async () => {
  const inv = await s.createInvite("order");
  const base = Date.now();
  const log = await drive({
    ticks: 7,
    script: async (n) => {
      if (n === 1) await sessionRow("sess-new", inv.invite.id, { updated_at: base + 5000, status: "idle" });
      // another instance's write stamped 1.5 s earlier commits after the newer one was already delivered
      if (n === 3) await sessionRow("sess-late", inv.invite.id, { updated_at: base + 3500, status: "idle" });
    },
  });
  const ids = log.msgs.filter((m) => m.event === "session").map((m) => m.payload.id);
  assert.equal(ids.filter((x) => x === "sess-new").length, 1);
  assert.equal(ids.filter((x) => x === "sess-late").length, 1);
});

test("two instances (two concurrent feeds) each deliver every change independently", async () => {
  const inv = await s.createInvite("multi");
  await sessionRow("sess-multi", inv.invite.id);
  let wrote = false;
  const run = () => drive({
    ticks: 5,
    script: async (n) => {
      if (n === 2 && !wrote) { wrote = true; await s.db.addEvent("sess-multi", "assistant", { text: "shared-change" }); }
    },
  });
  const [a, b] = await Promise.all([run(), run()]);
  for (const log of [a, b]) {
    assert.equal(log.msgs.filter((m) => m.event === "event" && m.payload.data.text === "shared-change").length, 1);
  }
});

test("lost connection: the feed's sweep fails a silent session and the dashboard hears about it", async () => {
  const inv = await s.createInvite("lost");
  await sessionRow("sess-lost", inv.invite.id, { status: "working", last_heartbeat: Date.now() - 120_000 });
  const log = await drive({ ticks: 12 }); // 12 x 700 ms of virtual time passes the 5 s live-sweep cadence
  const failed = log.msgs.find((m) => m.event === "session" && m.payload.id === "sess-lost" && m.payload.status === "failed");
  assert.ok(failed, "session update delivered");
  assert.equal(failed.payload.status_text, "Lost connection");
});

test("an expired invite is swept while idle and delivered", async () => {
  const inv = await s.createInvite("expiring");
  await s.db.run("UPDATE invites SET expires_at = $1 WHERE id = $2", [Date.now() - 1000, inv.invite.id]);
  // Only the quiet 60 s sweep cadence applies; 20 idle ticks of 8 s cover it.
  await s.db.run("UPDATE invites SET updated_at = $1", [Date.now() - 30 * 60_000]);
  const log = await drive({ ticks: 20 });
  const m = log.msgs.find((x) => x.event === "invite" && x.payload.id === inv.invite.id);
  assert.ok(m && m.payload.status === "expired");
});

// Keep last: it rewinds the virtual clock to real time, which the sweeper throttle (shared state) does not like.
test("a recent change makes a new stream hot", async () => {
  await s.createInvite("recent");
  vt = Date.now(); // database timestamps are real time, so compare against a real-time start
  const log = await drive({ ticks: 2 });
  assert.equal(log.sleeps[1], DEFAULT_TUNING.hotMs);
});
