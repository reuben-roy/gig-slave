// Operator API tokens over the real Hono app on in-memory PGlite. No network, no model tokens.
import assert from "node:assert/strict";
import { test } from "node:test";
import { loadServer } from "./helpers.mjs";

const s = await loadServer({ OPERATOR_API_ENABLED: "1", MODELS: "anthropic/claude-haiku-5.5,anthropic/claude-sonnet-5.5" });
const auth = await import("../dist/operatorAuth.js");

async function call(method, path, { token, body, headers = {} } = {}) {
  const res = await s.app.request(path, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
      ...headers,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* not json */ }
  return { status: res.status, json, headers: res.headers };
}

const admin = (method, path, body) => call(method, path, { token: s.token, body });
async function mint(over = {}) {
  const r = await admin("POST", "/api/operator-tokens", { label: "t", ...over });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  return r.json;
}
const JOB = { label: "job", task: "Organize my Desktop", expiry_policy: "one_use" };

test("token format, shown once, only the hash is stored", async () => {
  const m = await mint({ label: "fmt" });
  assert.match(m.token, auth.TOKEN_RE);
  assert.deepEqual(m.record.scopes.sort(), [...auth.PRESETS.read].sort());
  assert.equal(m.record.created_by, "admin");
  const secret = m.token.split("_").slice(3).join("_");
  const row = await s.db.one("SELECT * FROM operator_tokens WHERE id = $1", [m.record.id]);
  assert.equal(JSON.stringify(row).includes(secret), false, "secret must not be stored");
  assert.equal(row.secret_hash.length, 64);
  const list = await admin("GET", "/api/operator-tokens");
  assert.equal(JSON.stringify(list.json).includes(secret), false);
  assert.equal(JSON.stringify(list.json).includes(row.secret_hash), false, "hash is not returned either");
});

test("invalid tokens all look the same; junk bearers never touch the database", async () => {
  const m = await mint();
  const [id, secret] = [m.record.id, m.token.slice(m.token.indexOf(m.record.id) + 9)];
  const bodies = [];
  for (const t of ["hg_op_short", `hg_op_${id}_${"A".repeat(43)}`, `hg_op_ZZZZZZZZ_${secret}`, "nonsense"]) {
    const r = await call("GET", "/api/whoami", { token: t });
    assert.equal(r.status, 401);
    bodies.push(JSON.stringify(r.json));
  }
  assert.equal(new Set(bodies).size, 1);
  const before = s.queries();
  await call("GET", "/api/whoami", { token: "hg_op_short" });
  await call("GET", "/api/config", { token: "nonsense" });
  assert.equal(s.queries() - before, 0, "malformed bearers must cost zero statements");
  assert.equal((await call("GET", "/api/whoami")).status, 401);
});

test("whoami for admin and operator; query-string operator token is refused on the stream", async () => {
  const w = await admin("GET", "/api/whoami");
  assert.equal(w.json.principal, "admin");
  assert.equal(w.json.token, null);
  const m = await mint({ label: "who" });
  const o = await call("GET", "/api/whoami", { token: m.token });
  assert.equal(o.json.principal, "operator");
  assert.equal(o.json.token.id, m.record.id);
  assert.equal(JSON.stringify(o.json).includes(m.token), false);
  assert.equal((await s.app.request(`/api/stream?token=${m.token}`)).status, 401);
  const viaHeader = await s.app.request("/api/stream", { headers: { authorization: `Bearer ${m.token}` } });
  assert.equal(viaHeader.status, 200);
  await viaHeader.body.cancel();
});

test("scopes: read token cannot write; unknown and admin-only routes are refused", async () => {
  const m = await mint({ preset: "read" });
  assert.equal((await call("GET", "/api/config", { token: m.token })).status, 200);
  assert.equal((await call("GET", "/api/invites", { token: m.token })).status, 200);
  const create = await call("POST", "/api/invites", { token: m.token, body: JOB });
  assert.equal(create.status, 403);
  assert.match(create.json.error, /invites:create/);
  for (const [method, path] of [
    ["POST", "/api/invites/abc/revoke"], ["POST", "/api/sessions/abc/kill"], ["POST", "/api/sessions/abc/instructions"],
    ["GET", "/api/operator-tokens"], ["POST", "/api/operator-tokens"], ["POST", "/api/operator-tokens/revoke-all"],
    ["GET", "/api/cron/sweep"], ["GET", "/api/some/future/route"],
  ]) {
    assert.equal((await call(method, path, { token: m.token, body: method === "POST" ? {} : undefined })).status, 403, `${method} ${path}`);
  }
});

