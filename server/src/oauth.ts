import { createHash, randomBytes } from "node:crypto";
import { Hono, type Context } from "hono";
import { clientIp } from "./agent.js";
import { newId, sha256 } from "./codes.js";
import { config } from "./config.js";
import { ensureSchema, one, run } from "./db.js";
import { ServiceError, str } from "./jobs.js";
import {
  SCOPES, createOperator, mintToken, operatorById, parseScopes, scopesFrom, type Scope,
} from "./operators.js";

/**
 * OAuth 2.1 authorization server for linking connectors (ChatGPT, Claude) to an operator account.
 * Public clients only (PKCE S256 required), dynamic client registration, authorization-code + refresh-token grants.
 * Consent is never implicit: the owner signs in with the admin token on /connect and explicitly picks which
 * operator account the client is linked to and which scopes it gets. Tokens are ordinary operator tokens
 * (kind "oauth"), so limits, scopes, revocation and account scoping behave exactly as for CLI tokens.
 */

const CODE_TTL_MS = 10 * 60_000;
const ACCESS_TTL_MS = 3_600_000;
const REFRESH_TTL_MS = 30 * 86_400_000;
const MAX_CLIENTS_PER_IP_HOUR = 20;
const LOOPBACK = ["localhost", "127.0.0.1", "[::1]"];

const oauthError = (status: 400 | 401, error: string, description: string) =>
  new ServiceError(status, error, description);

function redirectOk(raw: unknown): raw is string {
  if (typeof raw !== "string" || raw.length > 2000) return false;
  try {
    const u = new URL(raw);
    if (u.hash) return false;
    return u.protocol === "https:" || (u.protocol === "http:" && LOOPBACK.includes(u.hostname));
  } catch {
    return false;
  }
}

async function clientById(id: unknown) {
  const r = typeof id === "string" ? await one("SELECT * FROM oauth_clients WHERE client_id = $1", [id]) : undefined;
  return r ? { id: r.client_id as string, name: r.name as string, redirect_uris: JSON.parse(r.redirect_uris) as string[] } : null;
}

const publicScopes = (raw: unknown): Scope[] => {
  const asked = typeof raw === "string" && raw.trim() ? raw.trim().split(/\s+/) : [...SCOPES];
  return scopesFrom(asked, [...SCOPES]);
};

// ---------- discovery ----------

export const wellKnown = new Hono();

const base = () => config.publicUrl;
// This authorization server issues tokens for one resource only; legacy clients may omit it.
const resource = () => `${base()}/mcp`;
function validateResource(raw: unknown) {
  if (raw !== undefined && raw !== resource()) throw oauthError(400, "invalid_target", "resource must be the Hired Gun MCP endpoint");
}
wellKnown.get("/oauth-protected-resource", (c) =>
  c.json({
    resource: `${base()}/mcp`,
    authorization_servers: [base()],
    scopes_supported: SCOPES,
    bearer_methods_supported: ["header"],
    resource_name: "Hired Gun",
  }),
);
wellKnown.get("/oauth-protected-resource/*", (c) => c.redirect("/.well-known/oauth-protected-resource", 307));
wellKnown.get("/oauth-authorization-server", (c) =>
  c.json({
    issuer: base(),
    authorization_endpoint: `${base()}/oauth/authorize`,
    token_endpoint: `${base()}/oauth/token`,
    registration_endpoint: `${base()}/oauth/register`,
    revocation_endpoint: `${base()}/oauth/revoke`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    scopes_supported: SCOPES,
  }),
);
wellKnown.get("/oauth-authorization-server/*", (c) => c.redirect("/.well-known/oauth-authorization-server", 307));

// ---------- public endpoints ----------

export const oauth = new Hono();

// RFC 6749 error shape for the public OAuth endpoints: { error: "<code>", error_description: "<message>" }.
oauth.onError((e, c) => {
  if (e instanceof ServiceError) return c.json({ error: e.code, error_description: e.message }, e.status);
  console.error(e);
  return c.json({ error: "server_error" }, 500);
});

oauth.post("/register", async (c) => {
  await ensureSchema();
  const b = ((await c.req.json().catch(() => null)) ?? {}) as Record<string, unknown>;
  const uris = b.redirect_uris;
  if (!Array.isArray(uris) || !uris.length || uris.length > 10 || !uris.every(redirectOk)) {
    throw oauthError(400, "invalid_redirect_uri", "redirect_uris must be https URLs (or http://localhost) without fragments");
  }
  const ip = clientIp(c);
  const recent = await one<{ n: string }>("SELECT COUNT(*) AS n FROM oauth_clients WHERE ip = $1 AND created_at > $2", [ip, Date.now() - 3_600_000]);
  if (Number(recent?.n) >= MAX_CLIENTS_PER_IP_HOUR) throw new ServiceError(429, "rate_limited", "too many client registrations, try again later");
  const id = `hgc_${newId()}`;
  const name = str(b.client_name).slice(0, 80) || "Unnamed client";
  await run("INSERT INTO oauth_clients (client_id, name, redirect_uris, ip, created_at) VALUES ($1, $2, $3, $4, $5)", [
    id, name, JSON.stringify(uris), ip, Date.now(),
  ]);
  return c.json(
    {
      client_id: id, client_name: name, redirect_uris: uris, token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], client_id_issued_at: Math.floor(Date.now() / 1000),
    },
    201,
  );
});

