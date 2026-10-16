import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { CliError, usage } from "./errors.js";
import { CLI_NAME, KEYCHAIN_SERVICE } from "./names.js";
import { registerSecret } from "./scrub.js";

export const OPERATOR_TOKEN_RE = /^hg_op_[A-Za-z0-9]{8}_[A-Za-z0-9_-]{43}$/;

const env = () => process.env;
export const configDir = () => env().GIGAGENT_CONFIG_DIR?.trim() || join(homedir(), ".config", "gigagent");

/** Normalise to an origin. Refuses plain http except for loopback (the token would travel in clear text). */
export function normalizeOrigin(raw: string): string {
  let u: URL;
  try {
    u = new URL(raw.includes("://") ? raw : `https://${raw}`);
  } catch {
    throw usage(`not a valid server URL: ${raw}`);
  }
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname);
  if (u.protocol !== "https:" && !(u.protocol === "http:" && loopback)) {
    throw usage("the server URL must be https:// (http:// is only allowed for localhost)");
  }
  return u.origin;
}

function assertPrivate(file: string, what: string) {
  const st = statSync(file);
  if (st.mode & 0o077) {
    throw new CliError("error", `${what} is readable by other users: ${file}`, { hint: `run: chmod 600 ${file}` });
  }
  if (typeof process.getuid === "function" && st.uid !== process.getuid()) {
    throw new CliError("error", `${what} is not owned by you: ${file}`);
  }
}

// ---------- non-secret config (server URL) ----------

const configFile = () => join(configDir(), "config.json");

export function readSavedServer(): string | null {
  try {
    const j = JSON.parse(readFileSync(configFile(), "utf8"));
    return typeof j.server === "string" ? j.server : null;
  } catch {
    return null;
  }
}

export function saveServer(origin: string) {
  mkdirSync(configDir(), { recursive: true, mode: 0o700 });
  writeFileSync(configFile(), JSON.stringify({ server: origin }, null, 2));
}

/** Server URL: --server, then GIGAGENT_SERVER, then the saved config. There is deliberately no baked default. */
export function resolveServer(flag?: string): string {
  const raw = flag?.trim() || env().GIGAGENT_SERVER?.trim() || readSavedServer();
  if (!raw) throw usage("no server configured", `run \`${CLI_NAME} login --server https://YOUR-SERVER\` or set GIGAGENT_SERVER`);
  return normalizeOrigin(raw);
}

// ---------- secrets ----------

const credsFile = () => join(configDir(), "credentials.json");

function readCreds(): Record<string, { token: string; label?: string; saved_at?: number }> {
  const f = credsFile();
  if (!existsSync(f)) return {};
  assertPrivate(f, "the credentials file");
  try {
    return JSON.parse(readFileSync(f, "utf8"));
  } catch {
    throw new CliError("error", `credentials file is not valid JSON: ${f}`);
  }
}

function writeCreds(data: Record<string, unknown>) {
  const dir = configDir();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = `${credsFile()}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, credsFile());
}

export function saveToken(origin: string, token: string, label?: string) {
  const all = readCreds();
  all[origin] = { token, label, saved_at: Date.now() };
  writeCreds(all);
}

export function deleteToken(origin: string): boolean {
  const all = readCreds();
  if (!(origin in all)) return false;
  delete all[origin];
  writeCreds(all);
  return true;
}

function keychainToken(origin: string): string | null {
  if (process.platform !== "darwin" || env().GIGAGENT_NO_KEYCHAIN === "1") return null;
  const r = spawnSync("security", ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", origin, "-w"], {
    encoding: "utf8", timeout: 5000,
  });
  if (r.status !== 0) return null;
  return r.stdout.trim() || null;
}

export interface LoadedToken {
  token: string;
  source: "env" | "env-file" | "keychain" | "file";
}

/**
 * Operator token for an origin. Never a command-line flag (argv is visible in `ps`).
 * Order: GIGAGENT_OPERATOR_TOKEN, GIGAGENT_OPERATOR_TOKEN_FILE, macOS Keychain, credentials file.
 */
export function loadToken(origin: string): LoadedToken | null {
  const found = ((): LoadedToken | null => {
    const e = env().GIGAGENT_OPERATOR_TOKEN?.trim();
    if (e) return { token: e, source: "env" };
    const f = env().GIGAGENT_OPERATOR_TOKEN_FILE?.trim();
    if (f) {
      assertPrivate(f, "the token file");
      return { token: readFileSync(f, "utf8").trim(), source: "env-file" };
    }
    const k = keychainToken(origin);
    if (k) return { token: k, source: "keychain" };
    const c = readCreds()[origin];
    return c?.token ? { token: c.token, source: "file" } : null;
  })();
  if (found) registerSecret(found.token);
  return found;
}

/** Master admin token, for `tokens ...` commands only. Env only (or a hidden prompt in the caller); never stored. */
export function adminTokenFromEnv(): string | null {
  const t = env().GIGAGENT_ADMIN_TOKEN?.trim();
  if (t) registerSecret(t);
  return t || null;
}

/** Read a line without echo from the terminal. */
export async function promptHidden(question: string): Promise<string> {
  const stdin = process.stdin;
  if (!stdin.isTTY) throw usage("no terminal available for a hidden prompt", "pipe the token with --stdin");
  process.stderr.write(question);
  return new Promise((resolve, reject) => {
    let buf = "";
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    const done = (fn: () => void) => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.off("data", onData);
      process.stderr.write("\n");
      fn();
    };
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === "\r" || ch === "\n") return done(() => resolve(buf.trim()));
        if (ch === "\u0003") return done(() => reject(new CliError("declined", "cancelled")));
        if (ch === "\u007f" || ch === "\b") buf = buf.slice(0, -1);
        else buf += ch;
      }
    };
    stdin.on("data", onData);
  });
}
