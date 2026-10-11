# gig-slave — Architecture & Build Plan (demo-ready v0)

> **Decisions locked (2026-10-11):** macOS only for v0 · server exposed via Cloudflare Tunnel · CLI published to npm as `gig-slave` · no email in v0 (copy code from dashboard) · models: `deepseek-flash` (default) and `deepseek-v4-pro` via the DeepSeek API · Pi SDK `@mariozechner/pi-coding-agent@0.73.1`.

## 1. What it is

A one-shot, zero-config remote agent. You (the operator) issue an "agent invite" from a dashboard. The recipient (dad, a new employee, whoever) runs one command:

```
npx gig-slave
```

…types the code from the email, and watches a status screen while a headless Pi coding agent does the task on their machine. You watch progress live on your dashboard, can send follow-up instructions, and get a report when it's done. Then it cleans itself up.

**Demo task:** "Organize my Desktop into folders by type."

**Non-goals for v0:** hardened security, sandboxing, multi-tenant accounts, Windows-specific polish beyond basic path handling.

---

## 2. Components

```
┌──────────────────────┐        HTTPS         ┌───────────────────────────────┐        HTTPS        ┌─────────────┐
│  gig-slave CLI         │ ───────────────────▶ │  control-server               │ ──────────────────▶ │ DeepSeek  │
│  (recipient machine) │  redeem / events /   │  - Admin API + dashboard      │  real API key lives │ (any OpenAI │
│  Pi SDK, no TUI      │  heartbeat / poll    │  - Agent API                  │  ONLY here          │  compatible)│
│                      │ ◀─────────────────── │  - /v1 inference proxy        │                     └─────────────┘
└──────────────────────┘  tasks / kill        │  - SQLite                     │
                                              │  - Email (Resend, optional)   │
                         ┌────────────────┐   │                               │
                         │ Dashboard (you)│◀──┤  SSE live events              │
                         └────────────────┘   └───────────────────────────────┘
```

Three deliverables, two packages:

| Package | What | Stack |
|---|---|---|
| `server/` | control-server: admin API, agent API, inference proxy, dashboard static page | Node 20+, TypeScript, Hono, better-sqlite3 |
| `server/public/` | dashboard: one HTML file, vanilla JS, SSE | no build step |
| `cli/` | `gig-slave` npm package | Node 20+, TypeScript → bundled single JS file, `@mariozechner/pi-coding-agent` SDK |

Repo layout: **one monorepo** (`gig-slave/`) with `server/` and `cli/` as npm workspaces. Separate repos add friction for a 2-hour demo; they can be split later with no code changes.

---

## 3. Key design decision: the API key never touches the recipient's machine

The CLI never receives the DeepSeek key. Instead:

1. Code redemption returns a **session token** (random 32-byte, stored hashed).
2. The CLI configures Pi with a custom OpenAI-compatible model whose `baseUrl` = `https://<server>/v1` and `apiKey` = session token.
3. The server's `/v1/chat/completions` checks the session is alive, swaps in the real DeepSeek key, and streams the response back.

Wins: you can revoke instantly (expire session → next LLM call fails → agent stops), you can log/limit token spend per session, you can switch providers without republishing the CLI.

---

## 4. Data model (SQLite)

```sql
invites(
  id TEXT PK, code_hash TEXT, label TEXT, email TEXT NULL,
  task TEXT,                         -- initial instruction
  working_dir TEXT DEFAULT '~/Desktop',
  model TEXT,                        -- e.g. deepseek model id; default from env
  expiry_policy TEXT,                -- 'one_use' | 'on_complete' | 'ttl'
  expires_at INTEGER NULL,           -- unix ms, for 'ttl' (1 day, 30 days, ...)
  max_redemptions INTEGER DEFAULT 1,
  redemptions INTEGER DEFAULT 0,
  failed_attempts INTEGER DEFAULT 0,
  status TEXT,                       -- 'pending' | 'active' | 'completed' | 'expired' | 'revoked'
  created_at INTEGER
)
sessions(
  id TEXT PK, invite_id TEXT FK, token_hash TEXT,
  machine TEXT,                      -- hostname/os/user reported at redeem (JSON)
  status TEXT,                       -- 'connecting' | 'working' | 'idle' | 'done' | 'failed' | 'killed'
  last_heartbeat INTEGER, started_at INTEGER, ended_at INTEGER,
  tokens_in INTEGER DEFAULT 0, tokens_out INTEGER DEFAULT 0
)
events(
  id INTEGER PK AUTOINCREMENT, session_id TEXT, ts INTEGER,
  type TEXT,                         -- 'status' | 'tool_call' | 'tool_result' | 'assistant' | 'error' | 'report' | 'instruction'
  data TEXT                          -- JSON, truncated to ~4KB
)
instructions(
  id INTEGER PK AUTOINCREMENT, session_id TEXT, text TEXT,
  delivered INTEGER DEFAULT 0, created_at INTEGER
)
```

