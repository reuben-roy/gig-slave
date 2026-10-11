import type { AgentEvent, ApiClient } from "./api.js";

/** Buffers events in memory and ships them in batches; keeps them on failure. */
export class EventBuffer {
  private buf: AgentEvent[] = [];
  private timer: NodeJS.Timeout | null = null;
  private flushing: Promise<void> | null = null;

  constructor(private api: ApiClient) {}

  push(type: AgentEvent["type"], data: Record<string, unknown>): void {
    this.buf.push({ ts: Date.now(), type, data });
  }

  start(intervalMs = 1000): void {
    this.timer = setInterval(() => void this.flush(), intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Returns true if everything buffered was delivered. */
  flush(): Promise<boolean> {
    const run = async (): Promise<boolean> => {
      if (this.flushing) await this.flushing;
      if (this.buf.length === 0) return true;
      const batch = this.buf.splice(0, this.buf.length);
      const p = this.api.events(batch).then(
        () => undefined,
        () => {
          this.buf.unshift(...batch);
        },
      );
      this.flushing = p;
      await p;
      this.flushing = null;
      return this.buf.length === 0;
    };
    return run();
  }
}
