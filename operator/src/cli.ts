import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { Client } from "./client.js";
import {
  adminTokenFromEnv, deleteToken, loadToken, normalizeOrigin, OPERATOR_TOKEN_RE, promptHidden, resolveServer,
  saveServer, saveToken,
} from "./credentials.js";
import { CliError, EXIT, usage } from "./errors.js";
import {
  fmtAudit, fmtEvent, fmtInvite, fmtJobs, fmtReport, fmtSession, fmtToken, parseDuration,
} from "./format.js";
import { CLI_NAME, CLIENT_TAG, VERSION } from "./names.js";
import * as ops from "./ops.js";
import { scrub, stripControl } from "./scrub.js";

export interface IO {
  out(s: string): void;
  err(s: string): void;
  isTTY: boolean;
  readStdin(): Promise<string>;
  confirm(question: string): Promise<boolean>;
  hidden(question: string): Promise<string>;
  sleep(ms: number): Promise<void>;
  now(): number;
  clipboard(text: string): boolean;
}

const OPTIONS = {
  json: { type: "boolean" }, server: { type: "string" }, quiet: { type: "boolean" }, debug: { type: "boolean" },
  timeout: { type: "string" }, "no-color": { type: "boolean" }, help: { type: "boolean", short: "h" },
  version: { type: "boolean" }, yes: { type: "boolean", short: "y" }, stdin: { type: "boolean" },
  "allow-admin-token": { type: "boolean" },
  label: { type: "string" }, task: { type: "string" }, "task-file": { type: "string" }, dir: { type: "string" },
  model: { type: "string" }, expiry: { type: "string" }, "ttl-hours": { type: "string" },
  "max-redemptions": { type: "string" }, "notify-email": { type: "string" }, "notify-webhook": { type: "string" },
  "idempotency-key": { type: "string" }, "dry-run": { type: "boolean" }, copy: { type: "boolean" },
  "redact-code": { type: "boolean" },
  status: { type: "string" }, limit: { type: "string" }, since: { type: "string" }, after: { type: "string" },
  follow: { type: "boolean" }, interval: { type: "string" },
  preset: { type: "string" }, scopes: { type: "string" }, "expires-in-days": { type: "string" },
  "never-expires": { type: "boolean" }, models: { type: "string" }, "max-ttl-hours": { type: "string" },
  "invites-per-day": { type: "string" }, "max-redemptions-cap": { type: "string" },
  "allow-webhook-host": { type: "string", multiple: true }, "allow-email": { type: "string", multiple: true },
  "allow-on-complete": { type: "boolean" }, save: { type: "boolean" },
  token: { type: "string" }, action: { type: "string" },
} as const;

type Opts = ReturnType<typeof parseArgs<{ options: typeof OPTIONS; allowPositionals: true }>>["values"];

const HELP = `${CLI_NAME} ${VERSION}: operate Hired Gun jobs from a terminal

Usage: ${CLI_NAME} <command> [options]        (add --json for machine-readable output)

  login [--server URL] [--stdin]           save an operator token (hidden prompt; never a flag)
  logout | whoami | doctor | config
  jobs list [--status a,b] [--limit N] [--since 24h]
  jobs get <job-id>
  jobs create --label TEXT (--task TEXT | --task-file PATH | --task -) [--dir PATH] [--model ID]
              [--expiry one_use|on_complete|ttl] [--ttl-hours N] [--max-redemptions N]
              [--notify-email ADDR] [--notify-webhook URL] [--dry-run] [--yes] [--copy] [--redact-code]
  jobs revoke <job-id> [--yes]
  sessions get|report <session-id>
  sessions events <session-id> [--after N] [--limit N] [--follow]
  sessions instruct <session-id> (TEXT | -) [--yes]
  sessions kill <session-id> [--yes]
  sessions wait <session-id> [--timeout 30m] [--interval 3s]
  tokens create --label TEXT [--preset read|claude|operate|full | --scopes a,b] [--expires-in-days N]
                [--models a,b] [--max-ttl-hours N] [--invites-per-day N] [--allow-webhook-host H] [--allow-email A] [--save]
  tokens list | revoke <token-id> | revoke-all [--yes]       (need GIGAGENT_ADMIN_TOKEN; never stored)
  audit [--limit N] [--after ID] [--token ID] [--action NAME]
  mcp                                       stdio MCP server for Claude and other MCP clients

Server: --server, GIGAGENT_SERVER, or the saved login. Token: GIGAGENT_OPERATOR_TOKEN, GIGAGENT_OPERATOR_TOKEN_FILE,
macOS Keychain (service gigagent-operator, account = server origin), or the saved login.
Exit codes: 0 ok, 2 usage, 3 auth/limit, 4 not found, 5 conflict, 6 rate limited, 7 network/server, 8 declined,
9 wait timeout, 10 session failed, 11 session killed.`;

