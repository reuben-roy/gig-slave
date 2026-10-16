// OAuth 2.1 linking of connectors (ChatGPT / Claude) to operator accounts: discovery, DCR, PKCE, explicit consent, rotation, revocation.
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { loadServer } from "./helpers.mjs";

let s;
before(async () => {
  s = await loadServer({ PUBLIC_URL: "https://hired.example" });
});
after(async () => {
  await s.db.closeDb();
});

const REDIRECT = "https://chatgpt.example/callback";

const call = async (method, path, { token, body, form, headers } = {}) => {
  const res = await s.app.request(path, {
    method,
    redirect: "manual",
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body ? { "content-type": "application/json" } : {}),
      ...(form ? { "content-type": "application/x-www-form-urlencoded" } : {}),
      ...headers,
    },
    body: body ? JSON.stringify(body) : form ? new URLSearchParams(form).toString() : undefined,
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    // not JSON
  }
  return { status: res.status, headers: res.headers, body: json, text };
};

const pkce = () => {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
};

let n = 0;
async function register(redirect = REDIRECT, name = "ChatGPT") {
  const r = await call("POST", "/oauth/register", { body: { client_name: name, redirect_uris: [redirect] }, headers: { "x-gig-client-ip": `10.5.0.${++n}` } });
  assert.equal(r.status, 201, r.text);
  return r.body.client_id;
}

/** Runs authorize -> owner consent -> returns the authorization code and the PKCE verifier. */
async function consent(clientId, extra = {}) {
  const { verifier, challenge } = pkce();
  const body = {
    approve: true, client_id: clientId, redirect_uri: REDIRECT, state: "xyz", code_challenge: challenge, code_challenge_method: "S256",
    scopes: ["jobs:read", "jobs:write"], new_operator: { name: "ChatGPT account", max_active_jobs: 2 }, ...extra,
  };
  const r = await call("POST", "/api/oauth/authorize", { token: s.token, body });
  assert.equal(r.status, 200, r.text);
  const url = new URL(r.body.redirect_to);
  assert.equal(url.searchParams.get("state"), "xyz");
  return { code: url.searchParams.get("code"), verifier, operatorId: r.body.operator_id, challenge };
}

const exchange = (clientId, code, verifier, redirect = REDIRECT) =>
  call("POST", "/oauth/token", { form: { grant_type: "authorization_code", client_id: clientId, code, code_verifier: verifier, redirect_uri: redirect } });

describe("discovery", () => {
  it("publishes protected-resource and authorization-server metadata", async () => {
    const pr = (await call("GET", "/.well-known/oauth-protected-resource")).body;
    assert.equal(pr.resource, "https://hired.example/mcp");
    assert.deepEqual(pr.authorization_servers, ["https://hired.example"]);
    const as = (await call("GET", "/.well-known/oauth-authorization-server")).body;
    assert.equal(as.issuer, "https://hired.example");
    assert.equal(as.token_endpoint, "https://hired.example/oauth/token");
    assert.deepEqual(as.code_challenge_methods_supported, ["S256"]);
    assert.ok(as.registration_endpoint && as.authorization_endpoint && as.revocation_endpoint);
    assert.equal((await call("GET", "/.well-known/oauth-protected-resource/mcp")).status, 307);
  });

  it("an unauthenticated MCP call points clients at the metadata", async () => {
    const r = await call("POST", "/mcp", { body: { jsonrpc: "2.0", id: 1, method: "ping" } });
    assert.equal(r.status, 401);
    assert.match(r.headers.get("www-authenticate"), /resource_metadata="https:\/\/hired\.example\/\.well-known\/oauth-protected-resource"/);
  });
});

describe("registration and authorize", () => {
  it("only registers safe redirect URIs", async () => {
    for (const bad of ["http://evil.example/cb", "javascript:alert(1)", "https://x.example/cb#frag", "not a url"]) {
      const r = await call("POST", "/oauth/register", { body: { redirect_uris: [bad] }, headers: { "x-gig-client-ip": "10.6.0.1" } });
      assert.equal(r.status, 400, bad);
    }
    assert.equal((await call("POST", "/oauth/register", { body: { redirect_uris: ["http://localhost:8123/cb"] }, headers: { "x-gig-client-ip": "10.6.0.2" } })).status, 201);
  });

  it("never redirects to an unregistered URI; valid requests go to the consent page", async () => {
    const id = await register();
    const { challenge } = pkce();
    const q = (o) => "?" + new URLSearchParams({ response_type: "code", client_id: id, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: "S256", state: "s", ...o });
    assert.equal((await call("GET", "/oauth/authorize" + q({ redirect_uri: "https://evil.example/cb" }))).status, 400);
    assert.equal((await call("GET", "/oauth/authorize" + q({ client_id: "hgc_nope" }))).status, 400);
    const noPkce = await call("GET", "/oauth/authorize" + q({ code_challenge_method: "plain" }));
    assert.equal(noPkce.status, 302);
    assert.match(noPkce.headers.get("location"), /^https:\/\/chatgpt\.example\/callback\?error=invalid_request&state=s/);
    const ok = await call("GET", "/oauth/authorize" + q({ scope: "jobs:read" }));
    assert.equal(ok.status, 302);
    const loc = new URL(ok.headers.get("location"), "https://hired.example");
    assert.equal(loc.pathname, "/connect");
    assert.equal(loc.searchParams.get("scope"), "jobs:read");
    assert.equal(loc.searchParams.get("client_id"), id);
  });
});

