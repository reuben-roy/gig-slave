#!/usr/bin/env node
// Measures database statements issued by the admin SSE stream (and a simulated job) in-process,
// against in-memory PGlite. No network, no real data, no secrets. Build first: npm run build -w server.
//   node scripts/measure-usage.mjs [seconds=30] [json]
// Each scenario loads a fresh copy of the server in a child process so module state (sweeper throttle, caches) is clean.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const SECS = Number(process.argv[2]) || 30;
const AS_JSON = process.argv[3] === "json";
const SCENARIOS = ["idle", "active", "reconnect"];

if (process.argv[2] === "--scenario") {
  const { loadServer, sleep } = await import("../server/test/helpers.mjs");
  const [name, secs] = [process.argv[3], Number(process.argv[4])];

  const simulatedJob = async (s, withStream) => {
    const inv = await s.createInvite("measure");
    const sess = await s.redeem(inv.code);
    const st = withStream ? s.openStream() : null;
    await sleep(300);
    const q0 = s.queries();
    const lat = [];
    const end = Date.now() + secs * 1000;
    let hb = 0, ev = 0, nextHb = Date.now(), nextEv = Date.now();
    while (Date.now() < end) {
      if (Date.now() >= nextHb) { await s.agent(sess.session_token, "/heartbeat", { status: "working", status_text: "step " + hb }); hb++; nextHb += 5000; }
      if (Date.now() >= nextEv) {
        const t0 = Date.now();
        const marker = "m" + ev++;
        await s.agent(sess.session_token, "/events", { events: [{ type: "tool_call", data: { tool: "bash", args: { command: marker } } }] });
        if (st) {
          try { await st.waitFor((m) => m.event === "event" && m.data?.data?.args?.command === marker, 4000); lat.push(Date.now() - t0); } catch { lat.push(null); }
        }
        nextEv += 1000;
      }
      await sleep(25);
    }
    const queries = s.queries() - q0;
    await s.agent(sess.session_token, "/complete", { success: true, report: "ok", result: null });
    if (st) await st.close();
    const ok = lat.filter((x) => x !== null).sort((a, b) => a - b);
    return { queries, heartbeats: hb, event_posts: ev, sse_latency_p50_ms: ok[Math.floor(ok.length / 2)] ?? null, sse_latency_max_ms: ok.at(-1) ?? null, missed: lat.length - ok.length };
  };

  let result;
  if (name === "idle") {
    const s = await loadServer();
    const q0 = s.queries();
    const st = s.openStream();
    await sleep(secs * 1000);
    result = { queries: s.queries() - q0 };
    await st.close();
  } else if (name === "active") {
    const s = await loadServer();
    const base = await simulatedJob(s, false);
    const withDash = await simulatedJob(s, true);
    result = { job_only: base, job_plus_dashboard: withDash, dashboard_share: withDash.queries - base.queries };
  } else if (name === "reconnect") {
    const s = await loadServer({ FLUID_MAX_STREAM_MS: "6000" });
    const cycles = Math.max(2, Math.floor(secs / 6));
    const q0 = s.queries();
    for (let i = 0; i < cycles; i++) {
      const st = s.openStream();
      await s.admin("GET", "/api/invites"); // what the dashboard does on every (re)connect
      await st.done;
    }
    const queries = s.queries() - q0;
    result = { cycles, queries, per_cycle: +(queries / cycles).toFixed(1), note: "6s streams; per-cycle cost includes the dashboard refetch and the stream's own polling" };
  }
  console.log("RESULT " + JSON.stringify(result));
  process.exit(0);
}

const out = {};
for (const name of SCENARIOS) {
  const r = spawnSync(process.execPath, [fileURLToPath(import.meta.url), "--scenario", name, String(SECS)], { encoding: "utf8" });
  const line = r.stdout.split("\n").find((l) => l.startsWith("RESULT "));
  if (!line) { console.error(`scenario ${name} failed:\n${r.stdout}\n${r.stderr}`); process.exit(1); }
  out[name] = { seconds: SECS, ...JSON.parse(line.slice(7)) };
}
const perHour = (n) => Math.round((n / SECS) * 3600);
out.idle.per_hour = perHour(out.idle.queries);
if (AS_JSON) console.log(JSON.stringify(out, null, 2));
else {
  console.log(`idle (1 dashboard open, no jobs): ${out.idle.queries} statements in ${SECS}s  ->  ~${out.idle.per_hour}/hour`);
  const a = out.active;
  console.log(`active job alone: ${a.job_only.queries} statements in ${SECS}s (${a.job_only.heartbeats} heartbeats, ${a.job_only.event_posts} event posts)`);
  console.log(`active job + dashboard: ${a.job_plus_dashboard.queries}; dashboard share ${a.dashboard_share} (~${perHour(a.dashboard_share)}/hour); event->SSE latency p50 ${a.job_plus_dashboard.sse_latency_p50_ms}ms, max ${a.job_plus_dashboard.sse_latency_max_ms}ms, missed ${a.job_plus_dashboard.missed}`);
  console.log(`reconnect: ${out.reconnect.cycles} cycles -> ${out.reconnect.queries} statements (${out.reconnect.per_cycle}/cycle)`);
}
process.exit(0);