interface Result {
  data: unknown;
  text: string;
  /** The command already wrote its own output (NDJSON stream, MCP); print no envelope. */
  silent?: boolean;
  /** Only `tokens create`: the output legitimately contains a brand-new token, printed once. */
  allowToken?: boolean;
}

const intOpt = (v: string | undefined, name: string, min = 1, max = Number.MAX_SAFE_INTEGER) => {
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw usage(`--${name} must be an integer from ${min} to ${max}`);
  return n;
};
const dur = (v: string | undefined, name: string, dflt: number) => {
  if (v === undefined) return dflt;
  try {
    return parseDuration(v, `--${name}`);
  } catch (e) {
    throw usage((e as Error).message);
  }
};
const list = (v: string | undefined) => (v ? v.split(",").map((s) => s.trim()).filter(Boolean) : undefined);

export async function runCli(argv: string[], io: IO): Promise<number> {
  let json = argv.includes("--json");
  const secretsInOutput: string[] = [];
  const out = (s: string) => io.out(scrub(s));
  try {
    let parsed;
    try {
      parsed = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true, strict: true });
    } catch (e) {
      throw usage((e as Error).message, `run \`${CLI_NAME} --help\``);
    }
    const o = parsed.values;
    const pos = parsed.positionals;
    json = Boolean(o.json);
    if (o.version) {
      out(`${CLI_NAME} ${VERSION}`);
      return EXIT.ok;
    }
    if (o.help || pos.length === 0 || pos[0] === "help") {
      out(HELP);
      return EXIT.ok;
    }
    if (o.token && /^hg_op_/.test(o.token)) throw usage("never pass a token on the command line; use `login` or GIGAGENT_OPERATOR_TOKEN");

    const res = await dispatch(pos, o, io);
    if (res.silent) return EXIT.ok;
    const emit = (x: string) => io.out(res.allowToken ? scrub(x, [], { pattern: false }) : scrub(x));
    if (json) emit(JSON.stringify({ ok: true, data: res.data }));
    else if (res.text) emit(res.text);
    return EXIT.ok;
  } catch (e) {
    const err = e instanceof CliError ? e : new CliError("error", e instanceof Error ? e.message : String(e));
    const detail = (err.extra as any).data;
    if (json) {
      out(JSON.stringify({ ok: false, error: err.toJSON(), ...(detail !== undefined ? { data: detail } : {}) }));
    } else {
      io.err(scrub(`Error: ${stripControl(err.message)}${err.extra.hint ? `\n  ${stripControl(err.extra.hint)}` : ""}`, secretsInOutput));
    }
    return err.exit;
  }
}

// ---------- client construction ----------

function timeoutMs(o: Opts) {
  return dur(o.timeout, "timeout", 30_000);
}

function operatorClient(o: Opts, requestTimeoutMs?: number): Client {
  const origin = resolveServer(o.server);
  const t = loadToken(origin);
  if (!t) throw new CliError("unauthorized", `not logged in to ${origin}`, { hint: `run \`${CLI_NAME} login --server ${origin}\`` });
  return new Client({ server: origin, token: t.token, timeoutMs: requestTimeoutMs ?? timeoutMs(o), clientTag: CLIENT_TAG });
}

