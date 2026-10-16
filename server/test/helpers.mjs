// Shared helpers for the stream tests and scripts/measure-usage.mjs.
// Runs the real Hono app in-process against in-memory PGlite (no network, no real database, no secrets).
import { randomBytes } from "node:crypto";

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Must be called before anything imports the server (config is read at import time). */
export async function loadServer(env = {}) {
  process.env.ADMIN_TOKEN = randomBytes(24).toString("hex"); // throwaway, in-memory only
  process.env.PGLITE_DIR = "memory://";
  for (const k of ["DATABASE_URL", "POSTGRES_URL", "VERCEL", "CRON_SECRET"]) delete process.env[k];
  Object.assign(process.env, env);
  const [{ default: app }, db, feed, sweeper] = await Promise.all([
    import("../dist/index.js"),
    import("../dist/db.js"),
    import("../dist/stream.js").catch(() => null), // absent in the pre-fix build
    import("../dist/sweeper.js"),
  ]);
  await db.ensureSchema();
  const token = process.env.ADMIN_TOKEN;
  const auth = { authorization: `Bearer ${token}` };
  const api = {
    app, db, feed, sweeper, token,
    queries: () => db.dbStats.queries,
    async admin(method, path, body) {
      const res = await app.request(path, {
        method,
        headers: { ...auth, ...(body ? { "content-type": "application/json" } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      });
      return { status: res.status, body: await res.json() };
    },
    async createInvite(label = "job") {
      const r = await api.admin("POST", "/api/invites", { label, task: "t", expiry_policy: "ttl", ttl_hours: 1 });
      if (r.status !== 201) throw new Error("createInvite " + JSON.stringify(r));
      return r.body;
    },
    async redeem(code) {
      const res = await app.request("/agent/redeem", {
        method: "POST",
        headers: { "content-type": "application/json", "x-real-ip": "10.0.0.1" },
        body: JSON.stringify({ code, machine: { hostname: "h", platform: "darwin", release: "1", arch: "arm64", username: "u" } }),
      });
      if (res.status !== 200) throw new Error("redeem " + res.status + " " + (await res.text()));
      return res.json();
    },
    async agent(sessionToken, path, body) {
      const res = await app.request("/agent" + path, {
        method: "POST",
        headers: { authorization: `Bearer ${sessionToken}`, "content-type": "application/json" },
        body: JSON.stringify(body ?? {}),
      });
      return { status: res.status, body: await res.json() };
    },
    /** Open /api/stream like EventSource would (token in the query string); collects parsed messages. */
    openStream() {
      const ac = new AbortController();
      const msgs = [];
      let waiters = [];
      let ended = false;
      const p = (async () => {
        const res = await app.request(`/api/stream?token=${token}`, { signal: ac.signal });
        if (res.status !== 200) throw new Error("stream status " + res.status);
        const reader = res.body.getReader();
        const dec = new TextDecoder();
        let buf = "";
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            buf += dec.decode(value, { stream: true });
            let i;
            while ((i = buf.indexOf("\n\n")) >= 0) {
              const raw = buf.slice(0, i);
              buf = buf.slice(i + 2);
              const m = { at: Date.now(), raw, id: null, event: "message", data: null, comment: null };
              for (const line of raw.split("\n")) {
                if (line.startsWith("id:")) m.id = line.slice(3).trim();
                else if (line.startsWith("event:")) m.event = line.slice(6).trim();
                else if (line.startsWith("data:")) m.data = JSON.parse(line.slice(5).trim());
                else if (line.startsWith(":")) m.comment = line.slice(1).trim();
              }
              msgs.push(m);
              waiters = waiters.filter((w) => !w(m));
            }
          }
        } catch {
          // aborted
        }
        ended = true;
        waiters.forEach((w) => w(null));
      })();
      return {
        msgs,
        done: p,
        get ended() { return ended; },
        waitFor(pred, ms = 5000) {
          const hit = msgs.find(pred);
          if (hit) return Promise.resolve(hit);
          return new Promise((resolve, reject) => {
            const t = setTimeout(() => reject(new Error("timeout waiting for message")), ms);
            waiters.push((m) => {
              if (m === null) { clearTimeout(t); reject(new Error("stream ended")); return true; }
              if (pred(m)) { clearTimeout(t); resolve(m); return true; }
              return false;
            });
          });
        },
        close() { ac.abort(); return p; },
      };
    },
  };
  return api;
}
