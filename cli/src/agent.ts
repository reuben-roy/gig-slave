import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Model } from "@mariozechner/pi-ai";
import {
  AuthStorage,
  createAgentSession,
  createExtensionRuntime,
  ModelRegistry,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type AgentSessionEvent,
  type ResourceLoader,
} from "@mariozechner/pi-coding-agent";

export const SYSTEM_PROMPT = `You are a careful helper working on someone's Mac. You are operated remotely, on behalf of a person they trust, to complete one task. The person at the computer is not technical and cannot answer questions, so do not ask any. Make sensible decisions and carry on.

You have four tools: read (read a file), write (create a file), edit (change part of a file) and bash (run a shell command). Your working folder is the current working directory.

Rules you must always follow:
- Stay inside the working folder. Never read, change or move anything outside it.
- Never delete anything. Do not use rm, do not empty the Trash, and never overwrite an existing file. If something has to go, move it into a folder inside the working folder instead. If a destination file already exists, pick a different name (for example add " 2").
- Keep a record of every move. The file ".gig-slave-undo.json" in the working folder must be a JSON array of objects like {"from": "old/relative/path", "to": "new/relative/path"}, using paths relative to the working folder. Create it if it does not exist, add to it after you move files, and keep it valid JSON and up to date. Do not list the undo file itself.
- No sudo, no installing software, no network access, no downloading or uploading anything.
- Be efficient. Look around once, make a plan, then do the work in as few bash commands as you reasonably can (batch many moves into one command, using mv -n so nothing is ever overwritten). Do not read the contents of files unless you need to.
- Leave hidden files, system files and folders you do not understand alone, unless the task says otherwise.
- Do not narrate every step. Keep text between tool calls to a minimum.

If the operator sends you an extra instruction while you work, follow it too, under the same rules.

When you are completely finished, reply with a short plain-English report for the person at the computer: what you did and what changed, in a few sentences, with no technical jargon and no code. Mention that the changes can be undone using the ".gig-slave-undo.json" file. That final reply is the report, so do not end on a tool call.`;

export type EventSink = (type: "status" | "tool_call" | "tool_result" | "assistant" | "error", data: Record<string, unknown>) => void;

export interface AgentOptions {
  cwd: string;
  agentDir: string;
  model: string;
  baseUrl: string;
  token: string;
  emit: EventSink;
  onChange: () => void;
}

export interface RunResult {
  success: boolean;
  report: string;
}

