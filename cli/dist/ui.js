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
function wrap(text, width) {
    if (!text)
        return [""];
    const out = [];
    for (const para of text.split("\n")) {
        if (!para.trim()) {
            out.push("");
            continue;
        }
        let line = "";
        for (const word of para.split(/\s+/).filter(Boolean)) {
            if (line && line.length + 1 + word.length > width) {
                out.push(line);
                line = "";
            }
            line = line ? `${line} ${word}` : word;
            while (line.length > width) {
                out.push(line.slice(0, width));
                line = line.slice(width);
            }
        }
        if (line)
            out.push(line);
    }
    return out;
}
export class StatusUi {
    getState;
    tty = Boolean(process.stdout.isTTY);
    color = this.tty && !process.env.NO_COLOR && process.env.TERM !== "dumb";
    color256 = this.color && /256color|truecolor|24bit/i.test(`${process.env.TERM ?? ""} ${process.env.COLORTERM ?? ""}`);
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
    paint(codes, text) {
        return this.color ? `\x1b[${codes}m${text}\x1b[0m` : text;
    }
    bold = (t) => this.paint("1", t);
    dim = (t) => this.paint("2", t);
    cyan = (t) => this.paint("36", t);
    /** Brand accent: 256-colour brass where supported, plain yellow otherwise. */
    brass = (t) => this.paint(this.color256 ? "38;5;214;1" : "33;1", t);
    green = (t) => this.paint("32;1", t);
    red = (t) => this.paint("31;1", t);
    yellow = (t) => this.paint("33", t);
    /** Text for the one question we ever ask. */
    get codePrompt() {
        return `  ${this.bold("Enter your code")} ${this.dim("(it looks like ABCD-EFGH)")}\n  ${this.brass("›")} `;
    }
    header() {
        if (!this.tty) {
            console.log("Hired Gun - a helper sent by someone you trust. It does one job on this Mac, then leaves.");
            return;
        }
        console.log(`\n  ${this.brass("★")} ${this.bold("Hired Gun")}\n  ${this.dim("A helper sent by someone you trust. It does one job on this Mac, then leaves.")}\n`);
    }
    /** Print a permanent line (clears the live line first). */
    say(text) {
        this.clearLine();
        console.log(text);
    }
    warn(text) {
        this.say(`${this.tty ? "  " : ""}${this.yellow("!")} ${text}`);
    }
    error(text) {
        this.say(`${this.tty ? "  " : ""}${this.red("✗")} ${text}`);
    }
    connected(task) {
        const first = task.split("\n")[0] ?? "";
        this.say(`${this.tty ? "  " : ""}${this.green("✓")} Connected. ${this.dim("Job:")} ${truncate(first, 70)}`);
        if (this.tty)
            console.log(`  ${this.dim("Working now. Leave this window open, and press Ctrl+C to stop it at any time.")}\n`);
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
            console.log(`[hired-gun] ${line}`);
        }
    }
    stop() {
        if (this.timer)
            clearInterval(this.timer);
        this.timer = null;
        this.clearLine();
    }
    /** A clear boxed ending: result, plain-English summary, and the self-removal line. */
    finalBox(info) {
        this.clearLine();
        if (!this.tty) {
            console.log(`${info.ok ? "OK" : "FAILED"}: ${info.title}`);
            for (const l of info.lines)
                if (l)
                    console.log(l);
            return;
        }
        const cols = process.stdout.columns || 80;
        const inner = Math.max(30, Math.min(68, cols - 8));
        const body = info.lines.flatMap((l) => wrap(l, inner));
        const mark = info.ok ? "✓" : "✗";
        const title = ` ${mark} ${info.title} `;
        const paint = info.ok ? this.green : this.red;
        const edge = (t) => (info.ok ? this.paint("32", t) : this.paint("31", t));
        const top = edge("╭─") + paint(title) + edge("─".repeat(Math.max(1, inner + 2 - title.length - 1)) + "╮");
        console.log(`\n  ${top}`);
        console.log(`  ${edge("│")}${" ".repeat(inner + 2)}${edge("│")}`);
        for (const l of body)
            console.log(`  ${edge("│")} ${l.padEnd(inner)} ${edge("│")}`);
        console.log(`  ${edge("│")}${" ".repeat(inner + 2)}${edge("│")}`);
        console.log(`  ${edge("╰" + "─".repeat(inner + 2) + "╯")}\n`);
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
        const n = s.actions;
        const tailPlain = s.online
            ? `${fmtElapsed(Date.now() - s.startedAt)} · ${n} ${n === 1 ? "action" : "actions"}`
            : "reconnecting…";
        const head = FRAMES[this.frame++ % FRAMES.length];
        const room = Math.max(10, cols - head.length - tailPlain.length - 6);
        const text = truncate(s.statusText || "Working…", room);
        const pad = " ".repeat(Math.max(2, room - text.length + 2));
        const tail = s.online ? this.dim(tailPlain) : this.yellow(tailPlain);
        process.stdout.write(`\r\x1b[2K  ${this.brass(head)} ${text}${pad}${tail}`);
        this.lineShown = true;
    }
}
