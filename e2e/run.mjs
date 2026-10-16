#!/usr/bin/env node
// End-to-end test: real server + real CLI, against the scripted mock upstream.
// Run with `npm run e2e` from the repo root. Exit 0 on pass, 1 on the first failure.

import { execFile, spawn } from "node:child_process";
import { existsSync, promises as fsp } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startMock } from "../mock/server.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const TMP = path.join(HERE, ".tmp");
const DESKTOP = path.join(TMP, "Desktop");
const CLI_TMP = path.join(TMP, "tmp");
const PGLITE_DIR = path.join(TMP, "pglite");
const OPERATOR_BIN = path.join(ROOT, "operator", "bin.mjs");
const OPERATOR_HOME = path.join(TMP, "operator-home");
const SERVER_ENTRY = path.join(ROOT, "server", "dist", "main.js");
const CLI_ENTRY = path.join(ROOT, "cli", "dist", "index.js");

const ADMIN_TOKEN = "e2e-admin";
const GATEWAY_KEY = "mock-gateway-key";
const UPSTREAM_KEY = "mock-upstream-key";
const MODEL = "anthropic/claude-haiku-5.5"; // routed to the AI gateway
const TTL_MODEL = "deepseek-flash"; // routed direct to the upstream
const CLI_VERSION = "0.2.0";
const CODE_RE = /^[A-Z2-9]{4}-[A-Z2-9]{4}$/;
const WEBHOOK_PATH = "/hook";
const MACHINE = {
  hostname: "e2e-mac",
  platform: "darwin",
  release: "e2e",
  arch: "arm64",
  username: "e2e",
};
const CHAT_BODY = {
  model: "whatever",
  messages: [{ role: "user", content: "hi" }],
  stream: false,
};
const DESKTOP_FILES = {
  "photo1.png": "fake png bytes, photo one\n",
  "photo2.jpg": "fake jpg bytes, photo two\n",
  "report.pdf": "%fake pdf report\n",
  "notes.txt": "notes: buy milk\n",
  "song.mp3": "fake mp3 bytes, song\n",
};

// Env vars that would make the e2e run depend on the developer's shell or .env.
const STRIPPED_ENV = [
  /^GIGAGENT_/,
  /^GIG_SLAVE_/,
  /^AI_GATEWAY_/,
  /^UPSTREAM_/,
  /^GATEWAY_EXTRA_BODY$/,
  /^DATABASE_URL$/,
  /^RESEND_/,
  /^NOTIFY_FROM$/,
  /^CRON_SECRET$/,
  /^ADMIN_TOKEN$/,
  /^PGLITE_DIR$/,
  /^DB_PATH$/,
  /^MODELS$/,
  /^DEFAULT_MODEL$/,
  /^PUBLIC_URL$/,
  /^PORT$/,
];

function baseEnv() {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (STRIPPED_ENV.some((re) => re.test(key))) continue;
    env[key] = value;
  }
  return env;
}

// ---------- failure plumbing ----------

class E2EFailure extends Error {
  constructor(step, message) {
    super(message);
    this.name = "E2EFailure";
    this.step = step;
  }
}

function assert(cond, step, msg) {
  if (!cond) throw new E2EFailure(step, msg);
}

async function step(name, fn) {
  try {
    await fn(name);
  } catch (err) {
    if (err instanceof E2EFailure) throw err;
    throw new E2EFailure(name, err?.message ?? String(err));
  }
  console.log(`✓ ${name}`);
}

class Tail {
  constructor(max = 64 * 1024) {
    this.max = max;
    this.text = "";
  }
  push(chunk) {
    this.text += chunk.toString("utf8");
    if (this.text.length > this.max) this.text = this.text.slice(-this.max);
  }
  tail(lines = 40) {
    return this.text.split("\n").slice(-lines).join("\n").trimEnd();
  }
}

// ---------- helpers ----------

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(fn, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  let lastErr = null;
  while (Date.now() < deadline) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (err) {
      if (err instanceof E2EFailure) throw err;
      lastErr = err;
    }
    await sleep(200);
  }
  const detail = lastErr ? ` (last error: ${lastErr.message})` : "";
  throw new Error(`timed out after ${timeoutMs}ms waiting for ${label}${detail}`);
}

