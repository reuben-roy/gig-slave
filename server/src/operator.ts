import { Hono, type Context } from "hono";
import { runAction } from "./actions.js";
import { clientIp } from "./agent.js";
import { ensureSchema } from "./db.js";
import { ServiceError } from "./jobs.js";
import { authenticateOperator, collectEnrollment, revokeToken, startEnrollment, type OperatorAuth } from "./operators.js";
import { maybeSweep } from "./sweeper.js";

/**
 * REST face of the operator actions (see actions.ts). Auth: `Authorization: Bearer hgo_...`, except the two
 * enrollment endpoints, which are how an agent asks a human for that token in the first place.
 */
type Env = { Variables: { auth: OperatorAuth } };
export const operator = new Hono<Env>();

const json = async (c: Context<Env>) => ((await c.req.json().catch(() => null)) ?? {}) as Record<string, any>;

operator.post("/enroll", async (c) => {
  await ensureSchema();
  const b = await json(c);
  return c.json(await startEnrollment(b.name, b.scopes, clientIp(c)), 201);
});

operator.post("/enroll/token", async (c) => {
  await ensureSchema();
  const r = await collectEnrollment((await json(c)).device_secret);
  return c.json(r, r.status === "pending" ? 202 : 200);
});

const WWW_AUTH = { "WWW-Authenticate": 'Bearer realm="hired-gun"' };

/** Shared by the REST routes and the MCP endpoint. */
export async function requireOperator(header: string | undefined) {
  const auth = await authenticateOperator(header);
  if (!auth) throw new ServiceError(401, "invalid_token", "missing, expired or revoked operator token");
  await maybeSweep();
  return auth;
}

operator.use("*", async (c, next) => {
  try {
    c.set("auth", await requireOperator(c.req.header("authorization")));
  } catch (e) {
    if (e instanceof ServiceError) return c.json({ error: e.message, code: e.code }, e.status as 401, WWW_AUTH);
    throw e;
  }
  await next();
});

const act = (name: string, input: (c: Context<Env>) => Promise<Record<string, any>> | Record<string, any>) =>
  async (c: Context<Env>) => {
    const out = (await runAction(name, c.get("auth"), await input(c))) as { replayed?: boolean };
    return c.json(out, out.replayed === false ? 201 : 200);
  };

operator.get("/me", act("get_account", () => ({})));
operator.post("/jobs", act("create_job", async (c) => ({
  idempotency_key: c.req.header("idempotency-key")?.trim() || undefined,
  ...(await json(c)),
})));
operator.get("/jobs", act("list_jobs", (c) => c.req.query()));
operator.get("/jobs/:id", act("get_job", (c) => ({ ...c.req.query(), job_id: c.req.param("id") })));
operator.get("/jobs/:id/events", act("get_job_events", (c) => ({ ...c.req.query(), job_id: c.req.param("id") })));
operator.post("/jobs/:id/instructions", act("send_instruction", async (c) => ({ ...(await json(c)), job_id: c.req.param("id") })));
operator.post("/jobs/:id/stop", act("stop_job", (c) => ({ job_id: c.req.param("id") })));
operator.post("/jobs/:id/code", act("reissue_code", (c) => ({ job_id: c.req.param("id") })));

/** Log out: revoke the token used for this request. */
operator.delete("/token", async (c) => {
  const { operator: op, token } = c.get("auth");
  await revokeToken(op.id, token.id);
  return c.json({ ok: true });
});
