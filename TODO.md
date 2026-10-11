# Your TODOs (things only you can do)

`npm run e2e` passes offline against the mock. These steps get the real demo running.

## Needed for the real demo
- [ ] **Fix `.env`**. It still has the pre-DeepSeek values:
  - `ADMIN_TOKEN` is still the `change-me…` placeholder. The server now refuses to start with it. Replace it with the output of `openssl rand -hex 24`.
  - Switch the provider lines to match `.env.example`: `UPSTREAM_BASE_URL=https://api.deepseek.com`, `DEFAULT_MODEL=deepseek-flash`, `MODELS=deepseek-flash,deepseek-v4-pro`, and add `UPSTREAM_EXTRA_BODY={"thinking":{"type":"disabled"}}`.
  - Check that `UPSTREAM_API_KEY` is your DeepSeek key (https://platform.deepseek.com/api_keys). Keep it out of chat; it only needs to be in `.env`.
  - Set `PUBLIC_URL` to your tunnel URL (it's still `REPLACE-ME`).
- [x] Model is `deepseek-flash` (V4.1 Flash) at `https://api.deepseek.com`; thinking is disabled via `UPSTREAM_EXTRA_BODY` so tool calls work.
- [x] cloudflared is installed, and a tunnel URL is baked into `cli/src/server-url.ts`.
- [ ] **Tunnel URL must match**: quick tunnels get a new URL on every start. The baked one (`inflation-someone-expenditures-contracts.trycloudflare.com`) currently returns 502, so the tunnel or server is down. After each `cloudflared tunnel --url http://localhost:8787`, update both `PUBLIC_URL` in `.env` and `BAKED_SERVER_URL` in `cli/src/server-url.ts`, or set up a named tunnel for a stable hostname.
- [ ] **npm publish**: `npm login` (needs your npm account and 2FA), then `cd cli && npm publish --access public`. Do this after the final tunnel URL is baked in, and bump `version` for every republish.

## Worth doing before showing anyone
- [ ] **Dry run on your own Mac** with a throwaway folder: create an invite with working dir `~/gig-slave-test`, then run `GIG_SLAVE_SERVER=http://localhost:8787 node cli/dist/index.js <CODE>`. The first real-model run is the only thing the mock can't prove (DeepSeek's tool-call streaming through Pi).
- [ ] **macOS privacy prompt**: the first time Terminal touches `~/Desktop`, macOS asks "Terminal would like to access files in your Desktop folder". Tell the recipient to click **Allow**. If they refuse, the CLI explains how to fix it in System Settings.
- [ ] **Review the agent's system prompt** in `cli/src/agent.ts` (`SYSTEM_PROMPT`); it's the main safety control in v0.

## Decisions you may want to make
- [ ] The repo has `git init` but no commits yet. Want me to make the initial commit or push to GitHub?
