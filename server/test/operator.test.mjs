// Operator accounts, tokens, enrollment, scoping, limits, idempotency and MCP, against the real app on in-memory PGlite.
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { loadServer } from "./helpers.mjs";

let s;
before(async () => {
  s = await loadServer();
});
after(async () => {
  await s.db.closeDb();
});

const call = async (method, path, { token, body, headers } = {}) => {
  const res = await s.app.request(path, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body ? { "content-type": "application/json" } : {}),
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, headers: res.headers, body: text ? JSON.parse(text) : null };
};

/** Full device-style enrollment, approved with the admin token. Returns the operator token. */
let ipCounter = 0;
async function newOperator(name = "test agent", approve = {}, scopes) {
  const headers = { "x-gig-client-ip": `10.1.0.${++ipCounter}` }; // enrollment is rate-limited per client
  const start = await call("POST", "/operator/enroll", { body: { name, ...(scopes ? { scopes } : {}) }, headers });
  assert.equal(start.status, 201);
  const ap = await call("POST", `/api/enrollments/${start.body.user_code}/approve`, { token: s.token, body: approve });
  assert.equal(ap.status, 200, JSON.stringify(ap.body));
  const got = await call("POST", "/operator/enroll/token", { body: { device_secret: start.body.device_secret } });
  assert.equal(got.status, 200);
  return { token: got.body.token, operator: got.body.operator, operatorId: ap.body.operator.operator_id };
}

const job = (extra = {}) => ({ label: "Desktop", task: "Organize the Desktop", ...extra });
const MACHINE = { hostname: "h", platform: "darwin", release: "1", arch: "arm64", username: "u" };

