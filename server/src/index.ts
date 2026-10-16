import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Hono } from "hono";
import { admin } from "./admin.js";
import { agent } from "./agent.js";
import { config } from "./config.js";
import { mcp } from "./mcp.js";
import { operator } from "./operator.js";
import { ServiceError } from "./jobs.js";
import { proxy } from "./proxy.js";

/**
 * The whole app. Vercel's zero-config Hono detection imports the default export of this file;
 * the local Node entry (main.ts) wraps it with a static file server and the interval sweeper.
 * Importing this module must stay side-effect free (no listeners, no timers, no DB access).
 */
const app = new Hono();

app.get("/health", (c) => c.json({ ok: true }));

// On Vercel the Hono preset routes "/" to this function before the CDN, so serve the landing page
// here. (Locally main.ts serves it from disk before the request ever reaches the app.)
let landing: Promise<string | null> | undefined;
const loadLanding = () =>
  (landing ??= (async () => {
    const candidates = [
      new URL("../public/index.html", import.meta.url),
      join(process.cwd(), "public/index.html"),
      join(process.cwd(), "server/public/index.html"),
    ];
    for (const file of candidates) {
      try {
        return await readFile(file, "utf8");
      } catch {
        // try the next location
      }
    }
    return null;
  })());
app.get("/", async (c) => {
  const html = await loadLanding();
  return html ? c.html(html) : c.redirect("/home", 302);
});

// Misconfiguration (e.g. missing ADMIN_TOKEN) fails the API clearly, but never the static landing page.
app.use("*", async (c, next) => {
  const p = c.req.path;
  if (["/api", "/agent", "/v1", "/operator", "/mcp"].some((x) => p.startsWith(x)) && config.errors.length) {
    const msg = `server misconfigured: ${config.errors.join("; ")}`;
    return c.json(p.startsWith("/v1") ? { error: { message: msg } } : { error: msg }, 500);
  }
  await next();
});

// The lazy sweep (throttled to once per 5s, so expiry/lost-connection work without a long-lived process) runs inside
// each route group's auth middleware, only after authentication succeeds. Anonymous requests never trigger it, and
// /agent/redeem (unauthenticated by design) does not sweep either. Every DB helper awaits ensureSchema() itself;
// redeem also calls it explicitly up front.

app.route("/api", admin);
app.route("/agent", agent);
app.route("/v1", proxy);
app.route("/operator", operator);
app.route("/mcp", mcp);

app.notFound((c) => c.json({ error: "not found" }, 404));
app.onError((e, c) => {
  if (e instanceof ServiceError) return c.json({ error: e.message, code: e.code }, e.status);
  console.error(e);
  return c.json({ error: "internal error" }, 500);
});

export default app;