async function adminClient(o: Opts, io: IO): Promise<Client> {
  const origin = resolveServer(o.server);
  let token = adminTokenFromEnv();
  if (!token) {
    if (!io.isTTY) throw usage("admin commands need GIGAGENT_ADMIN_TOKEN in the environment", "it is never stored or accepted as a flag");
    token = await io.hidden("Admin token (input hidden, not stored): ");
  }
  if (!token) throw usage("no admin token given");
  return new Client({ server: origin, token, timeoutMs: timeoutMs(o), clientTag: CLIENT_TAG });
}

async function confirmOrThrow(o: Opts, io: IO, summary: string, question: string) {
  if (o.yes) return;
  if (!io.isTTY) {
    throw new CliError("declined", "confirmation required: re-run with --yes to proceed without a prompt", {
      hint: "this command changes state on the server",
    });
  }
  io.err(summary);
  if (!(await io.confirm(question))) throw new CliError("declined", "cancelled; nothing was changed");
}

// ---------- dispatcher ----------

async function dispatch(pos: string[], o: Opts, io: IO): Promise<Result> {
  const [group, sub, ...rest] = pos;
  const need = (v: string | undefined, what: string) => {
    if (!v) throw usage(`${what} is required`);
    return v;
  };

  switch (group) {
    case "login": return login(o, io);
    case "logout": {
      const origin = resolveServer(o.server);
      const removed = deleteToken(origin);
      return { data: { removed, server: origin }, text: removed ? `Removed the saved token for ${origin}. (It is still valid on the server until revoked.)` : `No saved token for ${origin}.` };
    }
    case "whoami": {
      const w = await ops.whoami(operatorClient(o));
      return { data: w, text: fmtWho(w) };
    }
    case "config": {
      const c = await ops.getConfig(operatorClient(o));
      return { data: c, text: `Server ${c.public_url}\nDefault model: ${c.default_model}\nModels: ${c.models.join(", ")}\nNotifications: email ${c.notifications.email ? "on" : "off"}, webhook ${c.notifications.webhook ? "on" : "off"}` };
    }
    case "doctor": return doctor(o);
    case "jobs":
    case "job": return jobs(sub, rest, o, io, need);
    case "sessions":
    case "session": return sessions(sub, rest, o, io, need);
    case "tokens":
    case "token": return tokens(sub, rest, o, io, need);
    case "audit": {
      const c = operatorClient(o);
      const r = await c.request("GET", "/api/audit", {
        query: { limit: intOpt(o.limit, "limit", 1, 200), after: intOpt(o.after, "after", 0), token_id: o.token, action: o.action },
      });
      return { data: r.json, text: r.json.entries.length ? r.json.entries.map(fmtAudit).join("\n") : "No audit entries." };
    }
    case "mcp": {
      const { runMcp } = await import("./mcp.js");
      await runMcp({ server: o.server });
      return { data: null, text: "", silent: true };
    }
    default: throw usage(`unknown command "${group}"`, `run \`${CLI_NAME} --help\``);
  }
}

function fmtWho(w: any) {
  if (w.principal === "admin") return "Signed in with the MASTER ADMIN token. Use a scoped operator token for day-to-day work.";
  const t = w.token;
  return `Operator token ${t.id} "${stripControl(t.label)}"\nScopes: ${t.scopes.join(", ")}\nExpires: ${t.expires_at ? new Date(t.expires_at).toISOString() : "never"}\nLimits: ${JSON.stringify(t.limits)}\nServer: ${w.server.public_url}`;
}

async function login(o: Opts, io: IO): Promise<Result> {
  const origin = resolveServer(o.server);
  const token = (o.stdin ? (await io.readStdin()).trim() : await io.hidden("Operator token (input hidden): ")).trim();
  if (!token) throw usage("no token given");
  if (!OPERATOR_TOKEN_RE.test(token) && !o["allow-admin-token"]) {
    throw usage(
      "that does not look like an operator token (hg_op_...)",
      "mint one with `tokens create`; the master admin token is refused unless --allow-admin-token (not recommended)",
    );
  }
  const c = new Client({ server: origin, token, timeoutMs: timeoutMs(o), clientTag: CLIENT_TAG });
  const w = await ops.whoami(c);
  if (w.principal === "admin" && !o["allow-admin-token"]) throw new CliError("forbidden", "that is the master admin token", { hint: "use a scoped operator token" });
  saveToken(origin, token, w.token?.label);
  saveServer(origin);
  return { data: { server: origin, principal: w.principal, token: w.token }, text: `Logged in to ${origin}\n${fmtWho(w)}` };
}

