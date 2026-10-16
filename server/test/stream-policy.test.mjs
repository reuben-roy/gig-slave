// Dashboard stream policy: when the SSE connection is open or closed. Pure logic, fake clock and timers.
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import vm from "node:vm";

// The file is a classic browser script (the package is "type": "module"), so load it the way a browser would
// and take what it publishes on its global.
const sandbox = { self: {} };
vm.runInNewContext(readFileSync(new URL("../public/assets/stream-policy.js", import.meta.url), "utf8"), sandbox);
const { createStreamPolicy } = sandbox.self.GigStreamPolicy;

const MIN = 60_000;

function harness(over = {}) {
  const h = {
    t: 1_000_000,
    hidden: false,
    live: false,
    connects: 0,
    disconnects: 0,
    states: [],
    timers: new Map(),
    nextTimer: 1,
  };
  h.policy = createStreamPolicy({
    now: () => h.t,
    setTimer: (fn, ms) => { const id = h.nextTimer++; h.timers.set(id, { fn, at: h.t + ms }); return id; },
    clearTimer: (id) => h.timers.delete(id),
    isHidden: () => h.hidden,
    hasLive: () => h.live,
    connect: () => { h.connects++; },
    disconnect: () => { h.disconnects++; },
    onState: (s, r) => h.states.push(r ? `${s}:${r}` : s),
    ...over,
  });
  /** Advance the fake clock, firing due timers in order. */
  h.advance = (ms) => {
    const end = h.t + ms;
    for (;;) {
      const due = [...h.timers.entries()].filter(([, v]) => v.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      h.timers.delete(due[0]);
      h.t = due[1].at;
      due[1].fn();
    }
    h.t = end;
  };
  return h;
}

test("a visible, attended dashboard stays connected; one timer pending, no churn", () => {
  const h = harness();
  h.policy.start();
  assert.equal(h.connects, 1);
  h.advance(5 * MIN);
  h.policy.activity();
  h.advance(5 * MIN);
  h.policy.activity();
  h.advance(5 * MIN);
  assert.equal(h.connects, 1);
  assert.equal(h.disconnects, 0);
  assert.equal(h.timers.size, 1);
});

test("unattended with no live job pauses after the idle window, and says why", () => {
  const h = harness();
  h.policy.start();
  h.advance(10 * MIN - 1);
  assert.equal(h.disconnects, 0);
  h.advance(2);
  assert.equal(h.disconnects, 1);
  assert.equal(h.policy.wantsStream(), false);
  assert.equal(h.policy.pausedReason(), "idle");
  assert.deepEqual(h.states, ["live", "paused:idle"]);
  assert.equal(h.timers.size, 0, "no timers left running while paused");
});

test("interaction resumes an idle-paused stream exactly once", () => {
  const h = harness();
  h.policy.start();
  h.advance(11 * MIN);
  h.policy.activity();
  h.policy.activity();
  h.policy.activity();
  assert.equal(h.connects, 2);
  assert.equal(h.policy.wantsStream(), true);
  assert.equal(h.states.at(-1), "live");
});

test("a live job keeps the stream open however long nobody touches the page", () => {
  const h = harness();
  h.live = true;
  h.policy.start();
  h.advance(60 * MIN);
  assert.equal(h.disconnects, 0);
  assert.equal(h.timers.size, 0, "no deadline while a job is live");
});

test("when the live job ends, the idle clock still counts from the last interaction", () => {
  const h = harness();
  h.live = true;
  h.policy.start();
  h.advance(30 * MIN);
  h.live = false;
  h.policy.liveChanged();
  assert.equal(h.disconnects, 1, "operator has been away > 10 min, so pause right away");
  assert.equal(h.policy.pausedReason(), "idle");
});

test("hidden tab with no live job: grace period, then closed", () => {
  const h = harness();
  h.policy.start();
  h.hidden = true;
  h.policy.visibilityChanged();
  assert.equal(h.disconnects, 0, "quick tab switches stay connected");
  h.advance(29_999);
  assert.equal(h.disconnects, 0);
  h.advance(2);
  assert.equal(h.disconnects, 1);
  assert.equal(h.policy.pausedReason(), "hidden");
  h.advance(60 * MIN);
  assert.equal(h.connects, 1, "a hidden tab never reopens by itself");
});

test("returning to a hidden-paused tab reconnects; a quick tab switch does not", () => {
  const h = harness();
  h.policy.start();
  h.hidden = true;
  h.policy.visibilityChanged();
  h.advance(10_000);
  h.hidden = false;
  h.policy.visibilityChanged();
  assert.equal(h.connects, 1, "came back inside the grace period: same connection");
  h.hidden = true;
  h.policy.visibilityChanged();
  h.advance(40_000);
  assert.equal(h.disconnects, 1);
  h.hidden = false;
  h.policy.visibilityChanged();
  assert.equal(h.connects, 2);
  assert.equal(h.states.at(-1), "live");
});

test("hidden tab with a live job stays connected (done/failed notifications still arrive), then gets the grace period", () => {
  const h = harness();
  h.live = true;
  h.policy.start();
  h.hidden = true;
  h.policy.visibilityChanged();
  h.advance(30 * MIN);
  assert.equal(h.disconnects, 0);
  h.live = false;
  h.policy.liveChanged();
  assert.equal(h.disconnects, 0, "grace period starts when the job ends, not earlier");
  h.advance(31_000);
  assert.equal(h.disconnects, 1);
  assert.equal(h.policy.pausedReason(), "hidden");
});

test("opening the page in a background tab does not open a stream until it is shown", () => {
  const h = harness();
  h.hidden = true;
  h.policy.start();
  assert.equal(h.connects, 0);
  assert.equal(h.states.at(-1), "paused:hidden");
  h.hidden = false;
  h.policy.visibilityChanged();
  assert.equal(h.connects, 1);
});

test("a paused-idle tab that is then hidden does not reconnect for the grace period", () => {
  const h = harness();
  h.policy.start();
  h.advance(11 * MIN);
  h.hidden = true;
  h.policy.visibilityChanged();
  assert.equal(h.connects, 1);
  assert.equal(h.policy.pausedReason(), "hidden");
});

test("resume() reopens regardless of reason; stop() closes and leaves no timers", () => {
  const h = harness();
  h.policy.start();
  h.advance(11 * MIN);
  h.policy.resume();
  assert.equal(h.connects, 2);
  h.policy.stop();
  assert.equal(h.disconnects, 2);
  assert.equal(h.timers.size, 0);
  h.policy.activity();
  h.policy.liveChanged();
  assert.equal(h.connects, 2, "stopped policies ignore events");
});

test("activity pushes the idle deadline out without reconnecting", () => {
  const h = harness();
  h.policy.start();
  h.advance(9 * MIN);
  h.policy.activity();
  h.advance(9 * MIN);
  assert.equal(h.disconnects, 0);
  h.advance(2 * MIN);
  assert.equal(h.disconnects, 1);
});
