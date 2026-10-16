# Hired Gun redesign: handoff

Branch `worktree-hired-gun-redesign`, worktree `.claude/worktrees/hired-gun-redesign` (local only, not pushed, nothing deployed). Direction, tokens, critique and the do-not-rename list: [DESIGN.md](DESIGN.md). Screenshots: `docs/hired-gun-redesign/*.png`.

## What changed

| Area | Files |
|---|---|
| Shared assets | `server/public/assets/brand.css` (tokens, primitives), `logo.svg` (badge), `og.png`, `fonts/` (Zilla Slab 600/700 + Hanken Grotesk, SIL OFL licences included, self-hosted) |
| Landing page | `server/public/index.html` (full rewrite, same section ids `#how #use-cases #roi #security #faq`, same ROI maths) |
| Dashboard | `server/public/dashboard.html` (new CSS and markup; every element id and every JS-built class kept; about a dozen script lines changed, all copy, branding or one aria-label) |
| CLI presentation | `cli/src/ui.ts`, `cli/src/index.ts`, `cli/src/bin.ts` (+ rebuilt `cli/dist`) |
| Display strings (server) | `server/src/notify.ts` (email subject/body, Slack, Discord), `proxy.ts` (`X-Title`), `config.ts` (`NOTIFY_FROM` default), `main.ts` (log line) |
| Docs | README, CONTRACT, PLAN, CLAUDE, TODO, DEMO_*, cli/README, `.env.example`, `e2e/run.mjs` (landing assertion now `Hired Gun`) |

Not renamed on purpose (compatibility): `npx gigagent`, npm package and bin, `GIGAGENT_*` / `GIG_SLAVE_*`, `.gigagent-undo.json`, Pi provider id, webhook `type: "gigagent.session.ended"`, `localStorage` key `gigagentAdminToken`, Vercel project and baked URL, Worker name `gig-slave`, workspace package names. The landing FAQ explains why the command still says `gigagent`.

## Integration requirements (do these in order; nothing here is done yet)

1. **Wait for both active workers to land.** Do not deploy or replace shared files before then.
2. **Polling fix owner (`gigagent-vercel-usage-assessment`).** In `dashboard.html` the block from `// ============ boot & live updates ============` to just before `// ============ done/failed notifications ============` (functions `start`, `loadConfig`, `loadInvites`, `setInvites`, `connect`, the `visibilitychange` listener, `upsertSession`, `onSession`, `onInvite`, `onEvent`) is **byte-identical to the pre-redesign file** (sha256 prefix `c0bc39af264f` before and after), so their changes can be carried over untouched. Apply their JS change on top of the redesigned file, or apply `docs/hired-gun-redesign/integration.patch` on top of theirs; the patch only touches script lines outside that block (list below). The JS reads these DOM hooks, all preserved: `#conn[data-state=off|live|retry]`, `#connText`, `#app`, `#auth`, `#jobs`, `#listErr`, `#formErr`, `#notifBtn`, `#signOut`, and the model radio class `.sr` (kept as a CSS alias). If they add markup (for example a "paused" indicator), put it next to `#conn` and style it with the tokens in `brand.css`.
   Script lines I changed outside that block: tab titles, notification title (`Hired Gun: …`), download file name (`hired-gun-<label>.md`), empty-jobs heading, "Job done" / "Job didn’t finish", the stop-dialog sentence, the message operators copy to send, `Website` link label, removal of the session-row `aria-label` (it contradicted the visible text), and `renderJobs` also clears the new `.jobs-loading` placeholder.
3. **Server admin stream:** I did not touch `admin.ts`, `index.ts`, `db.ts`, `lifecycle.ts`, `sweeper.ts`, `agent.ts` or SSE code. My server edits are four display strings in `notify.ts`, `proxy.ts`, `config.ts`, `main.ts` and cannot conflict logically.
4. **Credential / deployment owner (`gigagent-admin-secret-rotation`):** no secret, auth or deployment change in this work. Two things for them: (a) if Vercel has `NOTIFY_FROM` set to `GigAgent <…>`, change it to `Hired Gun <…>` (only the code default changed); (b) the new files under `server/public/assets/fonts/` and `assets/og.png` must ship with `server/public/` (Vercel serves that directory as-is; `vercel.json` unchanged).
5. After integrating: `npm run build && npm run e2e`, load `/` and `/dashboard` once at desktop and phone width, then deploy.
6. **CLI:** the new terminal copy only reaches recipients after you bump the version and `npm publish --access public` from `cli/` (your account; not done).