---

## 5. API

### Admin (header `Authorization: Bearer $ADMIN_TOKEN`)
| Method | Path | Purpose |
|---|---|---|
| POST | `/api/invites` | `{label, email?, task, working_dir?, model?, expiry_policy, ttl_hours?}` → `{id, code}`. Sends email if Resend configured. Code shown once. |
| GET | `/api/invites` | list invites + their sessions |
| POST | `/api/invites/:id/revoke` | revoke invite + kill live sessions |
| GET | `/api/sessions/:id/events` | history |
| GET | `/api/stream` | SSE: all events, all sessions (dashboard) |
| POST | `/api/sessions/:id/instructions` | send follow-up instruction |
| POST | `/api/sessions/:id/kill` | stop now |

This same API is what "the IT guy's agent" calls to issue agents — it's plain REST, documented in README with curl examples.

### Agent (CLI)
| Method | Path | Purpose |
|---|---|---|
| POST | `/agent/redeem` | `{code, machine}` → `{session_token, session_id, task, working_dir, model, server_v1_url}`. Rate limit: 5 failed attempts per invite → lock; 20/min per IP. |
| POST | `/agent/events` | batch of events (Bearer session token) |
| POST | `/agent/heartbeat` | every 10s → `{status, pending_instructions[], kill: bool}` (heartbeat doubles as the poll — no websockets needed) |
| POST | `/agent/complete` | `{report, success}` → applies expiry policy |

### Inference proxy
`POST /v1/chat/completions` (Bearer session token) → validates session alive & not expired → forwards to `${UPSTREAM_BASE_URL}` with `${UPSTREAM_API_KEY}` → streams back verbatim. Also `GET /v1/models` passthrough. Records usage when present.

---

## 6. Expiry policies

| Policy | Behavior |
|---|---|
| `one_use` | Code works once. Session ends on complete/fail/kill. |
| `on_complete` | Code works until a session calls `/complete` with success. |
| `ttl` | Code + sessions valid until `expires_at` (1 day, 30 days, custom). Reusable up to `max_redemptions` (default unlimited for ttl). |

A sweeper runs every 30s: expires overdue invites, marks sessions with no heartbeat for 60s as `failed (lost connection)`, and kills sessions whose invite expired (next heartbeat returns `kill: true`; proxy refuses calls immediately).

---

## 7. CLI (`gig-slave`) behavior

```
$ npx gig-slave
  gig-slave · remote helper
  Enter the code from your email: ▉
  ✓ Connected — task: "Organize my Desktop"
  ⠋ Working…  (moving screenshots into Desktop/Screenshots)
  ● online · 2m 14s · 18 actions
  ✓ Done. A report was sent. You can close this window.
```

