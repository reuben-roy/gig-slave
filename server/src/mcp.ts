import { Hono } from "hono";
import { actions, actionByName, runAction } from "./actions.js";
import { ServiceError } from "./jobs.js";
import { requireOperator, wwwAuthenticate } from "./operator.js";
import type { OperatorAuth } from "./operators.js";

/**
 * Remote MCP server (Streamable HTTP, stateless, JSON responses) exposing the operator actions as tools.
 * Every request needs `Authorization: Bearer <operator token>`; there are no cookies or ambient credentials.
 */
export const mcp = new Hono();

const VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];
const INSTRUCTIONS =
  "Hired Gun runs a task on a person's Mac via a helper agent. Call get_account first, then create_job (always with an idempotency_key). " +
  "Give the returned command to the person at the computer; they must run it themselves. Then poll get_job (wait_seconds up to 20) until its state is succeeded, failed, stopped or expired, and read job.result.";

type Rpc = { jsonrpc?: string; id?: string | number | null; method?: string; params?: any };

const rpcError = (id: Rpc["id"], code: number, message: string) => ({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });

async function handle(msg: Rpc, auth: OperatorAuth) {
  const id = msg?.id;
  if (!msg || msg.jsonrpc !== "2.0" || typeof msg.method !== "string") return rpcError(id, -32600, "invalid request");
  if (id === undefined) return null; // notification
  const ok = (result: unknown) => ({ jsonrpc: "2.0", id, result });
  switch (msg.method) {
    case "initialize": {
      const asked = msg.params?.protocolVersion;
      return ok({
        protocolVersion: VERSIONS.includes(asked) ? asked : VERSIONS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "hired-gun", title: "Hired Gun", version: "1.0.0" },
        instructions: INSTRUCTIONS,
      });
    }
    case "ping":
      return ok({});
    case "tools/list":
      return ok({
        tools: actions
          .filter((a) => auth.token.scopes.includes(a.scope))
          .map((a) => ({
            name: a.name,
            title: a.title,
            description: a.description,
            inputSchema: a.inputSchema,
            annotations: {
              readOnlyHint: Boolean(a.hints.readOnly),
              destructiveHint: Boolean(a.hints.destructive),
              idempotentHint: Boolean(a.hints.idempotent || a.hints.readOnly),
              openWorldHint: false,
            },
          })),
      });
    case "tools/call": {
      const name = msg.params?.name;
      if (typeof name !== "string" || !actionByName.has(name)) return rpcError(id, -32602, `unknown tool: ${name}`);
      try {
        const out = await runAction(name, auth, msg.params?.arguments ?? {});
        return ok({ content: [{ type: "text", text: JSON.stringify(out, null, 2) }], structuredContent: out, isError: false });
      } catch (e) {
        if (!(e instanceof ServiceError)) throw e;
        const err = { error: e.message, code: e.code };
        return ok({ content: [{ type: "text", text: JSON.stringify(err) }], structuredContent: err, isError: true });
      }
    }
    default:
      return rpcError(id, -32601, `method not found: ${msg.method}`);
  }
}

mcp.post("/", async (c) => {
  let auth: OperatorAuth;
  try {
    auth = await requireOperator(c.req.header("authorization"));
  } catch (e) {
    if (e instanceof ServiceError) {
      return c.json({ error: e.message, code: e.code }, 401, wwwAuthenticate());
    }
    throw e;
  }
  const body = await c.req.json().catch(() => undefined);
  if (body === undefined) return c.json(rpcError(null, -32700, "parse error"), 400);
  if (Array.isArray(body)) {
    if (body.length > 20) return c.json(rpcError(null, -32600, "batch too large (max 20)"), 400);
    const out = (await Promise.all(body.map((m) => handle(m, auth)))).filter((r) => r !== null);
    return out.length ? c.json(out) : c.body(null, 202);
  }
  const out = await handle(body, auth);
  return out ? c.json(out) : c.body(null, 202);
});

// Stateless server: no standalone SSE stream and no sessions to terminate.
mcp.all("/", (c) => c.json({ error: "use POST" }, 405, { Allow: "POST" }));