test("every admin route has an entry in the operator route table (default-deny guard)", async () => {
  // Routes the admin router exposes today; a new admin route must be added here AND to ROUTES (or stay admin-only on purpose).
  const adminOnly = new Set(["GET /api/cron/sweep"]);
  const exposed = [
    ["GET", "/api/config"], ["GET", "/api/invites"], ["POST", "/api/invites"], ["POST", "/api/invites/x/revoke"],
    ["GET", "/api/sessions/x/events"], ["POST", "/api/sessions/x/instructions"], ["POST", "/api/sessions/x/kill"],
    ["GET", "/api/stream"], ["GET", "/api/cron/sweep"],
  ];
  for (const [m, p] of exposed) {
    const scope = auth.requiredScope(m, p);
    assert.equal(scope === undefined, adminOnly.has(`${m} ${p}`), `${m} ${p} -> ${scope}`);
  }
  assert.equal(auth.requiredScope("GET", "/api/operator-tokens"), undefined);
  assert.equal(auth.requiredScope("GET", "/api/invites/"), "invites:read", "trailing slash is normalised");
});

test("revocation and expiry take effect on the very next request", async () => {
  const m = await mint({ label: "rev" });
  assert.equal((await call("GET", "/api/config", { token: m.token })).status, 200);
  assert.equal((await admin("POST", `/api/operator-tokens/${m.record.id}/revoke`)).status, 200);
  assert.equal((await call("GET", "/api/config", { token: m.token })).status, 401);
  const e = await mint({ label: "exp" });
  await s.db.run("UPDATE operator_tokens SET expires_at = $2 WHERE id = $1", [e.record.id, Date.now() - 1000]);
  assert.equal((await call("GET", "/api/config", { token: e.token })).status, 401);
  assert.equal((await admin("POST", "/api/operator-tokens/nope/revoke")).status, 404);
  const denied = (await admin("GET", `/api/audit?token_id=${m.record.id}&action=auth.denied`)).json.entries;
  assert.equal(denied.length, 1, "denied attempts on a known token are audited (sampled)");
  assert.equal(denied[0].detail, "revoked");
});

test("token management is admin-only, validates input and caps expiry", async () => {
  assert.equal((await call("POST", "/api/operator-tokens", { body: { label: "x" } })).status, 401);
  assert.equal((await admin("POST", "/api/operator-tokens", { label: "" })).status, 400);
  assert.equal((await admin("POST", "/api/operator-tokens", { label: "x", scopes: ["root"] })).status, 400);
  assert.equal((await admin("POST", "/api/operator-tokens", { label: "x", preset: "nope" })).status, 400);
  assert.equal((await admin("POST", "/api/operator-tokens", { label: "x", preset: "read", scopes: ["config:read"] })).status, 400);
  assert.equal((await admin("POST", "/api/operator-tokens", { label: "x", expires_in_days: 9999 })).status, 400);
  assert.equal((await admin("POST", "/api/operator-tokens", { label: "x", limits: { models: ["nope"] } })).status, 400);
  assert.equal((await admin("POST", "/api/operator-tokens", { label: "x", limits: { surprise: 1 } })).status, 400);
  const d = await mint({ label: "default-expiry" });
  const days = (d.record.expires_at - Date.now()) / 86_400_000;
  assert.ok(days > 29.9 && days <= 30);
  const forever = await mint({ label: "forever", expires_in_days: null });
  assert.equal(forever.record.expires_at, null);
});

test("create-job limits are enforced server-side", async () => {
  const m = await mint({
    preset: "claude",
    limits: { models: ["anthropic/claude-haiku-5.5"], max_ttl_hours: 24, max_redemptions: 2 },
  });
  const post = (body, headers) => call("POST", "/api/invites", { token: m.token, body, headers });
  const ok = await post(JOB);
  assert.equal(ok.status, 201, JSON.stringify(ok.json));
  assert.equal((await post({ ...JOB, model: "anthropic/claude-sonnet-5.5" })).json.limit, "models");
  assert.equal((await post({ ...JOB, expiry_policy: "on_complete" })).json.limit, "expiry_policy");
  assert.equal((await post({ ...JOB, expiry_policy: "ttl", ttl_hours: 48, max_redemptions: 1 })).json.limit, "max_ttl_hours");
  assert.equal((await post({ ...JOB, expiry_policy: "ttl", ttl_hours: 2 })).json.limit, "max_redemptions");
  assert.equal((await post({ ...JOB, expiry_policy: "ttl", ttl_hours: 2, max_redemptions: 3 })).json.limit, "max_redemptions");
  assert.equal((await post({ ...JOB, expiry_policy: "ttl", ttl_hours: 2, max_redemptions: 2 })).status, 201);
  assert.equal((await post({ ...JOB, notify_webhook: "https://evil.example/hook" })).json.limit, "webhook_hosts");
  assert.equal((await post({ ...JOB, notify_email: "a@b.co" })).json.limit, "notify_emails");

  const allowed = await mint({ preset: "claude", limits: { webhook_hosts: ["hooks.slack.com"], notify_emails: ["me@example.com"] } });
  const r = await call("POST", "/api/invites", {
    token: allowed.token,
    body: { ...JOB, notify_webhook: "https://hooks.slack.com/services/x", notify_email: "ME@example.com" },
  });
  assert.equal(r.status, 201, JSON.stringify(r.json));
});