/** Validates the request enough to never redirect to an unregistered URI, then hands over to the consent page. */
oauth.get("/authorize", async (c) => {
  await ensureSchema();
  const q = c.req.query();
  const client = await clientById(q.client_id);
  if (!client || !client.redirect_uris.includes(q.redirect_uri ?? "")) {
    return c.json({ error: "invalid_request", error_description: "unknown client_id or unregistered redirect_uri" }, 400);
  }
  const back = (error: string) => {
    const u = new URL(q.redirect_uri);
    u.searchParams.set("error", error);
    if (q.state) u.searchParams.set("state", q.state);
    return c.redirect(u.toString(), 302);
  };
  if (q.response_type !== "code") return back("unsupported_response_type");
  if (!q.code_challenge || q.code_challenge_method !== "S256") return back("invalid_request");
  if (q.resource !== undefined && q.resource !== resource()) return back("invalid_target");
  const params = new URLSearchParams({
    response_type: "code", client_id: q.client_id, redirect_uri: q.redirect_uri,
    code_challenge: q.code_challenge, code_challenge_method: "S256", scope: publicScopes(q.scope).join(" "), resource: resource(),
  });
  if (q.state) params.set("state", q.state);
  return c.redirect(`/connect?${params}`, 302);
});

const tokenBody = async (c: Context) => {
  const type = c.req.header("content-type") ?? "";
  if (type.includes("json")) return ((await c.req.json().catch(() => null)) ?? {}) as Record<string, unknown>;
  return Object.fromEntries(new URLSearchParams(await c.req.text()));
};

async function issue(operatorId: string, scopes: Scope[], clientId: string, grantId: string) {
  const refreshToken = `hgr_${randomBytes(32).toString("base64url")}`;
  const accessToken = await mintToken(operatorId, scopes, {
    ttlMs: ACCESS_TTL_MS,
    oauth: { clientId, grantId, refreshToken, refreshTtlMs: REFRESH_TTL_MS },
  });
  return {
    access_token: accessToken, token_type: "Bearer", expires_in: ACCESS_TTL_MS / 1000,
    refresh_token: refreshToken, scope: scopes.join(" "), resource: resource(),
  };
}

const revokeGrant = (grantId: string) =>
  run("UPDATE operator_tokens SET revoked_at = COALESCE(revoked_at, $2) WHERE grant_id = $1", [grantId, Date.now()]);

oauth.post("/token", async (c) => {
  await ensureSchema();
  const b = await tokenBody(c);
  c.header("Cache-Control", "no-store");
  validateResource(b.resource);
  const client = await clientById(b.client_id);
  if (!client) throw oauthError(401, "invalid_client", "unknown client_id");

  if (b.grant_type === "authorization_code") {
    const verifier = typeof b.code_verifier === "string" ? b.code_verifier : "";
    const row = typeof b.code === "string" ? await one("SELECT * FROM oauth_codes WHERE code_hash = $1", [sha256(b.code)]) : undefined;
    if (!row || row.client_id !== client.id) throw oauthError(400, "invalid_grant", "unknown authorization code");
    if (row.used) {
      await revokeGrant(row.code_hash); // a replayed code means it leaked: kill whatever it produced
      throw oauthError(400, "invalid_grant", "authorization code was already used");
    }
    const claimed = await run("UPDATE oauth_codes SET used = TRUE WHERE code_hash = $1 AND used = FALSE", [row.code_hash]);
    if (!claimed) throw oauthError(400, "invalid_grant", "authorization code was already used");
    if (Number(row.expires_at) <= Date.now()) throw oauthError(400, "invalid_grant", "authorization code expired");
    if (row.redirect_uri !== b.redirect_uri) throw oauthError(400, "invalid_grant", "redirect_uri does not match the authorization request");
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    if (verifier.length < 43 || verifier.length > 128 || challenge !== row.code_challenge) {
      throw oauthError(400, "invalid_grant", "PKCE verification failed");
    }
    const op = await operatorById(row.operator_id).catch(() => null);
    if (!op || op.status !== "active") throw oauthError(400, "invalid_grant", "the linked account is no longer active");
    return c.json(await issue(op.id, parseScopes(row.scopes), client.id, row.code_hash));
  }

  if (b.grant_type === "refresh_token") {
    const rt = typeof b.refresh_token === "string" ? b.refresh_token : "";
    const row = await one("SELECT * FROM operator_tokens WHERE refresh_hash = $1", [sha256(rt)]);
    if (!row || row.client_id !== client.id) throw oauthError(400, "invalid_grant", "unknown refresh token");
    if (row.revoked_at != null) {
      await revokeGrant(row.grant_id); // rotated or revoked token presented again: end the whole family
      throw oauthError(400, "invalid_grant", "refresh token is no longer valid");
    }
    if (Number(row.refresh_expires_at) <= Date.now()) throw oauthError(400, "invalid_grant", "refresh token expired");
    const op = await operatorById(row.operator_id).catch(() => null);
    if (!op || op.status !== "active") throw oauthError(400, "invalid_grant", "the linked account is no longer active");
    const rotated = await run("UPDATE operator_tokens SET revoked_at = $2 WHERE id = $1 AND revoked_at IS NULL", [row.id, Date.now()]);
    if (!rotated) throw oauthError(400, "invalid_grant", "refresh token is no longer valid");
    return c.json(await issue(op.id, parseScopes(row.scopes), client.id, row.grant_id));
  }

  throw oauthError(400, "unsupported_grant_type", "grant_type must be authorization_code or refresh_token");
});