describe("consent is explicit and owner-only", () => {
  it("needs the admin token; an operator token or none cannot approve", async () => {
    const id = await register();
    const { challenge } = pkce();
    const body = { approve: true, client_id: id, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: "S256", scopes: ["jobs:read"], new_operator: {} };
    assert.equal((await call("POST", "/api/oauth/authorize", { body })).status, 401);
    const other = await register();
    const issued = await consent(other);
    assert.equal((await exchange(id, issued.code, issued.verifier)).status, 400, "a different client cannot use someone else's code");
    const c2 = await consent(other);
    const t = await exchange(other, c2.code, c2.verifier);
    assert.equal(t.status, 200);
    assert.equal((await call("POST", "/api/oauth/authorize", { token: t.body.access_token, body })).status, 401, "a linked connector is not the owner");
  });

  it("deny redirects with access_denied and issues nothing", async () => {
    const id = await register();
    const r = await call("POST", "/api/oauth/authorize", { token: s.token, body: { approve: false, client_id: id, redirect_uri: REDIRECT, state: "st" } });
    const url = new URL(r.body.redirect_to);
    assert.equal(url.searchParams.get("error"), "access_denied");
    assert.equal(url.searchParams.get("code"), null);
    assert.equal(url.searchParams.get("state"), "st");
  });

  it("rejects approving with no scopes, a bad challenge or an unregistered redirect", async () => {
    const id = await register();
    const { challenge } = pkce();
    const base = { approve: true, client_id: id, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: "S256", scopes: ["jobs:read"], new_operator: {} };
    for (const patch of [{ scopes: [] }, { code_challenge_method: "plain" }, { redirect_uri: "https://evil.example/cb" }]) {
      const r = await call("POST", "/api/oauth/authorize", { token: s.token, body: { ...base, ...patch } });
      assert.equal(r.status, 400, JSON.stringify(patch));
    }
  });
});

