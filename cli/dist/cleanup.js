import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
export function ownNpxDir() {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const parts = here.split(path.sep);
    const i = parts.lastIndexOf("_npx");
    if (i === -1 || i + 1 >= parts.length)
        return null;
    return parts.slice(0, i + 2).join(path.sep);
}
export class Cleanup {
    tasks = [];
    done = false;
    tmpDirs = [];
    add(task) {
        this.tasks.push(task);
    }
    /** Idempotent. Returns true the first time it actually runs. */
    run() {
        if (this.done)
            return false;
        this.done = true;
        for (const t of this.tasks) {
            try {
                t();
            }
            catch {
                // best effort
            }
        }
        for (const d of this.tmpDirs) {
            try {
                fs.rmSync(d, { recursive: true, force: true });
            }
            catch {
                // best effort
            }
        }
        const npx = ownNpxDir();
        if (npx) {
            try {
                fs.rmSync(npx, { recursive: true, force: true });
            }
            catch {
                // best effort
            }
        }
        return true;
    }
}
