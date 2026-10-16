#!/usr/bin/env node
// hired-gun: operator CLI for agents and scripts. Create jobs, watch them, send instructions, stop them, read results.
// Output is JSON on stdout (one document, or one line per update for `watch`); progress and errors go to stderr.
// Exit codes: 0 ok, 1 error, 2 usage, 3 not signed in / token rejected; `jobs watch` exits 0 succeeded, 1 failed, 4 stopped or expired.

import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";

// Same default server the recipient CLI (cli/src/server-url.ts) talks to; a test keeps them equal.
const BAKED_SERVER_URL = "https://gigagent-beta.vercel.app";

const HOME = process.env.HIRED_GUN_HOME || join(homedir(), ".config", "hired-gun");
const CREDS = join(HOME, "credentials.json");
const PENDING = join(HOME, "pending-login.json");
const TERMINAL = ["succeeded", "failed", "stopped", "expired"];

class CliError extends Error {
  constructor(message, { code = "error", exit = 1, status } = {}) {
    super(message);
    Object.assign(this, { code, exit, status });
  }
}

const out = (v) => process.stdout.write(JSON.stringify(v, null, 2) + "\n");
const log = (s) => process.stderr.write(s + "\n");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}
function writeSecret(file, value) {
  mkdirSync(HOME, { recursive: true, mode: 0o700 });
  writeFileSync(file, JSON.stringify(value, null, 2), { mode: 0o600 });
  chmodSync(file, 0o600);
}

const serverUrl = (flag) => (flag || process.env.HIRED_GUN_SERVER || readJson(CREDS)?.server || BAKED_SERVER_URL).replace(/\/+$/, "");

function credentials(flags) {
  const token = process.env.HIRED_GUN_TOKEN || readJson(CREDS)?.token;
  if (!token) throw new CliError("not signed in: run `hired-gun login`, or set HIRED_GUN_TOKEN", { code: "not_signed_in", exit: 3 });
  return { token, server: serverUrl(flags.server) };
}