async function doctor(o: Opts): Promise<Result> {
  const origin = resolveServer(o.server);
  const checks: { name: string; ok: boolean; detail: string }[] = [];
  const add = (name: string, ok: boolean, detail: string) => checks.push({ name, ok, detail });
  try {
    const t0 = Date.now();
    const res = await fetch(new URL("/health", origin), { signal: AbortSignal.timeout(timeoutMs(o)), redirect: "error" });
    add("server reachable", res.ok, `${origin} answered ${res.status} in ${Date.now() - t0} ms`);
    const dateHdr = res.headers.get("date");
    if (dateHdr) {
      const skew = Math.abs(Date.now() - Date.parse(dateHdr));
      add("clock skew", skew < 120_000, `${Math.round(skew / 1000)} s`);
    }
  } catch (e) {
    add("server reachable", false, scrub(e instanceof Error ? e.message : String(e)));
  }
  const t = loadToken(origin);
  add("token found", Boolean(t), t ? `source: ${t.source}` : "none (run login)");
  if (t) {
    const c = new Client({ server: origin, token: t.token, timeoutMs: timeoutMs(o), clientTag: CLIENT_TAG });
    try {
      const w = await ops.whoami(c);
      add("token valid", true, w.principal === "admin" ? "MASTER ADMIN token (switch to a scoped token)" : `${w.token.id} scopes: ${w.token.scopes.join(", ")}`);
      try {
        const cfg = await ops.getConfig(c);
        add("models", true, cfg.models.join(", "));
      } catch (e) {
        add("models", false, (e as Error).message);
      }
    } catch (e) {
      add("token valid", false, (e as Error).message);
    }
  }
  const ok = checks.every((c) => c.ok);
  const text = checks.map((c) => `${c.ok ? "ok  " : "FAIL"} ${c.name}: ${c.detail}`).join("\n");
  if (!ok) throw new CliError("error", "doctor found problems", { data: { checks }, hint: text });
  return { data: { checks }, text };
}

// ---------- jobs ----------

async function readTask(o: Opts, io: IO): Promise<{ task: string; fromStdin: boolean }> {
  const given = [o.task !== undefined, o["task-file"] !== undefined].filter(Boolean).length;
  if (given !== 1) throw usage("give exactly one of --task, --task-file or --task -");
  if (o["task-file"]) {
    try {
      return { task: readFileSync(o["task-file"], "utf8"), fromStdin: false };
    } catch (e) {
      throw usage(`cannot read ${o["task-file"]}: ${(e as Error).message}`);
    }
  }
  if (o.task === "-") return { task: await io.readStdin(), fromStdin: true };
  return { task: o.task!, fromStdin: false };
}

async function jobs(sub: string | undefined, rest: string[], o: Opts, io: IO, need: (v: string | undefined, w: string) => string): Promise<Result> {
  switch (sub) {
    case "list":
    case "ls": {
      const since = o.since ? Date.now() - dur(o.since, "since", 0) : undefined;
      const inv = await ops.listJobs(operatorClient(o), { status: list(o.status), limit: intOpt(o.limit, "limit", 1, 200) ?? 20, sinceMs: since });
      return { data: { invites: inv }, text: fmtJobs(inv) };
    }
    case "get": {
      const inv = await ops.getJob(operatorClient(o), need(rest[0], "job id"));
      return { data: { invite: inv }, text: fmtInvite(inv) };
    }
    case "create": return createJob(o, io);
    case "revoke": {
      const id = need(rest[0], "job id");
      await confirmOrThrow(o, io, `Revoke job ${id}? Live sessions on it will be stopped.`, "Revoke? [y/N] ");
      const r = await ops.revokeJob(operatorClient(o), id);
      return { data: r, text: `Revoked job ${id}.` };
    }
    default: throw usage(`unknown jobs command "${sub ?? ""}"`, "try: list, get, create, revoke");
  }
}

