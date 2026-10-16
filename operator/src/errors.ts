import { CLI_NAME } from "./names.js";

export const EXIT = {
  ok: 0,
  error: 1,
  usage: 2,
  auth: 3,
  notFound: 4,
  conflict: 5,
  rateLimited: 6,
  network: 7,
  declined: 8,
  timeout: 9,
  sessionFailed: 10,
  sessionKilled: 11,
} as const;

export type ErrorCode =
  | "error" | "usage" | "unauthorized" | "forbidden" | "limit" | "not_found" | "conflict" | "rate_limited"
  | "network" | "server" | "declined" | "timeout" | "session_failed" | "session_killed";

const EXIT_FOR: Record<ErrorCode, number> = {
  error: EXIT.error, usage: EXIT.usage, unauthorized: EXIT.auth, forbidden: EXIT.auth, limit: EXIT.auth,
  not_found: EXIT.notFound, conflict: EXIT.conflict, rate_limited: EXIT.rateLimited, network: EXIT.network,
  server: EXIT.network, declined: EXIT.declined, timeout: EXIT.timeout, session_failed: EXIT.sessionFailed,
  session_killed: EXIT.sessionKilled,
};

export class CliError extends Error {
  constructor(
    public code: ErrorCode,
    message: string,
    public extra: { status?: number; hint?: string; retry_after_s?: number; data?: unknown } = {},
  ) {
    super(message);
    this.name = "CliError";
  }
  get exit() {
    return EXIT_FOR[this.code];
  }
  toJSON() {
    const { data: _data, ...rest } = this.extra;
    return { code: this.code, message: this.message, ...rest };
  }
}

export const usage = (message: string, hint?: string) => new CliError("usage", message, { hint });

/** Map an HTTP failure from the server into a CliError. */
export function fromHttp(status: number, body: any, retryAfter: number | null): CliError {
  const message = typeof body?.error === "string" ? body.error : `server returned HTTP ${status}`;
  if (status === 401) {
    return new CliError("unauthorized", "unauthorized: the token is missing, invalid, revoked or expired", {
      status, hint: `run \`${CLI_NAME} login\` with a valid operator token`,
    });
  }
  if (status === 403) {
    const scope = /lacks scope ([a-z:]+)/.exec(message)?.[1];
    if (typeof body?.limit === "string") return new CliError("limit", message, { status, hint: `token limit "${body.limit}"; ask the admin for a token with a higher limit` });
    return new CliError("forbidden", message, {
      status, hint: scope ? `mint a token whose preset or scopes include ${scope}` : undefined,
    });
  }
  if (status === 404) return new CliError("not_found", message, { status });
  if (status === 409 || status === 422) return new CliError("conflict", message, { status });
  if (status === 429) {
    return new CliError("rate_limited", message, {
      status, retry_after_s: retryAfter ?? body?.retry_after_s ?? undefined, hint: "wait and retry",
    });
  }
  if (status >= 500) return new CliError("server", message, { status });
  return new CliError("usage", message, { status });
}
