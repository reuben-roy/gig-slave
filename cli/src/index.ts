#!/usr/bin/env node
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import { Agent, resolveWorkingDir } from "./agent.js";
import { ApiClient, HttpError, NetworkError, type RedeemResult } from "./api.js";
import { Cleanup } from "./cleanup.js";
import { EventBuffer } from "./events.js";
import { resolveServerUrl } from "./server-url.js";
import { StatusUi } from "./ui.js";

const OFFLINE_LIMIT_MS = 5 * 60_000;
const MAX_CODE_TRIES = 3;

function cliVersion(): string {
  try {
    const dir = path.dirname(fileURLToPath(import.meta.url));
    return JSON.parse(fs.readFileSync(path.join(dir, "..", "package.json"), "utf8")).version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

/** Resolves null if the person presses Ctrl+C / Ctrl+D instead of answering. */
function ask(question: string): Promise<string | null> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    let answered = false;
    rl.question(question, (answer) => {
      answered = true;
      rl.close();
      resolve(answer.trim());
    });
    rl.on("close", () => {
      if (!answered) resolve(null);
    });
  });
}

function keepAwake(): void {
  if (process.platform !== "darwin") return;
  try {
    const child = spawn("caffeinate", ["-i", "-w", String(process.pid)], { stdio: "ignore", detached: false });
    child.on("error", () => {});
    child.unref();
  } catch {
    // ignore
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  const cleanup = new Cleanup();
  const api = new ApiClient(resolveServerUrl());
  const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
  let agent: Agent | null = null;
  let events: EventBuffer | null = null;
  let ui: StatusUi | null = null;
  let session: RedeemResult | null = null;
  let finishing = false;
  let online = true;
  let startedAt = Date.now();

  let hbTimer: NodeJS.Timeout | null = null;

  const finish = (code: number, message?: string): never => {
    finishing = true;
    if (hbTimer) clearTimeout(hbTimer);
    events?.stop();
    ui?.stop();
    agent?.dispose();
    if (message) console.log(message);
    if (cleanup.run()) console.log("gig-slave removed itself.");
    process.exit(code);
  };

  let signalled = false;
  const onSignal = async () => {
    if (signalled) return;
    signalled = true;
    finishing = true;
    ui?.stop();
    console.log("\nStopping…");
    await agent?.abort();
    if (session) {
      await api.complete(false, "Cancelled by the person at the computer.", 3000).catch(() => {});
    }
    finish(130);
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  process.on("SIGHUP", onSignal); // Terminal window closed
  process.on("exit", () => cleanup.run()); // last resort; synchronous and idempotent
  process.on("uncaughtException", async (err) => {
    if (session && !finishing) {
      await api.complete(false, `The helper crashed: ${err.message}`, 3000).catch(() => {});
    }
    finish(1, `Something went wrong: ${err.message}`);
  });
  process.on("unhandledRejection", (err) => {
    throw err instanceof Error ? err : new Error(String(err));
  });

  // --- redeem ---
  const machine = {
    hostname: os.hostname(),
    platform: process.platform,
    release: os.release(),
    arch: os.arch(),
    username: os.userInfo().username,
  };
  let code = (process.argv[2] ?? process.env.GIG_SLAVE_CODE ?? "").trim();

  if (api.baseUrl.includes("REPLACE-ME")) {
    finish(1, "This copy of gig-slave hasn't been set up with a server address yet. Please tell the person who sent it to you.");
  }

  const header = new StatusUi(() => ({ statusText: "", online: true, actions: 0, startedAt }));
  header.header();

  for (let attempt = 1; ; attempt++) {
    if (!code) {
      if (!interactive) finish(1, "No code given. Run: npx gig-slave ABCD-EFGH");
      const answer = await ask("Enter the code you were sent: ");
      if (answer === null) finish(130, "");
      code = answer ?? "";
      if (!code) continue;
    }
    try {
      session = await api.redeem(code, machine, cliVersion());
      break;
    } catch (err) {
      if (err instanceof NetworkError) {
        finish(1, "Couldn't reach the server. Please check your internet connection and try again.");
      }
      if (err instanceof HttpError) {
        if (err.status === 401) {
          if (!interactive || attempt >= MAX_CODE_TRIES) {
            finish(1, "That code wasn't recognised. Please check it and try again.");
          }
          console.log("That code wasn't recognised. Please check it and try again.");
          code = "";
          continue;
        }
        if (err.status === 403) {
          finish(1, "This code can no longer be used (it may have expired, been used already, or been cancelled).");
        }
        if (err.status === 429) {
          finish(1, "Too many wrong tries. Please wait about 10 minutes and try again.");
        }
        if (err.status >= 500) {
          finish(1, "The helper service isn't available right now. Please try again in a few minutes, or tell the person who sent you the code.");
        }
        finish(1, `The server said: ${err.message}`);
      }
      throw err;
    }
  }

  api.token = session.session_token;
  startedAt = Date.now();
  const s = session;

  // --- temp agent dir ---
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "gig-slave-"));
  cleanup.tmpDirs.push(agentDir);
  // Pi and the agent's shell put scratch files in os.tmpdir(); keep them inside the dir we remove.
  process.env.TMPDIR = agentDir;

  keepAwake();

  // --- heartbeat (starts right away so a slow macOS permission prompt doesn't look like a lost connection) ---
  let killed = false;
  let offlineReason = false;
  let offlineSince: number | null = null;
  let failures = 0;
  const early: string[] = []; // instructions that arrive before the agent exists
  const stopFor = (offline: boolean) => {
    killed = true;
    offlineReason = offline;
    if (agent) void agent.abort();
    else finish(offline ? 1 : 2, offline ? "Lost the connection for too long, so the helper stopped." : "Stopped by the operator.");
  };
  const beat = async () => {
    if (finishing) return;
    let next = s.heartbeat_ms;
    try {
      const res = await api.heartbeat(agent?.status ?? "connecting", agent?.statusText ?? "Starting…");
      if (!online) {
        online = true;
        ui?.changed();
      }
      offlineSince = null;
      failures = 0;
      if (res.kill) return stopFor(false);
      for (const i of res.instructions ?? []) {
        if (!agent) {
          early.push(i.text);
          continue;
        }
        events?.push("status", { status: agent.status, text: `New instruction: ${i.text.slice(0, 50)}` });
        agent.instruct(i.text);
      }
    } catch (err) {
      if (err instanceof HttpError && (err.status === 401 || err.status === 403)) return stopFor(false);
      failures++;
      offlineSince ??= Date.now();
      if (online) {
        online = false;
        ui?.changed();
      }
      if (Date.now() - offlineSince > OFFLINE_LIMIT_MS) return stopFor(true);
      next = Math.min(s.heartbeat_ms * 2 ** Math.min(failures, 5), 30_000);
    }
    hbTimer = setTimeout(beat, next);
  };
  hbTimer = setTimeout(beat, 0);

  // --- working dir ---
  let cwd: string;
  try {
    cwd = await resolveWorkingDir(s.working_dir);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await api.complete(false, msg).catch(() => {});
    finish(1, msg);
    return;
  }

  // --- wiring ---
  events = new EventBuffer(api);
  const buf = events;
  const view = () => ({
    statusText: agent?.statusText ?? "Starting…",
    online,
    actions: agent?.actions ?? 0,
    startedAt,
  });
  ui = new StatusUi(view);
  const screen = ui;

  agent = new Agent({
    cwd,
    agentDir,
    model: s.model,
    baseUrl: s.v1_base_url,
    token: s.session_token,
    emit: (type, data) => buf.push(type, data),
    onChange: () => screen.changed(),
  });
  const ag = agent;
  await ag.init();
  if (finishing) return;
  if (killed) finish(offlineReason ? 1 : 2, offlineReason ? "Lost the connection for too long, so the helper stopped." : "Stopped by the operator.");

  screen.connected(s.task);
  buf.start(1000);
  screen.start();

  // --- run ---
  const task = early.length ? `${s.task}\n\nExtra instructions from the operator:\n${early.join("\n")}` : s.task;
  const result = await ag.run(task);
  if (signalled) return; // onSignal reports and exits

  if (killed) {
    if (offlineReason) finish(1, "Lost the connection for too long, so the helper stopped.");
    finish(2, "Stopped by the operator.");
  }

  finishing = true;
  if (hbTimer) clearTimeout(hbTimer);
  buf.push("status", { status: result.success ? "done" : "failed", text: result.success ? "Finished" : "Failed" });
  await buf.flush();
  for (let i = 0; i < 3; i++) {
    try {
      await api.complete(result.success, result.report);
      break;
    } catch (err) {
      if (err instanceof HttpError || i === 2) break;
      await sleep(1000);
    }
  }

  if (result.success) {
    finish(0, "✓ Done. A report was sent to the person who asked for this. You can close this window.");
  }
  finish(1, `✗ The helper could not finish the task. ${result.report}`);
}

main().catch((err) => {
  console.error(`Something went wrong: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