describe("enrollment", () => {
  it("pending until a human approves; the token is released exactly once", async () => {
    const start = await call("POST", "/operator/enroll", { body: { name: "claude" } });
    assert.equal(start.status, 201);
    assert.match(start.body.user_code, /^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    assert.match(start.body.verification_url, /\/connect\?code=/);
    assert.ok(!JSON.stringify(start.body).includes("hgo_"));

    const poll = () => call("POST", "/operator/enroll/token", { body: { device_secret: start.body.device_secret } });
    assert.equal((await poll()).status, 202);

    assert.equal((await call("POST", `/api/enrollments/${start.body.user_code}/approve`, { body: {} })).status, 401);
    assert.equal((await call("POST", `/api/enrollments/${start.body.user_code}/approve`, { token: "hgo_nope", body: {} })).status, 401);

    const pending = await call("GET", "/api/enrollments", { token: s.token });
    assert.ok(pending.body.enrollments.some((e) => e.user_code === start.body.user_code));

    await call("POST", `/api/enrollments/${start.body.user_code}/approve`, { token: s.token, body: { max_active_jobs: 2 } });
    const got = await poll();
    assert.equal(got.status, 200);
    assert.match(got.body.token, /^hgo_/);
    assert.equal(got.body.operator.limits.max_active_jobs, 2);
    assert.equal((await poll()).status, 410);
    assert.equal((await call("POST", `/api/enrollments/${start.body.user_code}/approve`, { token: s.token, body: {} })).status, 409);
  });

  it("denied and bogus enrollments never yield a token", async () => {
    const start = await call("POST", "/operator/enroll", { body: { name: "nope" } });
    await call("POST", `/api/enrollments/${start.body.user_code}/deny`, { token: s.token });
    const r = await call("POST", "/operator/enroll/token", { body: { device_secret: start.body.device_secret } });
    assert.equal(r.status, 403);
    assert.equal((await call("POST", "/operator/enroll/token", { body: { device_secret: "hgd_bogus" } })).status, 401);
    assert.equal((await call("POST", "/operator/enroll", { body: {} })).status, 400);
    assert.equal((await call("POST", "/operator/enroll", { body: { name: "x", scopes: ["admin"] } })).status, 400);
  });

  it("rate-limits enrollment requests per client", async () => {
    let last;
    for (let i = 0; i < 12; i++) last = await call("POST", "/operator/enroll", { body: { name: "spam" }, headers: { "x-gig-client-ip": "9.9.9.9" } });
    assert.equal(last.status, 429);
  });
});

describe("credential separation", () => {
  it("admin, operator and session tokens are not interchangeable", async () => {
    const op = await newOperator();
    assert.equal((await call("GET", "/operator/me", { token: op.token })).status, 200);
    assert.equal((await call("GET", "/operator/me", { token: s.token })).status, 401);
    assert.equal((await call("GET", "/api/invites", { token: op.token })).status, 401);
    assert.equal((await call("GET", "/operator/me")).status, 401);

    const created = await call("POST", "/operator/jobs", { token: op.token, body: job() });
    const redeemed = await s.redeem(created.body.code);
    assert.equal((await call("GET", "/operator/me", { token: redeemed.session_token })).status, 401);
    assert.equal((await call("POST", "/mcp", { token: s.token, body: { jsonrpc: "2.0", id: 1, method: "ping" } })).status, 401);
  });
});

describe("jobs", () => {
  it("runs the whole lifecycle through the operator API", async () => {
    const op = await newOperator();
    const created = await call("POST", "/operator/jobs", { token: op.token, body: job({ idempotency_key: "life-1" }) });
    assert.equal(created.status, 201);
    assert.match(created.body.command, /^npx gigagent [A-Z2-9]{4}-[A-Z2-9]{4}$/);
    const id = created.body.job.id;
    assert.equal(created.body.job.state, "waiting_for_recipient");
    assert.equal(created.body.job.operator_id, op.operatorId);

    const redeemed = await s.redeem(created.body.code);
    await s.agent(redeemed.session_token, "/events", { events: [{ type: "status", data: { status: "working", text: "Moving files" } }, { type: "tool_call", data: { tool: "bash", args: {} } }] });
    const running = await call("GET", `/operator/jobs/${id}`, { token: op.token });
    assert.equal(running.body.job.state, "running");
    assert.equal(running.body.job.active_session_id, redeemed.session_id);
    assert.equal(running.body.job.sessions[0].status_text, "Moving files");

    const inst = await call("POST", `/operator/jobs/${id}/instructions`, { token: op.token, body: { text: "also tidy Downloads" } });
    assert.equal(inst.status, 200);
    const hb = await s.agent(redeemed.session_token, "/heartbeat", { status: "working", status_text: "x" });
    assert.deepEqual(hb.body.instructions.map((i) => i.text), ["also tidy Downloads"]);

    const events = await call("GET", `/operator/jobs/${id}/events`, { token: op.token });
    assert.ok(events.body.events.some((e) => e.type === "instruction"));
    const next = await call("GET", `/operator/jobs/${id}/events?after=${events.body.next_after}`, { token: op.token });
    assert.deepEqual(next.body.events, []);

    const result = { success: true, summary: "Done", answer: "42 files", findings: [{ label: "files", value: "42" }], changes: ["Moved 42"] };
    await s.agent(redeemed.session_token, "/complete", { success: true, report: "Done", result });
    const done = await call("GET", `/operator/jobs/${id}`, { token: op.token });
    assert.equal(done.body.job.state, "succeeded");
    assert.deepEqual(done.body.job.result, result);
    assert.equal((await call("POST", `/operator/jobs/${id}/instructions`, { token: op.token, body: { text: "more" } })).status, 409);

    const listed = await call("GET", "/operator/jobs?state=succeeded", { token: op.token });
    assert.ok(listed.body.jobs.some((j) => j.id === id));
    assert.equal((await call("GET", "/operator/jobs?state=running", { token: op.token })).body.jobs.length, 0);
  });

  it("stops a running job and its helper is told to stop", async () => {
    const op = await newOperator();
    const created = await call("POST", "/operator/jobs", { token: op.token, body: job() });
    const redeemed = await s.redeem(created.body.code);
    const stop = await call("POST", `/operator/jobs/${created.body.job.id}/stop`, { token: op.token });
    assert.equal(stop.status, 200);
    assert.equal(stop.body.job.state, "stopped");
    assert.equal((await s.agent(redeemed.session_token, "/heartbeat", {})).body.kill, true);
    assert.equal((await call("POST", `/operator/jobs/${created.body.job.id}/stop`, { token: op.token })).status, 200);
  });

  it("only sees its own jobs", async () => {
    const a = await newOperator("a");
    const b = await newOperator("b");
    const ja = (await call("POST", "/operator/jobs", { token: a.token, body: job() })).body.job.id;
    for (const [m, p, body] of [
      ["GET", `/operator/jobs/${ja}`], ["GET", `/operator/jobs/${ja}/events`], ["POST", `/operator/jobs/${ja}/stop`],
      ["POST", `/operator/jobs/${ja}/instructions`, { text: "x" }], ["POST", `/operator/jobs/${ja}/code`],
    ]) {
      assert.equal((await call(m, p, { token: b.token, body })).status, 404, `${m} ${p}`);
    }
    assert.ok(!(await call("GET", "/operator/jobs", { token: b.token })).body.jobs.some((j) => j.id === ja));
    assert.equal((await call("GET", `/operator/jobs/${ja}`, { token: a.token })).status, 200);
    // the dashboard (admin) still sees everything
    assert.ok((await call("GET", "/api/invites", { token: s.token })).body.invites.some((i) => i.id === ja));
  });

  it("reissues the code of an unclaimed job only", async () => {
    const op = await newOperator();
    const created = await call("POST", "/operator/jobs", { token: op.token, body: job() });
    const id = created.body.job.id;
    const again = await call("POST", `/operator/jobs/${id}/code`, { token: op.token });
    assert.notEqual(again.body.code, created.body.code);
    await assert.rejects(s.redeem(created.body.code));
    await s.redeem(again.body.code);
    assert.equal((await call("POST", `/operator/jobs/${id}/code`, { token: op.token })).status, 409);
  });
});

describe("idempotent creation", () => {
  it("returns the same job for a repeated key, never a second one", async () => {
    const op = await newOperator("idem", { max_active_jobs: 5 });
    const body = job({ idempotency_key: "k-1" });
    const first = await call("POST", "/operator/jobs", { token: op.token, body });
    const second = await call("POST", "/operator/jobs", { token: op.token, body });
    assert.equal(first.status, 201);
    assert.equal(second.status, 200);
    assert.equal(second.body.replayed, true);
    assert.equal(second.body.code, null);
    assert.equal(second.body.job.id, first.body.job.id);
    const viaHeader = await call("POST", "/operator/jobs", { token: op.token, body: job(), headers: { "idempotency-key": "k-1" } });
    assert.equal(viaHeader.body.job.id, first.body.job.id);
    assert.equal((await call("GET", "/operator/jobs", { token: op.token })).body.jobs.length, 1);
  });

  it("rejects a reused key with different parameters", async () => {
    const op = await newOperator("idem2", { max_active_jobs: 5 });
    await call("POST", "/operator/jobs", { token: op.token, body: job({ idempotency_key: "k-2" }) });
    const r = await call("POST", "/operator/jobs", { token: op.token, body: job({ idempotency_key: "k-2", task: "something else" }) });
    assert.equal(r.status, 422);
    assert.equal(r.body.code, "idempotency_conflict");
    assert.equal((await call("POST", "/operator/jobs", { token: op.token, body: job({ idempotency_key: "bad key!" }) })).status, 400);
  });

  it("is race-safe and scoped per account", async () => {
    const a = await newOperator("ra", { max_active_jobs: 5 });
    const b = await newOperator("rb", { max_active_jobs: 5 });
    const body = job({ idempotency_key: "same" });
    const rs = await Promise.all([1, 2, 3, 4].map(() => call("POST", "/operator/jobs", { token: a.token, body })));
    assert.equal(new Set(rs.map((r) => r.body.job.id)).size, 1);
    assert.equal(rs.filter((r) => r.status === 201).length, 1);
    const other = await call("POST", "/operator/jobs", { token: b.token, body });
    assert.equal(other.status, 201);
    assert.notEqual(other.body.job.id, rs[0].body.job.id);
  });

  it("a replay still works when the account is at its limit", async () => {
    const op = await newOperator("lim-replay", { max_active_jobs: 1 });
    const body = job({ idempotency_key: "at-limit" });
    assert.equal((await call("POST", "/operator/jobs", { token: op.token, body })).status, 201);
    assert.equal((await call("POST", "/operator/jobs", { token: op.token, body })).status, 200);
  });
});

describe("limits", () => {
  it("enforces active jobs, daily jobs, ttl and allowed models", async () => {
    const op = await newOperator("limited", { max_active_jobs: 1, max_jobs_per_day: 3, max_ttl_hours: 2 });
    const first = await call("POST", "/operator/jobs", { token: op.token, body: job() });
    assert.equal(first.status, 201);
    const blocked = await call("POST", "/operator/jobs", { token: op.token, body: job({ label: "two" }) });
    assert.equal(blocked.status, 429);
    assert.equal(blocked.body.code, "limit_exceeded");
    await call("POST", `/operator/jobs/${first.body.job.id}/stop`, { token: op.token });
    assert.equal((await call("POST", "/operator/jobs", { token: op.token, body: job({ label: "three" }) })).status, 201);

    const me = (await call("GET", "/operator/me", { token: op.token })).body;
    assert.equal(me.usage.active_jobs, 1);
    assert.equal(me.usage.jobs_today, 2);

    const ttl = await call("POST", "/operator/jobs", { token: op.token, body: job({ ttl_hours: 5 }) });
    assert.equal(ttl.status, 403);
    assert.equal((await call("POST", "/operator/jobs", { token: op.token, body: job({ model: "nope/none" }) })).status, 400);
  });

  it("daily limit and model allow-list", async () => {
    const models = (await call("GET", "/api/config", { token: s.token })).body.models;
    const op = await newOperator("daily", { max_active_jobs: 10, max_jobs_per_day: 2, allowed_models: [models[0]] });
    for (let i = 0; i < 2; i++) assert.equal((await call("POST", "/operator/jobs", { token: op.token, body: job({ label: `j${i}` }) })).status, 201);
    const r = await call("POST", "/operator/jobs", { token: op.token, body: job({ label: "j3" }) });
    assert.equal(r.status, 429);
    assert.match(r.body.error, /daily/);
    if (models.length > 1) {
      const m = await call("POST", "/operator/jobs", { token: op.token, body: job({ model: models[1] }) });
      assert.equal(m.status, 403);
      assert.equal(m.body.code, "model_not_allowed");
    }
  });

  it("operator jobs cannot email arbitrary addresses or call http/loopback webhooks", async () => {
    const op = await newOperator("hooks", { max_active_jobs: 5 });
    const email = await call("POST", "/operator/jobs", { token: op.token, body: job({ notify_email: "victim@example.com" }) });
    assert.equal(email.status, 400);
    const http = await call("POST", "/operator/jobs", { token: op.token, body: job({ notify_webhook: "http://127.0.0.1:9/hook" }) });
    assert.equal(http.status, 400);
    const ok = await call("POST", "/operator/jobs", { token: op.token, body: job({ notify_webhook: "https://hooks.example.com/x" }) });
    assert.equal(ok.status, 201);
    // the owner's dashboard keeps both abilities
    const admin = await call("POST", "/api/invites", { token: s.token, body: { label: "a", task: "t", expiry_policy: "one_use", notify_webhook: "http://127.0.0.1:9/hook" } });
    assert.equal(admin.status, 201);
  });

  it("operator jobs always expire", async () => {
    const op = await newOperator("exp", { max_active_jobs: 5 });
    const j = (await call("POST", "/operator/jobs", { token: op.token, body: job() })).body.job;
    assert.ok(j.expires_at > Date.now() && j.expires_at <= Date.now() + 24 * 3_600_000 + 5000);
  });
});

describe("revocation and scopes", () => {
  it("revoking a token kills only that token; revoking the account stops its jobs", async () => {
    const op = await newOperator("rev", { max_active_jobs: 5 });
        const created = await call("POST", "/operator/jobs", { token: op.token, body: job() });
    const redeemed = await s.redeem(created.body.code);

    const list = await call("GET", "/api/operators", { token: s.token });
    const mine = list.body.operators.find((o) => o.id === op.operatorId);
    assert.equal(mine.tokens.length, 1);
    assert.ok(!JSON.stringify(list.body).includes(op.token));

    assert.equal((await call("POST", `/api/operators/${op.operatorId}/revoke`, { token: s.token, body: {} })).status, 200);
    assert.equal((await call("GET", "/operator/me", { token: op.token })).status, 401);
    assert.equal((await s.agent(redeemed.session_token, "/heartbeat", {})).body.kill, true);
    const after = (await call("GET", "/api/invites", { token: s.token })).body.invites.find((i) => i.id === created.body.job.id);
    assert.equal(after.status, "revoked");
  });

  it("logout revokes the presented token; admin can revoke one token", async () => {
    const op = await newOperator("logout");
    assert.equal((await call("DELETE", "/operator/token", { token: op.token })).status, 200);
    assert.equal((await call("GET", "/operator/me", { token: op.token })).status, 401);

    const op2 = await newOperator("single");
    const tokens = (await call("GET", "/api/operators", { token: s.token })).body.operators.find((o) => o.id === op2.operatorId).tokens;
    assert.equal((await call("POST", `/api/operators/${op2.operatorId}/tokens/${tokens[0].id}/revoke`, { token: s.token })).status, 200);
    assert.equal((await call("GET", "/operator/me", { token: op2.token })).status, 401);
  });

  it("a read-only token can read but not change anything", async () => {
    const full = await newOperator("rw");
    const ro = await newOperator("ro", { scopes: ["jobs:read"] }, ["jobs:read"]);
    assert.equal((await call("GET", "/operator/jobs", { token: ro.token })).status, 200);
    const w = await call("POST", "/operator/jobs", { token: ro.token, body: job() });
    assert.equal(w.status, 403);
    assert.equal(w.body.code, "insufficient_scope");
    assert.ok(full.token);
  });

  it("limits can be changed, and the approval cannot grant more scopes than requested", async () => {
    const op = await newOperator("tune");
    await call("POST", `/api/operators/${op.operatorId}/limits`, { token: s.token, body: { max_active_jobs: 7 } });
    assert.equal((await call("GET", "/operator/me", { token: op.token })).body.operator.limits.max_active_jobs, 7);
    const start = await call("POST", "/operator/enroll", { body: { name: "ro", scopes: ["jobs:read"] }, headers: { "x-gig-client-ip": "10.2.0.1" } });
    const r = await call("POST", `/api/enrollments/${start.body.user_code}/approve`, { token: s.token, body: { scopes: ["jobs:read", "jobs:write"] } });
    assert.equal(r.body.operator.scopes.length, 1);
  });

  it("expired tokens stop working", async () => {
    const op = await newOperator("short");
    await s.db.run("UPDATE operator_tokens SET expires_at = $1 WHERE operator_id = $2", [Date.now() - 1, op.operatorId]);
    assert.equal((await call("GET", "/operator/me", { token: op.token })).status, 401);
  });
});

describe("MCP", () => {
  const rpc = (token, body, headers) => call("POST", "/mcp", { token, body, headers });

  it("requires a token and speaks JSON-RPC", async () => {
    const none = await rpc(undefined, { jsonrpc: "2.0", id: 1, method: "ping" });
    assert.equal(none.status, 401);
    assert.match(none.headers.get("www-authenticate"), /Bearer/);
    assert.equal((await call("GET", "/mcp")).status, 405);

    const op = await newOperator("mcp", { max_active_jobs: 5 });
    const init = await rpc(op.token, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } } });
    assert.equal(init.body.result.protocolVersion, "2025-06-18");
    assert.ok(init.body.result.capabilities.tools);
    assert.equal((await rpc(op.token, { jsonrpc: "2.0", method: "notifications/initialized" })).status, 202);

    const tools = (await rpc(op.token, { jsonrpc: "2.0", id: 2, method: "tools/list" })).body.result.tools;
    assert.deepEqual(tools.map((t) => t.name).sort(), ["create_job", "get_account", "get_job", "get_job_events", "list_jobs", "reissue_code", "send_instruction", "stop_job"]);
    assert.ok(tools.every((t) => t.inputSchema.type === "object" && t.description && t.annotations));
    assert.equal(tools.find((t) => t.name === "stop_job").annotations.destructiveHint, true);
    assert.equal(tools.find((t) => t.name === "get_job").annotations.readOnlyHint, true);

    const created = (await rpc(op.token, { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "create_job", arguments: job({ idempotency_key: "mcp-1" }) } })).body.result;
    assert.equal(created.isError, false);
    assert.match(created.structuredContent.command, /^npx gigagent /);
    const jobId = created.structuredContent.job.id;
    const got = (await rpc(op.token, { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "get_job", arguments: { job_id: jobId } } })).body.result;
    assert.equal(got.structuredContent.job.state, "waiting_for_recipient");
    assert.equal(JSON.parse(got.content[0].text).job.id, jobId);

    const missing = (await rpc(op.token, { jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "get_job", arguments: { job_id: "nope" } } })).body.result;
    assert.equal(missing.isError, true);
    assert.equal(missing.structuredContent.code, "not_found");
    assert.equal((await rpc(op.token, { jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "drop_tables", arguments: {} } })).body.error.code, -32602);
    assert.equal((await rpc(op.token, { jsonrpc: "2.0", id: 7, method: "bogus" })).body.error.code, -32601);

    const batch = (await rpc(op.token, [{ jsonrpc: "2.0", id: 8, method: "ping" }, { jsonrpc: "2.0", id: 9, method: "ping" }])).body;
    assert.equal(batch.length, 2);
  });

  it("hides write tools from a read-only token and blocks calling them", async () => {
    const ro = await newOperator("mcp-ro", { scopes: ["jobs:read"] }, ["jobs:read"]);
    const tools = (await rpc(ro.token, { jsonrpc: "2.0", id: 1, method: "tools/list" })).body.result.tools.map((t) => t.name);
    assert.ok(tools.includes("get_job") && !tools.includes("create_job") && !tools.includes("stop_job"));
    const r = (await rpc(ro.token, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "create_job", arguments: job() } })).body.result;
    assert.equal(r.isError, true);
    assert.equal(r.structuredContent.code, "insufficient_scope");
  });
});

describe("get_job wait", () => {
  it("returns early when the job changes", async () => {
    const op = await newOperator("wait", { max_active_jobs: 5 });
    const created = await call("POST", "/operator/jobs", { token: op.token, body: job() });
    const id = created.body.job.id;
    const waiting = call("GET", `/operator/jobs/${id}?wait_seconds=10`, { token: op.token });
    setTimeout(() => s.redeem(created.body.code), 300);
    const started = Date.now();
    const r = await waiting;
    assert.equal(r.body.job.state, "running");
    assert.ok(Date.now() - started < 8000);
  });
});
