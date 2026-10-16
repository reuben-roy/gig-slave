# Your TODOs (things only you can do)

`npm run e2e` passes offline against the mock. These steps get the real GigAgent running on Vercel.

## Vercel (done 2026-10-14)
- [x] Project `gigagent` (team reubenroy's projects, Hobby), Root Directory `server`, linked from the repo root (`.vercel/`).
- [x] Neon Postgres `gigagent-db` from the Marketplace, connected (sets `DATABASE_URL`). **Check its plan is Free**: Vercel dashboard → Storage → gigagent-db.
- [x] Env vars `ADMIN_TOKEN` and `CRON_SECRET` set (Production + Preview). Their values are in `.vercel/secrets.env` (gitignored); use `ADMIN_TOKEN` to sign in to the dashboard.
- [x] Models use the AI Gateway through the project's OIDC token, so no `AI_GATEWAY_API_KEY` is needed. `PUBLIC_URL` defaults to the production URL.
- [x] Production: **https://gigagent-beta.vercel.app** (`gigagent.vercel.app` was taken; add a custom domain in Project Settings → Domains if you want one, then update `BAKED_SERVER_URL`).
- [x] Real job on production with Claude Haiku 5.5 passed (about 7k tokens, well under a cent).
- [ ] Check in Vercel billing that AI Gateway usage is being taken from your credits.
- To redeploy: `npx vercel deploy --prod` from the repo root.

## Publish the CLI
- [x] **Production URL baked** into `BAKED_SERVER_URL` (`https://gigagent-beta.vercel.app`).
- [x] **Published** `gigagent@0.2.0` to npm (2026-10-14). Recipients run `npx gigagent ABCD-EFGH`.
- [ ] For the next release: bump `version` in `cli/package.json`, then `cd cli && npm publish --access public` (needs your 2FA code).
- [ ] Optional: `npm deprecate gigagent@0.0.0-stage "placeholder"` to hide the leftover staging placeholder version.

## Optional
- [ ] **Email notifications**: create a Resend account and verify a sending domain, then set `NOTIFY_FROM` to an address on it. The default sender only delivers to your own Resend address.
- [ ] **Try a Slack webhook** on a real job (paste an incoming-webhook URL into Notify me) and check the summary arrives.
- [ ] **Review the agent's system prompt** in `cli/src/agent.ts` (`SYSTEM_PROMPT`). It's the main safety control. It now allows read-only system info commands (`sw_vers`, `df`, `system_profiler`) so the agent can answer questions. Check that's the balance you want.
- [ ] **macOS privacy prompt**: the first time Terminal touches `~/Desktop`, macOS asks "Terminal would like to access files in your Desktop folder". Tell the recipient to click **Allow**. If they refuse, the CLI explains how to fix it in System Settings.
- [ ] **Review the landing-page claims** in `server/public/index.html`, and the **ROI calculator defaults** on it, before sharing the link.
- [ ] **Set up an external pinger for `/api/cron/sweep`** (or a Pro-plan Vercel cron) for timely lost-connection alerts. Hobby cron only runs daily.
- [ ] **Decide whether to add real enforcement** (sandbox/allow-list) for the agent's file rules. Today they are instructions only.
- [ ] **Rename the GitHub repo and local folder** from `gig-slave` to `gigagent`, if you want the names to match.
- [ ] **Commit, then push to GitHub?** The GigAgent rework and Vercel setup are not committed yet. No remote yet.

## Done
- [x] `.env` is set up for local runs (model key, random admin token).
- [x] Real DeepSeek test through the self-hosting tunnel passed on a throwaway folder (`~/gig-slave-test`).
- [x] Self-hosting front door (old Worker name): `https://gig-slave.reubenroyk.workers.dev`. The Worker is intentionally still named `gig-slave`, so redeploying it keeps the same address. Only needed if you self-host with `npm run tunnel`.
