import { randomBytes } from "node:crypto";
import type { Client } from "./client.js";
import { CliError, usage } from "./errors.js";

/** Operations shared by the CLI and the MCP server. Return the server JSON unchanged. */

export const TERMINAL = ["done", "failed", "killed"];
export const EXPIRY_POLICIES = ["one_use", "on_complete", "ttl"];

export const whoami = async (c: Client) => (await c.request("GET", "/api/whoami")).json;
export const getConfig = async (c: Client) => (await c.request("GET", "/api/config")).json;

export async function listJobs(c: Client, o: { status?: string[]; limit?: number; sinceMs?: number } = {}) {
  const r = await c.request("GET", "/api/invites", {
    query: { status: o.status?.length ? o.status.join(",") : undefined, limit: o.limit, since: o.sinceMs },
  });
  return r.json.invites as any[];
}
export const getJob = async (c: Client, id: string) => (await c.request("GET", `/api/invites/${encodeURIComponent(id)}`)).json.invite;
export const getSession = async (c: Client, id: string) => (await c.request("GET", `/api/sessions/${encodeURIComponent(id)}`)).json;
export async function getEvents(c: Client, id: string, after = 0) {
  return (await c.request("GET", `/api/sessions/${encodeURIComponent(id)}/events`, { query: { after: after || undefined } })).json.events as any[];
}
export const revokeJob = async (c: Client, id: string) => (await c.request("POST", `/api/invites/${encodeURIComponent(id)}/revoke`, { body: {} })).json;
export const killSession = async (c: Client, id: string) => (await c.request("POST", `/api/sessions/${encodeURIComponent(id)}/kill`, { body: {} })).json;
export const instruct = async (c: Client, id: string, text: string) =>
  (await c.request("POST", `/api/sessions/${encodeURIComponent(id)}/instructions`, { body: { text } })).json;

// ---------- job drafts ----------

export interface JobDraft {
  label: string;
  task: string;
  working_dir?: string;
  model?: string;
  expiry_policy: "one_use" | "on_complete" | "ttl";
  ttl_hours?: number;
  max_redemptions?: number;
  notify_email?: string;
  notify_webhook?: string;
}

const opt = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);

/** Local validation and normalisation. Throws a usage error for anything the server would reject anyway. */
export function normalizeDraft(input: Record<string, unknown>): JobDraft {
  const label = opt(input.label);
  const task = opt(input.task);
  if (!label) throw usage("label is required");
  if (label.length > 120) throw usage("label is limited to 120 characters");
  if (!task) throw usage("task is required");
  if (task.length > 20_000) throw usage("task is limited to 20000 characters");
  const policy = (opt(input.expiry_policy) ?? "one_use") as JobDraft["expiry_policy"];
  if (!EXPIRY_POLICIES.includes(policy)) throw usage(`expiry_policy must be one of: ${EXPIRY_POLICIES.join(", ")}`);
  const d: JobDraft = { label, task, expiry_policy: policy };
  const dir = opt(input.working_dir);
  if (dir) d.working_dir = dir;
  const model = opt(input.model);
  if (model) d.model = model;
  if (policy === "ttl") {
    const h = Number(input.ttl_hours);
    if (!Number.isFinite(h) || h <= 0) throw usage("ttl_hours (> 0) is required for the ttl policy");
    d.ttl_hours = h;
  } else if (input.ttl_hours !== undefined && input.ttl_hours !== null && input.ttl_hours !== "") {
    throw usage("ttl_hours only applies to the ttl policy");
  }
  if (input.max_redemptions !== undefined && input.max_redemptions !== null && input.max_redemptions !== "") {
    const n = Number(input.max_redemptions);
    if (!Number.isInteger(n) || n < 1) throw usage("max_redemptions must be a positive integer");
    d.max_redemptions = n;
  }
  const email = opt(input.notify_email);
  if (email) {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw usage("notify_email must be a valid email address");
    d.notify_email = email;
  }
  const hook = opt(input.notify_webhook);
  if (hook) {
    try {
      const u = new URL(hook);
      const loop = ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname);
      if (u.protocol !== "https:" && !(u.protocol === "http:" && loop)) throw new Error("scheme");
    } catch {
      throw usage("notify_webhook must be an https:// URL");
    }
    d.notify_webhook = hook;
  }
  return d;
}

/** Friendly client-side mirror of the server limits (the server stays the authority). Returns problems found. */
export function limitsProblems(d: JobDraft, who: any, config: any | null): string[] {
  const out: string[] = [];
  const model = d.model ?? config?.default_model;
  if (config && model && !config.models.includes(model)) out.push(`model "${model}" is not available (use one of: ${config.models.join(", ")})`);
  const lim = who?.token?.limits;
  if (!lim) return out;
  if (lim.models && model && !lim.models.includes(model)) out.push(`this token may only use models: ${lim.models.join(", ")}`);
  if (d.expiry_policy === "on_complete" && !lim.allow_on_complete) out.push("this token may not create on_complete jobs");
  if (d.expiry_policy === "ttl" && (d.ttl_hours ?? 0) > lim.max_ttl_hours) out.push(`ttl_hours is capped at ${lim.max_ttl_hours} for this token`);
  if (d.expiry_policy === "ttl" && d.max_redemptions === undefined) out.push(`ttl jobs need max_redemptions (up to ${lim.max_redemptions}) for this token`);
  if (d.max_redemptions !== undefined && d.max_redemptions > lim.max_redemptions) out.push(`max_redemptions is capped at ${lim.max_redemptions} for this token`);
  if (d.notify_webhook) {
    const host = new URL(d.notify_webhook).hostname.toLowerCase();
    if (!lim.webhook_hosts.map((h: string) => h.toLowerCase()).includes(host)) out.push(`this token may not notify webhook host ${host}`);
  }
  if (d.notify_email && !lim.notify_emails.map((e: string) => e.toLowerCase()).includes(d.notify_email.toLowerCase())) {
    out.push("this token may not set notify_email for that address");
  }
  return out;
}

export const newIdempotencyKey = () => `cli-${randomBytes(12).toString("hex")}`;

export async function createJob(c: Client, d: JobDraft, idempotencyKey = newIdempotencyKey()) {
  const r = await c.request("POST", "/api/invites", {
    body: d, headers: { "idempotency-key": idempotencyKey }, retry: true,
  });
  return { ...(r.json as { invite: any; code: string | null; command: string | null }), idempotency_key: idempotencyKey, replay: r.headers.get("idempotent-replay") === "true" };
}

/** Mask the secret part of an invite code: ABCD-EFGH -> ABCD-**** */
export const maskCode = (code: string) => code.replace(/^([A-Z0-9]{4})-?[A-Z0-9]{4}$/, "$1-****");

export function ensureNotAdmin(w: any) {
  if (w?.principal === "admin") {
    throw new CliError("forbidden", "this credential is the master admin token", {
      hint: "mint a scoped operator token (tokens create) and use that instead",
    });
  }
}
