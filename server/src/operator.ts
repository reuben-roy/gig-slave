import { Hono, type Context } from "hono";
import { listAudit, pruneLazy, writeAudit } from "./audit.js";
import { config } from "./config.js";
import {
  all, getInvite, getSession, inviteJson, one, run, sessionJson, toInvite, toSession,
} from "./db.js";
import {
  DEFAULT_LIMITS, newTokenParts, normalizeLimits, PRESETS, SCOPES, tokenRecordJson, clientIp,
  type Limits, type OpEnv, type Principal, type Scope,
} from "./operatorAuth.js";
import { maybeSweep } from "./sweeper.js";

/**
 * New operator routes (all additive). Authentication, scope checks and rate limits already ran in `gate`
 * (operatorAuth.ts); these handlers only re-check that a principal exists and that token management is admin-only.
 * Mounted under /api BEFORE the admin router, so unknown paths still fall through to it.
 */
export const operatorRoutes = new Hono<OpEnv>();

const INVITE_STATUSES = ["pending", "active", "completed", "expired", "revoked"];
const unauthorized = (c: Context) => c.json({ error: "unauthorized" }, 401);

function principalOf(c: Context<OpEnv>): Principal | null {
  return c.get("principal") ?? null;
}

async function ready() {
  await maybeSweep();
}

// ---------- identity ----------

operatorRoutes.get("/whoami", async (c) => {
  const p = principalOf(c);
  if (!p) return unauthorized(c);
  await ready();
  return c.json({
    principal: p.kind,
    token:
      p.kind === "operator"
        ? {
            id: p.token_id, label: p.label, scopes: p.scopes, limits: p.limits,
            created_at: p.created_at, expires_at: p.expires_at, last_used_at: p.last_used_at,
          }
        : null,
    server: { public_url: config.publicUrl, api: "operator/1", operator_tokens_enabled: config.operatorApiEnabled },
  });
});

// ---------- reads ----------

async function invitesWithSessions(rows: any[]) {
  const ids = rows.map((r) => r.id as string);
  const sessions = ids.length
    ? (await all("SELECT * FROM sessions WHERE invite_id = ANY($1::text[]) ORDER BY started_at, seq", [ids])).map(toSession)
    : [];
  const byInvite = new Map<string, ReturnType<typeof sessionJson>[]>();
  for (const s of sessions) {
    const list = byInvite.get(s.invite_id) ?? [];
    list.push(sessionJson(s));
    byInvite.set(s.invite_id, list);
  }
  return rows.map(toInvite).map((i) => ({ ...inviteJson(i), sessions: byInvite.get(i.id) ?? [] }));
}

// GET /api/invites with filters. With no filter params this falls through to the unchanged admin handler.
operatorRoutes.get("/invites", async (c, next) => {
  const q = c.req.query();
  if (!principalOf(c) || (q.status === undefined && q.limit === undefined && q.since === undefined)) return next();
  const conds: string[] = [];
  const params: unknown[] = [];
  if (q.status !== undefined) {
    const list = q.status.split(",").map((s) => s.trim()).filter(Boolean);
    if (!list.length || list.some((s) => !INVITE_STATUSES.includes(s))) {
      return c.json({ error: `status must be a comma list of: ${INVITE_STATUSES.join(", ")}` }, 400);
    }
    params.push(list);
    conds.push(`status = ANY($${params.length}::text[])`);
  }
  if (q.since !== undefined) {
    const since = Number(q.since);
    if (!Number.isFinite(since) || since < 0) return c.json({ error: "since must be a unix ms timestamp" }, 400);
    params.push(Math.floor(since));
    conds.push(`created_at >= $${params.length}`);
  }
  let limit = 200;
  if (q.limit !== undefined) {
    limit = Number(q.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) return c.json({ error: "limit must be an integer from 1 to 200" }, 400);
  }
  const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";
  await ready();
  const rows = await all(`SELECT * FROM invites ${where} ORDER BY created_at DESC, seq DESC LIMIT ${limit}`, params);
  return c.json({ invites: await invitesWithSessions(rows) });
});