test("daily invite cap is durable and returns 429 with Retry-After", async () => {
  const m = await mint({ preset: "claude", limits: { invites_per_day: 2 } });
  const post = () => call("POST", "/api/invites", { token: m.token, body: JOB });
  assert.equal((await post()).status, 201);
  assert.equal((await post()).status, 201);
  const third = await post();
  assert.equal(third.status, 429);
  assert.equal(third.json.limit, "invites_per_day");
  assert.ok(third.headers.get("retry-after"));
});

test("idempotency: replay returns the same invite without a code; different body is 422; nothing secret at rest", async () => {
  const m = await mint({ preset: "claude" });
  const key = "retry-key-0001";
  const post = (body) => call("POST", "/api/invites", { token: m.token, body, headers: { "idempotency-key": key } });
  const first = await post(JOB);
  assert.equal(first.status, 201);
  assert.match(first.json.code, /^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  const again = await post(JOB);
  assert.equal(again.status, 200);
  assert.equal(again.headers.get("idempotent-replay"), "true");
  assert.equal(again.json.invite.id, first.json.invite.id);
  assert.equal(again.json.code, null);
  assert.equal(again.json.replay, true);
  assert.equal((await post({ ...JOB, task: "something else" })).status, 422);
  assert.equal((await call("POST", "/api/invites", { token: m.token, body: JOB, headers: { "idempotency-key": "short" } })).status, 400);
  const mine = (await admin("GET", "/api/invites")).json.invites.filter((i) => i.label === "job" && i.id === first.json.invite.id);
  assert.equal(mine.length, 1);
  const rows = JSON.stringify(await s.db.all("SELECT * FROM idempotency_keys"));
  assert.equal(rows.includes(first.json.code), false);
  assert.equal(rows.includes(first.json.code.replace("-", "")), false);
  // another token may reuse the same key independently
  const other = await mint({ preset: "claude" });
  const o = await call("POST", "/api/invites", { token: other.token, body: JOB, headers: { "idempotency-key": key } });
  assert.equal(o.status, 201);
  assert.notEqual(o.json.invite.id, first.json.invite.id);
  // a failed creation releases the key
  const bad = await call("POST", "/api/invites", { token: m.token, body: { label: "", task: "x" }, headers: { "idempotency-key": "fails-key-0002" } });
  assert.equal(bad.status, 400);
  const fixed = await call("POST", "/api/invites", { token: m.token, body: JOB, headers: { "idempotency-key": "fails-key-0002" } });
  assert.equal(fixed.status, 201);
});

test("lifecycle with a full token: filters, single reads, instruct, kill, revoke, audit without secrets", async () => {
  const m = await mint({ preset: "full", label: "life" });
  const T = m.token;
  const created = await call("POST", "/api/invites", { token: T, body: { ...JOB, label: "life-job", task: "SECRET-TASK-TEXT-123" } });
  assert.equal(created.status, 201);
  const { invite, code } = created.json;

  assert.equal((await call("GET", `/api/invites/${invite.id}`, { token: T })).json.invite.label, "life-job");
  assert.equal((await call("GET", "/api/invites/none", { token: T })).status, 404);
  assert.equal((await call("GET", "/api/invites?status=pending", { token: T })).json.invites.some((i) => i.id === invite.id), true);
  assert.equal((await call("GET", "/api/invites?status=revoked", { token: T })).json.invites.some((i) => i.id === invite.id), false);
  assert.equal((await call("GET", "/api/invites?limit=1", { token: T })).json.invites.length, 1);
  assert.equal((await call("GET", `/api/invites?since=${Date.now() + 60000}`, { token: T })).json.invites.length, 0);
  for (const q of ["status=bogus", "limit=0", "limit=999", "since=abc"]) {
    assert.equal((await call("GET", `/api/invites?${q}`, { token: T })).status, 400, q);
  }
  const plain = await call("GET", "/api/invites", { token: T });
  const full = await call("GET", "/api/invites?limit=200", { token: T });
  assert.deepEqual(plain.json, full.json, "no params behaves exactly like the legacy listing");

  const red = await s.redeem(code);
  const sid = red.session_id;
  const got = await call("GET", `/api/sessions/${sid}`, { token: T });
  assert.equal(got.json.session.id, sid);
  assert.equal(got.json.invite.id, invite.id);
  assert.equal((await call("GET", "/api/sessions/none", { token: T })).status, 404);

  assert.equal((await call("POST", `/api/sessions/${sid}/instructions`, { token: T, body: { text: "x".repeat(4001) } })).status, 400);
  const ins = await call("POST", `/api/sessions/${sid}/instructions`, { token: T, body: { text: "SECRET-INSTRUCTION-TEXT-456" } });
  assert.equal(ins.status, 200);
  const ev = await call("GET", `/api/sessions/${sid}/events`, { token: T });
  assert.ok(ev.json.events.some((e) => e.type === "instruction"));
  assert.equal((await call("POST", `/api/sessions/${sid}/kill`, { token: T })).status, 200);
  assert.equal((await call("POST", `/api/sessions/${sid}/instructions`, { token: T, body: { text: "late" } })).status, 409);
  assert.equal((await call("POST", `/api/invites/${invite.id}/revoke`, { token: T })).status, 200);

  const audit = await call("GET", "/api/audit?limit=200", { token: T });
  const actions = audit.json.entries.map((e) => e.action);
  for (const a of ["invite.create", "session.instruct", "session.kill", "invite.revoke"]) assert.ok(actions.includes(a), a);
  assert.ok(audit.json.entries.every((e) => e.token_id === m.record.id), "operator tokens see only their own entries");
  const create = audit.json.entries.find((e) => e.action === "invite.create");
  assert.equal(create.target_id, invite.id);
  const dump = JSON.stringify(await s.db.all("SELECT * FROM operator_audit"));
  const secret = T.slice(T.indexOf(m.record.id) + 9);
  for (const forbidden of [T, secret, code, code.replace("-", ""), "SECRET-TASK-TEXT-123", "SECRET-INSTRUCTION-TEXT-456"]) {
    assert.equal(dump.includes(forbidden), false, `audit must not contain ${forbidden.slice(0, 12)}...`);
  }
  const adminView = await admin("GET", `/api/audit?token_id=${m.record.id}&action=invite.create`);
  assert.equal(adminView.json.entries.length, 1);
  assert.equal(adminView.json.entries[0].token_label, "life");
  const next = await admin("GET", `/api/audit?after=${adminView.json.entries[0].id - 1}&limit=1`);
  assert.equal(next.json.entries.length, 1);
});

test("admin mutations are audited too (token.create, token.revoke, invite.create)", async () => {
  const m = await mint({ label: "audited" });
  await admin("POST", `/api/operator-tokens/${m.record.id}/revoke`);
  await admin("POST", "/api/invites", JOB);
  const a = (await admin("GET", "/api/audit?limit=200")).json.entries;
  assert.ok(a.some((e) => e.action === "token.create" && e.target_id === m.record.id && e.actor === "admin"));
  assert.ok(a.some((e) => e.action === "token.revoke" && e.target_id === m.record.id));
  assert.ok(a.some((e) => e.action === "invite.create" && e.actor === "admin"));
});

test("rate limits: bucket maths and HTTP 429 with Retry-After", async () => {
  const b = new auth.TokenBucket(3, 60, 0);
  assert.deepEqual([b.take(0), b.take(0), b.take(0)], [0, 0, 0]);
  assert.ok(b.take(0) >= 1);
  assert.equal(b.take(1500), 0, "refills over time");
  const m = await mint({ label: "rl" });
  const codes = [];
  for (let i = 0; i < 45; i++) codes.push((await call("GET", "/api/whoami", { token: m.token })).status);
  assert.ok(codes.includes(429));
  const r = await call("GET", "/api/whoami", { token: m.token });
  if (r.status === 429) assert.ok(Number(r.headers.get("retry-after")) >= 1);
});

test("revoke-all kills every token and is audited", async () => {
  const a = await mint({ label: "ra1" });
  const b = await mint({ label: "ra2" });
  const r = await admin("POST", "/api/operator-tokens/revoke-all");
  assert.equal(r.status, 200);
  assert.ok(r.json.revoked >= 2);
  assert.equal((await call("GET", "/api/whoami", { token: a.token })).status, 401);
  assert.equal((await call("GET", "/api/whoami", { token: b.token })).status, 401);
  assert.equal((await admin("GET", "/api/whoami")).status, 200, "admin token is unaffected");
});
