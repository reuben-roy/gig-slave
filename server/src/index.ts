import { readFile } from "node:fs/promises";
import { serve, type HttpBindings } from "@hono/node-server";
import { Hono } from "hono";
import { admin } from "./admin.js";
import { agent } from "./agent.js";
import { config } from "./config.js";
import { db } from "./db.js";
import { proxy } from "./proxy.js";
import { startSweeper } from "./sweeper.js";

const app = new Hono<{ Bindings: HttpBindings }>();

app.get("/", async (c) => {
  try {
    return c.html(await readFile(new URL("../public/index.html", import.meta.url), "utf8"));
  } catch {
    return c.html("<h1>gig-slave</h1><p>Dashboard not built yet (server/public/index.html is missing).</p>");
  }
});

app.route("/api", admin);
app.route("/agent", agent);
app.route("/v1", proxy);

app.notFound((c) => c.json({ error: "not found" }, 404));
app.onError((e, c) => {
  console.error(e);
  return c.json({ error: "internal error" }, 500);
});

const sweeper = startSweeper();
const server = serve({ fetch: app.fetch, port: config.port }, () => {
  console.log(`gig-slave server listening on port ${config.port}`);
});

function shutdown() {
  clearInterval(sweeper);
  (server as { closeAllConnections?: () => void }).closeAllConnections?.();
  server.close(() => {
    db.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 2000).unref();
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
