#!/usr/bin/env node
// Browser smoke test for the dashboard's stream policy, using headless Google Chrome over CDP (no extra deps).
// Starts a throwaway server (in-memory PGlite, random admin token), loads /dashboard and checks that the live
// stream opens, resyncs once per (re)connect, closes when the tab is hidden, reopens when shown, and stays
// open in a hidden tab while a job is live. Takes ~80 s because the hidden-tab grace period is 30 s real time.
//   node scripts/dashboard-smoke.mjs        (build first: npm run build -w server)
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CHROME = process.env.CHROME || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PORT = 18000 + Math.floor(Math.random() * 1000);
const CDP = PORT + 1000;
const TOKEN = randomBytes(24).toString("hex");
const BASE = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const procs = [];
let failed = 0;
const check = (ok, msg) => { console.log(`${ok ? "✓" : "✗"} ${msg}`); if (!ok) failed++; };

function cleanup() { for (const p of procs) try { p.kill(); } catch {} }
process.on("exit", cleanup);

const profile = mkdtempSync(path.join(tmpdir(), "gigagent-smoke-"));
const server = spawn(process.execPath, [path.join(ROOT, "server/dist/main.js")], {
  env: { ...process.env, ADMIN_TOKEN: TOKEN, PORT: String(PORT), PUBLIC_URL: BASE, PGLITE_DIR: "memory://", DATABASE_URL: "" },
  stdio: "ignore",
});
procs.push(server);
const chrome = spawn(CHROME, ["--headless=new", `--remote-debugging-port=${CDP}`, `--user-data-dir=${profile}`, "--no-first-run", "--disable-gpu", "about:blank"], { stdio: "ignore" });
procs.push(chrome);

async function until(fn, ms = 15000) {
  const end = Date.now() + ms;
  for (;;) {
    try { const v = await fn(); if (v) return v; } catch {}
    if (Date.now() > end) throw new Error("timeout");
    await sleep(200);
  }
}

await until(async () => (await fetch(`${BASE}/health`)).ok);
const targets = await until(async () => {
  const l = await (await fetch(`http://127.0.0.1:${CDP}/json/list`)).json();
  return l.find((t) => t.type === "page");
});
const ws = new WebSocket(targets.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let id = 0;
const pending = new Map();
const streams = new Map(); // requestId -> { open }
let invitesGets = 0;
let streamOpens = 0;
const errors = [];
ws.onmessage = (m) => {
  const d = JSON.parse(m.data);
  if (d.id && pending.has(d.id)) { pending.get(d.id)(d.result ?? d.error); pending.delete(d.id); return; }
  if (d.method === "Network.requestWillBeSent") {
    const u = d.params.request.url;
    if (u.includes("/api/stream")) { streams.set(d.params.requestId, { open: true }); streamOpens++; }
    if (u.endsWith("/api/invites") && d.params.request.method === "GET") invitesGets++;
  }
  if (d.method === "Network.loadingFinished" || d.method === "Network.loadingFailed") {
    const s = streams.get(d.params.requestId);
    if (s) s.open = false;
  }
  if (d.method === "Runtime.exceptionThrown") errors.push(d.params.exceptionDetails?.exception?.description || d.params.exceptionDetails?.text);
};
const send = (method, params = {}) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
const evaluate = async (expression) => (await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true })).result?.value;
const openStreams = () => [...streams.values()].filter((s) => s.open).length;
const setHidden = (hidden) => evaluate(`Object.defineProperty(document, 'hidden', { configurable: true, get: () => ${hidden} }); document.dispatchEvent(new Event('visibilitychange')); true`);
const badge = () => evaluate(`document.getElementById('connText').textContent`);

await send("Network.enable");
await send("Runtime.enable");
await send("Page.enable");
await send("Page.navigate", { url: `${BASE}/dashboard` });
await sleep(1500);
await evaluate(`localStorage.setItem('gigagentAdminToken', ${JSON.stringify(TOKEN)}); true`);
await send("Page.navigate", { url: `${BASE}/dashboard` });

await until(() => openStreams() === 1, 10000);
await sleep(1500);
check(openStreams() === 1 && streamOpens === 1, "one stream opens on load");
check(invitesGets === 2, `invite list fetched once at start and once on ready (got ${invitesGets})`);
check((await badge()) === "Live", "badge says Live");

await setHidden(true);
await sleep(5000);
check(openStreams() === 1, "hidden for 5 s: stream still open (grace period)");
await sleep(28000);
check(openStreams() === 0, "hidden for 33 s with no job: stream closed");
check((await badge()).startsWith("Paused"), `badge says paused (“${await badge()}”)`);

const gets = invitesGets;
await setHidden(false);
await until(() => openStreams() === 1, 8000).catch(() => {});
await sleep(1500);
check(openStreams() === 1 && streamOpens === 2, "shown again: stream reopens");
check(invitesGets === gets + 1, "and state is refetched exactly once");
check((await badge()) === "Live", "badge says Live again");

// A live job keeps a hidden tab connected (so done/failed notifications still arrive).
const auth = { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" };
const inv = await (await fetch(`${BASE}/api/invites`, { method: "POST", headers: auth, body: JSON.stringify({ label: "smoke", task: "t", expiry_policy: "ttl", ttl_hours: 1 }) })).json();
await fetch(`${BASE}/agent/redeem`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code: inv.code, machine: { hostname: "smoke" } }) });
await until(() => evaluate(`document.body.innerText.includes('smoke')`), 10000);
await sleep(2500);
await setHidden(true);
await sleep(35000);
check(openStreams() >= 1, "hidden for 35 s while a job is live: stream stays open");

check(errors.length === 0, `no uncaught page errors${errors.length ? ": " + errors[0] : ""}`);
ws.close();
cleanup();
rmSync(profile, { recursive: true, force: true });
console.log(failed ? `\n${failed} check(s) failed` : "\ndashboard smoke test passed");
process.exit(failed ? 1 : 0);