async function http(server, method, path, { token, body, headers } = {}) {
  let res;
  try {
    res = await fetch(server + path, {
      method,
      headers: { ...(body ? { "content-type": "application/json" } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(40_000),
    });
  } catch (e) {
    throw new CliError(`could not reach ${server}: ${e.message}`, { code: "network" });
  }
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    // non-JSON error page
  }
  if (!res.ok && res.status !== 202) {
    throw new CliError(data?.error || `HTTP ${res.status}`, {
      code: data?.code || "http_error", status: res.status, exit: res.status === 401 ? 3 : 1,
    });
  }
  return { status: res.status, data };
}

// ---------- commands ----------

async function login(flags) {
  const server = serverUrl(flags.server);
  let pending = readJson(PENDING);
  if (!flags.new && pending && pending.server === server && pending.expires_at > Date.now()) {
    log("Resuming the pending request.");
  } else {
    const scopes = flags.scopes ? flags.scopes.split(",").map((s) => (s.includes(":") ? s : `jobs:${s}`)) : undefined;
    const { data } = await http(server, "POST", "/operator/enroll", { body: { name: flags.name || `hired-gun CLI on ${hostname()}`, scopes } });
    pending = { server, device_secret: data.device_secret, user_code: data.user_code, verification_url: data.verification_url, expires_at: Date.now() + data.expires_in * 1000, interval: data.interval };
    writeSecret(PENDING, pending);
  }
  log(`\nAsk the owner of this Hired Gun service to approve this request:\n  open ${pending.verification_url}\n  code ${pending.user_code} (valid until ${new Date(pending.expires_at).toLocaleTimeString()})\n`);
  if (flags["no-wait"]) {
    return out({ status: "pending", user_code: pending.user_code, verification_url: pending.verification_url, expires_at: pending.expires_at, next: "run `hired-gun login` again after approval" });
  }
  while (Date.now() < pending.expires_at) {
    const { status, data } = await http(server, "POST", "/operator/enroll/token", { body: { device_secret: pending.device_secret } });
    if (status === 200 && data?.token) {
      writeSecret(CREDS, { server, token: data.token, operator: data.operator, scopes: data.scopes, saved_at: Date.now() });
      rmSync(PENDING, { force: true });
      return out({ status: "approved", operator: data.operator, scopes: data.scopes, credentials: CREDS });
    }
    await sleep((data?.interval || pending.interval || 3) * 1000);
  }
  rmSync(PENDING, { force: true });
  throw new CliError("the request expired before it was approved", { code: "expired" });
}

async function logout(flags) {
  const token = process.env.HIRED_GUN_TOKEN || readJson(CREDS)?.token;
  if (token) {
    await http(serverUrl(flags.server), "DELETE", "/operator/token", { token }).catch((e) => {
      if (e.status !== 401) throw e; // already revoked is fine
    });
  }
  rmSync(CREDS, { force: true });
  rmSync(PENDING, { force: true });
  out({ ok: true });
}

const call = async (flags, method, path, body, headers) => {
  const { token, server } = credentials(flags);
  return (await http(server, method, path, { token, body, headers })).data;
};

const need = (v, what) => {
  if (!v) throw new CliError(`missing ${what}`, { code: "usage", exit: 2 });
  return v;
};

async function create(flags) {
  const key = flags.key || undefined;
  const body = {
    label: need(flags.label, "--label"), task: need(flags.task, "--task"),
    working_dir: flags.dir, model: flags.model, expiry_policy: flags.policy,
    ttl_hours: flags["ttl-hours"] ? Number(flags["ttl-hours"]) : undefined,
    notify_webhook: flags.webhook,
  };
  out(await call(flags, "POST", "/operator/jobs", body, key ? { "idempotency-key": key } : undefined));
}

async function watch(flags, id) {
  let last = "";
  for (let first = true; ; first = false) {
    // The first request returns the current state at once; later ones wait for the next change.
    const { job } = await call(flags, "GET", `/operator/jobs/${encodeURIComponent(id)}?wait_seconds=${first ? 0 : 20}`);
    const line = JSON.stringify({ state: job.state, status_text: job.sessions.at(-1)?.status_text ?? null });
    if (line !== last) {
      last = line;
      process.stdout.write(JSON.stringify({ ts: Date.now(), job_id: job.id, state: job.state, status_text: job.sessions.at(-1)?.status_text ?? null }) + "\n");
    }
    if (TERMINAL.includes(job.state)) {
      process.stdout.write(JSON.stringify({ final: true, job }) + "\n");
      process.exitCode = job.state === "succeeded" ? 0 : job.state === "failed" ? 1 : 4;
      return;
    }
  }
}

const USAGE = `hired-gun <command>

  login [--name N] [--scopes read,write] [--server URL] [--no-wait] [--new]   ask the owner for access (they approve in a browser)
  logout                                                                       revoke this token and forget it
  whoami                                                                       account, limits, usage, models
  jobs create --label L --task T [--dir D] [--model M] [--policy one_use|on_complete|ttl] [--ttl-hours H]
              [--webhook URL] [--key IDEMPOTENCY_KEY]           returns the code to give the recipient
  jobs list [--state S] [--limit N]
  jobs get ID [--wait SECONDS]
  jobs watch ID                                                                stream state changes until the job ends
  jobs events ID [--after N]
  jobs instruct ID TEXT
  jobs stop ID
  jobs code ID                                                                 new code for a job nobody has run yet

Env: HIRED_GUN_TOKEN, HIRED_GUN_SERVER override the saved sign-in. Output is JSON.`;

async function main(argv) {
  const { values: f, positionals: p } = parseArgs({
    args: argv, allowPositionals: true, strict: false,
    options: {
      name: { type: "string" }, scopes: { type: "string" }, server: { type: "string" }, "no-wait": { type: "boolean" }, new: { type: "boolean" },
      label: { type: "string" }, task: { type: "string" }, dir: { type: "string" }, model: { type: "string" }, policy: { type: "string" },
      "ttl-hours": { type: "string" }, webhook: { type: "string" }, key: { type: "string" },
      state: { type: "string" }, limit: { type: "string" }, wait: { type: "string" }, after: { type: "string" }, help: { type: "boolean", short: "h" },
    },
  });
  const [cmd, sub, id, ...rest] = p;
  if (f.help || !cmd) return log(USAGE);
  if (cmd === "login") return login(f);
  if (cmd === "logout") return logout(f);
  if (cmd === "whoami") return out(await call(f, "GET", "/operator/me"));
  if (cmd !== "jobs") throw new CliError(`unknown command: ${cmd}\n\n${USAGE}`, { code: "usage", exit: 2 });

  const q = (o) => {
    const s = new URLSearchParams(Object.entries(o).filter(([, v]) => v !== undefined)).toString();
    return s ? `?${s}` : "";
  };
  const job = (x) => `/operator/jobs/${encodeURIComponent(need(x, "job id"))}`;
  switch (sub) {
    case "create": return create(f);
    case "list": return out(await call(f, "GET", `/operator/jobs${q({ state: f.state, limit: f.limit })}`));
    case "get": return out(await call(f, "GET", job(id) + q({ wait_seconds: f.wait })));
    case "watch": return watch(f, need(id, "job id"));
    case "events": return out(await call(f, "GET", `${job(id)}/events${q({ after: f.after, limit: f.limit })}`));
    case "instruct": return out(await call(f, "POST", `${job(id)}/instructions`, { text: need(rest.join(" "), "instruction text") }));
    case "stop": return out(await call(f, "POST", `${job(id)}/stop`));
    case "code": return out(await call(f, "POST", `${job(id)}/code`));
    default: throw new CliError(`unknown jobs command: ${sub ?? "(none)"}\n\n${USAGE}`, { code: "usage", exit: 2 });
  }
}

main(process.argv.slice(2)).catch((e) => {
  if (!(e instanceof CliError)) throw e;
  process.stderr.write(JSON.stringify({ error: e.message, code: e.code, ...(e.status ? { status: e.status } : {}) }) + "\n");
  process.exit(e.exit);
});
