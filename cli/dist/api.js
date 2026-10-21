/** Thrown when the server could not be reached at all. */
export class NetworkError extends Error {
}
/** Thrown when the server answered with a non-2xx status. */
export class HttpError extends Error {
    status;
    constructor(status, message) {
        super(message);
        this.status = status;
    }
}
export class ApiClient {
    baseUrl;
    token = null;
    constructor(baseUrl) {
        this.baseUrl = baseUrl;
    }
    async post(path, body, timeoutMs = 10_000) {
        let res;
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
        }
        catch (err) {
            throw new NetworkError(err instanceof Error ? err.message : String(err));
        }
        const text = await res.text().catch(() => "");
        let json = null;
        try {
            json = text ? JSON.parse(text) : null;
        }
        catch {
            // non-JSON body
        }
        if (!res.ok) {
            const msg = typeof json?.error === "string" ? json.error : json?.error?.message ?? `HTTP ${res.status}`;
            throw new HttpError(res.status, msg);
        }
        return json;
    }
    redeem(code, machine, cliVersion) {
        return this.post("/agent/redeem", { code, machine, cli_version: cliVersion });
    }
    events(events) {
        return this.post("/agent/events", { events });
    }
    heartbeat(status, statusText) {
        return this.post("/agent/heartbeat", { status, status_text: statusText });
    }
    complete(success, report, result = null, timeoutMs = 10_000) {
        return this.post("/agent/complete", { success, report, result }, timeoutMs);
    }
}
