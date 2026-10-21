export interface Result {
  success: boolean;
  summary: string;
  answer: string | null;
  findings: { label: string; value: string }[];
  changes: string[];
}

export interface Machine {
  hostname: string;
  platform: string;
  release: string;
  arch: string;
  username: string;
}

export interface RedeemResult {
  session_id: string;
  session_token: string;
  task: string;
  working_dir: string;
  model: string;
  v1_base_url: string;
  heartbeat_ms: number;
}

export interface AgentEvent {
  ts: number;
  type: "status" | "tool_call" | "tool_result" | "assistant" | "error";
  data: Record<string, unknown>;
}

export interface HeartbeatResult {
  kill: boolean;
  instructions: { id: string; text: string }[];
}

/** Thrown when the server could not be reached at all. */
export class NetworkError extends Error {}

/** Thrown when the server answered with a non-2xx status. */
export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export class ApiClient {
  token: string | null = null;

  constructor(readonly baseUrl: string) {}

  private async post<T>(path: string, body: unknown, timeoutMs = 10_000): Promise<T> {
    let res: Response;
    try {
      res = await fetch(this.baseUrl + path, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      throw new NetworkError(err instanceof Error ? err.message : String(err));
    }
    const text = await res.text().catch(() => "");
    let json: any = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      // non-JSON body
    }
    if (!res.ok) {
      const msg = typeof json?.error === "string" ? json.error : json?.error?.message ?? `HTTP ${res.status}`;
      throw new HttpError(res.status, msg);
    }
    return json as T;
  }

  redeem(code: string, machine: Machine, cliVersion: string): Promise<RedeemResult> {
    return this.post("/agent/redeem", { code, machine, cli_version: cliVersion });
  }

  events(events: AgentEvent[]): Promise<unknown> {
    return this.post("/agent/events", { events });
  }

  heartbeat(status: string, statusText: string): Promise<HeartbeatResult> {
    return this.post("/agent/heartbeat", { status, status_text: statusText });
  }

  complete(success: boolean, report: string, result: Result | null = null, timeoutMs = 10_000): Promise<unknown> {
    return this.post("/agent/complete", { success, report, result }, timeoutMs);
  }
}
