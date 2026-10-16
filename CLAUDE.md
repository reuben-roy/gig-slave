# Hired Gun (formerly GigAgent, formerly gig-slave) — instructions for Claude Code

Read PLAN.md (architecture) and CONTRACT.md (binding API contract) before writing code. CONTRACT.md wins on any conflict, including with this file.

## Locked decisions
- Product name **Hired Gun** (display); identifiers stay `gigagent` (npm package, `npx gigagent`, `GIGAGENT_*`, `.gigagent-undo.json`, webhook `type`, `localStorage` key, Vercel project) until a deliberate migration. Design direction and tokens: DESIGN.md. macOS only for the CLI. Node 22+.
- npm package name for the CLI: `gigagent` (verified free on npm 2026-10-14). Recipient runs `npx gigagent`.
- Server deploys to **Vercel** (Hono zero-config, project Root Directory = `server`), Postgres via `DATABASE_URL` (Neon), embedded PGlite locally/e2e. The Cloudflare tunnel + Worker remain as a self-hosting option.
- Models: Vercel **AI Gateway** for ids containing `/` (default `anthropic/claude-haiku-5.5`); bare ids (e.g. `deepseek-flash`) go to the direct DeepSeek upstream.
- Jobs end with a structured `Result` (via the agent's `submit_report` tool) that is shown on the dashboard and sent to the operator by email (Resend, optional) and/or webhook (Slack/Discord/generic).
- Harness: `@mariozechner/pi-coding-agent@0.73.1` via its SDK (not the `pi` binary).

## Repo layout (npm workspaces)
- `server/`: Hono + `@hono/node-server`, built-in `node:sqlite` (no native deps). Serves `server/public/index.html` at `/`.
- `server/public/index.html`: marketing landing page. `server/public/dashboard.html`: operator dashboard, single file, vanilla JS, SSE. `server/public/assets/`: shared `brand.css` tokens + `logo.svg`.
- `cli/`: the `gigagent` npm package. Compile with plain `tsc` to `dist/` (don't bundle Pi; npx installs deps). `bin: { "gigagent": "dist/index.js" }`.
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
- Model: build the `Model` object directly (see `Model` in `@mariozechner/pi-ai/dist/types.d.ts`): `{ id: <invite model>, name, api: "openai-completions", provider: "gigagent", baseUrl: <v1_base_url from redeem>, reasoning: false, input: ["text"], cost: {input:0,output:0,cacheRead:0,cacheWrite:0}, contextWindow: 200000, maxTokens: 16000, compat: { supportsStore: false, supportsDeveloperRole: false, supportsReasoningEffort: false, maxTokensField: "max_tokens" } }`. API key: `authStorage.setRuntimeApiKey("gigagent", session_token)` so the proxy receives `Authorization: Bearer <session_token>`.
- Events: `session.subscribe(e => …)`; use `tool_execution_start` (toolName/args), `tool_execution_end` (isError/result), `message_end` / `turn_end` for assistant text, `agent_end` when done. Check the exact event field names in the package's `.d.ts` files before mapping them.
- Follow-up instructions from the operator: `session.followUp(text)` while streaming, `session.prompt(text)` when idle. Kill: `session.abort()`.
- Before writing the mock, check the bash tool's parameter name in the package (expected `command`).

## CLI behaviour that's easy to miss
- The only input it ever asks for is the code (or `npx gigagent ABCD-EFGH`). No prompt box.
- Baked server URL lives in `cli/src/server-url.ts`; `GIGAGENT_SERVER` overrides it.
- On macOS, run `caffeinate -i -w <pid>` so the Mac doesn't sleep mid-task.
- System prompt for the agent: it's on a non-technical person's Mac, remotely operated; never delete, only move; record every move in `.gigagent-undo.json` in the working folder; stay inside the working folder; finish by calling `submit_report` (summary for the person at the computer, answer/findings for the operator).
- Cleanup on every exit path (done, failed, killed, Ctrl+C): remove the temp agent dir. Remove its own npx cache dir only if `__dirname` contains `/_npx/`.

## Definition of done
- `npm run e2e` passes against the mock: create invite → CLI redeems → fake Desktop gets organized → report on dashboard → `one_use` invite can't be redeemed again → expired session gets 403 from `/v1` → temp dir gone.
- README covers: `.env` setup, running the server, starting the Cloudflare tunnel, setting the baked server URL, `npm publish --access public` from `cli/`, and the real-key demo on a Mac.
