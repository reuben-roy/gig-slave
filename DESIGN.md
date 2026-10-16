# Hired Gun: design direction

Product name: **Hired Gun** (display). Identifiers stay `gigagent` (npm package, `npx gigagent`, `GIGAGENT_*` env, `.gigagent-undo.json`, webhook `type`, `localStorage` key, Vercel project). See [Compatibility](#compatibility-what-was-not-renamed).

## Brief

- **Subject:** an operator writes one job, sends a one-time code, and an AI agent does it on someone else's Mac while the operator watches. Then it reports back and removes itself.
- **Audiences:** (1) the *operator*, a capable friend / IT person who lives in the dashboard; (2) the *person at the computer*, non-technical, who only sees one Terminal line and a landing page link.
- **The joke:** a hired gun rides in, does one job, rides out. The name carries the humour. The interface stays plain, honest and fast to read; no weapon imagery, no costume Western.

## Rejected first draft

Wanted poster: cream paper, serif display, terracotta/rust accent, revolver or bullet-hole motifs. Rejected: cream + clay is the stock generated look, and weapons make a trust product for non-technical people feel threatening. Replaced with workwear: a hired *hand* (denim, brass rivets, a work-order ticket, a badge star).

## Tokens

| Role | Light | Dark | Notes |
|---|---|---|---|
| Bleached denim (`--bg`) | `#E9EEF2` | `#0B1322` | page ground |
| Ticket stock (`--surface`) | `#FBFCFD` | `#111C31` | cards, ticket, inputs |
| Denim ink (`--text`) | `#14213A` | `#E8EEF6` | body, headings, focus ring (light) |
| Brass (`--brass`) | `#F2B632` | `#F2B632` | the one accent: primary actions, badge, live state. Ink text on it is 8.8:1 |
| Deep brass (`--brass-text`) | `#7F5000` | `#F2B632` | brass used as *text* on light grounds (5.9:1+) |
| Pine / Rust / Rivet blue | `#1B6B49` / `#B3321B` / `#2B5FA0` | `#4FD39A` / `#FF8A73` / `#7DB0F2` | done / stop or failed / info. Always paired with an icon or word, never colour alone |

Secondary text `#3A4862` (7.9:1) and tertiary `#56647D` (5.1:1 on the page ground); input and control borders `#77879B` (3.1:1). Dark mode follows `prefers-color-scheme`; every pair was checked with a contrast script (see the verification notes in the handoff).

**Type.** *Zilla Slab* 600/700 (Mozilla, SIL OFL) for headlines, the access code and numbers: a typewriter/telegraph slab with real weight. *Hanken Grotesk* (variable, SIL OFL) for all UI and body text. System monospace only for commands and code. Both are self-hosted in `assets/fonts/` (no third-party font requests), `font-display: swap`, `font-size-adjust: from-font` so the fallback doesn't jump. Scale is fluid via `clamp()`; sizes in `rem` so user text-size settings work.

**Shape.** Three radii on purpose: 6px controls, 10px panels, 999px pills/status. The ticket (the memorable object) has notched edges and a perforated tear line. Elevation is one soft shadow, used only on the ticket and dialogs.

**Motion.** Landing: one orchestrated moment, the terminal lines typing in on the ticket. Everything else is state feedback only (button press, disclosure, toast). `prefers-reduced-motion` shows the final state with no animation.

## Layout concepts

Landing (left-aligned, asymmetric; the ticket is the hero object):

```
 [★] Hired Gun        How it works  Jobs  Trust  FAQ            [ Open dashboard ]
 ─────────────────────────────────────────────────────────────────────────────
  A hired gun for the                         ┌─ Job ticket ───────────┐
  Mac you can't get to.                       │ Tidy Dad's Desktop     │
  Write the job. Send a code. They paste      │ Code  K7QM-4XPA        │
  one line, an AI agent does it while you     ├╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌┤  tear line
  watch, then it reports back and leaves.     │ $ npx gigagent K7QM…   │
  [ Open dashboard ]  How it works            │ ✓ Done. Report sent.   │
                                              └────────────────────────┘
```

Then: the gap (two columns, plain) → how it works (a real 3-step sequence, so numbered) → the jobs people send (ruled list, not a card grid) → ROI calculator → example result → trust (built in vs. rules the agent follows) → FAQ → final call → footer.

Dashboard (operator tool; same IDs and behaviour as before, new surface): ink top bar with the badge, two columns (new job + jobs on the left, session detail on the right), single column with a Back button on phones. The success card is the ticket again: the code is shown on a tear-off stub.

CLI: brass `★ Hired Gun` header, one brass spinner line while working, a boxed ending (green done / red problem) that says it has left.

## Voice

Plain verbs, sentence case, active voice. One dry joke per surface, never in an error. Same noun everywhere: **job** (what the operator writes), **code** (what they send), **session** (one computer running a job), **report** (what comes back). Errors say what happened and what to do; they don't apologise.

## Self-critique (design-critique pass, before building)

| Finding | Severity | Resolution |
|---|---|---|
| Hero object (ticket) and the terminal compete if both are shown separately | Moderate | Fuse them: the terminal is the ticket's stub, one object |
| A grid of 8 identical use-case cards is the SaaS-card default | Moderate | Ruled two-column list: who / task / outcome |
| Brass on light ground fails as text | Critical | Brass is a fill with ink text; text use is `--brass-text` (5.9:1) |
| Dashboard density vs. phone | Moderate | Single column below 960px, 44px touch targets, 16px inputs |
| Humour could undermine trust copy | Moderate | Jokes only in headlines, empty states and the CLI sign-off; security text stays literal and keeps its "rules, not locks" honesty |

## State coverage (dashboard)

Loading (skeleton rows + "Connecting…" chip) · empty jobs · empty detail · sign-in error · config/list error (inline alert) · form validation (per field, `aria-invalid`) · creating (disabled button) · success ticket · session: connecting / working (pulsing) / idle / done / failed / stopped · event log empty / following / paused with unread · stop and revoke confirm dialogs · reconnecting chip · toasts.

## Compatibility: what was not renamed

`npx gigagent`, `cli/` package name and `bin`, `GIGAGENT_SERVER` / `GIG_SLAVE_SERVER`, `.gigagent-undo.json`, the Pi provider id `gigagent`, webhook payload `"type": "gigagent.session.ended"`, `localStorage` key `gigagentAdminToken`, the Vercel project / `BAKED_SERVER_URL` host, the Cloudflare Worker name `gig-slave`, workspace package names, the temp dir prefix `gigagent-`. A package or domain rename is a separate, deliberate migration (new npm name, redirects, deprecating the old name) and is not done here.