describe("tokens", () => {
  it("authorization code + PKCE yields working, account-scoped tokens", async () => {
    const id = await register();
    const c = await consent(id, { scopes: ["jobs:read", "jobs:write"] });

    assert.equal((await exchange(id, c.code, "x".repeat(50))).status, 400, "wrong verifier");
    const bad = await exchange(id, c.code, c.verifier, "https://chatgpt.example/other");
    assert.equal(bad.status, 400, "redirect mismatch (and the code is burned by the failed attempts above)");

    const c2 = await consent(id);
    const t = await exchange(id, c2.code, c2.verifier);
    assert.equal(t.status, 200, t.text);
    assert.equal(t.body.token_type, "Bearer");
    assert.equal(t.body.expires_in, 3600);
    assert.match(t.body.access_token, /^hgo_/);
    assert.match(t.body.refresh_token, /^hgr_/);

    const me = await call("GET", "/operator/me", { token: t.body.access_token });
    assert.equal(me.body.operator.id, c2.operatorId);
    assert.equal(me.body.operator.limits.max_active_jobs, 2);
    assert.equal(me.body.token.kind, "oauth");
    assert.equal(me.body.token.client_id, id);

    const tools = await call("POST", "/mcp", { token: t.body.access_token, body: { jsonrpc: "2.0", id: 1, method: "tools/list" } });
    assert.ok(tools.body.result.tools.length >= 8);
    const job = await call("POST", "/mcp", { token: t.body.access_token, body: { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "create_job", arguments: { label: "L", task: "T", idempotency_key: "o-1" } } } });
    assert.equal(job.body.result.isError, false);
    assert.equal((await call("GET", "/api/invites", { token: t.body.access_token })).status, 401, "oauth tokens never reach the admin API");
  });

  it("an authorization code is single use, and replaying it revokes what it issued", async () => {
    const id = await register();
    const c = await consent(id);
    const t = await exchange(id, c.code, c.verifier);
    assert.equal(t.status, 200);
    assert.equal((await call("GET", "/operator/me", { token: t.body.access_token })).status, 200);
    assert.equal((await exchange(id, c.code, c.verifier)).status, 400);
    assert.equal((await call("GET", "/operator/me", { token: t.body.access_token })).status, 401);
  });

  it("only the scopes the owner granted are issued", async () => {
    const id = await register();
    const c = await consent(id, { scopes: ["jobs:read"] });
    const t = await exchange(id, c.code, c.verifier);
    assert.equal(t.body.scope, "jobs:read");
    const w = await call("POST", "/operator/jobs", { token: t.body.access_token, body: { label: "x", task: "y" } });
    assert.equal(w.status, 403);
  });

  it("links to an existing account when the owner picks one", async () => {
    const id = await register();
    const first = await consent(id);
    const t1 = await exchange(id, first.code, first.verifier);
    const second = await consent(await register("https://chatgpt.example/callback", "Claude"), { new_operator: undefined, operator_id: first.operatorId });
    assert.equal(second.operatorId, first.operatorId);
    assert.equal((await call("GET", "/operator/me", { token: t1.body.access_token })).body.operator.id, first.operatorId);
  });

  it("refresh tokens rotate; reusing an old one ends the whole grant", async () => {
    const id = await register();
    const c = await consent(id);
    const t = await exchange(id, c.code, c.verifier);
    const refresh = (rt) => call("POST", "/oauth/token", { form: { grant_type: "refresh_token", client_id: id, refresh_token: rt } });

    const r1 = await refresh(t.body.refresh_token);
    assert.equal(r1.status, 200, r1.text);
    assert.notEqual(r1.body.access_token, t.body.access_token);
    assert.equal((await call("GET", "/operator/me", { token: t.body.access_token })).status, 401, "old access token is rotated out");
    assert.equal((await call("GET", "/operator/me", { token: r1.body.access_token })).status, 200);

    assert.equal((await refresh(t.body.refresh_token)).status, 400, "stale refresh token");
    assert.equal((await call("GET", "/operator/me", { token: r1.body.access_token })).status, 401, "replay revoked the family");
    assert.equal((await refresh(r1.body.refresh_token)).status, 400);
  });

  it("refresh tokens are bound to their client", async () => {
    const id = await register();
    const other = await register();
    const c = await consent(id);
    const t = await exchange(id, c.code, c.verifier);
    const r = await call("POST", "/oauth/token", { form: { grant_type: "refresh_token", client_id: other, refresh_token: t.body.refresh_token } });
    assert.equal(r.status, 400);
  });

  it("access tokens expire", async () => {
    const id = await register();
    const c = await consent(id);
    const t = await exchange(id, c.code, c.verifier);
    await s.db.run("UPDATE operator_tokens SET expires_at = $1 WHERE client_id = $2", [Date.now() - 1, id]);
    assert.equal((await call("GET", "/operator/me", { token: t.body.access_token })).status, 401);
  });

  it("RFC 7009 revocation and owner account revocation both end access", async () => {
    const id = await register();
    const c = await consent(id);
    const t = await exchange(id, c.code, c.verifier);
    assert.equal((await call("POST", "/oauth/revoke", { form: { token: t.body.refresh_token, client_id: id } })).status, 200);
    assert.equal((await call("GET", "/operator/me", { token: t.body.access_token })).status, 401);
    assert.equal((await call("POST", "/oauth/revoke", { form: { token: "garbage" } })).status, 200);

    const c2 = await consent(id);
    const t2 = await exchange(id, c2.code, c2.verifier);
    await call("POST", `/api/operators/${c2.operatorId}/revoke`, { token: s.token, body: {} });
    assert.equal((await call("GET", "/operator/me", { token: t2.body.access_token })).status, 401);
    const rf = await call("POST", "/oauth/token", { form: { grant_type: "refresh_token", client_id: id, refresh_token: t2.body.refresh_token } });
    assert.equal(rf.status, 400);
    const { challenge } = pkce();
    const again = await call("POST", "/api/oauth/authorize", {
      token: s.token,
      body: { approve: true, client_id: id, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: "S256", scopes: ["jobs:read"], operator_id: c2.operatorId },
    });
    assert.equal(again.status, 409, "cannot link a connector to a revoked account");
  });

  it("rejects unknown grant types and clients", async () => {
    const id = await register();
    assert.equal((await call("POST", "/oauth/token", { form: { grant_type: "client_credentials", client_id: id } })).body.code, "unsupported_grant_type");
    assert.equal((await call("POST", "/oauth/token", { form: { grant_type: "authorization_code", client_id: "hgc_nope" } })).status, 401);
  });
});
