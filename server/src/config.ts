const env = process.env;

const port = Number(env.PORT) || 8787;
const models = (env.MODELS ?? "deepseek-flash")
  .split(",")
  .map((m) => m.trim())
  .filter(Boolean);

if (!env.ADMIN_TOKEN || env.ADMIN_TOKEN.startsWith("change-me")) {
  console.error("ADMIN_TOKEN must be set to a long random string (e.g. `openssl rand -hex 24`)");
  process.exit(1);
}
if (env.ADMIN_TOKEN.length < 24) console.warn("warning: ADMIN_TOKEN is short; use a long random string before exposing the server");
if (!env.UPSTREAM_API_KEY) console.warn("warning: UPSTREAM_API_KEY is empty; model calls will fail");

function parseExtraBody(raw: string | undefined): Record<string, unknown> {
  if (!raw) return {};
  try {
    const v = JSON.parse(raw);
    if (v && typeof v === "object" && !Array.isArray(v)) return v;
  } catch {
    // fall through
  }
  console.error("UPSTREAM_EXTRA_BODY must be a JSON object");
  process.exit(1);
}

export const config = {
  port,
  adminToken: env.ADMIN_TOKEN,
  upstreamBaseUrl: (env.UPSTREAM_BASE_URL || "https://api.deepseek.com").replace(/\/+$/, ""),
  upstreamApiKey: env.UPSTREAM_API_KEY ?? "",
  // Extra JSON fields merged into every upstream request body. For DeepSeek this turns thinking off,
  // because thinking mode requires reasoning_content to be echoed back on every tool-call turn.
  upstreamExtraBody: parseExtraBody(env.UPSTREAM_EXTRA_BODY),
  defaultModel: env.DEFAULT_MODEL || models[0] || "deepseek-flash",
  models,
  publicUrl: (env.PUBLIC_URL || `http://localhost:${port}`).replace(/\/+$/, ""),
  dbPath: env.DB_PATH || "./data/gig-slave.db",
  heartbeatMs: 5000,
  lostAfterMs: 45_000,
};
