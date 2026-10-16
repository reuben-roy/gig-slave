// Starts a quick tunnel to the local server and points the stable Worker at it.
// Self-hosting option only: the main deployment is GigAgent on Vercel (see README).
import { spawn, spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const port = process.env.PORT || "8787";
const tunnel = spawn("cloudflared", ["tunnel", "--url", `http://localhost:${port}`], { stdio: ["ignore", "pipe", "pipe"] });
tunnel.on("error", (e) => { console.error(`Could not start cloudflared: ${e.message}`); process.exit(1); });

let deployed = false;
const onData = (d) => {
  process.stderr.write(d);
  const m = !deployed && String(d).match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
  if (!m) return;
  deployed = true;
  console.log(`\nTunnel up at ${m[0]}; updating the Worker…`);
  const r = spawnSync("npx", ["wrangler", "deploy", "--var", `TARGET:${m[0]}`], { cwd: path.join(root, "worker"), stdio: "inherit" });
  console.log(r.status === 0 ? "\nWorker updated. Keep this window open while the demo runs." : "\nWorker deploy failed.");
};
tunnel.stdout.on("data", onData);
tunnel.stderr.on("data", onData);
tunnel.on("exit", (code) => process.exit(code ?? 0));
for (const s of ["SIGINT", "SIGTERM"]) process.on(s, () => tunnel.kill());
