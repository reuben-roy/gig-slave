import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Type } from "typebox";
import { AuthStorage, createAgentSession, createExtensionRuntime, defineTool, ModelRegistry, SessionManager, SettingsManager, } from "@mariozechner/pi-coding-agent";
export const SYSTEM_PROMPT = `You are a careful helper working on someone's Mac. You were sent by a trusted person (the operator), who is not at this computer and will receive your report. The person sitting at the computer is not technical and cannot answer questions, so do not ask any. Make sensible decisions and carry on.

You have five tools: read (read a file), write (create a file), edit (change part of a file), bash (run a shell command) and submit_report (hand in your final report). Your working folder is the current working directory.

Rules you must always follow:
- Any change you make must stay inside the working folder. Never create, change, move or delete anything outside it.
- Never delete anything. Do not use rm, do not empty the Trash, and never overwrite an existing file. If something has to go, move it into a folder inside the working folder instead. If a destination file already exists, pick a different name (for example add " 2").
- Keep a record of every move. The file ".gigagent-undo.json" in the working folder must be a JSON array of objects like {"from": "old/relative/path", "to": "new/relative/path"}, using paths relative to the working folder. Create it if it does not exist, add to it after you move files, and keep it valid JSON and up to date. Do not list the undo file itself.
- No sudo, no installing software, no network access, no downloading or uploading anything.
- Be efficient. Look around once, make a plan, then do the work in as few bash commands as you reasonably can (batch many moves into one command, using mv -n so nothing is ever overwritten). Do not read the contents of files unless you need to.
- Leave hidden files, system files and folders you do not understand alone, unless the task says otherwise.
- Do not narrate every step. Keep text between tool calls to a minimum.

If the task asks for information (for example about this computer or about files in the working folder), find it and put the full answer in the "answer" field of your report: clear, complete, and Markdown is fine. Put the key facts in "findings" as short label/value pairs (for example label "macOS version", value "15.3"). To look up information about the computer you MAY run read-only commands even outside the working folder when the task needs it (for example sw_vers, df -h, system_profiler SPHardwareDataType, fdesetup status, uname -a, ls /Applications). Read-only means they must not change anything. Never change anything outside the working folder.

If the operator sends you an extra instruction while you work, follow it too, under the same rules.

When you are completely finished, call submit_report exactly once, as your very last action, and then stop. Its fields:
- success: true if you did what was asked, false if you could not.
- summary: a few plain-English sentences for the non-technical person at the computer: what you did and what changed, with no jargon and no code. If you moved anything, mention that it can be undone using the ".gigagent-undo.json" file in the working folder.
- answer: (optional) the information the task asked for, for the operator.
- findings: (optional) key facts as {label, value} pairs.
- changes: (optional) one short line per change you made, for example "Moved 23 screenshots into Screenshots/". Leave it out or empty if you changed nothing.`;
function failure(reason) {
    return { success: false, report: reason, result: { success: false, summary: reason, answer: null, findings: [], changes: [] } };
}
const str = (v) => (typeof v === "string" ? v : v == null ? "" : String(v));
/** Normalise whatever the model passed to submit_report into a Result. */
function toResult(p) {
    const findings = Array.isArray(p?.findings)
        ? p.findings
            .filter((f) => f && (f.label != null || f.value != null))
            .map((f) => ({ label: str(f.label), value: str(f.value) }))
        : [];
    const changes = Array.isArray(p?.changes) ? p.changes.map(str).filter((c) => c.trim()) : [];
    const answer = typeof p?.answer === "string" && p.answer.trim() ? p.answer : null;
    const summary = str(p?.summary).trim() || (p?.success === false ? "The task could not be completed." : "The task is finished.");
    return { success: p?.success !== false, summary, answer, findings, changes };
}
const SUBMIT_REPORT_TOOL = "submit_report";
function clip(s, n) {
    return s.length > n ? s.slice(0, n - 1) + "…" : s;
}
function clipArgs(args) {
    if (typeof args === "string")
        return clip(args, 500);
    if (Array.isArray(args))
        return args.slice(0, 20).map(clipArgs);
    if (args && typeof args === "object") {
        return Object.fromEntries(Object.entries(args).map(([k, v]) => [k, clipArgs(v)]));
    }
    return args;
}
function textOf(content) {
    if (typeof content === "string")
        return content;
    if (!Array.isArray(content))
        return "";
    return content
        .filter((c) => c && c.type === "text" && typeof c.text === "string")
        .map((c) => c.text)
        .join("\n");
}
function oneLine(s) {
    return s.replace(/\s+/g, " ").trim();
}
export function describeTool(tool, args) {
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
        case SUBMIT_REPORT_TOOL:
            return "Writing up the report";
        default:
            return clip(`Using ${tool}`, 60);
    }
}
export class Agent {
    opts;
    status = "idle";
    statusText = "Starting…";
    actions = 0;
    session;
    active = 0;
    firstError = null;
    disposed = false;
    aborted = false;
    unsubscribe = null;
    idleWaiters = [];
    submitted = null;
    constructor(opts) {
        this.opts = opts;
    }
    async init() {
        const { cwd, agentDir, model: modelId, baseUrl, token } = this.opts;
        const authStorage = AuthStorage.create(path.join(agentDir, "auth.json"));
        authStorage.setRuntimeApiKey("gigagent", token);
        const modelRegistry = ModelRegistry.inMemory(authStorage);
        const settingsManager = SettingsManager.inMemory({
            compaction: { enabled: false },
            retry: { enabled: true, maxRetries: 2 },
        });
        const model = {
            id: modelId,
            name: modelId,
            api: "openai-completions",
            provider: "gigagent",
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
        const submitReport = defineTool({
            name: SUBMIT_REPORT_TOOL,
            label: "Submit report",
            description: "Hand in your final report. Call this exactly once, as your very last action, when the task is finished (or cannot be finished).",
            parameters: Type.Object({
                success: Type.Boolean({ description: "true if you did what was asked, false if you could not" }),
                summary: Type.String({
                    description: "A few plain-English sentences for the non-technical person at the computer. Mention the undo file if you moved anything.",
                }),
                answer: Type.Optional(Type.String({ description: "The information the task asked for, for the operator. Clear and complete; Markdown is fine." })),
                findings: Type.Optional(Type.Array(Type.Object({ label: Type.String(), value: Type.String() }), {
                    description: "Key facts as label/value pairs, e.g. {label: 'macOS version', value: '15.3'}",
                })),
                changes: Type.Optional(Type.Array(Type.String(), { description: "One short line per change made, e.g. 'Moved 23 screenshots into Screenshots/'" })),
            }),
            execute: async (_id, params) => {
                this.submitted = toResult(params);
                return {
                    content: [{ type: "text", text: "Report received. You are finished; stop now." }],
                    details: undefined,
                    terminate: true,
                };
            },
        });
        const resourceLoader = {
            getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }),
            getSkills: () => ({ skills: [], diagnostics: [] }),
            getPrompts: () => ({ prompts: [], diagnostics: [] }),
            getThemes: () => ({ themes: [], diagnostics: [] }),
            getAgentsFiles: () => ({ agentsFiles: [] }),
            getSystemPrompt: () => SYSTEM_PROMPT,
            getAppendSystemPrompt: () => [],
            extendResources: () => { },
            reload: async () => { },
        };
        const { session } = await createAgentSession({
            cwd,
            agentDir,
            model,
            thinkingLevel: "off",
            authStorage,
            modelRegistry,
            resourceLoader,
            tools: ["read", "write", "edit", "bash", SUBMIT_REPORT_TOOL],
            customTools: [submitReport],
            sessionManager: SessionManager.inMemory(cwd),
            settingsManager,
        });
        this.session = session;
        this.unsubscribe = session.subscribe((e) => this.onEvent(e));
    }
    setStatus(status, text) {
        const changed = status !== this.status || text !== this.statusText;
        this.status = status;
        this.statusText = text;
        if (changed) {
            this.opts.emit("status", { status, text });
            this.opts.onChange();
        }
    }
    onEvent(e) {
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
                const m = e.message;
                if (m?.role !== "assistant")
                    break;
                const text = textOf(m.content).trim();
                if (text)
                    this.opts.emit("assistant", { text });
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
    start(text) {
        this.active++;
        this.setStatus("working", "Thinking…");
        this.session.prompt(text).then(() => { }, (err) => {
            const msg = err instanceof Error ? err.message : String(err);
            this.firstError ??= msg;
            this.opts.emit("error", { message: msg });
        }).finally(() => {
            this.active--;
            if (this.active === 0)
                this.wake();
        });
    }
    wake() {
        const w = this.idleWaiters;
        this.idleWaiters = [];
        for (const f of w)
            f();
    }
    /** Operator instruction: queue it behind the current work, or start a new run if idle. */
    instruct(text) {
        if (this.disposed)
            return;
        if (this.session.isStreaming) {
            this.session.followUp(text).catch((err) => {
                this.opts.emit("error", { message: err instanceof Error ? err.message : String(err) });
            });
        }
        else {
            this.start(text);
        }
    }
    async run(task) {
        this.start(task);
        for (;;) {
            while (this.active > 0 && !this.disposed) {
                await new Promise((r) => this.idleWaiters.push(r));
            }
            if (this.disposed)
                return failure("Stopped.");
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
    result() {
        if (this.submitted) {
            return { success: this.submitted.success, report: this.submitted.summary, result: this.submitted };
        }
        const msgs = this.session.messages;
        const last = [...msgs].reverse().find((m) => m.role === "assistant");
        if (this.firstError && !last)
            return failure(`The helper could not complete the task: ${this.firstError}`);
        if (!last)
            return failure("The helper did not produce any answer.");
        if (last.stopReason === "error" || last.stopReason === "aborted") {
            const why = last.errorMessage ?? (last.stopReason === "aborted" ? "the run was stopped" : "an unknown error");
            return failure(`The helper could not complete the task: ${why}`);
        }
        const text = textOf(last.content).trim() || "The task finished, but no written report was produced.";
        return { success: true, report: text, result: { success: true, summary: text, answer: null, findings: [], changes: [] } };
    }
    async abort() {
        this.aborted = true;
        try {
            this.session?.clearQueue();
            await this.session?.abort();
        }
        catch {
            // ignore
        }
    }
    dispose() {
        if (this.disposed)
            return;
        this.disposed = true;
        this.unsubscribe?.();
        try {
            this.session?.dispose();
        }
        catch {
            // ignore
        }
        this.wake();
    }
}
export async function resolveWorkingDir(input) {
    let p = input.trim();
    if (p === "~")
        p = os.homedir();
    else if (p.startsWith("~/"))
        p = path.join(os.homedir(), p.slice(2));
    if (!path.isAbsolute(p))
        throw new Error(`The folder "${input}" is not a full path.`);
    let stat;
    try {
        stat = await fs.promises.stat(p);
    }
    catch {
        throw new Error(`The folder "${p}" does not exist on this computer.`);
    }
    if (!stat.isDirectory())
        throw new Error(`"${p}" is not a folder.`);
    // Reading it up front triggers macOS's "allow access to Desktop?" prompt before the agent starts.
    // Async, so heartbeats keep flowing while the person decides.
    try {
        await fs.promises.readdir(p);
    }
    catch (err) {
        if (err?.code === "EPERM" || err?.code === "EACCES") {
            throw new Error(`macOS didn't allow access to "${p}". Open System Settings → Privacy & Security → Files and Folders, allow Terminal to use that folder, then run the command again.`);
        }
        throw err;
    }
    return fs.realpathSync(p);
}