async function createJob(o: Opts, io: IO): Promise<Result> {
  const { task, fromStdin } = await readTask(o, io);
  const expiry = o.expiry ?? "one_use";
  const draft = ops.normalizeDraft({
    label: o.label, task, working_dir: o.dir, model: o.model, expiry_policy: expiry,
    ttl_hours: o["ttl-hours"], max_redemptions: o["max-redemptions"],
    notify_email: o["notify-email"], notify_webhook: o["notify-webhook"],
  });
  const c = operatorClient(o);
  let who: any = null;
  let cfg: any = null;
  try { who = await ops.whoami(c); } catch (e) { if (!(e instanceof CliError) || e.code !== "forbidden") throw e; }
  try { cfg = await ops.getConfig(c); } catch (e) { if (!(e instanceof CliError) || e.code !== "forbidden") throw e; }
  const problems = ops.limitsProblems(draft, who, cfg);
  if (problems.length) throw new CliError("limit", problems.join("; "), { hint: "adjust the job or ask the admin for a token with higher limits" });
  if (o["dry-run"]) {
    return { data: { dry_run: true, request: draft, server: c.server }, text: `Dry run: would create\n${JSON.stringify(draft, null, 2)}` };
  }
  const summary = [
    "About to create a job (the code lets someone run an AI agent on their Mac):",
    `  label    ${stripControl(draft.label)}`,
    `  folder   ${draft.working_dir ?? "(server default, ~/Desktop)"}`,
    `  model    ${draft.model ?? cfg?.default_model ?? "(server default)"}`,
    `  expiry   ${draft.expiry_policy}${draft.ttl_hours ? ` ${draft.ttl_hours}h` : ""}${draft.max_redemptions ? `, max ${draft.max_redemptions} redemptions` : ""}`,
    `  notify   ${[draft.notify_email, draft.notify_webhook].filter(Boolean).join(", ") || "(none)"}`,
    `  task     ${stripControl(draft.task.slice(0, 300))}${draft.task.length > 300 ? "…" : ""}`,
  ].join("\n");
  if (fromStdin && !o.yes) throw new CliError("declined", "the task came from stdin, so there is no terminal to confirm on", { hint: "re-run with --yes" });
  await confirmOrThrow(o, io, summary, "Create this job? [y/N] ");
  const made = await ops.createJob(c, draft, o["idempotency-key"]);
  let code = made.code;
  let command = made.command;
  let copied = false;
  if (o.copy && command) {
    copied = io.clipboard(command);
    if (!copied) throw usage("--copy needs macOS (pbcopy)");
  }
  if (o["redact-code"] || copied) {
    if (code) code = ops.maskCode(code);
    if (command && made.code) command = command.replace(made.code, ops.maskCode(made.code));
  }
  const data = { ...made, code, command, copied_to_clipboard: copied };
  const lines = [`Created job ${made.invite.id}: ${stripControl(made.invite.label)}`];
  if (made.code === null) lines.push("This was a replay of an earlier request: the code was shown only the first time. Revoke the job and create a new one if you lost it.");
  else {
    lines.push(`Code:    ${code}`, `Send the person:  ${command}`);
    if (copied) lines.push("(The full command is on your clipboard.)");
  }
  return { data, text: lines.join("\n") };
}

// ---------- sessions ----------

const isTerminal = (s: any) => ops.TERMINAL.includes(s.status);

