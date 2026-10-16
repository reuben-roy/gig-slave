# Hired Gun: Architecture

> **Decisions (2026-10-14, renamed 2026-10-16):** product name **Hired Gun** (formerly GigAgent, formerly gig-slave; identifiers keep `gigagent`, see DESIGN.md) · CLI package `gigagent`, run as `npx gigagent` · macOS only for the CLI · server deploys to **Vercel** (root directory `server`) with **Postgres** (Neon) via `DATABASE_URL`; embedded PGlite locally and in e2e · models through **Vercel AI Gateway** for ids with `/` (default `anthropic/claude-haiku-5.5`), bare ids go direct to DeepSeek · jobs end with a structured **Result** (via the agent's `submit_report` tool) shown on the dashboard and sent by email (Resend, optional) and/or webhook · Pi SDK `@mariozechner/pi-coding-agent@0.73.1` · a Cloudflare tunnel + Worker remain as a self-hosting option.

CONTRACT.md is the binding reference for routes, shapes and env vars. This file explains why the pieces are shaped the way they are.

## 1. What it is

An operator (you) creates an **invite** for a job on a dashboard. The person at the computer runs one command and types the code:

```
npx gigagent ABCD-EFGH
```

A headless Pi coding agent then does the job on their Mac while the operator watches live, can send follow-up instructions or stop it, and gets a structured report when it ends. The CLI then removes its temporary files.

**Demo task:** "Organize my Desktop into folders by type."

**Non-goals for now:** hardened security, sandboxing, multi-tenant accounts, Windows support.

## 2. Components

```
┌──────────────────────┐   HTTPS    ┌──────────────────────────────────┐   HTTPS   ┌──────────────────────┐
│  gigagent CLI        │ ─────────▶ │  server (Vercel, Hono)           │ ────────▶ │ AI Gateway (ids "/") │
│  (recipient's Mac)   │ redeem /   │  - landing page  (/)             │           ├──────────────────────┤
│  Pi SDK, status UI   │ events /   │  - dashboard     (/dashboard)    │ ────────▶ │ DeepSeek direct      │
│                      │ heartbeat  │  - admin API    (/api, token)    │  real     │ (bare ids)           │
│                      │ ◀───────── │  - agent API    (/agent)         │  keys     └──────────────────────┘
│                      │ instructions│ - /v1 proxy     (session token) │  live here
└──────────────────────┘  / kill    │  - sweeper                       │
                                    │  - Postgres (Neon) / PGlite      │ ──────▶ Resend email (optional)
                                    │  - SSE to dashboard              │ ──────▶ Slack / Discord / webhook
                                    └──────────────────────────────────┘
```

| Part | What | Stack |
|---|---|---|
| `server/` | landing page, dashboard, admin and agent APIs, `/v1` proxy, sweeper | Hono on Vercel (zero-config), TypeScript, Postgres via `DATABASE_URL` (PGlite when unset) |
| `server/public/` | `index.html` landing page, `dashboard.html` operator dashboard, `assets/` shared styles | Static HTML, vanilla JS, SSE. No build step |
| `cli/` | the `gigagent` npm package | Node 22+, TypeScript compiled with `tsc`, `@mariozechner/pi-coding-agent` SDK (not bundled) |
| `mock/`, `e2e/` | scripted upstream and end-to-end test | Node, no tokens spent |
| `worker/`, `scripts/` | self-hosting only: stable `workers.dev` address in front of a Cloudflare quick tunnel | Cloudflare Worker, `cloudflared` |

One monorepo with npm workspaces (`server`, `cli`, `mock`).

## 3. The API key never reaches the recipient's Mac

1. Redeeming a code returns a **session token** (random 32 bytes; only its hash is stored).
2. The CLI configures Pi with a custom OpenAI-compatible model whose base URL is the server's `/v1` and whose API key is the session token.
3. `/v1/chat/completions` checks the session is still alive, forces the invite's model, swaps in the real upstream key (gateway or DeepSeek), and streams the response back unchanged.

So you can revoke a job instantly (the next model call fails), track token use per session, and change providers without republishing the CLI.

## 4. Data and lifecycle

- **Invites** have an expiry policy: `one_use` (ends after the first redemption), `on_complete` (works until a session succeeds), or `ttl` (until `expires_at`, optionally with `max_redemptions`). Exact rules are in CONTRACT.md.
- **Sessions** move through `connecting → working/idle → done | failed | killed`. Heartbeats every few seconds carry status text and pick up instructions and kill requests.
- **Sweeper** expires overdue invites and marks sessions with no heartbeat for 45 s as `failed` ("Lost connection"). Locally it runs on a timer. On Vercel it runs lazily during requests and from Vercel Cron (`/api/cron/sweep`).
- **Notifications** run once per session that ends `done` or `failed`. Each attempt is awaited and logged, so serverless functions don't drop it.
- **Rate limiting** for wrong codes is stored in the database, so it holds across serverless instances.

## 5. CLI behaviour

```
$ npx gigagent ABCD-EFGH
  ★ Hired Gun
  ✓ Connected: "Organize my Desktop"
  ⠋ Working…  (moving screenshots into Screenshots/)
  ● online · 2m 14s · 18 actions
  ✓ Done. The report has been sent. You can close this window.
```

- **No prompt box.** The only input is the code, given as an argument or typed when asked.
- Server URL is baked in at build time (`cli/src/server-url.ts`). `GIGAGENT_SERVER` overrides it; `GIG_SLAVE_SERVER` is still honoured as a fallback.
- Pi runs through the **SDK** (`createAgentSession`) with an isolated temp agent dir, so nothing from the recipient's `~/.pi` or the working folder is loaded. Session persistence is off.
- Tools: `read`, `write`, `edit`, `bash`, plus `submit_report`, which the agent calls once at the end with the structured result.
- The system prompt says: the person can't answer questions; never delete, only move; record every move in `.gigagent-undo.json`; stay in the working folder; read-only system checks are fine; finish by calling `submit_report`.
- Event bridge: Pi events map to `status`, `tool_call`, `tool_result`, `assistant` and are batched to the server. Heartbeat delivers instructions (`session.followUp`) and kill (`session.abort()`).
- Offline: events buffer in memory and heartbeats retry with backoff. After 5 minutes offline the CLI stops.
- `caffeinate` keeps the Mac awake for the job.
- **Cleanup on every exit path** (done, failed, killed, Ctrl+C): remove the temp agent dir, and remove its own npx cache dir only if it sits under `/_npx/`.

## 6. Dashboard and landing page

- **Dashboard** (`/dashboard`): paste the admin token once. New job form (label, task, working folder, model, expiry, optional email and webhook). On create it shows the code and the exact command. Sessions list with status, machine and token use. Session detail with live event log, structured report, instruction box, Kill and Revoke.
- **Landing page** (`/`): marketing page for Hired Gun. Visual direction and tokens are in [DESIGN.md](DESIGN.md).

## 7. Config and deployment

- Server env vars: [CONTRACT.md](CONTRACT.md#server-env). Local: `.env` at the repo root. Vercel: project environment variables.
- Deployment steps: [README.md](README.md#deploy-to-vercel).

## 8. Testing

`npm run e2e` runs everything offline against the mock upstream: create an invite, the CLI redeems it against a fake Desktop, files get organized, the report shows on the dashboard, a `one_use` code is refused the second time, an expired session gets 403 from `/v1`, and the temp dir is gone.

## 9. Known gaps and deferred work

**Handled now:** wrong-code rate limits, lost connection and reconnect, crash detection by the sweeper, Ctrl+C, kill and revoke, all expiry policies, keys kept on the server, no deletion with an undo log, isolated Pi config, Desktop path handling.

**Deferred:** machine-binding of tokens, signed CLI releases, per-session tool allowlists and command policy, operator approval for risky commands, end-user sign-up and password accounts for operators (accounts are owner-approved today), audit export, spend caps per invite, Windows support, an offboarding mode.
