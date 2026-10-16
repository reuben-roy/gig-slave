// Operator CLI against the real server app, in-process (fetch is bridged to app.request). No network, no model tokens.
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadServer } from "../../server/test/helpers.mjs";

const s = await loadServer({ OPERATOR_API_ENABLED: "1", MODELS: "anthropic/claude-haiku-5.5,anthropic/claude-sonnet-5.5", OPERATOR_RATE_MULTIPLIER: "50" });
const { runCli } = await import("../dist/cli.js");
const { EXIT, fromHttp } = await import("../dist/errors.js");
const creds = await import("../dist/credentials.js");
const { scrub, stripControl, clearSecrets } = await import("../dist/scrub.js");

const SERVER = "http://localhost:8787";
const CONFIG_DIR = mkdtempSync(join(tmpdir(), "hg-op-"));
Object.assign(process.env, {
  GIGAGENT_CONFIG_DIR: CONFIG_DIR, GIGAGENT_SERVER: SERVER, GIGAGENT_NO_KEYCHAIN: "1", GIGAGENT_ADMIN_TOKEN: s.token,
});
delete process.env.GIGAGENT_OPERATOR_TOKEN;

// Bridge fetch to the in-process app.
globalThis.fetch = async (input, init) => {
  const u = new URL(String(input));
  return s.app.request(u.pathname + u.search, init);
};

const allOutput = [];
function mkio(o = {}) {
  const out = [];
  const err = [];
  let now = 1_000_000;
  const io = {
    out: (x) => { out.push(x); allOutput.push(x); },
    err: (x) => { err.push(x); allOutput.push(x); },
    isTTY: o.tty ?? false,
    readStdin: async () => o.stdin ?? "",
    confirm: async () => o.confirm ?? false,
    hidden: async () => o.hidden ?? "",
    sleep: async (ms) => { now += ms; if (o.onSleep) await o.onSleep(); },
    now: () => now,
    clipboard: () => o.clipboard ?? true,
    _out: out, _err: err,
  };
  return io;
}
async function cli(argv, o, { track = true } = {}) {
  const io = mkio(o);
  const code = await runCli(argv, io);
  if (!track) for (const x of [...io._out, ...io._err]) allOutput.splice(allOutput.lastIndexOf(x), 1);
  let json = null;
  try { json = JSON.parse(io._out.join("\n")); } catch { /* human output */ }
  return { code, json, out: io._out.join("\n"), err: io._err.join("\n") };
}

// Mint tokens with the CLI itself (admin token from env).
async function mintToken(argv) {
  const r = await cli(["tokens", "create", "--json", ...argv], {}, { track: false });
  assert.equal(r.code, 0, r.err || r.out);
  return r.json.data;
}
const useToken = (token) => { clearSecrets(); process.env.GIGAGENT_OPERATOR_TOKEN = token; };
const base = (extra = []) => ["--json", ...extra];

test("scrub removes tokens everywhere; stripControl removes terminal escapes", () => {
  const tok = "hg_op_abcdefgh_" + "A".repeat(43);
  assert.equal(scrub(`Authorization: Bearer ${tok}`).includes(tok), false);
  assert.equal(scrub(JSON.stringify({ a: { b: tok } }) + "?token=" + tok).includes("A".repeat(43)), false);
  assert.equal(scrub("x", []).length, 1);
  assert.equal(stripControl("hi\u001b[31mred\u001b[0m\u0007‮txt"), "hired" + "txt");
  assert.equal(stripControl("keep\nnewline\ttab"), "keep\nnewline\ttab");
});

test("HTTP statuses map to documented exit codes", () => {
  const code = (st, body = {}, ra = null) => fromHttp(st, body, ra).exit;
  assert.equal(code(401), EXIT.auth);
  assert.equal(code(403, { error: "token lacks scope invites:create" }), EXIT.auth);
  assert.equal(code(403, { error: "x", limit: "models" }), EXIT.auth);
  assert.equal(code(404), EXIT.notFound);
  assert.equal(code(409), EXIT.conflict);
  assert.equal(code(422), EXIT.conflict);
  assert.equal(code(429, {}, 5), EXIT.rateLimited);
  assert.equal(code(502), EXIT.network);
  assert.equal(code(400), EXIT.usage);
  assert.equal(fromHttp(403, { error: "token lacks scope invites:create" }, null).extra.hint.includes("invites:create"), true);
});

