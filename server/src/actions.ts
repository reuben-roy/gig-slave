import { config } from "./config.js";
import {
  ServiceError, commandFor, createInvite, inviteFor, jobEvents, jobView, liveSession, listJobs, reissueCode,
  revokeInvite, sendInstruction, str, usageOf,
} from "./jobs.js";
import { operatorJson, type OperatorAuth, type Scope } from "./operators.js";

/**
 * The operator surface, defined once. The REST routes (operator.ts), the MCP tools (mcp.ts) and the CLI all
 * expose exactly these actions, each running the same job logic the dashboard uses (jobs.ts).
 */

type Input = Record<string, any>;

export interface Action {
  name: string;
  title: string;
  description: string;
  scope: Scope;
  /** MCP tool annotations. */
  hints: { readOnly?: boolean; destructive?: boolean; idempotent?: boolean };
  inputSchema: Record<string, unknown>;
  run: (auth: OperatorAuth, input: Input) => Promise<unknown>;
}

const jobId = { type: "string", description: "Job id, from create_job or list_jobs." };
const obj = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: "object", properties, required, additionalProperties: false,
});

const TERMINAL_STATES = ["succeeded", "failed", "stopped", "expired"];
const MAX_WAIT_S = 20;

async function loadJob(auth: OperatorAuth, id: unknown) {
  return inviteFor(str(id), auth.operator);
}

const fingerprint = (view: Awaited<ReturnType<typeof jobView>>) =>
  JSON.stringify([view.state, view.status, view.sessions.map((s) => [s.status, s.status_text, s.actions, s.ended_at])]);

