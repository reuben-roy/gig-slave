# Hired Gun — Interface Contract (source of truth for all packages)

Product name: **Hired Gun** (display; formerly GigAgent). Identifiers stay `gigagent` for compatibility (npm package, bin, env prefix `GIGAGENT_`, file names, the webhook `type`).
All JSON. All times are unix **ms**. Errors: `{ "error": "<message>" }` with a 4xx/5xx status.

## Routes at a glance
| Path | What |
|---|---|
| `/` | Marketing landing page (`server/public/index.html`) |
| `/dashboard` | Operator dashboard (`server/public/dashboard.html`) |
| `/assets/*` | Shared static assets (`server/public/assets/`: `brand.css`, `logo.svg`, …) |
| `/api/*` | Admin API (admin token) |
| `/agent/*` | Agent API (used by the CLI) |
| `/v1/*` | OpenAI-compatible inference proxy (session token) |
| `/operator/*` | Operator API for agents (operator token) |
| `/mcp` | MCP server exposing the operator actions as tools (operator token) |
| `/oauth/*`, `/.well-known/oauth-*` | OAuth 2.1 authorization server for connectors |
| `/connect` | Owner approval page for agent access and connector links |

Static files are served by Vercel's CDN in production and by the Hono app locally; both must resolve the same paths (`/` → `index.html`, `/dashboard` → `dashboard.html`, `/assets/x` → `assets/x`).

