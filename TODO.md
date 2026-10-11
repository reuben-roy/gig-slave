# Your TODOs (things only you can do)

`npm run e2e` passes offline against the mock. These steps get the real demo running.

## Needed for the real demo
- [x] `.env` is set up (DeepSeek key, random admin token, stable `PUBLIC_URL`).
- [x] Stable URL: `https://gig-slave.reubenroyk.workers.dev` (Cloudflare Worker, baked into the CLI). Run `npm run tunnel` whenever the server should be reachable.
- [x] Real DeepSeek test through the public URL passed on a throwaway folder (`~/gig-slave-test`).
- [ ] **npm publish**: `npm login` (needs your npm account and 2FA), then `cd cli && npm publish --access public`. Do this after the final tunnel URL is baked in, and bump `version` for every republish.

## Worth doing before showing anyone
- [ ] **macOS privacy prompt**: the first time Terminal touches `~/Desktop`, macOS asks "Terminal would like to access files in your Desktop folder". Tell the recipient to click **Allow**. If they refuse, the CLI explains how to fix it in System Settings.
- [ ] **Review the agent's system prompt** in `cli/src/agent.ts` (`SYSTEM_PROMPT`); it's the main safety control in v0.

## Decisions you may want to make
- [ ] The repo has `git init` but no commits yet. Want me to make the initial commit or push to GitHub?
