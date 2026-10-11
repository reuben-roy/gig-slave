# gig-slave — instructions for Claude Code

Read PLAN.md (architecture) and CONTRACT.md (binding API contract) before writing code. CONTRACT.md wins on any conflict.

## Locked decisions
- macOS only for v0. Node 22+.
- npm package name for the CLI: `gig-slave` (verified free on npm 2026-10-11). Recipient runs `npx gig-slave`.
- Server exposed with a Cloudflare Tunnel (`cloudflared tunnel --url http://localhost:8787`).
- No email in v0: the dashboard shows the code to copy.
- Models via the DeepSeek API (`https://api.deepseek.com`): `deepseek-flash` (V4.1 Flash, default) and `deepseek-v4-pro`. Thinking is disabled upstream via `UPSTREAM_EXTRA_BODY`.
- Harness: `@mariozechner/pi-coding-agent@0.73.1` via its SDK (not the `pi` binary).

## Repo layout (npm workspaces)
- `server/`: Hono + `@hono/node-server`, built-in `node:sqlite` (no native deps). Serves `server/public/index.html` at `/`.
- `server/public/index.html`: dashboard, single file, vanilla JS, SSE. Plain styling.
- `cli/`: the `gig-slave` npm package. Compile with plain `tsc` to `dist/` (don't bundle Pi; npx installs deps). `bin: { "gig-slave": "dist/index.js" }`.
- `mock/`: OpenAI-compatible scripted upstream for offline tests (no tokens spent).
- `e2e/run.mjs`: full end-to-end test.

## Build order (use subagents; Haiku where it's mechanical)
1. In parallel:
   - **server** (Sonnet): admin API, agent API, `/v1` streaming proxy, sweeper.
   - **dashboard** (Haiku): against CONTRACT.md only.
   - **cli** (Sonnet): Pi SDK integration + status UI + heartbeat/instructions/kill + cleanup.
   - **mock + e2e** (Haiku).
2. Integrate and make `npm run e2e` pass (main agent).
3. A fresh reviewer subagent checks the repo against PLAN.md and CONTRACT.md.

## Pi SDK notes (checked against 0.73.1)
- Use the "full control" pattern from `node_modules/@mariozechner/pi-coding-agent/examples/sdk/12-full-control.ts`: `createAgentSession({ cwd, agentDir, model, thinkingLevel: "off", authStorage, modelRegistry, resourceLoader, tools: ["read","write","edit","bash"], sessionManager: SessionManager.inMemory(cwd), settingsManager })`.
- Isolation: `agentDir` = a fresh `fs.mkdtemp` dir; `AuthStorage.create(<tmp>/auth.json)`; `ModelRegistry.inMemory(authStorage)`; `SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: true, maxRetries: 2 } })`. Provide a custom `ResourceLoader` returning no extensions/skills/prompts/themes/agentsFiles, so nothing from the recipient's `~/.pi` or the working folder is loaded.
- Model: build the `Model` object directly (see `Model` in `@mariozechner/pi-ai/dist/types.d.ts`): `{ id: <invite model>, name, api: "openai-completions", provider: "gig-slave", baseUrl: <v1_base_url from redeem>, reasoning: false, input: ["text"], cost: {input:0,output:0,cacheRead:0,cacheWrite:0}, contextWindow: 200000, maxTokens: 16000, compat: { supportsStore: false, supportsDeveloperRole: false, supportsReasoningEffort: false, maxTokensField: "max_tokens" } }`. API key: `authStorage.setRuntimeApiKey("gig-slave", session_token)` so the proxy receives `Authorization: Bearer <session_token>`.
- Events: `session.subscribe(e => …)`; use `tool_execution_start` (toolName/args), `tool_execution_end` (isError/result), `message_end` / `turn_end` for assistant text, `agent_end` when done. Check the exact event field names in the package's `.d.ts` files before mapping them.
- Follow-up instructions from the operator: `session.followUp(text)` while streaming, `session.prompt(text)` when idle. Kill: `session.abort()`.
- Before writing the mock, check the bash tool's parameter name in the package (expected `command`).

## CLI behaviour that's easy to miss
- The only input it ever asks for is the code (or `npx gig-slave ABCD-EFGH`). No prompt box.
- Baked server URL lives in `cli/src/server-url.ts`; `GIG_SLAVE_SERVER` overrides it.
- On macOS, run `caffeinate -i -w <pid>` so the Mac doesn't sleep mid-task.
- System prompt for the agent: it's on a non-technical person's Mac, remotely operated; never delete, only move; record every move in `.gig-slave-undo.json` in the working folder; stay inside the working folder; finish with a short plain-English report.
- Cleanup on every exit path (done, failed, killed, Ctrl+C): remove the temp agent dir. Remove its own npx cache dir only if `__dirname` contains `/_npx/`.

## Definition of done
- `npm run e2e` passes against the mock: create invite → CLI redeems → fake Desktop gets organized → report on dashboard → `one_use` invite can't be redeemed again → expired session gets 403 from `/v1` → temp dir gone.
- README covers: `.env` setup, running the server, starting the Cloudflare tunnel, setting the baked server URL, `npm publish --access public` from `cli/`, and the real-key demo on a Mac.