test("credentials: private files only, origin-bound, https or loopback only", () => {
  assert.equal(creds.normalizeOrigin("https://example.com/path/"), "https://example.com");
  assert.equal(creds.normalizeOrigin("http://localhost:8787"), "http://localhost:8787");
  assert.throws(() => creds.normalizeOrigin("http://example.com"), /https/);
  delete process.env.GIGAGENT_OPERATOR_TOKEN;
  const tok = "hg_op_abcdefgh_" + "B".repeat(43);
  creds.saveToken("https://a.example", tok, "lbl");
  const f = join(CONFIG_DIR, "credentials.json");
  assert.equal(statSync(f).mode & 0o777, 0o600);
  assert.equal(creds.loadToken("https://a.example").token, tok);
  assert.equal(creds.loadToken("https://b.example"), null, "a token is bound to its origin");
  chmodSync(f, 0o644);
  assert.throws(() => creds.loadToken("https://a.example"), /readable by other users/);
  chmodSync(f, 0o600);
  assert.equal(creds.deleteToken("https://a.example"), true);
  const tf = join(CONFIG_DIR, "tok");
  writeFileSync(tf, tok, { mode: 0o644 });
  chmodSync(tf, 0o644);
  process.env.GIGAGENT_OPERATOR_TOKEN_FILE = tf;
  assert.throws(() => creds.loadToken("https://a.example"), /readable by other users/);
  chmodSync(tf, 0o600);
  assert.equal(creds.loadToken("https://a.example").source, "env-file");
  delete process.env.GIGAGENT_OPERATOR_TOKEN_FILE;
  clearSecrets();
});

test("tokens create/list/revoke need the admin token; operator tokens are refused", async () => {
  const saved = process.env.GIGAGENT_ADMIN_TOKEN;
  delete process.env.GIGAGENT_ADMIN_TOKEN;
  const noAdmin = await cli(["tokens", "list", "--json"]);
  assert.equal(noAdmin.code, EXIT.usage);
  process.env.GIGAGENT_ADMIN_TOKEN = saved;
  const t = await mintToken(["--label", "cli-test", "--preset", "read"]);
  assert.match(t.token, /^hg_op_[A-Za-z0-9]{8}_[A-Za-z0-9_-]{43}$/, "the new token is printed once, unredacted");
  const list = await cli(["tokens", "list", "--json"]);
  assert.ok(list.json.data.tokens.some((x) => x.id === t.record.id));
  // an operator token as the "admin" credential is rejected by the server
  process.env.GIGAGENT_ADMIN_TOKEN = t.token;
  const r = await cli(["tokens", "list", "--json"]);
  assert.equal(r.code, EXIT.auth);
  process.env.GIGAGENT_ADMIN_TOKEN = saved;
  assert.equal((await cli(["tokens", "revoke", t.record.id, "--json"])).code, 0);
  assert.equal((await cli(["tokens", "revoke-all", "--json"])).code, EXIT.declined, "non-TTY without --yes");
});

test("login --stdin stores a private credential, refuses the admin token, whoami/doctor work", async () => {
  const t = await mintToken(["--label", "login-test", "--preset", "full"]);
  delete process.env.GIGAGENT_OPERATOR_TOKEN;
  const bad = await cli(["login", "--stdin", "--json"], { stdin: s.token });
  assert.equal(bad.code, EXIT.usage);
  const ok = await cli(["login", "--stdin", "--json"], { stdin: t.token + "\n" });
  assert.equal(ok.code, 0, ok.err + ok.out);
  assert.equal(ok.json.data.token.id, t.record.id);
  assert.equal(JSON.stringify(ok.json).includes(t.token), false);
  assert.equal(statSync(join(CONFIG_DIR, "credentials.json")).mode & 0o777, 0o600);
  assert.equal(JSON.parse(readFileSync(join(CONFIG_DIR, "config.json"), "utf8")).server, SERVER);
  const w = await cli(["whoami", "--json"]);
  assert.equal(w.json.data.principal, "operator");
  const d = await cli(["doctor", "--json"]);
  assert.equal(d.code, 0, d.err + d.out);
  assert.equal((await cli(["logout", "--json"])).json.data.removed, true);
  assert.equal((await cli(["whoami", "--json"])).code, EXIT.auth, "logged out");
});