async function api(method, p, body, token, timeoutMs = 10000) {
  const headers = {};
  if (body !== undefined) headers["content-type"] = "application/json";
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(`${state.serverUrl}${p}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { status: res.status, json, text };
}

async function fetchInvite(id) {
  const r = await api("GET", "/api/invites", undefined, ADMIN_TOKEN);
  if (r.status !== 200) throw new Error(`GET /api/invites returned ${r.status}`);
  return (r.json?.invites ?? []).find((i) => i.id === id) ?? null;
}

// Opens the admin SSE stream in the background and collects parsed messages.
// Tolerates `id:` and `retry:` fields and `: ping` keep-alive comments.
function openSse(url) {
  const ac = new AbortController();
  const conn = { ac, status: null, contentType: null, error: null, messages: [], lastId: null, retry: null };
  (async () => {
    try {
      const res = await fetch(url, { signal: ac.signal, headers: { accept: "text/event-stream" } });
      conn.status = res.status;
      conn.contentType = res.headers.get("content-type");
      if (!res.ok || !res.body) {
        conn.error = `HTTP ${res.status}`;
        return;
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");
        let idx;
        while ((idx = buf.indexOf("\n\n")) !== -1) {
          const frame = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          let event = "message";
          let id = null;
          const dataLines = [];
          for (const line of frame.split("\n")) {
            if (!line || line.startsWith(":")) continue; // keep-alive comments
            const colon = line.indexOf(":");
            const field = colon === -1 ? line : line.slice(0, colon);
            let value = colon === -1 ? "" : line.slice(colon + 1);
            if (value.startsWith(" ")) value = value.slice(1);
            if (field === "event") event = value.trim();
            else if (field === "data") dataLines.push(value);
            else if (field === "id") {
              id = value;
              conn.lastId = value;
            } else if (field === "retry") conn.retry = Number(value);
          }
          if (dataLines.length === 0) continue;
          const raw = dataLines.join("\n");
          let data;
          try {
            data = JSON.parse(raw);
          } catch {
            data = raw;
          }
          conn.messages.push({ event, id, data });
        }
      }
    } catch (err) {
      if (!ac.signal.aborted) conn.error = err.message;
    }
  })();
  return conn;
}

// Starts a tiny local HTTP listener standing in for a webhook receiver.
async function startWebhookListener() {
  const port = await freePort();
  const posts = [];
  const srv = createHttpServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      let json = null;
      try {
        json = JSON.parse(text);
      } catch {
        json = null;
      }
      posts.push({ method: req.method, url: req.url ?? "", contentType: req.headers["content-type"] ?? null, text, json });
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("ok");
    });
    req.on("error", () => res.destroy());
  });
  await new Promise((resolve, reject) => {
    srv.once("error", reject);
    srv.listen(port, "127.0.0.1", () => {
      srv.off("error", reject);
      resolve();
    });
  });
  return {
    url: `http://127.0.0.1:${port}${WEBHOOK_PATH}`,
    posts,
    close: () =>
      new Promise((resolve) => {
        srv.close(() => resolve());
        srv.closeAllConnections();
      }),
  };
}

// Only the mock's known keys are shown; anything else is redacted in messages.
function redactAuth(auth) {
  const known = [`Bearer ${GATEWAY_KEY}`, `Bearer ${UPSTREAM_KEY}`];
  if (typeof auth === "string" && auth.startsWith("Bearer ") && !known.includes(auth)) {
    return "\"Bearer <redacted>\"";
  }
  return JSON.stringify(auth);
}

function hasExited(child) {
  return child.exitCode !== null || child.signalCode !== null;
}

function waitExit(child, ms) {
  if (hasExited(child)) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), ms);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

async function stopChild(child, graceMs = 3000) {
  if (!child || hasExited(child)) return;
  child.kill("SIGTERM");
  if (!(await waitExit(child, graceMs))) {
    child.kill("SIGKILL");
    await waitExit(child, 2000);
  }
}

// Every child we spawn is tracked here so teardown and SIGINT can reach it.
const state = {
  serverUrl: "",
  server: null,
  mock: null,
  webhook: null,
  sse: null,
  lastCli: null,
  live: new Set(),
  logs: { build: new Tail(), server: new Tail() },
};

function spawnTracked(cmd, args, { cwd, env, tail }) {
  const child = spawn(cmd, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
  child.out = tail;
  const onData = (d) => tail.push(d);
  child.stdout.on("data", onData);
  child.stderr.on("data", onData);
  child.on("error", (err) => tail.push(Buffer.from(`[spawn error] ${err.message}\n`)));
  state.live.add(child);
  child.once("exit", () => state.live.delete(child));
  return child;
}

function runCli(code) {
  return spawnTracked(process.execPath, [CLI_ENTRY, code], {
    cwd: ROOT,
    env: { ...baseEnv(), GIGAGENT_SERVER: state.serverUrl, TMPDIR: CLI_TMP },
    tail: new Tail(),
  });
}

/** Runs the operator CLI (`hired-gun`) with an isolated credentials folder. Resolves with exit code and output. */
function runOperator(args, extraEnv = {}) {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [OPERATOR_BIN, ...args],
      {
        cwd: ROOT,
        env: { ...baseEnv(), HIRED_GUN_HOME: OPERATOR_HOME, HIRED_GUN_SERVER: state.serverUrl, ...extraEnv },
        timeout: 60000,
      },
      (err, stdout, stderr) => resolve({ code: err ? (err.code ?? 1) : 0, stdout, stderr }),
    );
  });
}

