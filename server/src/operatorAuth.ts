import { createHash, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import type { Context, MiddlewareHandler } from "hono";
import { countRecent, writeAudit } from "./audit.js";
import { sha256 } from "./codes.js";
import { config } from "./config.js";
import { getInvite, inviteJson, one, run } from "./db.js";

/**
 * Operator API tokens: scoped, revocable, expiring credentials so a CLI or Claude never needs the master ADMIN_TOKEN.
 * Design and rationale: docs/operator-api-contract.md. This file never logs or returns a secret.
 *
 * Wiring: index.ts mounts `gate` on /api/* before the admin router. The gate resolves a principal, enforces scopes and
 * limits for operator tokens, records the audit trail, and lets everything else through to the unchanged admin router.
 */

export const SCOPES = [
  "config:read", "invites:read", "sessions:read", "invites:create", "invites:revoke",
  "sessions:instruct", "sessions:kill", "audit:read",
] as const;
export type Scope = (typeof SCOPES)[number];

const READ: Scope[] = ["config:read", "invites:read", "sessions:read", "audit:read"];
export const PRESETS: Record<string, Scope[]> = {
  read: READ,
  // For Claude: read plus creating jobs. Never instruct/kill/revoke.
  claude: [...READ, "invites:create"],
  operate: [...READ, "invites:create", "sessions:instruct"],
  full: [...READ, "invites:create", "invites:revoke", "sessions:instruct", "sessions:kill"],
};

export interface Limits {
  invites_per_day: number;
  models: string[] | null; // null = every configured model
  max_ttl_hours: number;
  max_redemptions: number;
  webhook_hosts: string[]; // [] = notify_webhook not allowed
  notify_emails: string[]; // [] = notify_email not allowed
  allow_on_complete: boolean;
}

export const DEFAULT_LIMITS: Limits = {
  invites_per_day: 20, models: null, max_ttl_hours: 72, max_redemptions: 5,
  webhook_hosts: [], notify_emails: [], allow_on_complete: false,
};

export const normalizeLimits = (raw: unknown): Limits => ({
  ...DEFAULT_LIMITS,
  ...(raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Partial<Limits>) : {}),
});

export type Principal =
  | { kind: "admin" }
  | {
      kind: "operator"; token_id: string; label: string; scopes: Scope[]; limits: Limits;
      created_at: number; expires_at: number | null; last_used_at: number | null;
    };

export type OpEnv = { Variables: { principal?: Principal; opAuthed?: boolean } };

// ---------- token format and storage ----------

const ID_ALPHABET = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
export const TOKEN_RE = /^hg_op_([A-Za-z0-9]{8})_([A-Za-z0-9_-]{43})$/;

export function newTokenParts() {
  let id = "";
  for (let i = 0; i < 8; i++) id += ID_ALPHABET[randomInt(ID_ALPHABET.length)];
  const secret = randomBytes(32).toString("base64url");
  return { id, secret, token: `hg_op_${id}_${secret}`, secret_hash: sha256(secret) };
}

const hashEq = (a: string, b: string) => timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
const DUMMY_HASH = sha256("no such token");

export function adminSecretOk(given: string | undefined, secret: string) {
  if (!given || !secret) return false;
  return timingSafeEqual(Buffer.from(sha256(given)), Buffer.from(sha256(secret)));
}

type Resolved = { principal: Extract<Principal, { kind: "operator" }> } | { denied: string; token_id: string | null };