operatorRoutes.get("/invites/:id", async (c) => {
  if (!principalOf(c)) return unauthorized(c);
  await ready();
  const row = await one("SELECT * FROM invites WHERE id = $1", [c.req.param("id")]);
  if (!row) return c.json({ error: "invite not found" }, 404);
  return c.json({ invite: (await invitesWithSessions([row]))[0] });
});

operatorRoutes.get("/sessions/:id", async (c) => {
  if (!principalOf(c)) return unauthorized(c);
  await ready();
  const session = await getSession(c.req.param("id"));
  if (!session) return c.json({ error: "session not found" }, 404);
  const invite = await getInvite(session.invite_id);
  return c.json({ session: sessionJson(session), invite: invite ? inviteJson(invite) : null });
});

operatorRoutes.get("/audit", async (c) => {
  const p = principalOf(c);
  if (!p) return unauthorized(c);
  await ready();
  const limit = c.req.query("limit") === undefined ? 50 : Number(c.req.query("limit"));
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) return c.json({ error: "limit must be an integer from 1 to 200" }, 400);
  const afterRaw = c.req.query("after");
  const after = afterRaw === undefined ? undefined : Number(afterRaw);
  if (after !== undefined && (!Number.isInteger(after) || after < 0)) return c.json({ error: "after must be an audit id" }, 400);
  await pruneLazy();
  // Operator tokens only ever see their own entries.
  const tokenId = p.kind === "operator" ? p.token_id : c.req.query("token_id") || undefined;
  return c.json(await listAudit({ after, limit, token_id: tokenId, action: c.req.query("action") || undefined }));
});

// ---------- token management (admin principal only) ----------

function adminOnly(c: Context<OpEnv>) {
  const p = principalOf(c);
  if (!p) return unauthorized(c);
  if (p.kind !== "admin") return c.json({ error: "token management needs the admin token" }, 403);
  return null;
}

const strList = (v: unknown): string[] | null =>
  Array.isArray(v) && v.every((x) => typeof x === "string" && x.trim()) ? v.map((x: string) => x.trim()) : null;

function parseLimits(raw: unknown): { limits: Limits } | { error: string } {
  if (raw === undefined || raw === null) return { limits: { ...DEFAULT_LIMITS } };
  if (typeof raw !== "object" || Array.isArray(raw)) return { error: "limits must be an object" };
  const r = raw as Record<string, unknown>;
  const out: Limits = { ...DEFAULT_LIMITS };
  const known = Object.keys(DEFAULT_LIMITS);
  for (const k of Object.keys(r)) if (!known.includes(k)) return { error: `unknown limit "${k}"` };
  const int = (k: string, min: number, max: number) => {
    if (r[k] === undefined) return null;
    const n = Number(r[k]);
    return Number.isInteger(n) && n >= min && n <= max ? n : NaN;
  };
  for (const [k, min, max] of [["invites_per_day", 1, 1000], ["max_ttl_hours", 1, 720], ["max_redemptions", 1, 100]] as const) {
    const n = int(k, min, max);
    if (n === null) continue;
    if (Number.isNaN(n)) return { error: `${k} must be an integer from ${min} to ${max}` };
    out[k] = n;
  }
  if (r.models !== undefined && r.models !== null) {
    const m = strList(r.models);
    if (!m || m.some((x) => !config.models.includes(x))) return { error: `models must be a list of: ${config.models.join(", ")}` };
    out.models = m;
  }
  for (const k of ["webhook_hosts", "notify_emails"] as const) {
    if (r[k] === undefined) continue;
    const l = strList(r[k]);
    if (!l) return { error: `${k} must be a list of strings` };
    out[k] = l.map((x) => x.toLowerCase());
  }
  if (r.allow_on_complete !== undefined) {
    if (typeof r.allow_on_complete !== "boolean") return { error: "allow_on_complete must be a boolean" };
    out.allow_on_complete = r.allow_on_complete;
  }
  return { limits: out };
}

