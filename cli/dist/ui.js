const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
function fmtElapsed(ms) {
    const s = Math.floor(ms / 1000);
    const m = Math.floor(s / 60);
    return m > 0 ? `${m}m ${String(s % 60).padStart(2, "0")}s` : `${s}s`;
}
function truncate(s, n) {
    s = s.replace(/\s+/g, " ").trim();
    return s.length > n ? s.slice(0, n - 1) + "…" : s;
}
export class StatusUi {
    getState;
    tty = Boolean(process.stdout.isTTY);
    timer = null;
    frame = 0;
    lineShown = false;
    lastPlain = "";
    constructor(getState) {
        this.getState = getState;
    }
    get interactive() {
        return this.tty;
    }
    header() {
        console.log(this.tty ? "\n  \x1b[1mgig-slave\x1b[0m · remote helper\n" : "gig-slave · remote helper");
    }
    /** Print a permanent line (clears the live line first). */
    say(text) {
        this.clearLine();
        console.log(text);
    }
    connected(task) {
        const first = task.split("\n")[0] ?? "";
        this.say(`✓ Connected — task: ${truncate(first, 70)}`);
    }
    start() {
        if (this.tty) {
            this.timer = setInterval(() => this.render(), 100);
            this.timer.unref();
            this.render();
        }
    }
    /** Call when the state changes; only used in non-TTY mode for plain log lines. */
    changed() {
        if (this.tty)
            return;
        const s = this.getState();
        const line = s.online ? s.statusText : "reconnecting…";
        if (line !== this.lastPlain) {
            this.lastPlain = line;
            console.log(`[gig-slave] ${line}`);
        }
    }
    stop() {
        if (this.timer)
            clearInterval(this.timer);
        this.timer = null;
        this.clearLine();
    }
    clearLine() {
        if (this.tty && this.lineShown) {
            process.stdout.write("\r\x1b[2K");
            this.lineShown = false;
        }
    }
    render() {
        const s = this.getState();
        const cols = process.stdout.columns || 80;
        const tail = s.online ? `● online · ${fmtElapsed(Date.now() - s.startedAt)} · ${s.actions} actions` : "● reconnecting…";
        const head = `${FRAMES[this.frame++ % FRAMES.length]} `;
        const room = Math.max(10, cols - head.length - tail.length - 4);
        const text = truncate(s.statusText || "Working…", room);
        const pad = " ".repeat(Math.max(2, room - text.length + 2));
        process.stdout.write(`\r\x1b[2K${head}${text}${pad}\x1b[2m${tail}\x1b[0m`);
        this.lineShown = true;
    }
}