/** Looks the token up on every request: revocation and expiry take effect immediately. */
export async function resolveToken(bearer: string, now = Date.now()): Promise<Resolved> {
  const m = TOKEN_RE.exec(bearer);
  if (!m) return { denied: "malformed", token_id: null };
  const row = await one("SELECT * FROM operator_tokens WHERE id = $1", [m[1]]);
  const okSecret = hashEq(sha256(m[2]), row ? row.secret_hash : DUMMY_HASH);
  if (!row || !okSecret) return { denied: row ? "bad_secret" : "unknown_token", token_id: row ? m[1] : null };
  const expiresAt = row.expires_at === null || row.expires_at === undefined ? null : Number(row.expires_at);
  if (row.revoked_at !== null && row.revoked_at !== undefined) return { denied: "revoked", token_id: m[1] };
  if (expiresAt !== null && expiresAt <= now) return { denied: "expired", token_id: m[1] };
  const lastUsed = row.last_used_at === null || row.last_used_at === undefined ? null : Number(row.last_used_at);
  if (lastUsed === null || now - lastUsed > 60_000) {
    await run("UPDATE operator_tokens SET last_used_at = $2 WHERE id = $1", [m[1], now]);
  }
  let scopes: Scope[] = [];
  let limits: unknown = {};
  try {
    scopes = (JSON.parse(row.scopes) as string[]).filter((s): s is Scope => (SCOPES as readonly string[]).includes(s));
    limits = JSON.parse(row.limits);
  } catch {
    // corrupt row: no scopes, default limits
  }
  return {
    principal: {
      kind: "operator", token_id: row.id, label: row.label, scopes, limits: normalizeLimits(limits),
      created_at: Number(row.created_at), expires_at: expiresAt, last_used_at: lastUsed ?? now,
    },
  };
}

export const tokenRecordJson = (row: any) => ({
  id: row.id as string,
  label: row.label as string,
  scopes: safeJson<string[]>(row.scopes, []),
  limits: normalizeLimits(safeJson(row.limits, {})),
  created_at: Number(row.created_at),
  created_by: row.created_by as string,
  expires_at: row.expires_at === null || row.expires_at === undefined ? null : Number(row.expires_at),
  last_used_at: row.last_used_at === null || row.last_used_at === undefined ? null : Number(row.last_used_at),
  revoked_at: row.revoked_at === null || row.revoked_at === undefined ? null : Number(row.revoked_at),
});

function safeJson<T>(raw: unknown, fallback: T): T {
  try {
    return JSON.parse(String(raw)) as T;
  } catch {
    return fallback;
  }
}

// ---------- in-memory limiters (best effort per serverless instance; 0 database statements) ----------

export class TokenBucket {
  private tokens: number;
  private last: number;
  constructor(private capacity: number, private perMinute: number, now = Date.now()) {
    this.tokens = capacity;
    this.last = now;
  }
  /** Returns 0 when allowed, else the number of seconds to wait. */
  take(now = Date.now()): number {
    this.tokens = Math.min(this.capacity, this.tokens + ((now - this.last) / 60_000) * this.perMinute);
    this.last = now;
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return 0;
    }
    return Math.max(1, Math.ceil(((1 - this.tokens) / this.perMinute) * 60));
  }
}

const buckets = new Map<string, TokenBucket>();
function bucketFor(tokenId: string, write: boolean) {
  const key = `${tokenId}:${write ? "w" : "r"}`;
  let b = buckets.get(key);
  if (!b) {
    if (buckets.size > 2000) buckets.clear();
    const k = config.operatorRateMultiplier;
    b = write ? new TokenBucket(10 * k, 30 * k) : new TokenBucket(30 * k, 120 * k);
    buckets.set(key, b);
  }
  return b;
}

const failures = new Map<string, { n: number; reset: number }>();
function failedTooOften(ip: string, now = Date.now()) {
  const f = failures.get(ip);
  return Boolean(f && f.reset > now && f.n >= 10);
}
function noteFailure(ip: string, now = Date.now()) {
  if (failures.size > 5000) failures.clear();
  const f = failures.get(ip);
  if (!f || f.reset <= now) failures.set(ip, { n: 1, reset: now + 60_000 });
  else f.n++;
}

const sampled = new Map<string, number>();
function shouldAuditDenied(key: string, now = Date.now()) {
  if (sampled.size > 5000) sampled.clear();
  const last = sampled.get(key) ?? 0;
  if (now - last < 60_000) return false;
  sampled.set(key, now);
  return true;
}

// ---------- scope table (default deny for operator tokens) ----------

