/** Buffers events in memory and ships them in batches; keeps them on failure. */
export class EventBuffer {
    api;
    buf = [];
    timer = null;
    flushing = null;
    constructor(api) {
        this.api = api;
    }
    push(type, data) {
        this.buf.push({ ts: Date.now(), type, data });
    }
    start(intervalMs = 1000) {
        this.timer = setInterval(() => void this.flush(), intervalMs);
        this.timer.unref();
    }
    stop() {
        if (this.timer)
            clearInterval(this.timer);
        this.timer = null;
    }
    /** Returns true if everything buffered was delivered. */
    flush() {
        const run = async () => {
            if (this.flushing)
                await this.flushing;
            if (this.buf.length === 0)
                return true;
            const batch = this.buf.splice(0, this.buf.length);
            const p = this.api.events(batch).then(() => undefined, () => {
                this.buf.unshift(...batch);
            });
            this.flushing = p;
            await p;
            this.flushing = null;
            return this.buf.length === 0;
        };
        return run();
    }
}