## Auth
- Admin endpoints (`/api/*`): `Authorization: Bearer <ADMIN_TOKEN>`. The SSE endpoint also accepts `?token=<ADMIN_TOKEN>` (EventSource can't set headers).
- Agent endpoints (`/agent/*` except redeem) and `/v1/*`: `Authorization: Bearer <session_token>`.
- Operator endpoints (`/operator/*` except enrollment) and `/mcp`: `Authorization: Bearer <operator token>` (`hgo_…`). Three credentials, never interchangeable: `ADMIN_TOKEN` (the owner, dashboard, approvals), recipient session tokens, and operator tokens (an agent's own account).

## Codes
- Invite code format: 8 chars, uppercase, from alphabet `ABCDEFGHJKMNPQRSTUVWXYZ23456789`, displayed as `XXXX-XXXX`. Server normalizes input: strip non-alphanumerics, uppercase.
- Stored as sha256 hex. Session token: 32 random bytes hex, stored as sha256 hex.

## Admin API

`POST /api/invites`
```json
// request
{ "label": "Dad's iMac", "task": "Organize my Desktop...", "working_dir": "~/Desktop",
  "model": "anthropic/claude-haiku-5.5", "expiry_policy": "one_use" | "on_complete" | "ttl",
  "ttl_hours": 24, "max_redemptions": null,
  "notify_email": "me@example.com" | null,      // optional: emailed when the job ends
  "notify_webhook": "https://hooks.slack.com/..." | null }  // optional: POSTed when the job ends
// response 201
{ "invite": Invite, "code": "ABCD-EFGH", "command": "npx gigagent ABCD-EFGH" }
```
Validation: `model` must be one of the configured models (else 400). `notify_email` must look like an email; `notify_webhook` must be an `https://` URL (`http://localhost`/`127.0.0.1` also allowed, for tests). Empty strings are treated as null.

`GET /api/invites` → `{ "invites": [Invite & { "sessions": Session[] }] }` (newest first)
`POST /api/invites/:id/revoke` → `{ "ok": true }` (invite.status=revoked, all live sessions → kill)
`GET /api/sessions/:id/events?after=<eventId>` → `{ "events": Event[] }`
`POST /api/sessions/:id/instructions` `{ "text": "..." }` → `{ "ok": true }`
`POST /api/sessions/:id/kill` → `{ "ok": true }`
`GET /api/config` →
```json
{ "models": ["anthropic/claude-haiku-5.5", "..."],
  "model_options": [{ "id": "anthropic/claude-haiku-5.5", "label": "Claude Haiku 5.5", "provider": "gateway" | "deepseek" }],
  "default_model": "...", "public_url": "...",
  "notifications": { "email": boolean, "webhook": true } }   // email=true only if RESEND_API_KEY is set
```
`GET /api/stream?token=` → SSE. Each message: `id: <cursor>\nevent: <name>\ndata: <json>\n\n` where name ∈
- `event` → `Event`
- `session` → `Session` (whenever a session row changes meaningfully; NOT on every heartbeat)
- `invite` → `Invite` (whenever an invite row changes)
Keep-alive comment `: ping` every 15s. The stream may end at any time (serverless functions have a max duration); clients rely on EventSource auto-reconnect and must re-fetch `GET /api/invites` (and the selected session's events with `?after=`) on every (re)connect so nothing is missed. Server sends `retry: 1000` at the start of each stream, then `event: ready` (`{ "cursor": <eventId>, "live": boolean }`) once its cursors are fixed. **Clients refetch on `ready`** (fall back to a few seconds after `open` for servers that do not send it): everything that changes after `ready` is streamed, everything before it is in the refetch, so there is no gap. Rows already present at connect time are not replayed.
Cost model: the stream is database polling (Vercel functions cannot share in-memory pub/sub, and LISTEN/NOTIFY would pin the database awake). One statement per tick; the tick delay is adaptive (700 ms while a session is live or something changed in the last 30 s, 3 s when quiet, 8 s after 5 quiet minutes), and the lazy sweeper runs at 5 s only while a session is live, otherwise every 60 s. Clients should therefore keep the stream open only when it is useful: the bundled dashboard (`assets/stream-policy.js`) closes it 30 s after the tab is hidden and 10 min after the last interaction, unless a job is live, and reopens it on interaction or when the tab is shown. A new job appearing on an idle stream can take up to 8 s to show up.

`GET /api/cron/sweep` → `{ "ok": true }`. Runs the sweeper once. Auth: admin token **or** `Authorization: Bearer <CRON_SECRET>` (Vercel Cron sends this).

### Shapes
```ts
Invite  = { id, label, task, working_dir, model, expiry_policy, expires_at: number|null,
            max_redemptions: number|null, redemptions, failed_attempts,
            notify_email: string|null, notify_webhook: string|null,
            status: "pending"|"active"|"completed"|"expired"|"revoked", created_at }
Session = { id, invite_id, machine: {hostname,platform,release,arch,username}|null,
            status: "connecting"|"working"|"idle"|"done"|"failed"|"killed",
            status_text: string|null,  // short human line, e.g. "Moving 12 screenshots"
            report: string|null,       // plain-English summary (same as result.summary when present)
            result: Result|null,       // structured outcome for the operator, set on complete
            last_heartbeat, started_at, ended_at: number|null,
            tokens_in, tokens_out, actions }
Result  = { success: boolean,
            summary: string,           // plain English, for the person at the computer
            answer: string|null,       // for the operator: the information the task asked for (markdown allowed)
            findings: { label: string, value: string }[],   // key facts, e.g. {label:"macOS version", value:"15.3"}; may be []
            changes: string[] }        // one line per change made, e.g. "Moved 23 screenshots into Screenshots/"; may be []
Event   = { id, session_id, ts, type: "status"|"tool_call"|"tool_result"|"assistant"|"error"|"report"|"instruction"|"notification",
            data: object }
```
Event `data` conventions:
- status: `{ status, text }`
- tool_call: `{ tool, args }` (args truncated)
- tool_result: `{ tool, ok, output }` (output truncated to 2000 chars)
- assistant: `{ text }`
- error: `{ message }`
- report: `{ text, success, result }` (`result` is the `Result` object or null)
- instruction: `{ text }` (server writes this when operator sends one)
- notification: `{ channel: "email"|"webhook", ok: boolean, detail: string }` (server writes one per notification attempt)

## Agent API

`POST /agent/redeem`
```json
// request
{ "code": "ABCD-EFGH", "machine": { "hostname","platform","release","arch","username" }, "cli_version": "0.2.0" }
// 200
{ "session_id", "session_token", "task", "working_dir", "model",
  "v1_base_url": "<PUBLIC_URL>/v1", "heartbeat_ms": 5000 }
// 401 invalid code, 403 locked/expired/revoked/used, 429 rate-limited
```
Rules: 5 failed attempts across all codes from one IP within 10 min → 429 (attempts are stored in the database, not in memory, so this holds across serverless instances). Client IP: on Vercel, first of `x-real-ip`, `x-forwarded-for` (first entry) (Vercel sets these; `x-gig-client-ip` is ignored there because anyone could send it). Self-hosted (not on Vercel): first of `x-gig-client-ip` (set by the Cloudflare Worker front door), `cf-connecting-ip`, `x-real-ip`, `x-forwarded-for` (first entry), socket address. Increment `redemptions`; for `one_use`, after redemption invite.status = completed-on-end (cannot be redeemed again). For `ttl`, redeemable until expires_at and `max_redemptions` (null = unlimited). For `on_complete`, redeemable until a session completes with success.

`POST /agent/events` `{ "events": [{ "ts", "type", "data" }] }` → `{ "ok": true }`. Server also updates session.status/status_text from `status` events, increments `actions` per tool_call.

`POST /agent/heartbeat` `{ "status", "status_text" }` → `{ "kill": boolean, "instructions": [{ "id", "text" }] }` (returned instructions are marked delivered).

`POST /agent/complete`
```json
{ "success": boolean, "report": string, "result": Result | null }   // result optional for backward compat
```
→ `{ "ok": true }`. Sets session done/failed, ended_at, `report`, `result` (if `result` is missing the server stores `{success, summary: report, answer: null, findings: [], changes: []}`), writes a `report` event, applies expiry policy, then sends notifications (below). Server clips `summary`/`answer` to 20 000 chars, `findings` to 50 items, `changes` to 200 items.

A session is **alive** iff status ∉ {done, failed, killed}, invite.status ∉ {expired, revoked}, and (expires_at null or > now). `kill` = !alive or kill requested.

## Notifications (when a session reaches a terminal state)
Sent once per session when it ends as `done` or `failed` (including "Lost connection" from the sweeper). Not sent for `killed` (the operator did that themselves). Each attempt writes a `notification` event. Failures never break the request; each attempt has a 5 s timeout and is awaited before the response is returned (so serverless functions don't drop it).
- **Email** (only if `RESEND_API_KEY` is set and invite.notify_email is set): `POST https://api.resend.com/emails` with `{ from: NOTIFY_FROM, to, subject, html, text }`. Subject: `✅ Hired Gun: "<label>" is done` / `⚠️ Hired Gun: "<label>" needs attention`. Body: summary, answer, findings table, changes list, machine, duration, link to `<PUBLIC_URL>/dashboard#session=<id>`.
- **Webhook** (if invite.notify_webhook is set): `POST` JSON. If the host is `hooks.slack.com` → `{ text }` (Slack mrkdwn). If the host is `discord.com`/`discordapp.com` → `{ content }`. Otherwise →
  `{ "type": "gigagent.session.ended", "invite": Invite, "session": Session, "result": Result|null, "dashboard_url": string }`.

## Inference proxy

`POST /v1/chat/completions` — Bearer session token. If session not alive → 403 `{error:{message:"session expired"}}`. **Force `model` to the invite's model** (the client value is ignored). Route by model id:
- id contains `/` (e.g. `anthropic/claude-haiku-5.5`) → **Vercel AI Gateway**: `${AI_GATEWAY_BASE_URL}/chat/completions` (default `https://ai-gateway.vercel.sh/v1`) with `Authorization: Bearer ${AI_GATEWAY_API_KEY}`; if no key is set and the server runs on Vercel, use the Vercel OIDC token (`@vercel/oidc` `getVercelOidcToken()`). Merge `GATEWAY_EXTRA_BODY` (JSON object, optional).
- otherwise → direct upstream: `${UPSTREAM_BASE_URL}/chat/completions` with `Authorization: Bearer ${UPSTREAM_API_KEY}`; merge `UPSTREAM_EXTRA_BODY`.
Add headers `HTTP-Referer: PUBLIC_URL`, `X-Title: Hired Gun`. Abuse bounds: reject bodies over 2 MB (413), clamp `max_tokens`/`max_completion_tokens` to 16000, force `n` to 1. Optional per-invite budget: env `SESSION_TOKEN_BUDGET` (default 2000000 tokens in+out per session); once a session's tokens_in+tokens_out exceed it, `/v1` returns 403 `{error:{message:"token budget exceeded"}}`. Stream the upstream response body back byte-for-byte with the same status and content-type. Parse usage best-effort (non-stream JSON `usage`, or SSE `data:` chunks containing `usage`) and add to tokens_in/tokens_out.
`GET /v1/models` → `{ "object":"list", "data":[{ "id": <invite model>, "object":"model" }] }`.

## Server env
```
PORT=8787  ADMIN_TOKEN  PUBLIC_URL=http://localhost:8787
# Database: Postgres when DATABASE_URL is set (Neon on Vercel), otherwise embedded PGlite at PGLITE_DIR.
DATABASE_URL=            PGLITE_DIR=./data/pglite      # PGLITE_DIR=memory:// for in-memory
# Models
MODELS=anthropic/claude-haiku-5.5,anthropic/claude-sonnet-5.5,openai/gpt-5.6-luna,deepseek/deepseek-v4.1-flash
DEFAULT_MODEL=anthropic/claude-haiku-5.5
AI_GATEWAY_API_KEY=      AI_GATEWAY_BASE_URL=https://ai-gateway.vercel.sh/v1    GATEWAY_EXTRA_BODY=
UPSTREAM_BASE_URL=https://api.deepseek.com   UPSTREAM_API_KEY=   UPSTREAM_EXTRA_BODY={"thinking":{"type":"disabled"}}
# Notifications
RESEND_API_KEY=          NOTIFY_FROM="Hired Gun <onboarding@resend.dev>"
CRON_SECRET=
```
Sweeper: invites with expires_at < now → expired; sessions alive with last_heartbeat older than 45s → failed (status_text "Lost connection", triggers notifications). Locally it runs every 10s; on Vercel it runs lazily (at most once per 5s, at the start of `/api` and `/agent` requests) plus Vercel Cron hitting `/api/cron/sweep`.

## CLI
- Package `gigagent`, bin `gigagent`, run as `npx gigagent` or `npx gigagent ABCD-EFGH`.
- `GIGAGENT_SERVER` overrides the baked-in server URL (`cli/src/server-url.ts`); `GIG_SLAVE_SERVER` is still honoured as a fallback.
- Undo log: `.gigagent-undo.json` in the working folder.
- The agent has one extra tool besides read/write/edit/bash: **`submit_report`** with parameters
  `{ success: boolean, summary: string, answer?: string, findings?: {label,value}[], changes?: string[] }`.
  The agent must call it exactly once, as its last action. The CLI turns it into `Result` and sends it with `/agent/complete`. If the agent ends without calling it, the CLI falls back to `{ success: true, summary: <last assistant text>, answer: null, findings: [], changes: [] }`.

## Operator API (agents and connectors)

An **operator account** is the identity an agent or connector acts as. It owns the jobs it creates (`invites.operator_id`), sees only those, and is bounded by limits. Accounts exist only because the owner (holder of `ADMIN_TOKEN`) approved an enrollment on `/connect` or an OAuth consent. A **job** is an invite plus its sessions.

Errors here are `{ "error": "<message>", "code": "<code>" }` (the `/oauth/*` endpoints use the RFC 6749 shape `{ "error": "<code>", "error_description": "<message>" }`). Codes: `invalid_request` 400, `invalid_token` 401 (with `WWW-Authenticate: Bearer … resource_metadata=…`), `insufficient_scope` 403, `model_not_allowed` 403, `limit_exceeded` 403/429, `not_found` 404 (also for another account's job), `not_running` / `not_reissuable` / `not_pending` 409, `idempotency_conflict` 422, `rate_limited` 429, enrollment: `invalid_device_secret` 401, `denied` 403, `expired` / `already_collected` 410.

### Enrollment (how an agent obtains access)
`POST /operator/enroll` `{ "name": "claude", "scopes": ["jobs:read","jobs:write"] }` → 201 `{ user_code: "ABCD-EFGH", device_secret: "hgd_…", verification_url, expires_in: 900, interval: 3 }`. Unauthenticated, rate-limited per client IP. The human opens `verification_url`, signs in with the admin token and approves (or denies).
`POST /operator/enroll/token` `{ "device_secret" }` → 202 `{ status: "pending", interval }` until approved, then 200 `{ status: "approved", token: "hgo_…", scopes, operator }` **once** (410 afterwards). Scopes: `jobs:read`, `jobs:write`. Tokens expire (default 90 days) and can be revoked.
Admin side (`ADMIN_TOKEN`): `GET /api/enrollments`, `POST /api/enrollments/:code/approve` `{ name?, scopes?, max_active_jobs?, max_jobs_per_day?, max_ttl_hours?, allowed_models?, token_ttl_days? }`, `POST /api/enrollments/:code/deny`, `GET /api/operators`, `POST /api/operators/:id/revoke` `{ stop_jobs?: true }`, `POST /api/operators/:id/limits`, `POST /api/operators/:id/tokens/:tokenId/revoke`.

### Actions (one definition, three faces: REST, MCP tool, `hired-gun` CLI)
| Action | REST | Scope |
|---|---|---|
| `get_account` | `GET /operator/me` | read |
| `create_job` | `POST /operator/jobs` (`Idempotency-Key` header or `idempotency_key` field) | write |
| `list_jobs` | `GET /operator/jobs?state=&limit=` | read |
| `get_job` | `GET /operator/jobs/:id?wait_seconds=0..20` | read |
| `get_job_events` | `GET /operator/jobs/:id/events?after=&limit=` → `{ events, next_after }` | read |
| `send_instruction` | `POST /operator/jobs/:id/instructions` `{ text }` | write |
| `stop_job` | `POST /operator/jobs/:id/stop` | write |
| `reissue_code` | `POST /operator/jobs/:id/code` | write |
| (logout) | `DELETE /operator/token` | any |

`create_job` takes the `POST /api/invites` fields; `expiry_policy` defaults to `one_use`; operator jobs always expire (`ttl_hours`, default 24, capped by the account's `max_ttl_hours`). Same `idempotency_key` + same parameters returns the original job with `replayed: true` and `code: null` (codes are shown once; use `reissue_code`); same key with different parameters is 422. Limits (`max_active_jobs`, `max_jobs_per_day`, `max_ttl_hours`, `allowed_models`) are enforced atomically in the insert.
```ts
Job = Invite & { state: "waiting_for_recipient"|"running"|"succeeded"|"failed"|"stopped"|"expired",
                 active_session_id: string|null, result: Result|null, sessions: Session[], operator_id: string|null }
```

### MCP (`POST /mcp`)
Streamable HTTP, stateless, JSON responses (`initialize`, `ping`, `tools/list`, `tools/call`; `GET` is 405). Tools are the actions above, listed only if the token's scopes allow them. Results carry `structuredContent` (and the same JSON as text); action errors return `isError: true` with `{ error, code }`.

### OAuth (connectors: ChatGPT, Claude)
Discovery: `/.well-known/oauth-protected-resource` (resource `<PUBLIC_URL>/mcp`) and `/.well-known/oauth-authorization-server`. `POST /oauth/register` (RFC 7591, public clients, https or loopback redirect URIs). `GET /oauth/authorize` requires PKCE S256 and sends the owner to `/connect`, where they sign in with the admin token and **explicitly** choose the operator account (existing or new, with limits) and scopes; deny returns `access_denied`. `POST /oauth/token`: `authorization_code` (single use, 10 min, replay revokes what it issued) and `refresh_token` (rotating; reuse of an old one revokes the grant). Access tokens are ordinary operator tokens (`kind: "oauth"`, 1 h); refresh tokens `hgr_…` last 30 days. `POST /oauth/revoke` (RFC 7009). Owner endpoints: `GET /api/oauth/clients/:id`, `POST /api/oauth/authorize`.