const ROUTES: [string, RegExp, Scope | null][] = [
  ["GET", /^\/api\/whoami$/, null], // any valid token
  ["GET", /^\/api\/config$/, "config:read"],
  ["GET", /^\/api\/invites$/, "invites:read"],
  ["POST", /^\/api\/invites$/, "invites:create"],
  ["GET", /^\/api\/invites\/[^/]+$/, "invites:read"],
  ["POST", /^\/api\/invites\/[^/]+\/revoke$/, "invites:revoke"],
  ["GET", /^\/api\/sessions\/[^/]+$/, "sessions:read"],
  ["GET", /^\/api\/sessions\/[^/]+\/events$/, "sessions:read"],
  ["POST", /^\/api\/sessions\/[^/]+\/instructions$/, "sessions:instruct"],
  ["POST", /^\/api\/sessions\/[^/]+\/kill$/, "sessions:kill"],
  ["GET", /^\/api\/stream$/, "sessions:read"],
  ["GET", /^\/api\/audit$/, "audit:read"],
];

/** undefined = not available to operator tokens; null = any valid token; string = required scope. */
export function requiredScope(method: string, path: string): Scope | null | undefined {
  const p = path.replace(/\/+$/, "") || "/";
  for (const [m, re, scope] of ROUTES) if (m === method && re.test(p)) return scope;
  return undefined;
}

export const routeTableForTests = () => ROUTES.map(([m, re, s]) => ({ method: m, pattern: re.source, scope: s }));

// ---------- helpers ----------

export function clientIp(c: Context) {
  const h = (name: string) => c.req.header(name)?.trim() || "";
  const xff = h("x-forwarded-for").split(",")[0]?.trim() || "";
  if (config.onVercel) return h("x-real-ip") || xff || "unknown";
  return h("x-gig-client-ip") || h("cf-connecting-ip") || h("x-real-ip") || xff || "unknown";
}

const clientTag = (c: Context) => c.req.header("x-hired-gun-client")?.slice(0, 64) ?? null;

const canonical = (v: unknown): string => {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object") {
    return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical((v as any)[k])}`).join(",")}}`;
  }
  return JSON.stringify(v) ?? "null";
};

const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
const limitErr = (c: Context, limit: string, error: string) => c.json({ error, limit }, 403);

/** Server-side limits for operator tokens creating a job (section 3.2). Returns a response when a limit is violated. */
export function checkCreateLimits(c: Context, b: Record<string, unknown>, limits: Limits): Response | null {
  const model = str(b.model) || config.defaultModel;
  const allowed = limits.models ?? config.models;
  if (!allowed.includes(model)) return limitErr(c, "models", `this token may only use models: ${allowed.join(", ")}`);
  const policy = b.expiry_policy;
  if (policy === "on_complete" && !limits.allow_on_complete) {
    return limitErr(c, "expiry_policy", "this token may not create on_complete jobs (they never expire on their own)");
  }
  if (policy === "ttl" && Number(b.ttl_hours) > limits.max_ttl_hours) {
    return limitErr(c, "max_ttl_hours", `this token may use ttl_hours up to ${limits.max_ttl_hours}`);
  }
  const has = b.max_redemptions !== undefined && b.max_redemptions !== null && b.max_redemptions !== "";
  if (has && Number(b.max_redemptions) > limits.max_redemptions) {
    return limitErr(c, "max_redemptions", `this token may use max_redemptions up to ${limits.max_redemptions}`);
  }
  if (policy === "ttl" && !has) {
    return limitErr(c, "max_redemptions", `ttl jobs need max_redemptions (up to ${limits.max_redemptions}) for this token`);
  }
  const hook = str(b.notify_webhook);
  if (hook) {
    let host = "";
    try {
      host = new URL(hook).hostname.toLowerCase();
    } catch {
      return null; // malformed: the handler answers 400
    }
    if (!limits.webhook_hosts.map((x) => x.toLowerCase()).includes(host)) {
      return limitErr(c, "webhook_hosts", "this token may not set notify_webhook for that host");
    }
  }
  const email = str(b.notify_email).toLowerCase();
  if (email && !limits.notify_emails.map((x) => x.toLowerCase()).includes(email)) {
    return limitErr(c, "notify_emails", "this token may not set notify_email for that address");
  }
  return null;
}

// ---------- idempotency (no plaintext invite code at rest) ----------

const IDEM_RE = /^[A-Za-z0-9_-]{8,64}$/;