export const actions: Action[] = [
  {
    name: "get_account",
    title: "Get account",
    description:
      "Show this operator account: its limits, current usage, the models it may use and the scopes of the token in use. Call this first to learn what you are allowed to do.",
    scope: "jobs:read",
    hints: { readOnly: true },
    inputSchema: obj({}),
    async run(auth) {
      return {
        operator: operatorJson(auth.operator),
        token: auth.token,
        usage: await usageOf(auth.operator.id),
        default_model: config.defaultModel,
      };
    },
  },
  {
    name: "create_job",
    title: "Create job",
    description:
      "Create a job: a task for a helper agent to carry out on someone's Mac. Returns a one-time code and the command (`npx gigagent CODE`) that the person at that computer must run themselves; nothing happens until they do. " +
      "Pass idempotency_key (any unique string per intended job) so a retry never creates a second job; a replay returns the same job with code null (use reissue_code if the code was lost). " +
      "Do not put secrets in the task text.",
    scope: "jobs:write",
    hints: { idempotent: true },
    inputSchema: obj(
      {
        label: { type: "string", description: "Short name for the job, e.g. \"Dad's iMac cleanup\"." },
        task: { type: "string", description: "Plain-English instructions for the helper agent." },
        working_dir: { type: "string", description: "Folder on the recipient's Mac the helper may work in. Default ~/Desktop." },
        model: { type: "string", description: "Model id. Omit for the default; see get_account for allowed models." },
        expiry_policy: {
          type: "string", enum: ["one_use", "on_complete", "ttl"],
          description: "one_use (default): the code works once. on_complete: reusable until a run succeeds. ttl: reusable until ttl_hours pass.",
        },
        ttl_hours: { type: "number", description: "Hours until the code and job expire. Default 24; capped by the account's max_ttl_hours." },
        notify_webhook: { type: "string", description: "Optional https URL (Slack/Discord/generic) called when the job ends." },
        idempotency_key: { type: "string", description: "1-128 chars of A-Z a-z 0-9 _ . : -. Same key + same parameters returns the original job." },
      },
      ["label", "task"],
    ),
    async run(auth, input) {
      const { invite, code, replayed } = await createInvite(
        { expiry_policy: "one_use", ...input },
        { owner: auth.operator, idemKey: typeof input.idempotency_key === "string" ? input.idempotency_key : undefined },
      );
      return { job: await jobView(invite), code, command: code ? commandFor(code) : null, replayed };
    },
  },
  {
    name: "list_jobs",
    title: "List jobs",
    description: "List this account's jobs, newest first, each with its state and (when finished) its structured result.",
    scope: "jobs:read",
    hints: { readOnly: true },
    inputSchema: obj({
      state: {
        type: "string", enum: ["waiting_for_recipient", "running", "succeeded", "failed", "stopped", "expired"],
        description: "Only jobs in this state.",
      },
      limit: { type: "integer", minimum: 1, maximum: 200, description: "Default 50." },
    }),
    async run(auth, input) {
      return { jobs: await listJobs(auth.operator.id, { state: input.state, limit: Number(input.limit) || undefined }) };
    },
  },
  {
    name: "get_job",
    title: "Get job",
    description:
      "Get one job: state (waiting_for_recipient, running, succeeded, failed, stopped, expired), live status text, sessions and the structured result once finished. " +
      "Set wait_seconds (max 20) to wait for the next change instead of polling.",
    scope: "jobs:read",
    hints: { readOnly: true },
    inputSchema: obj(
      {
        job_id: jobId,
        wait_seconds: { type: "integer", minimum: 0, maximum: MAX_WAIT_S, description: "Long-poll: return early when something changes. Default 0." },
      },
      ["job_id"],
    ),
    async run(auth, input) {
      let invite = await loadJob(auth, input.job_id);
      let view = await jobView(invite);
      const wait = Math.min(Math.max(Number(input.wait_seconds) || 0, 0), MAX_WAIT_S);
      if (wait && !TERMINAL_STATES.includes(view.state)) {
        const first = fingerprint(view);
        const until = Date.now() + wait * 1000;
        while (Date.now() < until) {
          await new Promise((r) => setTimeout(r, 1500));
          invite = await loadJob(auth, input.job_id);
          view = await jobView(invite);
          if (fingerprint(view) !== first || TERMINAL_STATES.includes(view.state)) break;
        }
      }
      return { job: view };
    },
  },
  {
    name: "get_job_events",
    title: "Get job events",
    description:
      "The activity log of a job (status changes, tool calls, assistant messages, the final report). Pass after=<next_after from the previous call> to read only new events.",
    scope: "jobs:read",
    hints: { readOnly: true },
    inputSchema: obj(
      {
        job_id: jobId,
        after: { type: "integer", minimum: 0, description: "Return events with id greater than this." },
        limit: { type: "integer", minimum: 1, maximum: 500, description: "Default 200." },
      },
      ["job_id"],
    ),
    async run(auth, input) {
      const invite = await loadJob(auth, input.job_id);
      const after = Number(input.after) || 0;
      const events = await jobEvents(invite.id, after, Math.min(Math.max(Number(input.limit) || 200, 1), 500));
      return { events, next_after: events.length ? events[events.length - 1].id : after };
    },
  },
  {
    name: "send_instruction",
    title: "Send instruction",
    description:
      "Send a follow-up instruction to the helper while the job is running. Fails with not_running if no recipient is currently connected.",
    scope: "jobs:write",
    hints: {},
    inputSchema: obj({ job_id: jobId, text: { type: "string", description: "The instruction, in plain English." } }, ["job_id", "text"]),
    async run(auth, input) {
      const invite = await loadJob(auth, input.job_id);
      const text = str(input.text);
      if (!text) throw new ServiceError(400, "invalid_request", "text is required");
      const session = await liveSession(invite.id);
      if (!session) throw new ServiceError(409, "not_running", "no recipient is connected to this job right now");
      await sendInstruction(session, invite, text);
      return { ok: true, session_id: session.id };
    },
  },
  {
    name: "stop_job",
    title: "Stop job",
    description:
      "Stop a job: the code stops working and any running helper is told to stop at its next heartbeat. Safe to repeat.",
    scope: "jobs:write",
    hints: { destructive: true, idempotent: true },
    inputSchema: obj({ job_id: jobId }, ["job_id"]),
    async run(auth, input) {
      const invite = await loadJob(auth, input.job_id);
      const live = await liveSession(invite.id);
      if (live || ["pending", "active"].includes(invite.status)) await revokeInvite(invite);
      return { ok: true, job: await jobView((await inviteFor(invite.id, auth.operator))) };
    },
  },
  {
    name: "reissue_code",
    title: "Reissue code",
    description: "Get a fresh code for a job nobody has run yet (for a lost code). The previous code stops working.",
    scope: "jobs:write",
    hints: {},
    inputSchema: obj({ job_id: jobId }, ["job_id"]),
    async run(auth, input) {
      const code = await reissueCode(await loadJob(auth, input.job_id));
      return { code, command: commandFor(code) };
    },
  },
];

export const actionByName = new Map(actions.map((a) => [a.name, a]));

export async function runAction(name: string, auth: OperatorAuth, input: Input = {}) {
  const action = actionByName.get(name);
  if (!action) throw new ServiceError(404, "unknown_action", `unknown action: ${name}`);
  if (!auth.token.scopes.includes(action.scope)) {
    throw new ServiceError(403, "insufficient_scope", `this token lacks the ${action.scope} scope`);
  }
  return action.run(auth, input && typeof input === "object" ? input : {});
}
