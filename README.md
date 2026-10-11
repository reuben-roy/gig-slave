# gig-slave

A one-shot remote helper. You create an "agent invite" on a dashboard; the other person runs

```bash
npx gig-slave
```

types the code, and watches a status line while a headless [Pi](https://www.npmjs.com/package/@mariozechner/pi-coding-agent) agent does the task on their Mac. You watch it live, can send follow-up instructions or kill it, and get a plain-English report. Then it removes itself.

The DeepSeek key never leaves your server: the CLI gets a per-session token and talks to your server's `/v1` proxy, which swaps in the real key.

See [PLAN.md](PLAN.md) for the architecture and [CONTRACT.md](CONTRACT.md) for the API.

## Layout

| Path | What |
|---|---|
| `server/` | control server: admin API, agent API, `/v1` proxy, sweeper, SQLite (`node:sqlite`) |
| `server/public/index.html` | dashboard (served at `/`) |
| `cli/` | the `gig-slave` npm package |
| `mock/` | scripted OpenAI-compatible upstream for offline tests |
| `e2e/run.mjs` | end-to-end test |

Requires Node 22.13+ (for built-in `node:sqlite`) and macOS (v0).

## 1. Setup

```bash
npm install
```

```bash
cp .env.example .env
```

Edit `.env`:

- `ADMIN_TOKEN`: any long random string (`openssl rand -hex 24`). You paste it into the dashboard once.
- `UPSTREAM_API_KEY`: your DeepSeek API key (https://platform.deepseek.com). Defaults point at `https://api.deepseek.com` and model `deepseek-flash` (V4.1 Flash).
- `PUBLIC_URL`: your Cloudflare tunnel URL (step 3). Restart the server after changing it.

## 2. Run the server

```bash
npm run build
```

```bash
npm start
```

The server reads `.env` from the repo root and listens on `PORT` (8787). Open http://localhost:8787 for the dashboard. The database lives at `server/data/gig-slave.db` by default.

## 3. Expose it with a Cloudflare Tunnel

```bash
brew install cloudflared
```

```bash
cloudflared tunnel --url http://localhost:8787
```

It prints a `https://<random>.trycloudflare.com` URL. Put it in `.env` as `PUBLIC_URL` and restart the server. Quick tunnels get a new URL each time they start; for a stable URL, set up a named tunnel.

## 4. Bake the server URL into the CLI

Edit [cli/src/server-url.ts](cli/src/server-url.ts) and set `BAKED_SERVER_URL` to the same tunnel URL. For local testing you can skip this and use the override:

```bash
GIG_SLAVE_SERVER=http://localhost:8787 node cli/dist/index.js
```

## 5. Publish the CLI

```bash
cd cli && npm publish --access public
```

`prepublishOnly` builds `dist/` first. Bump `version` in `cli/package.json` for every publish (for example after the tunnel URL changes). Recipients then run `npx gig-slave` or `npx gig-slave ABCD-EFGH`.

## 6. Real-key demo on a Mac

1. Server running, tunnel up, `PUBLIC_URL` and `BAKED_SERVER_URL` set, CLI published.
2. Open the dashboard, paste your `ADMIN_TOKEN`, create an agent: task "Organize my Desktop…", working dir `~/Desktop`, policy `one_use`.
3. Send the person the command shown (`npx gig-slave ABCD-EFGH`).
4. On their Mac they run it in Terminal. Watch the event log on the dashboard; send an instruction or press Kill if needed.
5. When it finishes the report appears on the dashboard. Every move is listed in `~/Desktop/.gig-slave-undo.json`; nothing is deleted.

Try it on your own Mac first with a throwaway folder as the working dir (for example `~/gig-slave-test` filled with a few files).

## Admin API (curl)

```bash
curl -s -X POST http://localhost:8787/api/invites -H "Authorization: Bearer $ADMIN_TOKEN" -H 'content-type: application/json' -d '{"label":"Dad","task":"Organize my Desktop into folders by type.","expiry_policy":"one_use"}'
```

```bash
curl -s http://localhost:8787/api/invites -H "Authorization: Bearer $ADMIN_TOKEN"
```

Other endpoints (revoke, kill, instructions, events, SSE stream) are listed in [CONTRACT.md](CONTRACT.md).

## Tests

```bash
npm run e2e
```

Builds everything, starts the mock upstream and the server, creates an invite, runs the real CLI against a fake Desktop in `e2e/.tmp/`, and checks the report, expiry rules, kill path, and temp-dir cleanup. Spends no tokens.