async function sessions(sub: string | undefined, rest: string[], o: Opts, io: IO, need: (v: string | undefined, w: string) => string): Promise<Result> {
  switch (sub) {
    case "get": {
      const r = await ops.getSession(operatorClient(o), need(rest[0], "session id"));
      return { data: r, text: fmtSession(r.session) };
    }
    case "report": {
      const r = await ops.getSession(operatorClient(o), need(rest[0], "session id"));
      return { data: { session_id: r.session.id, status: r.session.status, result: r.session.result, report: r.session.report }, text: fmtReport(r.session) };
    }
    case "events": return events(need(rest[0], "session id"), o, io);
    case "instruct": {
      const id = need(rest[0], "session id");
      let text = rest[1];
      let fromStdin = false;
      if (text === "-") { text = (await io.readStdin()).trim(); fromStdin = true; }
      if (!text) throw usage("instruction text is required (or - to read stdin)");
      if (fromStdin && !o.yes) throw new CliError("declined", "the text came from stdin, so there is no terminal to confirm on", { hint: "re-run with --yes" });
      await confirmOrThrow(o, io, `Send this instruction to session ${id}:\n  ${stripControl(text.slice(0, 500))}`, "Send? [y/N] ");
      const r = await ops.instruct(operatorClient(o), id, text);
      return { data: r, text: "Instruction queued; the agent receives it on its next heartbeat (within about 5 seconds)." };
    }
    case "kill": {
      const id = need(rest[0], "session id");
      await confirmOrThrow(o, io, `Stop session ${id}? The agent on the recipient's Mac is aborted.`, "Stop it? [y/N] ");
      const r = await ops.killSession(operatorClient(o), id);
      return { data: r, text: `Session ${id} stopped.` };
    }
    case "wait": return wait(need(rest[0], "session id"), o, io);
    default: throw usage(`unknown sessions command "${sub ?? ""}"`, "try: get, report, events, instruct, kill, wait");
  }
}

async function events(id: string, o: Opts, io: IO): Promise<Result> {
  const c = operatorClient(o);
  let after = intOpt(o.after, "after", 0) ?? 0;
  const limit = intOpt(o.limit, "limit", 1, 5000);
  const json = Boolean(o.json);
  if (!o.follow) {
    let evs = await ops.getEvents(c, id, after);
    if (limit) evs = evs.slice(0, limit);
    return { data: { events: evs, next_after: evs.length ? evs[evs.length - 1].id : after }, text: evs.length ? evs.map(fmtEvent).join("\n") : "No new events." };
  }
  // --follow: poll with backoff; NDJSON in --json mode. Stops when the session has ended and nothing new arrives.
  let interval = dur(o.interval, "interval", 3000);
  const maxInterval = Math.max(interval, 10_000);
  for (;;) {
    const evs = await ops.getEvents(c, id, after);
    for (const e of evs) {
      after = e.id;
      io.out(scrub(json ? JSON.stringify(e) : fmtEvent(e)));
    }
    const s = (await ops.getSession(c, id)).session;
    if (isTerminal(s) && evs.length === 0) break;
    interval = evs.length ? dur(o.interval, "interval", 3000) : Math.min(maxInterval, Math.round(interval * 1.3));
    await io.sleep(interval);
  }
  return { data: null, text: "", silent: true };
}

async function wait(id: string, o: Opts, io: IO): Promise<Result> {
  // For `wait`, --timeout is the overall deadline; each request gets its own fixed timeout.
  const c2 = operatorClient(o, 30_000);
  const limit = dur(o.timeout, "timeout", 30 * 60_000);
  let interval = dur(o.interval, "interval", 3000);
  const start = io.now();
  let lastText = "";
  for (;;) {
    const r = await ops.getSession(c2, id);
    const s = r.session;
    if (!o.quiet && !o.json && s.status_text && s.status_text !== lastText) {
      lastText = s.status_text;
      io.err(scrub(`[${s.status}] ${stripControl(s.status_text)}`));
    }
    if (isTerminal(s)) {
      const okRun = s.status === "done" && s.result?.success !== false;
      const data = { session: s, invite: r.invite };
      if (okRun) return { data, text: `Session ${id} finished: ${s.status}.\n${fmtReport(s)}` };
      if (s.status === "killed") throw new CliError("session_killed", `session ${id} was stopped`, { data });
      throw new CliError("session_failed", `session ${id} ended with status ${s.status}${s.status_text ? ` (${stripControl(s.status_text)})` : ""}`, { data });
    }
    if (io.now() - start >= limit) throw new CliError("timeout", `still ${s.status} after ${Math.round(limit / 1000)} s`, { data: { session: s } });
    await io.sleep(interval);
    interval = Math.min(10_000, Math.round(interval * 1.25));
  }
}

// ---------- tokens (admin) ----------

