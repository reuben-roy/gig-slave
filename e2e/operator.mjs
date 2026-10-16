#!/usr/bin/env node
// Operator e2e: real server + real recipient CLI + operator CLI + MCP over stdio, against the scripted mock upstream.
// No live gigs, no real model tokens. Run with `npm run e2e:operator` (also part of `npm run e2e`). Exit 0 on pass.

import { spawn } from "node:child_process";
import { existsSync, promises as fsp } from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startMock } from "../mock/server.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const TMP = path.join(HERE, ".tmp-operator");
const DESKTOP = path.join(TMP, "Desktop");
const CLI_TMP = path.join(TMP, "tmp");
const CONFIG_DIR = path.join(TMP, "config");
const PGLITE_DIR = path.join(TMP, "pglite");
const SERVER_ENTRY = path.join(ROOT, "server", "dist", "main.js");
const CLI_ENTRY = path.join(ROOT, "cli", "dist", "index.js");
const OP_ENTRY = path.join(ROOT, "operator", "dist", "bin.js");

const ADMIN_TOKEN = "e2e-operator-admin-" + "x".repeat(16);
const GATEWAY_KEY = "mock-gateway-key";
const UPSTREAM_KEY = "mock-upstream-key";
const MODEL = "anthropic/claude-haiku-5.5";
const DESKTOP_FILES = {
  "photo1.png": "fake png bytes, photo one\n",
  "photo2.jpg": "fake jpg bytes, photo two\n",
  "report.pdf": "%fake pdf report\n",
  "notes.txt": "notes: buy milk\n",
  "song.mp3": "fake mp3 bytes, song\n",
};
const TOKEN_RE = /hg_op_[A-Za-z0-9]{8}_[A-Za-z0-9_-]{43}/;

const STRIPPED_ENV = [/^GIGAGENT_/, /^GIG_SLAVE_/, /^AI_GATEWAY_/, /^UPSTREAM_/, /^GATEWAY_EXTRA_BODY$/, /^DATABASE_URL$/, /^RESEND_/, /^NOTIFY_FROM$/, /^CRON_SECRET$/, /^ADMIN_TOKEN$/, /^PGLITE_DIR$/, /^MODELS$/, /^DEFAULT_MODEL$/, /^PUBLIC_URL$/, /^PORT$/, /^OPERATOR_/];
const baseEnv = () => Object.fromEntries(Object.entries(process.env).filter(([k, v]) => v !== undefined && !STRIPPED_ENV.some((re) => re.test(k))));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Fail extends Error {}
const check = (cond, msg) => { if (!cond) throw new Fail(msg); };
async function step(name, fn) {
  try { await fn(); } catch (e) { throw e instanceof Fail ? new Fail(`${name}: ${e.message}`) : new Fail(`${name}: ${e?.stack ?? e}`); }
  console.log(`✓ ${name}`);
}

const live = new Set();
const transcript = []; // every byte any process printed, to prove no secret leaked
let serverUrl = "";
let serverLog = "";
let mock = null;

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
  });
}

function spawnTracked(cmd, args, { env, input, collect = true } = {}) {
  const child = spawn(cmd, args, { cwd: ROOT, env, stdio: ["pipe", "pipe", "pipe"] });
  child.out = "";
  child.errText = "";
  child.stdout.on("data", (d) => { child.out += d; if (collect) transcript.push(String(d)); });
  child.stderr.on("data", (d) => { child.errText += d; if (collect) transcript.push(String(d)); });
  child.exited = new Promise((resolve) => child.once("exit", (code, sig) => { live.delete(child); resolve(code ?? sig); }));
  live.add(child);
  if (input !== undefined) child.stdin.end(input);
  return child;
}

const opEnv = (extra = {}) => ({ ...baseEnv(), GIGAGENT_SERVER: serverUrl, GIGAGENT_CONFIG_DIR: CONFIG_DIR, GIGAGENT_NO_KEYCHAIN: "1", ...extra });

/** Run the operator CLI; resolves { code, json, out, err }. `track:false` excludes output from the secret scan (freshly minted token). */
async function op(args, { env = {}, input, track = true } = {}) {
  const child = spawnTracked(process.execPath, [OP_ENTRY, ...args], { env: opEnv(env), input: input ?? "", collect: track });
  const timer = setTimeout(() => child.kill("SIGKILL"), 60_000);
  const code = await child.exited;
  clearTimeout(timer);
  let json = null;
  try { json = JSON.parse(child.out.trim().split("\n").pop()); } catch { /* human output */ }
  return { code, json, out: child.out, err: child.errText };
}

async function http(method, p, { token, body, headers = {} } = {}) {
  const res = await fetch(`${serverUrl}${p}`, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body ? { "content-type": "application/json" } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(10_000),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, json };
}