/** RFC 7009: always 200, whether or not the token existed. */
oauth.post("/revoke", async (c) => {
  await ensureSchema();
  const b = await tokenBody(c);
  const t = typeof b.token === "string" ? sha256(b.token) : null;
  if (t) {
    const row = await one("SELECT grant_id, client_id FROM operator_tokens WHERE (token_hash = $1 OR refresh_hash = $1) AND kind = 'oauth'", [t]);
    if (row && (!b.client_id || b.client_id === row.client_id)) await revokeGrant(row.grant_id);
  }
  return c.body(null, 200);
});

// ---------- owner consent (mounted under /api, so ADMIN_TOKEN auth applies) ----------

export const oauthAdmin = new Hono();

oauthAdmin.get("/oauth/clients/:id", async (c) => {
  const client = await clientById(c.req.param("id"));
  if (!client) throw new ServiceError(404, "not_found", "unknown client");
  return c.json({ client_id: client.id, name: client.name, redirect_uris: client.redirect_uris });
});

/**
 * The owner's decision. `approve: false` produces the access_denied redirect. Approving links the client to an existing
 * operator account (`operator_id`) or to a new one made from `new_operator`; `scopes` is what the owner actually grants.
 */
oauthAdmin.post("/oauth/authorize", async (c) => {
  const b = ((await c.req.json().catch(() => null)) ?? {}) as Record<string, any>;
  const client = await clientById(b.client_id);
  if (!client || !client.redirect_uris.includes(b.redirect_uri)) throw oauthError(400, "invalid_request", "unknown client_id or unregistered redirect_uri");
  validateResource(b.resource);
  const redirect = new URL(b.redirect_uri);
  if (typeof b.state === "string" && b.state) redirect.searchParams.set("state", b.state);

  if (b.approve !== true) {
    redirect.searchParams.set("error", "access_denied");
    return c.json({ redirect_to: redirect.toString() });
  }
  if (b.code_challenge_method !== "S256" || typeof b.code_challenge !== "string" || b.code_challenge.length < 43) {
    throw oauthError(400, "invalid_request", "a PKCE S256 code_challenge is required");
  }
  const scopes = scopesFrom(b.scopes, []);
  if (!scopes.length) throw oauthError(400, "invalid_request", "grant at least one scope");
  let operatorId: string;
  if (typeof b.operator_id === "string" && b.operator_id) {
    const op = await operatorById(b.operator_id);
    if (op.status !== "active") throw new ServiceError(409, "revoked", "that account is revoked");
    operatorId = op.id;
  } else {
    const name = str(b.new_operator?.name).slice(0, 80) || client.name;
    operatorId = (await createOperator(name, b.new_operator ?? {})).id;
  }
  const code = randomBytes(32).toString("base64url");
  await run(
    `INSERT INTO oauth_codes (code_hash, client_id, operator_id, scopes, redirect_uri, code_challenge, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [sha256(code), client.id, operatorId, scopes.join(" "), b.redirect_uri, b.code_challenge, Date.now() + CODE_TTL_MS],
  );
  redirect.searchParams.set("code", code);
  return c.json({ redirect_to: redirect.toString(), operator_id: operatorId });
});

/** Housekeeping for the sweeper: expired codes and long-dead tokens. */
export async function pruneOauth(now = Date.now()) {
  await run("DELETE FROM oauth_codes WHERE expires_at < $1", [now - 86_400_000]);
  await run("DELETE FROM enrollments WHERE expires_at < $1", [now - 86_400_000]);
  await run("DELETE FROM operator_tokens WHERE kind = 'oauth' AND COALESCE(refresh_expires_at, expires_at) < $1", [now - 86_400_000]);
}
