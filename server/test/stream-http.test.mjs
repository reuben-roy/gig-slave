// /api/stream over the real Hono app with the real clock: wire format, auth, reconnect correctness, shutdown.
import assert from "node:assert/strict";
import { test } from "node:test";
import { loadServer, sleep } from "./helpers.mjs";

const s = await loadServer({ FLUID_MAX_STREAM_MS: "8000" });

test("rejects missing and wrong tokens", async () => {
  assert.equal((await s.app.request("/api/stream")).status, 401);
  assert.equal((await s.app.request("/api/stream?token=nope")).status, 401);
});

test("wire format: retry first, then ready with a cursor, then typed messages with ids", async () => {
  await s.createInvite("seed"); // a recent change => the stream starts at the hot cadence (an untouched database polls every 8 s)
  const st = s.openStream();
  const ready = await st.waitFor((m) => m.event === "ready");
  assert.equal(st.msgs[0].raw, "retry: 1000");
  assert.equal(typeof ready.data.cursor, "number");
  const created = await s.createInvite("wire");
  const inv = await st.waitFor((m) => m.event === "invite" && m.data.id === created.invite.id);
  assert.ok(inv.id, "messages carry an id");
  assert.equal(inv.data.label, "wire");
  await st.close();
});

test("stream ends by itself at the configured lifetime so the client reconnects", async () => {
  const t0 = Date.now();
  const st = s.openStream();
  await st.done;
  const lived = Date.now() - t0;
  assert.ok(lived >= 7500 && lived < 12000, `lived ${lived} ms`);
});

test("reconnect: changes made while no stream was open are not replayed, but are in the refetch; later ones are streamed", async () => {
  const a = s.openStream();
  await a.waitFor((m) => m.event === "ready");
  await a.close();

  const gap = await s.createInvite("made-while-disconnected");

  const b = s.openStream();
  await b.waitFor((m) => m.event === "ready");
  // What the dashboard does on `ready`:
  const list = (await s.admin("GET", "/api/invites")).body.invites;
  assert.ok(list.some((i) => i.id === gap.invite.id), "refetch shows the gap change");
  // A change immediately after `ready` must be streamed (no hole between refetch and stream).
  const after = await s.createInvite("made-right-after-ready");
  await b.waitFor((m) => m.event === "invite" && m.data.id === after.invite.id);
  assert.ok(!b.msgs.some((m) => m.event === "invite" && m.data.id === gap.invite.id), "gap change was not replayed");
  await b.close();
});

test("a job's events reach the dashboard stream within ~1 s, in order", async () => {
  const inv = await s.createInvite("job");
  const sess = await s.redeem(inv.code);
  const st = s.openStream();
  await st.waitFor((m) => m.event === "ready");
  const lat = [];
  for (let i = 0; i < 4; i++) {
    const t0 = Date.now();
    await s.agent(sess.session_token, "/events", { events: [{ type: "tool_call", data: { tool: "bash", args: { command: "c" + i } } }] });
    await st.waitFor((m) => m.event === "event" && m.data.data.args?.command === "c" + i, 3000);
    lat.push(Date.now() - t0);
    await sleep(300);
  }
  assert.ok(Math.max(...lat) < 1500, `latencies ${lat.join(", ")} ms`);
  const order = st.msgs.filter((m) => m.event === "event" && m.data.type === "tool_call").map((m) => m.data.data.args.command);
  assert.deepEqual(order, ["c0", "c1", "c2", "c3"]);
  // the heartbeat path (no visible change) must not produce session spam
  const before = st.msgs.filter((m) => m.event === "session").length;
  for (let i = 0; i < 3; i++) { await s.agent(sess.session_token, "/heartbeat", { status: "working", status_text: "same" }); await sleep(250); }
  await sleep(1000);
  assert.ok(st.msgs.filter((m) => m.event === "session").length - before <= 1, "unchanged heartbeats are not streamed");
  await st.close();
});

test("closing the stream stops all database activity from it", async () => {
  const st = s.openStream();
  await st.waitFor((m) => m.event === "ready");
  await st.close();
  await sleep(300); // let an in-flight tick finish
  const q0 = s.queries();
  await sleep(2500);
  assert.equal(s.queries() - q0, 0, "no statements after the client went away");
});

test("with no dashboard open, nothing queries the database (hidden tabs cost nothing)", async () => {
  const q0 = s.queries();
  await sleep(2000);
  assert.equal(s.queries() - q0, 0);
});