async function reserveKey(actorKey: string, key: string, bodyHash: string) {
  const now = Date.now();
  await run("DELETE FROM idempotency_keys WHERE actor_key = $1 AND idem_key = $2 AND created_at < $3", [
    actorKey, key, now - 86_400_000,
  ]);
  const inserted = await run(
    `INSERT INTO idempotency_keys (actor_key, idem_key, body_hash, invite_id, created_at)
     VALUES ($1, $2, $3, NULL, $4) ON CONFLICT DO NOTHING`,
    [actorKey, key, bodyHash, now],
  );
  return inserted > 0;
}

async function replayFor(c: Context, actorKey: string, key: string, bodyHash: string): Promise<Response> {
  let row = await one("SELECT * FROM idempotency_keys WHERE actor_key = $1 AND idem_key = $2", [actorKey, key]);
  if (row && !row.invite_id && Date.now() - Number(row.created_at) > 60_000) {
    // A creation that never finished (crashed instance): free the key so the caller can retry.
    await run("DELETE FROM idempotency_keys WHERE actor_key = $1 AND idem_key = $2 AND invite_id IS NULL", [actorKey, key]);
    row = undefined;
  }
  if (!row) return c.json({ error: "idempotency key was just released, retry" }, 409);
  if (row.body_hash !== bodyHash) return c.json({ error: "Idempotency-Key was already used with a different request body" }, 422);
  if (!row.invite_id) return c.json({ error: "a request with this Idempotency-Key is still in progress" }, 409);
  const invite = await getInvite(row.invite_id);
  c.header("Idempotent-Replay", "true");
  return c.json(
    {
      invite: invite ? inviteJson(invite) : null, code: null, command: null, replay: true,
      note: "The code is shown only once, in the first response. If you lost it, revoke this job and create a new one.",
    },
    200,
  );
}

// ---------- the gate ----------

const denyAudit = async (c: Context, tokenId: string | null, reason: string, status: number) => {
  const ip = clientIp(c);
  if (!tokenId || !shouldAuditDenied(`${tokenId}:${reason}`)) return;
  await writeAudit({
    actor: "operator", token_id: tokenId, action: "auth.denied", status, ip, client: clientTag(c), detail: reason,
  });
};

function auditShape(method: string, path: string): { action: string; target_type: "invite" | "session"; id: string | null } | null {
  if (method !== "POST") return null;
  const p = path.replace(/\/+$/, "");
  if (/^\/api\/invites$/.test(p)) return { action: "invite.create", target_type: "invite", id: null };
  let m = /^\/api\/invites\/([^/]+)\/revoke$/.exec(p);
  if (m) return { action: "invite.revoke", target_type: "invite", id: m[1] };
  m = /^\/api\/sessions\/([^/]+)\/instructions$/.exec(p);
  if (m) return { action: "session.instruct", target_type: "session", id: m[1] };
  m = /^\/api\/sessions\/([^/]+)\/kill$/.exec(p);
  if (m) return { action: "session.kill", target_type: "session", id: m[1] };
  return null;
}