async function tokens(sub: string | undefined, rest: string[], o: Opts, io: IO, need: (v: string | undefined, w: string) => string): Promise<Result> {
  switch (sub) {
    case "create": {
      const label = need(o.label, "--label");
      const body: Record<string, unknown> = { label };
      if (o.scopes) body.scopes = list(o.scopes);
      else body.preset = o.preset ?? "read";
      if (o["never-expires"]) body.expires_in_days = null;
      else if (o["expires-in-days"] !== undefined) body.expires_in_days = Number(o["expires-in-days"]);
      const limits: Record<string, unknown> = {};
      if (o.models) limits.models = list(o.models);
      if (o["max-ttl-hours"]) limits.max_ttl_hours = Number(o["max-ttl-hours"]);
      if (o["invites-per-day"]) limits.invites_per_day = Number(o["invites-per-day"]);
      if (o["max-redemptions-cap"]) limits.max_redemptions = Number(o["max-redemptions-cap"]);
      if (o["allow-webhook-host"]) limits.webhook_hosts = o["allow-webhook-host"];
      if (o["allow-email"]) limits.notify_emails = o["allow-email"];
      if (o["allow-on-complete"]) limits.allow_on_complete = true;
      if (Object.keys(limits).length) body.limits = limits;
      const admin = await adminClient(o, io);
      const r = await admin.request("POST", "/api/operator-tokens", { body, allowTokenInResponse: true });
      const { token, record } = r.json as { token: string; record: any };
      if (o.save) {
        const origin = normalizeOrigin(admin.server);
        saveToken(origin, token, record.label);
        saveServer(origin);
        return { data: { record, saved: true }, text: `Created token ${record.id} "${stripControl(record.label)}" and saved it as this machine's login for ${origin}.\nScopes: ${record.scopes.join(", ")}` };
      }
      return {
        allowToken: true,
        data: { token, record },
        text: `Created token ${record.id} "${stripControl(record.label)}"\nScopes: ${record.scopes.join(", ")}\nExpires: ${record.expires_at ? new Date(record.expires_at).toISOString() : "never"}\n\nTOKEN (shown once, store it now):\n${token}\n\nSave it with:  ${CLI_NAME} login --stdin`,
      };
    }
    case "list": {
      const r = await (await adminClient(o, io)).request("GET", "/api/operator-tokens");
      return { data: r.json, text: r.json.tokens.length ? r.json.tokens.map(fmtToken).join("\n") : "No tokens." };
    }
    case "revoke": {
      const id = need(rest[0], "token id");
      await (await adminClient(o, io)).request("POST", `/api/operator-tokens/${encodeURIComponent(id)}/revoke`, { body: {} });
      return { data: { ok: true }, text: `Revoked token ${id}.` };
    }
    case "revoke-all": {
      await confirmOrThrow(o, io, "Revoke EVERY operator token?", "Revoke all? [y/N] ");
      const r = await (await adminClient(o, io)).request("POST", "/api/operator-tokens/revoke-all", { body: {} });
      return { data: r.json, text: `Revoked ${r.json.revoked} token(s).` };
    }
    default: throw usage(`unknown tokens command "${sub ?? ""}"`, "try: create, list, revoke, revoke-all");
  }
}

// ---------- default IO ----------

export function defaultIO(): IO {
  return {
    out: (s) => process.stdout.write(s.endsWith("\n") ? s : `${s}\n`),
    err: (s) => process.stderr.write(s.endsWith("\n") ? s : `${s}\n`),
    isTTY: Boolean(process.stdin.isTTY && process.stderr.isTTY),
    async readStdin() {
      const chunks: Buffer[] = [];
      for await (const c of process.stdin) chunks.push(c as Buffer);
      return Buffer.concat(chunks).toString("utf8");
    },
    async confirm(q) {
      const { createInterface } = await import("node:readline/promises");
      const rl = createInterface({ input: process.stdin, output: process.stderr });
      try {
        return /^y(es)?$/i.test((await rl.question(q)).trim());
      } finally {
        rl.close();
      }
    },
    hidden: promptHidden,
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    now: () => Date.now(),
    clipboard(text) {
      if (process.platform !== "darwin") return false;
      return spawnSync("pbcopy", { input: text }).status === 0;
    },
  };
}