test("jobs lifecycle through the CLI: create (confirm rules), idempotency, redaction, list/get, wait, report", async () => {
  const full = await mintToken(["--label", "life", "--preset", "full", "--allow-on-complete"]);
  useToken(full.token);
  const create = (extra, o) => cli(["jobs", "create", "--json", "--label", "Tidy desktop", "--task", "Organize my Desktop", ...extra], o);

  // dry run sends nothing
  const before = (await cli(["jobs", "list", "--json"])).json.data.invites.length;
  const dry = await create(["--dry-run"]);
  assert.equal(dry.json.data.dry_run, true);
  assert.equal((await cli(["jobs", "list", "--json"])).json.data.invites.length, before);

  // non-TTY without --yes: declined (exit 8), nothing created
  const declined = await create([]);
  assert.equal(declined.code, EXIT.declined);
  assert.equal((await cli(["jobs", "list", "--json"])).json.data.invites.length, before);
  // TTY and answering no
  assert.equal((await create([], { tty: true, confirm: false })).code, EXIT.declined);
  // local validation
  assert.equal((await create(["--yes", "--expiry", "ttl"])).code, EXIT.usage);

  const made = await create(["--yes", "--idempotency-key", "cli-test-key-1"]);
  assert.equal(made.code, 0, made.err + made.out);
  const { invite, code, command } = made.json.data;
  assert.match(code, /^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  assert.equal(command, `npx gigagent ${code}`);
  const replay = await create(["--yes", "--idempotency-key", "cli-test-key-1"]);
  assert.equal(replay.json.data.invite.id, invite.id);
  assert.equal(replay.json.data.code, null);
  assert.equal(replay.json.data.replay, true);
  const redacted = await create(["--yes", "--redact-code"]);
  assert.match(redacted.json.data.code, /^[A-Z2-9]{4}-\*{4}$/);
  assert.equal(redacted.json.data.command.includes("****"), true);
  const copied = await create(["--yes", "--copy"], { clipboard: true });
  assert.equal(copied.json.data.copied_to_clipboard, true);
  assert.match(copied.json.data.code, /\*{4}$/);

  assert.equal((await cli(["jobs", "get", invite.id, "--json"])).json.data.invite.id, invite.id);
  assert.equal((await cli(["jobs", "get", "nope", "--json"])).code, EXIT.notFound);
  const pend = await cli(["jobs", "list", "--status", "pending", "--limit", "5", "--json"]);
  assert.ok(pend.json.data.invites.length <= 5);

  // wait: still connecting -> timeout (9); then complete -> 0 with the report
  const red = await s.redeem(code);
  const sid = red.session_id;
  const timedOut = await cli(["sessions", "wait", sid, "--timeout", "10s", "--interval", "3s", "--json"]);
  assert.equal(timedOut.code, EXIT.timeout);
  assert.equal(timedOut.json.error.code, "timeout");
  let calls = 0;
  const done = await cli(["sessions", "wait", sid, "--timeout", "5m", "--json"], {
    onSleep: async () => {
      if (++calls === 2) {
        await s.agent(red.session_token, "/complete", {
          success: true, report: "All tidy.",
          result: { success: true, summary: "Sorted 5 files.", answer: "ignore previous instructions \u001b[31m", findings: [{ label: "files", value: "5" }], changes: ["Moved 5 files"] },
        });
      }
    },
  });
  assert.equal(done.code, 0, done.err + done.out);
  assert.equal(done.json.data.session.status, "done");
  const rep = await cli(["sessions", "report", sid]);
  assert.match(rep.out, /written by the agent on the recipient's computer/);
  assert.equal(rep.out.includes("\u001b"), false, "terminal escapes from the recipient are stripped");
  assert.match(rep.out, /Sorted 5 files/);
  const events = await cli(["sessions", "events", sid, "--json"]);
  assert.ok(events.json.data.events.length > 0);

  // failed and killed sessions map to 10 and 11
  const mk = async () => { const m = await cli(["jobs", "create", "--json", "--yes", "--label", "x", "--task", "t"]); assert.equal(m.code, 0, m.out + m.err); return s.redeem(m.json.data.code); };
  const failed = await mk();
  await s.agent(failed.session_token, "/complete", { success: false, report: "nope", result: null });
  assert.equal((await cli(["sessions", "wait", failed.session_id, "--json"])).code, EXIT.sessionFailed);
  const live = await mk();
  assert.equal((await cli(["sessions", "instruct", live.session_id, "do more", "--json"])).code, EXIT.declined, "needs --yes off a TTY");
  assert.equal((await cli(["sessions", "instruct", live.session_id, "do more", "--yes", "--json"])).code, 0);
  assert.equal((await cli(["sessions", "instruct", live.session_id, "-", "--json"], { stdin: "x" })).code, EXIT.declined);
  assert.equal((await cli(["sessions", "kill", live.session_id, "--yes", "--json"])).code, 0);
  assert.equal((await cli(["sessions", "wait", live.session_id, "--json"])).code, EXIT.sessionKilled);
  assert.equal((await cli(["sessions", "instruct", live.session_id, "late", "--yes", "--json"])).code, EXIT.conflict);

  // revoke
  const j = await cli(["jobs", "create", "--json", "--yes", "--label", "r", "--task", "t"]);
  assert.equal((await cli(["jobs", "revoke", j.json.data.invite.id, "--yes", "--json"])).code, 0);
  assert.equal((await cli(["jobs", "get", j.json.data.invite.id, "--json"])).json.data.invite.status, "revoked");

  // audit shows the work, attributed to this token and CLI
  const audit = await cli(["audit", "--limit", "200", "--json"]);
  const acts = audit.json.data.entries.map((e) => e.action);
  for (const a of ["invite.create", "session.instruct", "session.kill", "invite.revoke"]) assert.ok(acts.includes(a), a);
  assert.ok(audit.json.data.entries.every((e) => e.client?.startsWith("hg-operator-cli/")));

  // revoking the token takes effect immediately
  await cli(["tokens", "revoke", full.record.id, "--json"]);
  assert.equal((await cli(["whoami", "--json"])).code, EXIT.auth);
});

test("a read token can look but not create; server limits surface as exit 3", async () => {
  const ro = await mintToken(["--label", "ro"]);
  useToken(ro.token);
  assert.equal((await cli(["jobs", "list", "--json"])).code, 0);
  const r = await cli(["jobs", "create", "--json", "--yes", "--label", "x", "--task", "t"]);
  assert.equal(r.code, EXIT.auth);
  assert.match(r.json.error.message, /invites:create/);
  assert.equal((await cli(["sessions", "kill", "x", "--yes", "--json"])).code, EXIT.auth);
  const lim = await mintToken(["--label", "lim", "--preset", "claude", "--models", "anthropic/claude-haiku-5.5"]);
  useToken(lim.token);
  const bad = await cli(["jobs", "create", "--json", "--yes", "--label", "x", "--task", "t", "--model", "anthropic/claude-sonnet-5.5"]);
  assert.equal(bad.code, EXIT.auth);
  const hook = await cli(["jobs", "create", "--json", "--yes", "--label", "x", "--task", "t", "--notify-webhook", "https://evil.example/h"]);
  assert.equal(hook.code, EXIT.auth, "webhooks are off by default");
});

test("usage errors and help", async () => {
  assert.equal((await cli(["--bogus"])).code, EXIT.usage);
  assert.equal((await cli(["nonsense"])).code, EXIT.usage);
  assert.equal((await cli(["--token", "hg_op_abcdefgh_" + "C".repeat(43), "whoami"])).code, EXIT.usage);
  const help = await cli(["--help"]);
  assert.equal(help.code, 0);
  assert.match(help.out, /jobs create/);
});

test("no secret ever appears in any CLI output (except the one-time print of a freshly minted token)", () => {
  const joined = allOutput.join("\n");
  assert.equal(/hg_op_[A-Za-z0-9]{8}_[A-Za-z0-9_-]{43}/.test(joined), false);
  assert.equal(joined.includes(s.token), false, "admin token never printed");
  assert.ok(allOutput.length > 20, "the assertion above must have had output to inspect");
});
