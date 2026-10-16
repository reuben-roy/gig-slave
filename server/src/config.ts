const env = process.env;

/** Problems that make the server unusable. Local main.ts exits on them; on Vercel the API answers 500 with the text. */
const errors: string[] = [];

const port = Number(env.PORT) || 8787;
const onVercel = Boolean(env.VERCEL);

const DEFAULT_MODELS =
  "anthropic/claude-haiku-5.5,anthropic/claude-sonnet-5.5,openai/gpt-5.6-luna,deepseek/deepseek-v4.1-flash";
const models = (env.MODELS || DEFAULT_MODELS)
  .split(",")
  .map((m) => m.trim())
  .filter(Boolean);
const defaultModel = env.DEFAULT_MODEL || "anthropic/claude-haiku-5.5";

const warnings: string[] = [];

if (!env.ADMIN_TOKEN || env.ADMIN_TOKEN.startsWith("change-me")) {
  errors.push("ADMIN_TOKEN must be set to a long random string (e.g. `openssl rand -hex 24`)");
} else if (env.ADMIN_TOKEN.length < 24) {
  warnings.push("ADMIN_TOKEN is short; use a long random string before exposing the server");
}
if (onVercel && !(env.DATABASE_URL || env.POSTGRES_URL)) {
  // PGlite needs a writable disk; Vercel's filesystem is read-only.
  errors.push("Set DATABASE_URL (add Neon Postgres from the Vercel Marketplace)");
}
if (!models.includes(defaultModel)) {
  warnings.push(`DEFAULT_MODEL "${defaultModel}" is not in MODELS; invites without a model will be rejected`);
}

function parseExtraBody(name: string, raw: string | undefined): Record<string, unknown> {
  if (!raw || !raw.trim()) return {};
  try {
    const v = JSON.parse(raw);
    if (v && typeof v === "object" && !Array.isArray(v)) return v;
  } catch {
    // fall through
  }
  errors.push(`${name} must be a JSON object`);
  return {};
}

const publicUrl = (
  env.PUBLIC_URL ||
  (env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${env.VERCEL_PROJECT_PRODUCTION_URL}` : "") ||
  `http://localhost:${port}`
).replace(/\/+$/, "");

export const config = {
  port,
  onVercel,
  errors,
  warnings,
  adminToken: env.ADMIN_TOKEN ?? "",
  cronSecret: env.CRON_SECRET ?? "",
  publicUrl,
  databaseUrl: env.DATABASE_URL || env.POSTGRES_URL || "",
  pgliteDir: env.PGLITE_DIR || "./data/pglite",
  models,
  defaultModel,
  // Vercel AI Gateway: used for model ids that contain "/" (e.g. anthropic/claude-haiku-5.5).
  gatewayBaseUrl: (env.AI_GATEWAY_BASE_URL || "https://ai-gateway.vercel.sh/v1").replace(/\/+$/, ""),
  gatewayApiKey: env.AI_GATEWAY_API_KEY ?? "",
  gatewayExtraBody: parseExtraBody("GATEWAY_EXTRA_BODY", env.GATEWAY_EXTRA_BODY),
  // Direct upstream: used for bare model ids (e.g. deepseek-flash).
  upstreamBaseUrl: (env.UPSTREAM_BASE_URL || "https://api.deepseek.com").replace(/\/+$/, ""),
  upstreamApiKey: env.UPSTREAM_API_KEY ?? "",
  // Merged into every direct upstream request. For DeepSeek this turns thinking off, because thinking mode
  // requires reasoning_content to be echoed back on every tool-call turn.
  upstreamExtraBody: parseExtraBody("UPSTREAM_EXTRA_BODY", env.UPSTREAM_EXTRA_BODY),
  // Operator API tokens (scoped, revocable; see docs/operator-api-contract.md). Off unless OPERATOR_API_ENABLED=1.
  operatorApiEnabled: env.OPERATOR_API_ENABLED === "1" || env.OPERATOR_API_ENABLED === "true",
  // Test knob: scales the in-memory per-token rate limits (1 = documented limits).
  operatorRateMultiplier: Number(env.OPERATOR_RATE_MULTIPLIER) > 0 ? Number(env.OPERATOR_RATE_MULTIPLIER) : 1,
  operatorTokenMaxDays: Number(env.OPERATOR_TOKEN_MAX_DAYS) > 0 ? Number(env.OPERATOR_TOKEN_MAX_DAYS) : 90,
  operatorAuditRetentionDays: Number(env.OPERATOR_AUDIT_RETENTION_DAYS) > 0 ? Number(env.OPERATOR_AUDIT_RETENTION_DAYS) : 180,
  resendApiKey: env.RESEND_API_KEY ?? "",
  notifyFrom: env.NOTIFY_FROM || "Hired Gun <onboarding@resend.dev>",
  sessionTokenBudget: Number(env.SESSION_TOKEN_BUDGET) > 0 ? Number(env.SESSION_TOKEN_BUDGET) : 2_000_000,
  // Max lifetime of one admin SSE stream. On Vercel the client reconnects after this; keep it below the function's maxDuration.
  streamMaxMs: Number(env.FLUID_MAX_STREAM_MS) > 0 ? Number(env.FLUID_MAX_STREAM_MS) : onVercel ? 55_000 : Infinity,
  heartbeatMs: 5000,
  lostAfterMs: 45_000,
};

const LABELS: Record<string, string> = {
  "anthropic/claude-haiku-5.5": "Claude Haiku 5.5 (fast, cheap)",
  "anthropic/claude-sonnet-5.5": "Claude Sonnet 5.5 (smartest)",
  "openai/gpt-5.6-luna": "GPT-5.6 Luna",
  "deepseek/deepseek-v4.1-flash": "DeepSeek V4.1 Flash",
  "deepseek-flash": "DeepSeek Flash (direct)",
  "deepseek-v4-pro": "DeepSeek V4 Pro (direct)",
};

export const isGatewayModel = (id: string) => id.includes("/");

export const modelOptions = () =>
  config.models.map((id) => ({
    id,
    label: LABELS[id] ?? id,
    provider: isGatewayModel(id) ? ("gateway" as const) : ("deepseek" as const),
  }));