operatorRoutes.post("/operator-tokens", async (c) => {
  const denied = adminOnly(c);
  if (denied) return denied;
  const b = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!b || typeof b !== "object") return c.json({ error: "invalid JSON body" }, 400);
  const label = typeof b.label === "string" ? b.label.trim() : "";
  if (!label || label.length > 80) return c.json({ error: "label is required (max 80 characters)" }, 400);

  let scopes: Scope[];
  if (b.scopes !== undefined && b.preset !== undefined) return c.json({ error: "give either preset or scopes, not both" }, 400);
  if (b.scopes !== undefined) {
    const l = strList(b.scopes);
    if (!l || !l.length || l.some((s) => !(SCOPES as readonly string[]).includes(s))) {
      return c.json({ error: `scopes must be a non-empty list of: ${SCOPES.join(", ")}` }, 400);
    }
    scopes = [...new Set(l)] as Scope[];
  } else {
    const preset = typeof b.preset === "string" ? b.preset : "read";
    if (!PRESETS[preset]) return c.json({ error: `preset must be one of: ${Object.keys(PRESETS).join(", ")}` }, 400);
    scopes = PRESETS[preset];
  }

  let expiresAt: number | null;
  if (b.expires_in_days === null) {
    expiresAt = null; // admin may mint a never-expiring token explicitly
  } else {
    const days = b.expires_in_days === undefined ? 30 : Number(b.expires_in_days);
    if (!Number.isFinite(days) || days <= 0 || days > config.operatorTokenMaxDays) {
      return c.json({ error: `expires_in_days must be > 0 and <= ${config.operatorTokenMaxDays} (or null for no expiry)` }, 400);
    }
    expiresAt = Date.now() + Math.round(days * 86_400_000);
  }

  const parsed = parseLimits(b.limits);
  if ("error" in parsed) return c.json({ error: parsed.error }, 400);

  const now = Date.now();
  let parts = newTokenParts();
  for (let attempt = 0; ; attempt++) {
    try {
      await run(
        `INSERT INTO operator_tokens (id, secret_hash, label, scopes, limits, created_at, created_by, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, 'admin', $7)`,
        [parts.id, parts.secret_hash, label, JSON.stringify(scopes), JSON.stringify(parsed.limits), now, expiresAt],
      );
      break;
    } catch (e) {
      if (attempt >= 3) throw e; // id collision is astronomically unlikely; retry a few times
      parts = newTokenParts();
    }
  }
  await writeAudit({
    actor: "admin", action: "token.create", target_type: "token", target_id: parts.id, status: 201,
    ip: clientIp(c), client: c.req.header("x-hired-gun-client"), detail: `scopes=${scopes.length}`,
  });
  await pruneLazy();
  const row = await one("SELECT * FROM operator_tokens WHERE id = $1", [parts.id]);
  // The only time the secret is ever returned.
  return c.json({ token: parts.token, record: tokenRecordJson(row) }, 201);
});

operatorRoutes.get("/operator-tokens", async (c) => {
  const denied = adminOnly(c);
  if (denied) return denied;
  const rows = await all("SELECT * FROM operator_tokens ORDER BY created_at DESC LIMIT 200");
  return c.json({ tokens: rows.map(tokenRecordJson) });
});

operatorRoutes.post("/operator-tokens/revoke-all", async (c) => {
  const denied = adminOnly(c);
  if (denied) return denied;
  const rows = await all("UPDATE operator_tokens SET revoked_at = $1 WHERE revoked_at IS NULL RETURNING id", [Date.now()]);
  await writeAudit({
    actor: "admin", action: "token.revoke_all", target_type: "token", status: 200,
    ip: clientIp(c), client: c.req.header("x-hired-gun-client"), detail: `revoked=${rows.length}`,
  });
  return c.json({ ok: true, revoked: rows.length });
});

operatorRoutes.post("/operator-tokens/:id/revoke", async (c) => {
  const denied = adminOnly(c);
  if (denied) return denied;
  const id = c.req.param("id");
  const row = await one("SELECT id FROM operator_tokens WHERE id = $1", [id]);
  if (!row) return c.json({ error: "token not found" }, 404);
  await run("UPDATE operator_tokens SET revoked_at = $2 WHERE id = $1 AND revoked_at IS NULL", [id, Date.now()]);
  await writeAudit({
    actor: "admin", action: "token.revoke", target_type: "token", target_id: id, status: 200,
    ip: clientIp(c), client: c.req.header("x-hired-gun-client"),
  });
  return c.json({ ok: true });
});