const parseJson = (text) => {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

function killAllNow() {
  for (const child of state.live) {
    try {
      child.kill("SIGKILL");
    } catch {
      // already gone
    }
  }
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

async function runBuild() {
  const child = spawnTracked("npm", ["run", "build"], {
    cwd: ROOT,
    env: baseEnv(),
    tail: state.logs.build,
  });
  if (!(await waitExit(child, 180000))) {
    await stopChild(child);
    return { code: null, note: "timed out after 180s" };
  }
  return { code: child.exitCode, note: child.signalCode ? `signal ${child.signalCode}` : "" };
}

async function listTempLeftovers() {
  // CLI_TMP is only ever used as the CLI's TMPDIR in this run, so anything in it is a leftover.
  return fsp.readdir(CLI_TMP);
}

function printTail(title, tail) {
  console.error(`--- ${title} ---`);
  console.error(tail.tail(40) || "(no output)");
}

function printLogs(failedStep) {
  if (failedStep && failedStep.startsWith("build")) printTail("build output", state.logs.build);
  if (state.logs.server.text) printTail("server output (last lines)", state.logs.server);
  if (state.lastCli) printTail("CLI output (last lines)", state.lastCli.out);
}

// State shared between steps of the main organize run.
const inv1 = { id: null, code: null, sessionId: null };

// ---------- steps ----------

async function runSteps() {
  await step("fixtures created", async (s) => {
    await fsp.rm(TMP, { recursive: true, force: true });
    await fsp.mkdir(DESKTOP, { recursive: true });
    await fsp.mkdir(CLI_TMP, { recursive: true });
    for (const [name, content] of Object.entries(DESKTOP_FILES)) {
      await fsp.writeFile(path.join(DESKTOP, name), content);
    }
    const names = (await fsp.readdir(DESKTOP)).sort().join(",");
    const expected = Object.keys(DESKTOP_FILES).sort().join(",");
    assert(names === expected, s, `Desktop fixture contains "${names}", expected "${expected}"`);
  });

  await step("build (npm run build)", async (s) => {
    const r = await runBuild();
    assert(r.code === 0, s, `npm run build failed (exit ${r.code}${r.note ? `, ${r.note}` : ""})`);
    assert(existsSync(SERVER_ENTRY), s, `${path.relative(ROOT, SERVER_ENTRY)} was not built`);
    assert(existsSync(CLI_ENTRY), s, `${path.relative(ROOT, CLI_ENTRY)} was not built`);
  });

  await step("mock upstream started", async (s) => {
    state.mock = await startMock({ apiKeys: [GATEWAY_KEY, UPSTREAM_KEY] });
    assert(/^http:\/\/127\.0\.0\.1:\d+\/v1$/.test(state.mock.url), s, `unexpected mock url ${state.mock.url}`);
  });

  await step("webhook listener started", async (s) => {
    state.webhook = await startWebhookListener();
    assert(state.webhook.url.startsWith("http://127.0.0.1:"), s, `unexpected webhook url ${state.webhook.url}`);
  });

  await step("server started", async (s) => {
    const port = await freePort();
    state.serverUrl = `http://127.0.0.1:${port}`;
    state.server = spawnTracked(process.execPath, [SERVER_ENTRY], {
      cwd: ROOT,
      env: {
        ...baseEnv(),
        PORT: String(port),
        ADMIN_TOKEN,
        PGLITE_DIR,
        MODELS: `${MODEL},${TTL_MODEL}`,
        DEFAULT_MODEL: MODEL,
        AI_GATEWAY_BASE_URL: state.mock.url,
        AI_GATEWAY_API_KEY: GATEWAY_KEY,
        UPSTREAM_BASE_URL: state.mock.url,
        UPSTREAM_API_KEY: UPSTREAM_KEY,
        PUBLIC_URL: state.serverUrl,
      },
      tail: state.logs.server,
    });
    await waitFor(async () => {
      if (hasExited(state.server)) {
        throw new E2EFailure(
          s,
          `server exited early (code ${state.server.exitCode}, signal ${state.server.signalCode})`,
        );
      }
      const r = await api("GET", "/api/config", undefined, ADMIN_TOKEN, 2000);
      return r.status === 200;
    }, 15000, "server GET /api/config to return 200");
  });

  await step("GET / serves the Hired Gun landing page", async (s) => {
    const r = await fetch(`${state.serverUrl}/`, { signal: AbortSignal.timeout(5000) });
    const contentType = r.headers.get("content-type") ?? "";
    const body = await r.text();
    assert(r.status === 200, s, `GET / returned ${r.status}`);
    assert(contentType.includes("text/html"), s, `GET / content-type is "${contentType}", expected text/html`);
    assert(body.includes("Hired Gun"), s, "GET / HTML does not contain \"Hired Gun\"");
  });

  await step("GET /dashboard serves the operator dashboard", async (s) => {
    const r = await fetch(`${state.serverUrl}/dashboard`, { signal: AbortSignal.timeout(5000) });
    const contentType = r.headers.get("content-type") ?? "";
    const body = await r.text();
    assert(r.status === 200, s, `GET /dashboard returned ${r.status}`);
    assert(contentType.includes("text/html"), s, `GET /dashboard content-type is "${contentType}", expected text/html`);
    assert(body.length > 0, s, "GET /dashboard body is empty");
  });

  await step("GET /assets/brand.css serves CSS", async (s) => {
    const r = await fetch(`${state.serverUrl}/assets/brand.css`, { signal: AbortSignal.timeout(5000) });
    const contentType = r.headers.get("content-type") ?? "";
    const body = await r.text();
    assert(r.status === 200, s, `GET /assets/brand.css returned ${r.status}`);
    assert(contentType.includes("text/css"), s, `brand.css content-type is "${contentType}", expected text/css`);
    assert(body.trim().length > 0, s, "brand.css is empty");
  });

  await step("GET /assets/stream-policy.js serves JavaScript (the dashboard needs it to open its stream)", async (s) => {
    const r = await fetch(`${state.serverUrl}/assets/stream-policy.js`, { signal: AbortSignal.timeout(5000) });
    const contentType = r.headers.get("content-type") ?? "";
    const body = await r.text();
    assert(r.status === 200, s, `GET /assets/stream-policy.js returned ${r.status}`);
    assert(contentType.includes("javascript"), s, `stream-policy.js content-type is "${contentType}"`);
    assert(body.includes("createStreamPolicy"), s, "stream-policy.js has unexpected content");
  });

  await step("admin API rejects requests without token", async (s) => {
    const r = await api("GET", "/api/invites");
    assert(r.status === 401, s, `GET /api/invites without token returned ${r.status}, expected 401`);
  });

  await step("SSE stream connected", async (s) => {
    state.sse = openSse(`${state.serverUrl}/api/stream?token=${ADMIN_TOKEN}`);
    await waitFor(() => state.sse.status !== null || state.sse.error, 5000, "SSE response headers");
    assert(
      state.sse.status === 200,
      s,
      `GET /api/stream returned ${state.sse.status}${state.sse.error ? ` (${state.sse.error})` : ""}`,
    );
    assert(
      (state.sse.contentType ?? "").includes("text/event-stream"),
      s,
      `SSE content-type is "${state.sse.contentType}"`,
    );
  });

  await step("invite created (one_use, with webhook)", async (s) => {
    const r = await api(
      "POST",
      "/api/invites",
      {
        label: "E2E Desktop",
        task: "Organize my Desktop into folders by type.",
        working_dir: DESKTOP,
        model: MODEL,
        expiry_policy: "one_use",
        notify_webhook: state.webhook.url,
      },
      ADMIN_TOKEN,
    );
    assert(r.status === 201, s, `POST /api/invites returned ${r.status}: ${r.text}`);
    const { invite, code, command } = r.json ?? {};
    assert(typeof code === "string" && CODE_RE.test(code), s, `code ${JSON.stringify(code)} does not match XXXX-XXXX`);
    assert(command === `npx gigagent ${code}`, s, `command is ${JSON.stringify(command)}, expected "npx gigagent ${code}"`);
    assert(invite?.id, s, "response has no invite.id");
    assert(invite.notify_webhook === state.webhook.url, s, `invite.notify_webhook is ${JSON.stringify(invite.notify_webhook)}`);
    inv1.id = invite.id;
    inv1.code = code;
  });

  await step("CLI redeemed code and exited 0", async (s) => {
    const cli = runCli(inv1.code);
    state.lastCli = cli;
    if (!(await waitExit(cli, 90000))) {
      await stopChild(cli);
      throw new E2EFailure(s, "CLI did not exit within 90s (killed it)");
    }
    assert(cli.exitCode === 0, s, `CLI exited with code ${cli.exitCode} (signal ${cli.signalCode})`);
  });

  await step("Desktop organized with originals intact", async (s) => {
    const moved = {
      "Pictures/photo1.png": "photo1.png",
      "Pictures/photo2.jpg": "photo2.jpg",
      "Documents/report.pdf": "report.pdf",
      "Documents/notes.txt": "notes.txt",
      "Music/song.mp3": "song.mp3",
    };
    for (const [rel, original] of Object.entries(moved)) {
      const p = path.join(DESKTOP, rel);
      assert(existsSync(p), s, `${rel} is missing`);
      const got = await fsp.readFile(p);
      assert(got.equals(Buffer.from(DESKTOP_FILES[original])), s, `${rel} content differs from the original`);
    }
    for (const name of Object.keys(DESKTOP_FILES)) {
      assert(!existsSync(path.join(DESKTOP, name)), s, `${name} is still at the top level of Desktop`);
    }
    const undoPath = path.join(DESKTOP, ".gigagent-undo.json");
    assert(existsSync(undoPath), s, ".gigagent-undo.json was not written");
    let undo;
    try {
      undo = JSON.parse(await fsp.readFile(undoPath, "utf8"));
    } catch (err) {
      throw new E2EFailure(s, `.gigagent-undo.json does not parse: ${err.message}`);
    }
    assert(Array.isArray(undo) && undo.length === 5, s, `undo log is not an array of 5 entries: ${JSON.stringify(undo)}`);
  });

  await step("dashboard shows completed invite, result and report", async (s) => {
    let inv = null;
    const deadline = Date.now() + 5000;
    for (;;) {
      inv = await fetchInvite(inv1.id);
      const done = (inv?.sessions ?? []).filter((x) => x.status === "done");
      if (inv?.status === "completed" && done.length === 1) break;
      if (Date.now() > deadline) break;
      await sleep(200);
    }
    assert(inv, s, "invite is missing from GET /api/invites");
    assert(inv.status === "completed", s, `invite status is "${inv.status}", expected "completed"`);
    const done = (inv.sessions ?? []).filter((x) => x.status === "done");
    const statuses = (inv.sessions ?? []).map((x) => x.status);
    assert(done.length === 1, s, `expected exactly one "done" session, got statuses [${statuses.join(", ")}]`);
    const sess = done[0];
    inv1.sessionId = sess.id;

    assert(typeof sess.report === "string" && sess.report.includes("Pictures"), s, `report is ${JSON.stringify(sess.report)}`);
    assert(sess.result && typeof sess.result === "object", s, `session result is ${JSON.stringify(sess.result)}`);
    assert(sess.report === sess.result.summary, s, `report ${JSON.stringify(sess.report)} differs from result.summary`);
    assert(sess.result.success === true, s, `result.success is ${sess.result.success}, expected true`);
    assert(
      typeof sess.result.answer === "string" && sess.result.answer.includes("5 files"),
      s,
      `result.answer is ${JSON.stringify(sess.result.answer)}`,
    );
    assert(
      Array.isArray(sess.result.findings) && sess.result.findings[0]?.label === "Files sorted",
      s,
      `result.findings is ${JSON.stringify(sess.result.findings)}`,
    );
    assert(
      Array.isArray(sess.result.changes) && sess.result.changes.length === 3,
      s,
      `result.changes has ${sess.result.changes?.length} entries, expected 3`,
    );
    assert(sess.actions >= 2, s, `session actions=${sess.actions}, expected >= 2`);
    assert(sess.tokens_in > 0, s, `session tokens_in=${sess.tokens_in}, expected > 0`);
    assert(sess.machine && sess.machine.hostname, s, `session machine.hostname missing: ${JSON.stringify(sess.machine)}`);

    const ev = await api("GET", `/api/sessions/${sess.id}/events`, undefined, ADMIN_TOKEN);
    assert(ev.status === 200, s, `GET /api/sessions/:id/events returned ${ev.status}`);
    const events = ev.json?.events ?? [];
    assert(
      events.some((e) => e.type === "tool_call" && e.data?.tool === "bash"),
      s,
      `no tool_call event with tool "bash" among ${events.length} events`,
    );
    assert(events.some((e) => e.type === "tool_result"), s, "no tool_result event");
    assert(events.some((e) => e.type === "report"), s, "no report event");

    await waitFor(
      () => state.sse.messages.some((m) => m.event === "event"),
      5000,
      "an 'event' message on the admin SSE stream",
    );
    await waitFor(
      () => state.sse.messages.some((m) => m.event === "session" && m.data?.id === sess.id),
      5000,
      `a 'session' message for ${sess.id} on the admin SSE stream`,
    );
  });

  await step("report and notification events recorded", async (s) => {
    const sessionId = inv1.sessionId;
    assert(sessionId, s, "no session id from the organize run");
    const events = await waitFor(
      async () => {
        const ev = await api("GET", `/api/sessions/${sessionId}/events`, undefined, ADMIN_TOKEN);
        const list = ev.json?.events ?? [];
        return list.some((e) => e.type === "notification") ? list : null;
      },
      5000,
      "a notification event for the organize session",
    );
    const report = events.find((e) => e.type === "report");
    assert(report, s, "no report event");
    assert(
      report.data?.result && typeof report.data.result === "object",
      s,
      `report event data.result is ${JSON.stringify(report.data?.result)}`,
    );
    const notif = events.find((e) => e.type === "notification" && e.data?.channel === "webhook");
    assert(notif, s, "no webhook notification event");
    assert(notif.data.ok === true, s, `webhook notification ok=${notif.data.ok} detail=${notif.data.detail}`);
  });

  await step("webhook received exactly one gigagent.session.ended POST", async (s) => {
    await waitFor(() => state.webhook.posts.length >= 1, 5000, "the webhook POST");
    await sleep(500); // give a duplicate, if any, time to arrive
    const posts = state.webhook.posts.filter((p) => p.method === "POST");
    assert(posts.length === 1, s, `webhook received ${posts.length} POSTs, expected exactly 1`);
    const body = posts[0].json;
    assert(body && typeof body === "object", s, `webhook body is not JSON: ${posts[0].text.slice(0, 200)}`);
    assert(body.type === "gigagent.session.ended", s, `webhook type is ${JSON.stringify(body.type)}`);
    assert(body.invite?.id === inv1.id, s, `webhook invite.id is ${JSON.stringify(body.invite?.id)}`);
    assert(body.session?.id === inv1.sessionId, s, `webhook session.id is ${JSON.stringify(body.session?.id)}`);
    assert(body.result?.success === true, s, `webhook result.success is ${JSON.stringify(body.result?.success)}`);
    assert(
      typeof body.result?.answer === "string" && body.result.answer.includes("5 files"),
      s,
      `webhook result.answer is ${JSON.stringify(body.result?.answer)}`,
    );
  });

  await step("proxy used the gateway key and forced the invite model", async (s) => {
    const reqs = state.mock.requests;
    assert(reqs.length >= 3, s, `mock upstream saw ${reqs.length} requests, expected >= 3`);
    reqs.forEach((r, i) => {
      assert(
        r.model === MODEL,
        s,
        `upstream request #${i} had model "${r.model}", expected "${MODEL}"`,
      );
      assert(
        r.auth === `Bearer ${GATEWAY_KEY}`,
        s,
        `upstream request #${i} had Authorization ${redactAuth(r.auth)}, expected the gateway key`,
      );
    });
  });

  await step("one_use code cannot be redeemed again", async (s) => {
    const r = await api(
      "POST",
      "/agent/redeem",
      { code: inv1.code, machine: MACHINE, cli_version: CLI_VERSION },
      undefined,
    );
    assert(r.status === 403, s, `second redeem returned ${r.status}, expected 403: ${r.text}`);
  });

  await step("CLI temp dir removed after run", async (s) => {
    const left = await listTempLeftovers();
    assert(left.length === 0, s, `leftover entries in ${CLI_TMP}: ${left.join(", ")}`);
  });

  await step("expired ttl session gets 403 from /v1; heartbeat says kill", async (s) => {
    const created = await api(
      "POST",
      "/api/invites",
      {
        label: "E2E TTL",
        task: "Organize my Desktop into folders by type.",
        working_dir: DESKTOP,
        model: TTL_MODEL,
        expiry_policy: "ttl",
        ttl_hours: 0.0007,
      },
      ADMIN_TOKEN,
    );
    assert(created.status === 201, s, `POST /api/invites (ttl) returned ${created.status}: ${created.text}`);
    const { invite, code } = created.json;
    const expiresAt = invite.expires_at;
    assert(typeof expiresAt === "number", s, `invite.expires_at is ${JSON.stringify(expiresAt)}`);

    const red = await api("POST", "/agent/redeem", { code, machine: MACHINE, cli_version: CLI_VERSION });
    assert(red.status === 200, s, `redeem returned ${red.status}: ${red.text}`);
    const token = red.json?.session_token;
    assert(typeof token === "string" && token.length > 0, s, "redeem response has no session_token");

    assert(Date.now() < expiresAt, s, "ttl window (~2.5s) elapsed before the first /v1 call; machine too slow");
    const before = await api("POST", "/v1/chat/completions", CHAT_BODY, token);
    assert(before.status === 200, s, `/v1 call before expiry returned ${before.status}: ${before.text}`);
    const last = state.mock.requests.at(-1);
    assert(last?.model === TTL_MODEL, s, `upstream saw model "${last?.model}", expected forced "${TTL_MODEL}"`);
    assert(
      last?.auth === `Bearer ${UPSTREAM_KEY}`,
      s,
      `upstream saw Authorization ${redactAuth(last?.auth)}, expected the upstream key for a bare model id`,
    );

    const wait = expiresAt + 3000 - Date.now();
    if (wait > 0) await sleep(wait);

    const after = await api("POST", "/v1/chat/completions", CHAT_BODY, token);
    assert(after.status === 403, s, `/v1 call after expiry returned ${after.status}, expected 403`);

    const hb = await api("POST", "/agent/heartbeat", { status: "idle", status_text: "e2e" }, token);
    assert(hb.status === 200, s, `heartbeat after expiry returned ${hb.status}: ${hb.text}`);
    assert(hb.json?.kill === true, s, `heartbeat after expiry returned kill=${hb.json?.kill}, expected true`);
  });

  await step("kill stops the CLI and removes its temp dir", async (s) => {
    const created = await api(
      "POST",
      "/api/invites",
      {
        label: "E2E Kill",
        task: "[e2e:slow] Please wait.",
        working_dir: DESKTOP,
        model: MODEL,
        expiry_policy: "one_use",
      },
      ADMIN_TOKEN,
    );
    assert(created.status === 201, s, `POST /api/invites (slow) returned ${created.status}: ${created.text}`);
    const { invite, code } = created.json;

    const cli = runCli(code);
    state.lastCli = cli;
    let sessionId = null;
    await waitFor(async () => {
      if (hasExited(cli)) {
        throw new E2EFailure(
          s,
          `CLI exited early (code ${cli.exitCode}, signal ${cli.signalCode}) before the session started working`,
        );
      }
      const inv = await fetchInvite(invite.id);
      const sess = inv?.sessions?.[0];
      if (!sess) return false;
      sessionId = sess.id;
      if (sess.status === "working") return true;
      const ev = await api("GET", `/api/sessions/${sess.id}/events`, undefined, ADMIN_TOKEN);
      return (ev.json?.events ?? []).some((e) => e.type === "tool_call");
    }, 20000, "the slow session to start working");

    const kill = await api("POST", `/api/sessions/${sessionId}/kill`, {}, ADMIN_TOKEN);
    assert(kill.status === 200 && kill.json?.ok === true, s, `kill returned ${kill.status}: ${kill.text}`);

    if (!(await waitExit(cli, 20000))) {
      await stopChild(cli);
      throw new E2EFailure(s, "CLI did not exit within 20s after kill (killed it)");
    }
    assert(cli.exitCode !== 0, s, "CLI exited with code 0 after kill, expected a nonzero exit");

    let status = null;
    await waitFor(async () => {
      const inv = await fetchInvite(invite.id);
      status = inv?.sessions?.[0]?.status ?? null;
      return status && !["connecting", "working", "idle"].includes(status);
    }, 5000, "the killed session to reach a final status");
    assert(status === "killed", s, `session status is "${status}", expected "killed"`);

    const left = await listTempLeftovers();
    assert(left.length === 0, s, `leftover entries in ${CLI_TMP} after kill: ${left.join(", ")}`);
  });

  // ---------- operator journey: an agent uses only the `hired-gun` CLI and the MCP endpoint, never the dashboard ----------
  const op = { code: null, jobId: null };

  await step("operator CLI: login waits for a human, token is saved with owner-only permissions", async (s) => {
    const first = await runOperator(["login", "--no-wait", "--name", "e2e agent"]);
    assert(first.code === 0, s, `login --no-wait exited ${first.code}: ${first.stderr}`);
    const pending = parseJson(first.stdout);
    assert(pending?.status === "pending" && CODE_RE.test(pending.user_code), s, `unexpected login output: ${first.stdout}`);
    assert(!existsSync(path.join(OPERATOR_HOME, "credentials.json")), s, "credentials were saved before approval");
    const early = await runOperator(["whoami"]);
    assert(early.code === 3, s, `whoami before approval exited ${early.code}, expected 3`);

    const approve = await api("POST", `/api/enrollments/${pending.user_code}/approve`, { max_active_jobs: 3 }, ADMIN_TOKEN);
    assert(approve.status === 200, s, `approve returned ${approve.status}: ${approve.text}`);

    const done = await runOperator(["login"]);
    assert(done.code === 0, s, `login after approval exited ${done.code}: ${done.stderr}`);
    assert(parseJson(done.stdout)?.status === "approved", s, `unexpected login output: ${done.stdout}`);
    assert(!done.stdout.includes("hgo_"), s, "login printed the token");
    const mode = (await fsp.stat(path.join(OPERATOR_HOME, "credentials.json"))).mode & 0o777;
    assert(mode === 0o600, s, `credentials.json mode is ${mode.toString(8)}, expected 600`);

    const who = parseJson((await runOperator(["whoami"])).stdout);
    assert(who?.operator?.name === "e2e agent" && who.usage.active_jobs === 0, s, `whoami: ${JSON.stringify(who)}`);
  });

  await step("operator CLI: idempotent job creation returns the same job", async (s) => {
    const args = ["jobs", "create", "--key", "e2e-op-1", "--label", "Operator job", "--task", "Organize my Desktop into folders by type.", "--dir", DESKTOP, "--model", MODEL];
    const a = parseJson((await runOperator(args)).stdout);
    assert(a?.replayed === false && CODE_RE.test(a.code) && a.job?.state === "waiting_for_recipient", s, `create: ${JSON.stringify(a)}`);
    const b = parseJson((await runOperator(args)).stdout);
    assert(b?.replayed === true && b.code === null && b.job.id === a.job.id, s, `replay: ${JSON.stringify(b)}`);
    const listed = parseJson((await runOperator(["jobs", "list"])).stdout);
    assert(listed.jobs.length === 1, s, `expected exactly one job, got ${listed.jobs.length}`);
    op.code = a.code;
    op.jobId = a.job.id;
  });

  await step("operator CLI: watch follows the recipient's run to a structured result", async (s) => {
    const watching = runOperator(["jobs", "watch", op.jobId]);
    await sleep(1500); // let the watcher see the job waiting before the recipient shows up
    const cli = runCli(op.code);
    state.lastCli = cli;
    const watched = await watching;
    assert(watched.code === 0, s, `watch exited ${watched.code} (expected 0 = succeeded): ${watched.stderr}`);
    const lines = watched.stdout.trim().split("\n").map(parseJson);
    const final = lines.at(-1);
    assert(final?.final && final.job.state === "succeeded", s, `last line: ${JSON.stringify(final)?.slice(0, 300)}`);
    assert(lines[0]?.state === "waiting_for_recipient", s, `watch should start by reporting waiting_for_recipient, got ${JSON.stringify(lines[0])}`);
    const result = final.job.result;
    assert(result?.success === true && typeof result.summary === "string" && result.summary.length > 0, s, `result: ${JSON.stringify(result)}`);
    assert(Array.isArray(result.changes) && Array.isArray(result.findings), s, "result has no findings/changes arrays");
    assert(await waitExit(cli, 20000), s, "recipient CLI did not exit after the job finished");
  });

  await step("operator CLI: instruct and stop a running job; the recipient CLI stops", async (s) => {
    const created = parseJson((await runOperator(["jobs", "create", "--key", "e2e-op-2", "--label", "Slow", "--task", "[e2e:slow] Please wait.", "--dir", DESKTOP, "--model", MODEL])).stdout);
    assert(created?.job?.id, s, `create: ${JSON.stringify(created)}`);
    const early = await runOperator(["jobs", "instruct", created.job.id, "please", "hurry"]);
    assert(early.code === 1 && parseJson(early.stderr)?.code === "not_running", s, `instruct before a recipient connects: ${early.stderr}`);

    const cli = runCli(created.code);
    state.lastCli = cli;
    await waitFor(async () => {
      if (hasExited(cli)) throw new E2EFailure(s, "recipient CLI exited early");
      const j = parseJson((await runOperator(["jobs", "get", created.job.id])).stdout);
      return j?.job?.state === "running";
    }, 20000, "the job to be running");

    const sent = await runOperator(["jobs", "instruct", created.job.id, "also", "tidy", "Downloads"]);
    assert(sent.code === 0, s, `instruct exited ${sent.code}: ${sent.stderr}`);
    const events = parseJson((await runOperator(["jobs", "events", created.job.id])).stdout);
    assert(events.events.some((e) => e.type === "instruction" && e.data.text === "also tidy Downloads"), s, "instruction event missing");

    const stop = parseJson((await runOperator(["jobs", "stop", created.job.id])).stdout);
    assert(stop?.job?.state === "stopped", s, `stop: ${JSON.stringify(stop)?.slice(0, 300)}`);
    if (!(await waitExit(cli, 20000))) {
      await stopChild(cli);
      throw new E2EFailure(s, "recipient CLI did not exit within 20s after the operator stopped the job");
    }
    assert(cli.exitCode !== 0, s, "recipient CLI exited 0 after being stopped");
    const left = await listTempLeftovers();
    assert(left.length === 0, s, `leftover entries in ${CLI_TMP}: ${left.join(", ")}`);
  });

  await step("MCP endpoint serves the same account with the same token", async (s) => {
    const token = JSON.parse(await fsp.readFile(path.join(OPERATOR_HOME, "credentials.json"), "utf8")).token;
    const rpc = (id, method, params) => api("POST", "/mcp", { jsonrpc: "2.0", id, method, params }, token);
    const tools = await rpc(1, "tools/list");
    assert(tools.json?.result?.tools?.some((t) => t.name === "create_job"), s, `tools/list: ${tools.text.slice(0, 300)}`);
    const got = await rpc(2, "tools/call", { name: "get_job", arguments: { job_id: op.jobId } });
    assert(got.json?.result?.structuredContent?.job?.state === "succeeded", s, `get_job: ${got.text.slice(0, 300)}`);
    assert((await api("POST", "/mcp", { jsonrpc: "2.0", id: 3, method: "ping" })).status === 401, s, "unauthenticated MCP call was not rejected");
  });

  await step("operator CLI: logout revokes the token for good", async (s) => {
    const token = JSON.parse(await fsp.readFile(path.join(OPERATOR_HOME, "credentials.json"), "utf8")).token;
    const out = await runOperator(["logout"]);
    assert(out.code === 0, s, `logout exited ${out.code}: ${out.stderr}`);
    assert((await api("GET", "/operator/me", undefined, token)).status === 401, s, "the logged-out token still works");
    assert((await runOperator(["whoami"])).code === 3, s, "whoami after logout should exit 3");
  });

  await step("invalid code rejected with 401", async (s) => {
    const r = await api(
      "POST",
      "/agent/redeem",
      { code: "ZZZZ-ZZZZ", machine: MACHINE, cli_version: CLI_VERSION },
      undefined,
    );
    assert(r.status === 401, s, `redeem with invalid code returned ${r.status}, expected 401`);
  });
}

async function teardown() {
  if (state.sse) state.sse.ac.abort();
  if (state.server) await stopChild(state.server, 3000);
  await Promise.all([...state.live].map((child) => stopChild(child, 2000)));
  if (state.mock) await state.mock.close().catch(() => {});
  if (state.webhook) await state.webhook.close().catch(() => {});
}

async function main() {
  process.on("SIGINT", () => {
    killAllNow();
    console.error("\n✗ interrupted: child processes killed");
    process.exit(130);
  });
  process.on("SIGTERM", () => {
    killAllNow();
    process.exit(143);
  });

  const watchdog = setTimeout(() => {
    console.error("✗ overall: e2e exceeded its 240s budget");
    printLogs(null);
    killAllNow();
    process.exit(1);
  }, 240000);

  let failure = null;
  try {
    await runSteps();
  } catch (err) {
    failure = err;
  } finally {
    clearTimeout(watchdog);
    await teardown();
  }

  if (failure) {
    const failedStep = failure.step ?? "unexpected";
    console.error(`✗ ${failedStep}: ${failure.message}`);
    printLogs(failedStep);
    process.exit(1);
  }

  console.log("✓ e2e passed");
  process.exit(0);
}

main();