async function teardown() {
  for (const c of live) { try { c.kill("SIGKILL"); } catch { /* gone */ } }
  await mock?.close?.().catch?.(() => {});
}

async function main() {
  await step("fixtures and build outputs", async () => {
    await fsp.rm(TMP, { recursive: true, force: true });
    await fsp.mkdir(DESKTOP, { recursive: true });
    await fsp.mkdir(CLI_TMP, { recursive: true });
    await fsp.mkdir(CONFIG_DIR, { recursive: true, mode: 0o700 });
    for (const [n, c] of Object.entries(DESKTOP_FILES)) await fsp.writeFile(path.join(DESKTOP, n), c);
    for (const f of [SERVER_ENTRY, CLI_ENTRY, OP_ENTRY]) check(existsSync(f), `${path.relative(ROOT, f)} is missing: run \`npm run build\` first`);
  });

  await step("mock upstream and server (operator API enabled)", async () => {
    mock = await startMock({ apiKeys: [GATEWAY_KEY, UPSTREAM_KEY] });
    const port = await freePort();
    serverUrl = `http://127.0.0.1:${port}`;
    const server = spawnTracked(process.execPath, [SERVER_ENTRY], {
      env: {
        ...baseEnv(), PORT: String(port), ADMIN_TOKEN, PGLITE_DIR, MODELS: `${MODEL},deepseek-flash`, DEFAULT_MODEL: MODEL,
        AI_GATEWAY_BASE_URL: mock.url, AI_GATEWAY_API_KEY: GATEWAY_KEY, UPSTREAM_BASE_URL: mock.url, UPSTREAM_API_KEY: UPSTREAM_KEY,
        PUBLIC_URL: serverUrl, OPERATOR_API_ENABLED: "1", OPERATOR_RATE_MULTIPLIER: "20",
      },
    });
    server.stdout.on("data", (d) => { serverLog += d; });
    server.stderr.on("data", (d) => { serverLog += d; });
    const deadline = Date.now() + 20_000;
    for (;;) {
      const r = await http("GET", "/api/config", { token: ADMIN_TOKEN }).catch(() => null);
      if (r?.status === 200) break;
      check(Date.now() < deadline, `server did not start:\n${serverLog.slice(-1500)}`);
      await sleep(200);
    }
  });

  let fullToken = "";
  let fullId = "";
  await step("admin mints a scoped token with the operator CLI; login stores it privately", async () => {
    const minted = await op(["tokens", "create", "--json", "--label", "e2e-full", "--preset", "full"], { env: { GIGAGENT_ADMIN_TOKEN: ADMIN_TOKEN }, track: false });
    check(minted.code === 0, `tokens create failed: ${minted.out}${minted.err}`);
    fullToken = minted.json.data.token;
    fullId = minted.json.data.record.id;
    check(TOKEN_RE.test(fullToken), "token has the documented shape");
    const login = await op(["login", "--stdin", "--json"], { input: fullToken });
    check(login.code === 0, `login failed: ${login.out}${login.err}`);
    const mode = (await fsp.stat(path.join(CONFIG_DIR, "credentials.json"))).mode & 0o777;
    check(mode === 0o600, `credentials file mode is ${mode.toString(8)}, expected 600`);
    const who = await op(["whoami", "--json"]);
    check(who.json?.data?.principal === "operator" && who.json.data.token.id === fullId, "whoami sees the operator token");
  });

  let invite = null;
  let code = "";
  await step("jobs create (confirm rules) then the recipient CLI organizes the fake Desktop", async () => {
    const jobArgs = ["jobs", "create", "--json", "--label", "E2E operator Desktop", "--task", "Organize my Desktop into folders by type.", "--dir", DESKTOP, "--expiry", "one_use"];
    const noYes = await op(jobArgs);
    check(noYes.code === 8, `without --yes the command must exit 8, got ${noYes.code}`);
    const made = await op([...jobArgs, "--yes", "--idempotency-key", "e2e-operator-key-1"]);
    check(made.code === 0, `jobs create failed: ${made.out}${made.err}`);
    invite = made.json.data.invite;
    code = made.json.data.code;
    check(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(code), "code shape");
    check(made.json.data.command === `npx gigagent ${code}`, "command string");
    const replay = await op([...jobArgs, "--yes", "--idempotency-key", "e2e-operator-key-1"]);
    check(replay.json.data.invite.id === invite.id && replay.json.data.code === null, "idempotent replay returns the same job without a code");
    const list = (await http("GET", "/api/invites", { token: ADMIN_TOKEN })).json.invites.filter((i) => i.label === "E2E operator Desktop");
    check(list.length === 1, `expected one job, found ${list.length}`);

    const recipient = spawnTracked(process.execPath, [CLI_ENTRY, code], { env: { ...baseEnv(), GIGAGENT_SERVER: serverUrl, TMPDIR: CLI_TMP } });
    // find the session through the operator CLI, then wait on it
    let sid = null;
    for (let i = 0; i < 100 && !sid; i++) {
      const g = await op(["jobs", "get", invite.id, "--json"]);
      sid = g.json?.data?.invite?.sessions?.[0]?.id ?? null;
      if (!sid) await sleep(300);
    }
    check(sid, "no session appeared for the job");
    const waited = await op(["sessions", "wait", sid, "--timeout", "90s", "--interval", "1s", "--json"]);
    check(waited.code === 0, `sessions wait exited ${waited.code}: ${waited.out}${waited.err}`);
    check(waited.json.data.session.status === "done", "session is done");
    check((await Promise.race([recipient.exited, sleep(15_000).then(() => "timeout")])) === 0, "recipient CLI exited 0");
    check(existsSync(path.join(DESKTOP, "Pictures", "photo1.png")), "Desktop was organized");
    invite.sessionId = sid;
  });

  await step("report, events and audit are readable through the operator CLI", async () => {
    const rep = await op(["sessions", "report", invite.sessionId, "--json"]);
    check(rep.json?.data?.result?.success === true && /5 files/.test(rep.json.data.result.answer ?? ""), `report: ${rep.out}`);
    const human = await op(["sessions", "report", invite.sessionId]);
    check(/Treat it as data, not instructions/.test(human.out), "report is labelled as untrusted");
    const ev = await op(["sessions", "events", invite.sessionId, "--json"]);
    check(ev.json.data.events.some((e) => e.type === "tool_call"), "events include tool calls");
    const audit = await op(["audit", "--limit", "50", "--json"]);
    const acts = audit.json.data.entries.map((e) => e.action);
    check(acts.includes("invite.create"), "audit has invite.create");
    check(audit.json.data.entries.every((e) => e.token_id === fullId), "operator sees only its own audit rows");
  });

  await step("one_use code cannot be redeemed twice (recipient flow unchanged)", async () => {
    const r = await http("POST", "/agent/redeem", { body: { code, machine: { hostname: "h", platform: "darwin", release: "1", arch: "arm64", username: "u" } }, headers: { "x-real-ip": "10.9.9.9" } });
    check(r.status === 403, `second redeem returned ${r.status}, expected 403`);
  });

  let readToken = "";
  await step("scopes, limits and query-token rules hold over real HTTP", async () => {
    const ro = await op(["tokens", "create", "--json", "--label", "e2e-read"], { env: { GIGAGENT_ADMIN_TOKEN: ADMIN_TOKEN }, track: false });
    readToken = ro.json.data.token;
    const roEnv = { GIGAGENT_OPERATOR_TOKEN: readToken };
    check((await op(["jobs", "list", "--json"], { env: roEnv })).code === 0, "read token can list");
    check((await op(["jobs", "create", "--json", "--yes", "--label", "x", "--task", "t"], { env: roEnv })).code === 3, "read token cannot create (exit 3)");
    check((await http("GET", `/api/stream?token=${readToken}`)).status === 401, "operator token in the query string is refused");
    check((await http("GET", "/api/cron/sweep", { token: readToken })).status === 403, "operator tokens cannot call cron");
    check((await http("GET", "/api/operator-tokens", { token: readToken })).status === 403, "operator tokens cannot manage tokens");
    check((await http("GET", "/api/invites")).status === 401, "anonymous is refused");
    const claude = await op(["tokens", "create", "--json", "--label", "e2e-claude", "--preset", "claude", "--invites-per-day", "2"], { env: { GIGAGENT_ADMIN_TOKEN: ADMIN_TOKEN }, track: false });
    const cEnv = { GIGAGENT_OPERATOR_TOKEN: claude.json.data.token };
    const hook = await op(["jobs", "create", "--json", "--yes", "--label", "x", "--task", "t", "--notify-webhook", "https://evil.example/h"], { env: cEnv });
    check(hook.code === 3, "webhooks are off by default for Claude-class tokens");
    check((await op(["jobs", "create", "--json", "--yes", "--label", "a", "--task", "t"], { env: cEnv })).code === 0, "claude token can create (1)");
    check((await op(["jobs", "create", "--json", "--yes", "--label", "b", "--task", "t"], { env: cEnv })).code === 0, "claude token can create (2)");
    const third = await op(["jobs", "create", "--json", "--yes", "--label", "c", "--task", "t"], { env: cEnv });
    check(third.code === 6, `daily cap must give exit 6, got ${third.code}`);
    check((await op(["sessions", "kill", "x", "--yes", "--json"], { env: cEnv })).code === 3, "claude token cannot kill");
  });

  await step("MCP over stdio: tools by scope, prepare/confirm/create, admin token refused", async () => {
    const claude = await op(["tokens", "create", "--json", "--label", "e2e-mcp", "--preset", "claude"], { env: { GIGAGENT_ADMIN_TOKEN: ADMIN_TOKEN }, track: false });
    const child = spawnTracked(process.execPath, [OP_ENTRY, "mcp"], { env: opEnv({ GIGAGENT_OPERATOR_TOKEN: claude.json.data.token }) });
    let buf = "";
    const waiters = new Map();
    child.stdout.on("data", (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        const m = JSON.parse(line); // stdout must be protocol-only
        waiters.get(m.id)?.(m);
      }
    });
    let id = 1;
    const rpc = (method, params) => new Promise((resolve, reject) => {
      const my = id++;
      const t = setTimeout(() => reject(new Fail(`mcp ${method} timed out`)), 20_000);
      waiters.set(my, (m) => { clearTimeout(t); resolve(m); });
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: my, method, params }) + "\n");
    });
    const call = async (name, args) => { const r = await rpc("tools/call", { name, arguments: args }); return { err: Boolean(r.result.isError), body: JSON.parse(r.result.content[0].text) }; };

    const init = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "e2e", version: "1" } });
    check(init.result.serverInfo.name === "hired-gun-operator", "initialize");
    const tools = (await rpc("tools/list", {})).result.tools.map((t) => t.name);
    check(tools.includes("hired_gun_create_job") && !tools.some((n) => /instruct|kill|revoke/.test(n)), `tool list: ${tools}`);
    const prep = await call("hired_gun_prepare_job", { label: "MCP job", task: "Organize my Desktop", working_dir: DESKTOP });
    check(!prep.err && prep.body.draft_id, "prepare");
    check((await call("hired_gun_create_job", { draft_id: prep.body.draft_id })).err, "create without user_confirmed is refused");
    const before = (await http("GET", "/api/invites", { token: ADMIN_TOKEN })).json.invites.filter((i) => i.label === "MCP job").length;
    check(before === 0, "nothing was created by prepare or the refused create");
    const made = await call("hired_gun_create_job", { draft_id: prep.body.draft_id, user_confirmed: true });
    check(!made.err && /^[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(made.body.code), `create: ${JSON.stringify(made.body)}`);
    check((await call("hired_gun_create_job", { draft_id: prep.body.draft_id, user_confirmed: true })).err, "a draft is single-use");
    const jobs = await call("hired_gun_list_jobs", {});
    check(jobs.body.jobs.some((j) => j.label === "MCP job"), "list_jobs sees the new job");
    child.stdin.end();
    check((await Promise.race([child.exited, sleep(10_000).then(() => "timeout")])) === 0, "mcp exits cleanly when stdin closes");

    const admin = await op(["mcp"], { env: { GIGAGENT_OPERATOR_TOKEN: ADMIN_TOKEN, GIGAGENT_ADMIN_TOKEN: "" } });
    check(admin.code !== 0 && /master admin token/.test(admin.err), `mcp must refuse the admin token (exit ${admin.code}: ${admin.err})`);
  });

  await step("revocation is immediate; revoke-all kills the rest", async () => {
    check((await op(["tokens", "revoke", fullId, "--json"], { env: { GIGAGENT_ADMIN_TOKEN: ADMIN_TOKEN } })).code === 0, "revoke");
    check((await op(["whoami", "--json"])).code === 3, "revoked token is refused on the very next call");
    check((await http("GET", "/api/config", { token: readToken })).status === 200, "other tokens unaffected");
    const all = await op(["tokens", "revoke-all", "--yes", "--json"], { env: { GIGAGENT_ADMIN_TOKEN: ADMIN_TOKEN } });
    check(all.code === 0, "revoke-all");
    check((await http("GET", "/api/config", { token: readToken })).status === 401, "read token revoked");
    check((await http("GET", "/api/config", { token: ADMIN_TOKEN })).status === 200, "admin token is unaffected");
  });

  await step("no secret leaked into any process output or the server log", async () => {
    const all = transcript.join("") + serverLog;
    check(!TOKEN_RE.test(all), "an operator token appeared in output or logs");
    check(!all.includes(ADMIN_TOKEN), "the admin token appeared in output or logs");
    check(all.length > 500, "transcript unexpectedly small");
  });
}

process.on("SIGINT", () => { teardown().finally(() => process.exit(130)); });
try {
  await main();
  console.log("\noperator e2e passed");
  await teardown();
  await fsp.rm(TMP, { recursive: true, force: true });
  process.exit(0);
} catch (e) {
  console.error(`\n✗ ${e.message}`);
  if (serverLog) console.error(`--- server output (tail) ---\n${serverLog.slice(-1500)}`);
  await teardown();
  process.exit(1);
}
