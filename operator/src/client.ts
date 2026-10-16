import { CliError, fromHttp } from "./errors.js";
import { CLIENT_TAG } from "./names.js";
import { scrub, scrubValue } from "./scrub.js";

export interface ClientOptions {
  server: string; // origin
  token: string;
  clientTag?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

export interface Reply<T = any> {
  status: number;
  json: T;
  headers: Headers;
}

export interface RequestOptions {
  body?: unknown;
  query?: Record<string, string | number | undefined>;
  headers?: Record<string, string>;
  /** Safe to retry network errors and 5xx (GET, or a POST that carries an Idempotency-Key). */
  retry?: boolean;
  /** Only for `tokens create`: the response legitimately contains a new token that must not be redacted. */
  allowTokenInResponse?: boolean;
}

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Thin HTTP client for the admin/operator API. The token is only ever put in the Authorization header. */
export class Client {
  constructor(private opts: ClientOptions) {}

  get server() {
    return this.opts.server;
  }

  async request<T = any>(method: string, path: string, o: RequestOptions = {}): Promise<Reply<T>> {
    const url = new URL(path, this.opts.server);
    for (const [k, v] of Object.entries(o.query ?? {})) if (v !== undefined) url.searchParams.set(k, String(v));
    const retries = (o.retry ?? method === "GET") ? 2 : 0;
    const f = this.opts.fetchImpl ?? fetch;
    const sleep = this.opts.sleep ?? wait;
    let lastErr: CliError | null = null;
    for (let attempt = 0; attempt <= retries; attempt++) {
      if (attempt > 0) await sleep(300 * 2 ** (attempt - 1));
      try {
        const res = await f(url, {
          method,
          redirect: "error", // never forward the token to another origin
          headers: {
            authorization: `Bearer ${this.opts.token}`,
            accept: "application/json",
            "x-hired-gun-client": this.opts.clientTag ?? CLIENT_TAG,
            ...(o.body !== undefined ? { "content-type": "application/json" } : {}),
            ...o.headers,
          },
          body: o.body !== undefined ? JSON.stringify(o.body) : undefined,
          signal: AbortSignal.timeout(this.opts.timeoutMs ?? 30_000),
        });
        const text = await res.text();
        let json: any = null;
        try {
          json = text ? JSON.parse(text) : null;
        } catch {
          json = null;
        }
        if (res.ok) return { status: res.status, json: scrubValue(json, [this.opts.token], { pattern: !o.allowTokenInResponse }) as T, headers: res.headers };
        const retryAfter = Number(res.headers.get("retry-after")) || null;
        const err = fromHttp(res.status, scrubValue(json, [this.opts.token]), retryAfter);
        if (res.status >= 500 && attempt < retries) {
          lastErr = err;
          continue;
        }
        throw err;
      } catch (e) {
        if (e instanceof CliError) throw e;
        const msg = scrub(e instanceof Error ? `${e.name}: ${e.message}${(e as any).cause ? ` (${(e as any).cause.message ?? (e as any).cause})` : ""}` : String(e), [this.opts.token]);
        lastErr = new CliError("network", `cannot reach ${this.opts.server}: ${msg}`, {
          hint: "check the server URL and your connection",
        });
        if (attempt >= retries) throw lastErr;
      }
    }
    throw lastErr ?? new CliError("network", "request failed");
  }
}