`integration.patch` is a unified diff of every text file I changed against the snapshot of the dirty working tree taken at the start (`patch -p1 --dry-run < docs/hired-gun-redesign/integration.patch` from the repo root first). Binary and new directories (`assets/fonts/`, `assets/og.png`, `docs/`, `DESIGN.md`, this file) are copied, not patched. For `cli/dist` and `server/dist`, rebuild instead of patching.

## Commit note

The branch commit contains only files I changed for the redesign. Several of them also contain your earlier uncommitted work (the branch is based on `HEAD`, which predates that work), so merging the commit as-is would pull that work in too. Use the patch for integration.

## Verification evidence

Run locally against the app served by `server/dist/main.js` with in-memory PGlite, a throwaway admin token and seeded jobs/sessions (working, done with a structured report, failed, pending, revoked). Chrome via `playwright-core`.

- `npm run build` ok. `npm run e2e`: all 22 steps passed (mock upstream; no tokens spent).
- axe-core 4.x (WCAG 2.0/2.1/2.2 A and AA plus best-practice): **0 violations** on 14 scans: landing and dashboard (sign-in, working session, finished report) × light/dark × 1440 and 390 wide. A few "incomplete" items are axe being unable to compute contrast over the terminal mock and the `·` separators (the separators are `aria-hidden`).
- Contrast of every token pair computed (all text pairs ≥ 4.5:1, control borders ≥ 3:1; see DESIGN.md).
- Keyboard (scripted): skip link is the first tab stop; 70 tab stops on the landing page and 45 on the dashboard all showed a focus indicator (the one exception per page is the wrap-around back to the browser UI); mobile menu opens with Enter, closes with Escape and returns focus to its button; stop dialog opens, focuses Cancel, Escape closes and returns focus to Stop.
- No horizontal scroll at 320, 360, 390, 768 on either page. `prefers-reduced-motion` shows all terminal lines immediately.
- States captured: sign-in, wrong token, loading skeleton, list error, empty form validation, field-level error, creating, success ticket, session working / done / failed, revoked and pending jobs, stop dialog (light and dark), mobile detail.

Not verified, so do not assume: Safari and Firefox rendering; VoiceOver or any screen reader (only automated checks plus keyboard); a real Vercel deploy (fonts and `og.png` were served by the local Hono static handler, not the CDN); email rendering (no `RESEND_API_KEY` locally, so the new subject and header are untested in a real inbox); a real CLI run against a real model (only the mock e2e and a rendered preview of the new terminal output); the "Enable desktop notifications" flow; real session volume in the activity timeline.

## Skills and tools actually used

Read from the installed sources and applied inline (not invoked through the Skill tool): design plugin `design-system`, `design-critique`, `ux-copy`, `accessibility-review`; `frontend-design`; `modern-web-guidance` (search run before any frontend code, then guides `dark-mode`, `visually-stable-font-fallbacks`, `search-hidden-content`, `declarative-dialog-popover-control`, `platform-controls-dismiss-dialog`, `accessibility`, `color`, `typography`, `motion` retrieved). Not used: Figma and the other design-plugin connectors (not authenticated, no design file), DesignSync, Canva. The browser-use MCP was not used; `playwright-core` with the system Chrome was. The `MCP_DOCKER` server failed to connect and was not needed.

### Modern Web Guidance

- **`dark-mode`**: tokens are plain custom properties switched by `prefers-color-scheme` (not `light-dark()`), with `<meta name="color-scheme">` and `:root { color-scheme: light dark }` so form controls and scrollbars follow ("Apply the `color-scheme` property to the `html` element or the `:root` pseudo-class").
- **`visually-stable-font-fallbacks`**: `font-size-adjust: from-font` on `html` so the slab and grotesk fallbacks don't jump when the self-hosted fonts swap in ("Use the `from-font` keyword to let the browser extract the ratio from your primary web font").
- **`search-hidden-content`**: the FAQ is native `<details>`, so answers are findable with Find in page ("Prefer using `<details>` over `hidden=\"until-found\"` if possible").
- **`accessibility`**: kept the native `<dialog>` with `showModal()` and no focus trap code; moved field hints above inputs and linked them with `aria-describedby` ("place the hint above the input so autocomplete popovers don't cover it during editing").
- **`color`**: every status pairs colour with an icon or word, plus a `forced-colors` fallback for the ticket and primary button ("Don't use color alone to indicate the presence of a user interface component or its state").
- **`typography`**: sizes in `rem`, fluid `clamp()` headings, `text-wrap: balance` only on headings without boxes ("DO NOT apply it on `*`").
- **`motion`**: reduced-motion handled per component, not with a global near-zero duration ("DO NOT globally apply `animation-duration: 0.01ms;`").
- Searched and not applied: `declarative-dialog-popover-control` and `platform-controls-dismiss-dialog` (the confirm dialog needs a returned value from JS, so I kept the existing `showModal()` flow).
