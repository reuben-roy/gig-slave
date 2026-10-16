# Hired Gun

> Formerly GigAgent. The product name changed; the command, npm package and env vars are still `gigagent` / `GIGAGENT_*`, so existing codes, notes and deployments keep working.

Remote help for someone who isn't technical. You write a job on a dashboard and get a one-use code. The other person runs

```bash
npx gigagent ABCD-EFGH
```

in Terminal on their Mac. An AI agent does the job in one folder (say, `~/Desktop`), you watch every step live, and you get a structured report by email, Slack or Discord when it finishes. Then the agent removes itself.

The model API keys never reach the Mac. The CLI gets a per-session token and talks to the server's `/v1` proxy, which swaps in the real key.

- [PLAN.md](PLAN.md): architecture and decisions
- [CONTRACT.md](CONTRACT.md): the binding API contract
- [DESIGN.md](DESIGN.md): visual direction, tokens, voice and what was deliberately not renamed
- [CLAUDE.md](CLAUDE.md): working rules for the codebase

## Layout

| Path | What |
|---|---|
| `server/` | Hono app: admin API, agent API, `/v1` proxy, sweeper. Postgres (Neon) on Vercel, embedded PGlite locally |
| `server/public/index.html` | marketing landing page (served at `/`) |
| `server/public/dashboard.html` | operator dashboard (served at `/dashboard`) |
| `server/public/assets/` | shared brand tokens (`brand.css`), logo, self-hosted fonts (SIL OFL) |
| `cli/` | the `gigagent` npm package (the recipient's command) |
| `mock/` | scripted OpenAI-compatible upstream for offline tests |
| `e2e/run.mjs` | end-to-end test |
| `worker/`, `scripts/tunnel.mjs` | self-hosting option only: stable Cloudflare Worker address for a tunnel |

Requires Node 22.13+. The CLI runs on macOS only.

## Local development

```bash
cp .env.example .env
npm install
npm run build
npm start
```

Edit `.env` first. At minimum set `ADMIN_TOKEN` (`openssl rand -hex 24`) and a model key (see [Models](#models)).

Then open:

- http://localhost:8787: landing page
- http://localhost:8787/dashboard: operator dashboard (paste `ADMIN_TOKEN` once)

The local database is embedded PGlite in `./data/pglite`, relative to `server/` (because `npm start` runs there). Set `PGLITE_DIR=memory://` for a throwaway in-memory database. Set `DATABASE_URL` to use Postgres instead.

## Models

Models are set per job in the dashboard. `MODELS` lists the choices and `DEFAULT_MODEL` is preselected. The default is `anthropic/claude-haiku-5.5`.

- **Ids with a `/`** (for example `anthropic/claude-haiku-5.5`) go through **Vercel AI Gateway**. Set `AI_GATEWAY_API_KEY`. On Vercel you can leave it unset and the server uses the Vercel OIDC token.
- **Bare ids** (for example `deepseek-flash`) go **directly to DeepSeek** (`UPSTREAM_BASE_URL`, `UPSTREAM_API_KEY`). `UPSTREAM_EXTRA_BODY` keeps DeepSeek's thinking mode off, which breaks multi-turn tool calls.

## Notifications

When a job ends (done or failed), the operator is told in up to two ways. Each attempt is logged on the session.

- **Email** via Resend. Set `RESEND_API_KEY` and `NOTIFY_FROM` on the server, then give each job a `notify_email`. The default sender (`onboarding@resend.dev`) only delivers to the Resend account owner until you verify a sending domain.
- **Webhook** per job: `notify_webhook` takes a Slack or Discord incoming-webhook URL, or any `https://` URL that accepts JSON.

Killed jobs don't notify, because you stopped them yourself.

## Deploy to Vercel

The server runs on Vercel. The CLI talks to whatever URL is baked into it.

1. **Log in and link the project.** From the repo root:

   ```bash
   npx vercel login
   npx vercel link
   ```

2. **Set the root directory.** In the Vercel dashboard go to Project Settings → Build & Deployment → Root Directory and set it to `server`.

3. **Add a database.** In the Vercel dashboard add a **Postgres** database from the Marketplace (Neon). This sets `DATABASE_URL` for the project.

4. **Create an AI Gateway key.** Vercel dashboard → AI Gateway → API Keys. Set it as `AI_GATEWAY_API_KEY` (or rely on OIDC and skip this).

5. **Set the other environment variables** (Production). Either in the dashboard or with `npx vercel env add NAME production`:

   | Name | Value |
   |---|---|
   | `ADMIN_TOKEN` | `openssl rand -hex 24` (paste into the dashboard once) |
   | `PUBLIC_URL` | your production URL, e.g. `https://gigagent.vercel.app`, no trailing slash |
   | `CRON_SECRET` | `openssl rand -hex 24` (authorises `/api/cron/sweep`, which Vercel Cron calls) |
   | `RESEND_API_KEY`, `NOTIFY_FROM` | optional, for email notifications |

   Optional: `MODELS`, `DEFAULT_MODEL`, `UPSTREAM_API_KEY` (only if you use a bare DeepSeek id).

6. **Deploy.** From the repo root:

   ```bash
   npx vercel --prod
   ```

   Note the production URL it prints. It must match `PUBLIC_URL`.

7. **Bake the URL into the CLI.** Set `BAKED_SERVER_URL` in [cli/src/server-url.ts](cli/src/server-url.ts) to the production URL. Then:

   ```bash
   npm run build
   ```

   Bump `version` in `cli/package.json` (every publish needs a new version), then publish:

   ```bash
   cd cli && npm publish --access public
   ```

   `prepublishOnly` builds `dist/` first. Recipients then run `npx gigagent ABCD-EFGH`.

Check it end to end once: open `<production URL>/dashboard`, create a job on a throwaway folder, and run the command on a Mac.

### Self-hosting alternative (Cloudflare tunnel)

If you'd rather run the server on your own Mac, you need `cloudflared` (`brew install cloudflared`) and a free Cloudflare account.

1. Deploy the stable front door once: `cd worker && npx wrangler login && npx wrangler deploy`. It prints a permanent `https://gig-slave.<account>.workers.dev` address. The Worker is intentionally still named `gig-slave` (see `worker/wrangler.toml`), which keeps the already-baked `https://gig-slave.reubenroyk.workers.dev` URL working. Do not rename it.
2. Set that address as `PUBLIC_URL` in `.env` and as `BAKED_SERVER_URL` in `cli/src/server-url.ts`. Rebuild and publish the CLI as above.
3. Start the server (`npm start`), then in a second terminal run `npm run tunnel`. It starts a quick tunnel and points the Worker at it. Keep it running while jobs are live.

## Real-key demo on a Mac

1. Server up (Vercel or local with tunnel), `PUBLIC_URL` and `BAKED_SERVER_URL` set, CLI published.
2. In the dashboard, create a job: task "Organize my Desktop…", working folder `~/Desktop`, expiry `one_use`.
3. Send the person the code. They run `npx gigagent ABCD-EFGH` in Terminal.
4. Watch the event log on the dashboard. Send an instruction or press Kill if needed.
5. When it finishes, the report appears on the dashboard and goes to your email or Slack. The agent is instructed to log every move in `~/Desktop/.gigagent-undo.json` and to move files rather than delete them (an instruction, not a technical lock).

Try it on your own Mac first with a throwaway folder (for example `~/gigagent-test`, filled with a few files).

## Admin API (curl)

```bash
curl -s -X POST https://YOUR-SERVER/api/invites \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H 'content-type: application/json' \
  -d '{"label":"Dad","task":"Organize my Desktop into folders by type.","working_dir":"~/Desktop","model":"anthropic/claude-haiku-5.5","expiry_policy":"one_use"}'
```

```bash
curl -s https://YOUR-SERVER/api/invites -H "Authorization: Bearer $ADMIN_TOKEN"
```

Other endpoints (revoke, kill, instructions, events, SSE stream, config) are in [CONTRACT.md](CONTRACT.md).

Note: the browser's SSE stream (`EventSource`) cannot send headers, so the admin token appears in the SSE URL's query string. That means it can show up in request logs. Rotate `ADMIN_TOKEN` if logs are ever shared.

### Lost-connection alerts

The "Lost connection" notification comes from the sweeper at `GET /api/cron/sweep`. On the Vercel Hobby plan, cron runs at most daily, so alerts would be very late. For timely alerts, call it every 1 to 5 minutes from an external scheduler (for example cron-job.org or a GitHub Actions schedule), or use a Pro-plan Vercel cron:

```bash
curl -s https://YOUR-SERVER/api/cron/sweep -H "Authorization: Bearer $CRON_SECRET"
```


## Operator CLI and Claude (optional)

A terminal client and an MCP server for the operator, using scoped, revocable tokens instead of `ADMIN_TOKEN`. Contract: [CONTRACT.md](CONTRACT.md#operator-api-scoped-tokens-additive-design-docsoperator-api-contractmd); design and safety rules: [docs/operator-api-contract.md](docs/operator-api-contract.md); Claude setup: [integrations/claude/README.md](integrations/claude/README.md). The command name `hg-operator` and the workspace package `gigagent-operator-wip` are placeholders until the final name is chosen. `npx gigagent ABCD-EFGH` for recipients is untouched.

```bash
# server: set OPERATOR_API_ENABLED=1 (Vercel env or .env), redeploy
export GIGAGENT_SERVER=https://YOUR-SERVER
GIGAGENT_ADMIN_TOKEN=... node operator/dist/bin.js tokens create --label me --preset full --save   # token saved privately, not printed
node operator/dist/bin.js doctor
node operator/dist/bin.js jobs create --label "Tidy Desktop" --task "Organize my Desktop into folders by type."   # asks to confirm
node operator/dist/bin.js sessions wait <session-id> && node operator/dist/bin.js sessions report <session-id>
node operator/dist/bin.js --help          # add --json to any command for machine-readable output
```

Tokens never go on the command line: use `login` (hidden prompt or `--stdin`), `GIGAGENT_OPERATOR_TOKEN`, `GIGAGENT_OPERATOR_TOKEN_FILE`, or the macOS Keychain (service `gigagent-operator`, account = server origin). Revoke one with `tokens revoke <id>`, all with `tokens revoke-all`.

## Safety model

Built into the system:

- **Keys stay on the server.** The Mac holds only a session token. Revoke a job or kill a session and its next model call is refused at once.
- **Codes are single-use if you choose.** `one_use` codes stop working after the first redemption. Repeated wrong codes from one address are rate-limited.
- **You watch it live.** Every command, its output (up to 2000 characters each) and the files the agent opens appear on the dashboard, and you can send instructions or stop it. This content is also sent to the model provider via Vercel AI Gateway.
- **Cleans up after itself.** The CLI removes its temporary files when it exits normally (done, failed, killed, Ctrl+C). A power loss or force-kill can leave them behind.
- **The Mac stays awake** during a job (`caffeinate`).

Rules the agent follows (instructions in `SYSTEM_PROMPT` in `cli/src/agent.ts`, not technical locks; the bash tool is not sandboxed):

- **Stays in one folder.** The agent is instructed to change things only in the working folder you chose. It may run read-only commands outside it (for example `sw_vers`, `df`, listing `/Applications`) to look up information.
- **Moves instead of deleting.** It is told to move files rather than delete them, and to record every move in `.gigagent-undo.json` in that folder so it can be reversed.
- **No sudo, installs or network.** It is told not to use admin rights, install software, or download or upload anything.

The person running the CLI needs a Mac with Node.js 22+ (free installer at nodejs.org). If it is missing or too old, the CLI explains what to do; if Node is missing entirely, macOS reports `command not found: npx`.

## Tests

```bash
npm run e2e
```

Builds everything, starts the mock upstream and the server, creates an invite, runs the real CLI against a fake Desktop in `e2e/.tmp/`, and checks the report, expiry rules, kill path, and temp-dir cleanup. Spends no tokens.