- **No prompt box.** Only input ever requested is the code (also accepted via `npx gig-slave <CODE>` or `GIG_SLAVE_CODE`).
- Server URL baked into the package at build time (`GIG_SLAVE_SERVER` overrides for dev).
- Runs Pi via **SDK** (`createAgentSession`), not by shelling out to `pi`, so we get typed events and full control. Isolated config: Pi's agent dir pointed at a fresh temp dir so we never read or write the recipient's `~/.pi`. Session persistence off.
- Tools: `read, write, edit, bash`. cwd = resolved `working_dir` (expand `~`; on Windows check `~/OneDrive/Desktop` fallback).
- System prompt addendum (appended to Pi's): you are operating on a non-technical person's computer remotely; never delete files — move instead; write `.gig-slave-undo.json` manifest of every move in the working dir; stay inside the working directory; finish with a short plain-English report.
- Event bridge: subscribe to Pi session events → map to `status / tool_call / tool_result / assistant` → batch-POST every 1s. Short human status line derived from the latest tool call.
- Heartbeat loop every 10s: pick up `pending_instructions` → `session.prompt(text)` after current turn; `kill: true` → abort + exit.
- Network loss: events buffered in memory, heartbeat retries with backoff; status line shows `● reconnecting…`; after 5 min offline, abort and exit with a message.
- Ctrl+C: posts `failed: cancelled by user`, then cleanup.
- **Cleanup on exit (every path):** delete temp Pi dir; best-effort remove its own npx cache dir (`~/.npm/_npx/<hash>` derived from `__dirname`); print "gig-slave removed itself." Nothing is installed globally, so nothing else to remove.

---

## 8. Dashboard (single HTML page at `/`)

- Prompt for admin token once (kept in localStorage).
- **New agent** form: label, email (optional), task (textarea, prefilled with desktop demo), working dir, expiry policy + TTL, model. On submit shows the code big + copy button + the exact command to send.
- **Sessions list:** label, machine, status dot (green working / gray idle / blue done / red failed), last heartbeat, tokens used.
- **Session detail:** live event log (SSE), final report, "send instruction" box, Kill and Revoke buttons.
- Plain, unstyled-ish. No framework.

---

## 9. Config (server `.env`)

```
ADMIN_TOKEN=change-me
UPSTREAM_BASE_URL=https://api.deepseek.com
UPSTREAM_API_KEY=sk-...
DEFAULT_MODEL=<deepseek model id>
PUBLIC_URL=https://your-server.example.com
RESEND_API_KEY=            # optional; without it, codes are shown in dashboard only
EMAIL_FROM=
PORT=8787
DB_PATH=./data/gig-slave.db
```

---

## 10. Deployment for the demo

- Server: any box with a public HTTPS URL. Easiest: Railway / Fly.io / Render (Dockerfile provided), or run locally + `cloudflared tunnel` for a throwaway public URL.
- CLI distribution, two options:
  - **Fastest:** `npx github:<you>/gig-slave` (no npm publish needed; repo ships a prebuilt `cli/dist`).
  - **Proper:** `npm publish` the `cli/` package as `gig-slave` (name availability to check) → `npx gig-slave`.

---

## 11. Build plan (sub-agents)

| # | Work item | Agent model | Notes |
|---|---|---|---|
| 1 | Monorepo scaffold, tsconfig, workspaces, Dockerfile, `.env.example`, README skeleton | Haiku | mechanical |
| 2 | Server: DB schema + migrations, admin & agent APIs, expiry sweeper | Sonnet | |
| 3 | Server: `/v1` streaming inference proxy + usage capture | Sonnet | must stream SSE untouched |
| 4 | Dashboard HTML/JS | Haiku | against API contract in §5 |
| 5 | CLI: Pi SDK integration, custom provider pointing at proxy, isolated agent dir, event bridge | Sonnet | verify SDK API against installed Pi version first |
| 6 | CLI: status UI, heartbeat/instructions/kill loop, cleanup | Haiku | |
| 7 | Mock OpenAI-compatible upstream for offline E2E tests (scripted tool calls that move files in a fake Desktop) | Haiku | lets us test without spending tokens |
| 8 | Integration + E2E run: issue invite → redeem → agent organizes fake desktop → report → expiry applied → cleanup verified | Opus (me) | |
| 9 | Independent review pass of whole repo against this plan | Sonnet (fresh agent) | |

Items 1 first; 2/3, 4, 5/6, 7 in parallel; then 8, 9.

**Definition of done:** with a mock upstream, the full E2E passes in CI-style script; with a real DeepSeek key, the desktop demo works on macOS and Linux.

---

## 12. Known edge cases handled in v0 vs. deferred

**Handled now:** wrong code lockout, code rate limits, lost connection & reconnect, agent crash → session marked failed by sweeper, Ctrl+C, kill/revoke from dashboard, expiry by TTL/one-use/on-complete, key never on client, no file deletion + undo manifest, OneDrive Desktop on Windows, isolated Pi config.

**Deferred (security pass later):** machine-binding of tokens, signed CLI releases, per-session tool allowlists / command policy, operator approval for risky commands, multi-operator accounts, audit export, spend caps per invite.
