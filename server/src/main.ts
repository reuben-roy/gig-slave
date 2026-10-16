import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { serve, type Http2Bindings, type HttpBindings } from "@hono/node-server";
import app from "./index.js";
import { config } from "./config.js";
import { closeDb, ensureSchema } from "./db.js";
import { startSweeper } from "./sweeper.js";

// Local Node entry: static files + interval sweeper + graceful shutdown.
for (const w of config.warnings) console.warn(`warning: ${w}`);
if (config.errors.length) {
  for (const e of config.errors) console.error(e);
  process.exit(1);
}

const PUBLIC_DIR = resolve(fileURLToPath(new URL("../public", import.meta.url)));

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".map": "application/json; charset=utf-8",
};

/** Same URL space as Vercel's CDN with cleanUrls: / -> index.html, /dashboard -> dashboard.html, /assets/x -> assets/x. */
async function staticResponse(req: Request): Promise<Response | null> {
  if (req.method !== "GET" && req.method !== "HEAD") return null;
  let pathname: string;
  try {
    pathname = decodeURIComponent(new URL(req.url).pathname);
  } catch {
    return null;
  }
  if (pathname.includes("\0")) return null;
  let rel: string;
  if (pathname === "/") rel = "index.html";
  else if (pathname === "/dashboard") rel = "dashboard.html";
  else if (pathname.startsWith("/assets/") || /^\/[^/]+\.(html|ico|png|svg|txt)$/.test(pathname)) rel = pathname.slice(1);
  else return null;

  const file = resolve(join(PUBLIC_DIR, normalize(rel)));
  if (file !== PUBLIC_DIR && !file.startsWith(PUBLIC_DIR + sep)) return null; // path traversal guard
  try {
    const info = await stat(file);
    if (!info.isFile()) return null;
    const body = req.method === "HEAD" ? null : await readFile(file);
    return new Response(body, {
      headers: {
        "content-type": TYPES[extname(file).toLowerCase()] ?? "application/octet-stream",
        "content-length": String(info.size),
        "cache-control": "no-cache",
      },
    });
  } catch {
    return null;
  }
}

await ensureSchema();
const sweeper = startSweeper();

const server = serve(
  {
    fetch: async (req: Request, env: HttpBindings | Http2Bindings) => (await staticResponse(req)) ?? app.fetch(req, env),
    port: config.port,
  },
  () => {
    console.log(`GigAgent server listening on http://localhost:${config.port} (public url: ${config.publicUrl})`);
  },
);

let closing = false;
function shutdown() {
  if (closing) return;
  closing = true;
  clearInterval(sweeper);
  (server as { closeAllConnections?: () => void }).closeAllConnections?.();
  server.close(() => {
    closeDb().finally(() => process.exit(0));
  });
  setTimeout(() => process.exit(0), 2000).unref();
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