export const gate: MiddlewareHandler<OpEnv> = async (c, next) => {
  const method = c.req.method;
  const path = c.req.path;
  const bearer = c.req.header("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();

  let principal: Principal | null = null;
  if (bearer && adminSecretOk(bearer, config.adminToken)) {
    principal = { kind: "admin" };
  } else if (bearer && config.operatorApiEnabled && bearer.startsWith("hg_op_")) {
    const ip = clientIp(c);
    if (failedTooOften(ip)) {
      c.header("Retry-After", "60");
      return c.json({ error: "too many failed attempts", retry_after_s: 60 }, 429);
    }
    const r = TOKEN_RE.test(bearer) ? await resolveToken(bearer) : ({ denied: "malformed", token_id: null } as const);
    if ("denied" in r) {
      noteFailure(ip);
      await denyAudit(c, r.token_id, r.denied, 401);
      return c.json({ error: "unauthorized" }, 401);
    }
    principal = r.principal;
  }
  if (principal) c.set("principal", principal);

  // No principal: the admin router (or a new route's own guard) answers 401, exactly as before.
  if (!principal) return next();

  const tag = clientTag(c);
  const ip = clientIp(c);
  const shape = auditShape(method, path);
  const actor = principal.kind;
  const tokenId = principal.kind === "operator" ? principal.token_id : null;
  const audited = shape && (principal.kind === "operator" || config.operatorApiEnabled);

  let body: Record<string, unknown> | null = null;
  let idem: { actorKey: string; key: string } | null = null;

  if (principal.kind === "operator") {
    const scope = requiredScope(method, path);
    if (scope === undefined) {
      await denyAudit(c, tokenId, "route_not_allowed", 403);
      return c.json({ error: "this route is not available to operator tokens" }, 403);
    }
    if (scope !== null && !principal.scopes.includes(scope)) {
      await denyAudit(c, tokenId, `missing_scope:${scope}`, 403);
      return c.json({ error: `token lacks scope ${scope}` }, 403);
    }
    const wait = bucketFor(principal.token_id, method !== "GET").take();
    if (wait) {
      c.header("Retry-After", String(wait));
      return c.json({ error: "rate limited", retry_after_s: wait }, 429);
    }
    c.set("opAuthed", true);
  }

  if (shape?.action === "session.instruct" && principal.kind === "operator") {
    const b = (await c.req.json().catch(() => null)) as { text?: unknown } | null;
    if (typeof b?.text === "string" && b.text.length > 4000) return c.json({ error: "text is limited to 4000 characters" }, 400);
  }

  if (shape?.action === "invite.create") {
    const raw = await c.req.json().catch(() => null);
    body = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null;
    const key = c.req.header("idempotency-key")?.trim();
    if (body) {
      if (principal.kind === "operator") {
        const bad = checkCreateLimits(c, body, principal.limits);
        if (bad) return bad;
      }
      if (key !== undefined) {
        if (!IDEM_RE.test(key)) return c.json({ error: "Idempotency-Key must be 8-64 characters of A-Z a-z 0-9 _ -" }, 400);
        const actorKey = tokenId ?? "admin";
        const hash = sha256(canonical(body));
        if (!(await reserveKey(actorKey, key, hash))) return replayFor(c, actorKey, key, hash);
        idem = { actorKey, key };
      }
      if (principal.kind === "operator") {
        const used = await countRecent(principal.token_id, "invite.create", Date.now() - 86_400_000);
        if (used >= principal.limits.invites_per_day) {
          if (idem) await run("DELETE FROM idempotency_keys WHERE actor_key = $1 AND idem_key = $2", [idem.actorKey, idem.key]);
          c.header("Retry-After", "3600");
          return c.json({ error: `daily limit of ${principal.limits.invites_per_day} jobs reached for this token`, limit: "invites_per_day", retry_after_s: 3600 }, 429);
        }
      }
    }
  }

  try {
    await next();
  } catch (e) {
    if (idem) await run("DELETE FROM idempotency_keys WHERE actor_key = $1 AND idem_key = $2 AND invite_id IS NULL", [idem.actorKey, idem.key]).catch(() => {});
    throw e;
  }

  if (!shape) return;
  const status = c.res.status;
  let targetId = shape.id;
  let detail: string | null = null;
  if (shape.action === "invite.create") {
    if (status === 201) {
      const made = (await c.res.clone().json().catch(() => null)) as { invite?: { id?: string } } | null;
      targetId = made?.invite?.id ?? null;
      if (idem && targetId) {
        await run("UPDATE idempotency_keys SET invite_id = $3 WHERE actor_key = $1 AND idem_key = $2", [idem.actorKey, idem.key, targetId]);
      }
    } else if (idem) {
      await run("DELETE FROM idempotency_keys WHERE actor_key = $1 AND idem_key = $2 AND invite_id IS NULL", [idem.actorKey, idem.key]);
    }
  } else if (shape.action === "session.instruct") {
    const b = (await c.req.json().catch(() => null)) as { text?: unknown } | null;
    detail = typeof b?.text === "string" ? `text_len=${b.text.trim().length}` : null;
  }
  if (!audited) return;
  await writeAudit({
    actor, token_id: tokenId, action: shape.action, target_type: shape.target_type, target_id: targetId,
    status, ip, client: tag, detail,
  });
};

export const sha256Hex = (s: string) => createHash("sha256").update(s).digest("hex");
