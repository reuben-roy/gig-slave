# gig-slave — Interface Contract (source of truth for all packages)

All JSON. All times are unix **ms**. Errors: `{ "error": "<message>" }` with a 4xx/5xx status.

## Auth
- Admin endpoints (`/api/*`): `Authorization: Bearer <ADMIN_TOKEN>`. The SSE endpoint also accepts `?token=<ADMIN_TOKEN>` (EventSource can't set headers).
- Agent endpoints (`/agent/*` except redeem) and `/v1/*`: `Authorization: Bearer <session_token>`.

## Codes
- Invite code format: 8 chars, uppercase, from alphabet `ABCDEFGHJKMNPQRSTUVWXYZ23456789`, displayed as `XXXX-XXXX`. Server normalizes input: strip non-alphanumerics, uppercase.
- Stored as sha256 hex. Session token: 32 random bytes hex, stored as sha256 hex.

## Admin API

`POST /api/invites`
```json
// request
{ "label": "Dad's iMac", "task": "Organize my Desktop...", "working_dir": "~/Desktop",
  "model": "deepseek-flash", "expiry_policy": "one_use" | "on_complete" | "ttl",
  "ttl_hours": 24, "max_redemptions": null }
// response 201
{ "invite": Invite, "code": "ABCD-EFGH", "command": "npx gig-slave ABCD-EFGH" }
```
`GET /api/invites` → `{ "invites": [Invite & { "sessions": Session[] }] }` (newest first)
`POST /api/invites/:id/revoke` → `{ "ok": true }` (invite.status=revoked, all live sessions → kill)
`GET /api/sessions/:id/events?after=<eventId>` → `{ "events": Event[] }`
`POST /api/sessions/:id/instructions` `{ "text": "..." }` → `{ "ok": true }`
`POST /api/sessions/:id/kill` → `{ "ok": true }`
`GET /api/config` → `{ "models": ["deepseek-flash","deepseek-v4-pro"], "default_model": "...", "public_url": "..." }`
`GET /api/stream?token=` → SSE. Each message: `event: <name>\ndata: <json>\n\n` where name ∈
- `event` → `Event`
- `session` → `Session` (whenever a session row changes)
- `invite` → `Invite` (whenever an invite row changes)
Keep-alive comment `: ping` every 15s.

### Shapes
```ts
Invite  = { id, label, task, working_dir, model, expiry_policy, expires_at: number|null,
            max_redemptions: number|null, redemptions, failed_attempts,
            status: "pending"|"active"|"completed"|"expired"|"revoked", created_at }
Session = { id, invite_id, machine: {hostname,platform,release,arch,username}|null,
            status: "connecting"|"working"|"idle"|"done"|"failed"|"killed",
            status_text: string|null,  // short human line, e.g. "Moving 12 screenshots"
            report: string|null, last_heartbeat, started_at, ended_at: number|null,
            tokens_in, tokens_out, actions }
Event   = { id, session_id, ts, type: "status"|"tool_call"|"tool_result"|"assistant"|"error"|"report"|"instruction",
            data: object }
```
Event `data` conventions:
- status: `{ status, text }`
- tool_call: `{ tool, args }` (args truncated)
- tool_result: `{ tool, ok, output }` (output truncated to 2000 chars)
- assistant: `{ text }`
- error: `{ message }`
- report: `{ text, success }`
- instruction: `{ text }` (server writes this when operator sends one)

## Agent API

`POST /agent/redeem`
```json
// request
{ "code": "ABCD-EFGH", "machine": { "hostname","platform","release","arch","username" }, "cli_version": "0.1.0" }
// 200
{ "session_id", "session_token", "task", "working_dir", "model",
  "v1_base_url": "<PUBLIC_URL>/v1", "heartbeat_ms": 5000 }
// 401 invalid code, 403 locked/expired/revoked/used, 429 rate-limited
```
Rules: 5 failed attempts across all codes from one IP within 10 min → 429. An invite whose code was guessed wrong doesn't apply (codes are random); `failed_attempts` counts on IP only. Increment `redemptions`; for `one_use`, after redemption invite.status = completed-on-end (cannot be redeemed again). For `ttl`, redeemable until expires_at and `max_redemptions` (null = unlimited). For `on_complete`, redeemable until a session completes with success.

`POST /agent/events` `{ "events": [{ "ts", "type", "data" }] }` → `{ "ok": true }`. Server also updates session.status/status_text from `status` events, increments `actions` per tool_call.

`POST /agent/heartbeat` `{ "status", "status_text" }` → `{ "kill": boolean, "instructions": [{ "id", "text" }] }` (returned instructions are marked delivered).

`POST /agent/complete` `{ "success": boolean, "report": string }` → `{ "ok": true }`. Sets session done/failed, ended_at, writes a `report` event, applies expiry policy.

A session is **alive** iff status ∉ {done, failed, killed}, invite.status ∉ {expired, revoked}, and (expires_at null or > now). `kill` = !alive or kill requested.

## Inference proxy

`POST /v1/chat/completions` — Bearer session token. If session not alive → 403 `{error:{message:"session expired"}}`. Otherwise forward body to `${UPSTREAM_BASE_URL}/chat/completions` with `Authorization: Bearer ${UPSTREAM_API_KEY}`, `HTTP-Referer: PUBLIC_URL`, `X-Title: gig-slave`. **Force `model` to the invite's model** (the client value is ignored). Stream the upstream response body back byte-for-byte with the same status and content-type. Parse usage best-effort (non-stream JSON `usage`, or SSE `data:` chunks containing `usage`) and add to tokens_in/tokens_out.
`GET /v1/models` → `{ "object":"list", "data":[{ "id": <invite model>, "object":"model" }] }`.

## Server env
```
PORT=8787  ADMIN_TOKEN  UPSTREAM_BASE_URL=https://api.deepseek.com  UPSTREAM_API_KEY
DEFAULT_MODEL=deepseek-flash  MODELS=deepseek-flash,deepseek-v4-pro  UPSTREAM_EXTRA_BODY={"thinking":{"type":"disabled"}}
PUBLIC_URL=http://localhost:8787  DB_PATH=./data/gig-slave.db
```
Sweeper every 10s: invites with expires_at < now → expired; sessions alive with last_heartbeat older than 45s → failed (status_text "Lost connection").

## CLI env
`GIG_SLAVE_SERVER` overrides the baked-in server URL (baked default read from `cli/src/server-url.ts`).
