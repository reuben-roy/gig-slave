// With OPERATOR_API_ENABLED unset the feature is dark: operator tokens are plain 401s and nothing legacy changes.
import assert from "node:assert/strict";
import { test } from "node:test";
import { loadServer } from "./helpers.mjs";

const s = await loadServer();

test("operator tokens are refused while the flag is off, admin keeps working", async () => {
  const mint = await s.admin("POST", "/api/operator-tokens", { label: "dark" });
  assert.equal(mint.status, 201);
  const r = await s.app.request("/api/config", { headers: { authorization: `Bearer ${mint.body.token}` } });
  assert.equal(r.status, 401);
  assert.equal((await s.admin("GET", "/api/config")).status, 200);
  const who = await s.admin("GET", "/api/whoami");
  assert.equal(who.body.server.operator_tokens_enabled, false);
});

test("legacy admin behaviour is unchanged and admin mutations are not audited while dark", async () => {
  const made = await s.createInvite("legacy");
  assert.match(made.code, /^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  const list = await s.admin("GET", "/api/invites");
  assert.equal(list.body.invites.some((i) => i.id === made.invite.id), true);
  const audit = await s.admin("GET", "/api/audit?limit=200");
  assert.equal(audit.body.entries.some((e) => e.action === "invite.create"), false);
  assert.equal((await s.app.request("/api/invites")).status, 401);
  assert.equal((await s.app.request("/api/invites", { headers: { authorization: "Bearer nope" } })).status, 401);
});

test("admin gets the new read routes", async () => {
  const made = await s.createInvite("single");
  assert.equal((await s.admin("GET", `/api/invites/${made.invite.id}`)).body.invite.label, "single");
  assert.equal((await s.admin("GET", "/api/invites?limit=1")).body.invites.length, 1);
});