function clip(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

function clipArgs(args: unknown): unknown {
  if (typeof args === "string") return clip(args, 500);
  if (Array.isArray(args)) return args.slice(0, 20).map(clipArgs);
  if (args && typeof args === "object") {
    return Object.fromEntries(Object.entries(args).map(([k, v]) => [k, clipArgs(v)]));
  }
  return args;
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((c) => c && c.type === "text" && typeof c.text === "string")
    .map((c) => c.text)
    .join("\n");
}

function oneLine(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

export function describeTool(tool: string, args: any): string {
  const a = args ?? {};
  const file = typeof a.path === "string" ? a.path : typeof a.file_path === "string" ? a.file_path : "";
  switch (tool) {
    case "bash":
      return clip(`Running: ${oneLine(String(a.command ?? ""))}`, 60);
    case "write":
      return clip(`Writing ${file}`, 60);
    case "read":
      return clip(`Reading ${file}`, 60);
    case "edit":
      return clip(`Editing ${file}`, 60);
    default:
      return clip(`Using ${tool}`, 60);
  }
}

export class Agent {
  status: "working" | "idle" = "idle";
  statusText = "Starting…";
  actions = 0;

  private session!: AgentSession;
  private active = 0;
  private firstError: string | null = null;
  private disposed = false;
  private aborted = false;
  private unsubscribe: (() => void) | null = null;
  private idleWaiters: (() => void)[] = [];

  constructor(private opts: AgentOptions) {}

  async init(): Promise<void> {
    const { cwd, agentDir, model: modelId, baseUrl, token } = this.opts;

    const authStorage = AuthStorage.create(path.join(agentDir, "auth.json"));
    authStorage.setRuntimeApiKey("gig-slave", token);
    const modelRegistry = ModelRegistry.inMemory(authStorage);
    const settingsManager = SettingsManager.inMemory({
      compaction: { enabled: false },
      retry: { enabled: true, maxRetries: 2 },
    });

    const model: Model<"openai-completions"> = {
      id: modelId,
      name: modelId,
      api: "openai-completions",
      provider: "gig-slave",
      baseUrl,
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 200000,
      maxTokens: 16000,
      compat: {
        supportsStore: false,
        supportsDeveloperRole: false,
        supportsReasoningEffort: false,
        maxTokensField: "max_tokens",
      },
    };

    const resourceLoader: ResourceLoader = {
      getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }),
      getSkills: () => ({ skills: [], diagnostics: [] }),
      getPrompts: () => ({ prompts: [], diagnostics: [] }),
      getThemes: () => ({ themes: [], diagnostics: [] }),
      getAgentsFiles: () => ({ agentsFiles: [] }),
      getSystemPrompt: () => SYSTEM_PROMPT,
      getAppendSystemPrompt: () => [],
      extendResources: () => {},
      reload: async () => {},
    };

    const { session } = await createAgentSession({
      cwd,
      agentDir,
      model,
      thinkingLevel: "off",
      authStorage,
      modelRegistry,
      resourceLoader,
      tools: ["read", "write", "edit", "bash"],
      sessionManager: SessionManager.inMemory(cwd),
      settingsManager,
    });
    this.session = session;
    this.unsubscribe = session.subscribe((e) => this.onEvent(e));
  }

  private setStatus(status: "working" | "idle", text: string): void {
    const changed = status !== this.status || text !== this.statusText;
    this.status = status;
    this.statusText = text;
    if (changed) {
      this.opts.emit("status", { status, text });
      this.opts.onChange();
    }
  }

  private onEvent(e: AgentSessionEvent): void {
    switch (e.type) {
      case "agent_start":
        this.setStatus("working", "Thinking…");
        break;
      case "tool_execution_start":
        this.actions++;
        this.opts.emit("tool_call", { tool: e.toolName, args: clipArgs(e.args) });
        this.setStatus("working", describeTool(e.toolName, e.args));
        break;
      case "tool_execution_end":
        this.opts.emit("tool_result", {
          tool: e.toolName,
          ok: !e.isError,
          output: clip(textOf(e.result?.content ?? e.result), 2000),
        });
        this.setStatus("working", "Thinking…");
        break;
      case "message_end": {
        const m: any = e.message;
        if (m?.role !== "assistant") break;
        const text = textOf(m.content).trim();
        if (text) this.opts.emit("assistant", { text });
        if (m.stopReason === "error") {
          this.opts.emit("error", { message: String(m.errorMessage ?? "The model returned an error") });
        }
        break;
      }
      case "auto_retry_start":
        this.setStatus("working", `Retrying (${e.attempt}/${e.maxAttempts})…`);
        break;
      case "agent_end":
        this.setStatus("idle", "Finishing up…");
        break;
    }
  }

  /** Start a prompt in the background; tracks it so run() knows when everything is done. */
  private start(text: string): void {
    this.active++;
    this.setStatus("working", "Thinking…");
    this.session.prompt(text).then(
      () => {},
      (err) => {
        const msg = err instanceof Error ? err.message : String(err);
        this.firstError ??= msg;
        this.opts.emit("error", { message: msg });
      },
    ).finally(() => {
      this.active--;
      if (this.active === 0) this.wake();
    });
  }

  private wake(): void {
    const w = this.idleWaiters;
    this.idleWaiters = [];
    for (const f of w) f();
  }

  /** Operator instruction: queue it behind the current work, or start a new run if idle. */
  instruct(text: string): void {
    if (this.disposed) return;
    if (this.session.isStreaming) {
      this.session.followUp(text).catch((err) => {
        this.opts.emit("error", { message: err instanceof Error ? err.message : String(err) });
      });
    } else {
      this.start(text);
    }
  }

  async run(task: string): Promise<RunResult> {
    this.start(task);
    for (;;) {
      while (this.active > 0 && !this.disposed) {
        await new Promise<void>((r) => this.idleWaiters.push(r));
      }
      if (this.disposed) return { success: false, report: "Stopped." };
      // A follow-up that arrived just as the run ended may still be queued.
      if (!this.aborted && this.session.pendingMessageCount > 0 && !this.session.isStreaming) {
        const { steering, followUp } = this.session.clearQueue();
        this.start([...steering, ...followUp].join("\n\n"));
        continue;
      }
      break;
    }
    return this.result();
  }

  private result(): RunResult {
    const msgs = this.session.messages as any[];
    const last = [...msgs].reverse().find((m) => m.role === "assistant");
    if (this.firstError && !last) {
      return { success: false, report: `The helper could not complete the task: ${this.firstError}` };
    }
    if (!last) return { success: false, report: "The helper did not produce any answer." };
    if (last.stopReason === "error" || last.stopReason === "aborted") {
      const why = last.errorMessage ?? (last.stopReason === "aborted" ? "the run was stopped" : "an unknown error");
      return { success: false, report: `The helper could not complete the task: ${why}` };
    }
    const text = textOf(last.content).trim();
    return { success: true, report: text || "The task finished, but no written report was produced." };
  }

  async abort(): Promise<void> {
    this.aborted = true;
    try {
      this.session?.clearQueue();
      await this.session?.abort();
    } catch {
      // ignore
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.unsubscribe?.();
    try {
      this.session?.dispose();
    } catch {
      // ignore
    }
    this.wake();
  }
}

export async function resolveWorkingDir(input: string): Promise<string> {
  let p = input.trim();
  if (p === "~") p = os.homedir();
  else if (p.startsWith("~/")) p = path.join(os.homedir(), p.slice(2));
  if (!path.isAbsolute(p)) throw new Error(`The folder "${input}" is not a full path.`);
  let stat: fs.Stats;
  try {
    stat = await fs.promises.stat(p);
  } catch {
    throw new Error(`The folder "${p}" does not exist on this computer.`);
  }
  if (!stat.isDirectory()) throw new Error(`"${p}" is not a folder.`);
  // Reading it up front triggers macOS's "allow access to Desktop?" prompt before the agent starts.
  // Async, so heartbeats keep flowing while the person decides.
  try {
    await fs.promises.readdir(p);
  } catch (err: any) {
    if (err?.code === "EPERM" || err?.code === "EACCES") {
      throw new Error(
        `macOS didn't allow access to "${p}". Open System Settings → Privacy & Security → Files and Folders, allow Terminal to use that folder, then run the command again.`,
      );
    }
    throw err;
  }
  return fs.realpathSync(p);
}
