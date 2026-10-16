# Demo prompts

Three tasks to paste into the dashboard's "New invite" form. All of them fit the v0 safety rules in `SYSTEM_PROMPT` (`cli/src/agent.ts`): stay in the working folder, never delete (only move), no sudo, no installs, no network.

The agent's system prompt already covers the undo file, the plain-English summary, the structured report it submits at the end (summary, answer, findings, changes) and "don't ask questions", so the task text doesn't repeat those.

---

## 1. Desktop Overview (run this one live on your own Mac)

Only change: one new file. Nothing is moved, renamed or deleted, so it is safe on your real Desktop.

- **Label:** Dad's Desktop
- **Working folder:** `~/Desktop`
- **Model:** `anthropic/claude-haiku-5.5` (default)
- **Expiry:** `one_use`

```
My Desktop has got messy and I don't know what is on it. Please make me a simple guide to it.

Look at everything directly on the Desktop (skip hidden files and .DS_Store, and don't look inside app bundles). Then create ONE new file called "Desktop Overview.md" on the Desktop containing:

1. A one-sentence summary, such as "You have 41 files and 6 folders, taking up 2.3 GB in total."
2. A table of everything, grouped by kind: Documents, Photos and Screenshots, Installers, Archives, Folders, Other. For each item show its name, its size in plain units (KB, MB or GB) and the date it was last changed (like "12 March 2026").
3. "Biggest 5 things": the five largest items and their sizes.
4. "Looks like clutter": things that are probably not needed any more (installers, duplicates with names like "copy" or "(1)", screenshots older than 30 days, anything untouched for 6 months). Give each a short reason.
5. "Suggested tidy-up": 3 to 5 friendly suggestions in plain language, such as "Make a folder called Screenshots and put the 23 screenshots in it."

Write it for someone who is not technical. Do not move, rename, edit or delete anything. The only change allowed is creating "Desktop Overview.md".
```

---

## 2. Downloads Rescue (create the session, don't run it)

Frees disk space without deleting anything: junk gets moved into a "Safe to Delete" folder for a human to glance at and trash.

- **Label:** Disk space rescue
- **Working folder:** `~/Downloads`
- **Model:** `anthropic/claude-haiku-5.5` (default)
- **Expiry:** `on_complete`

```
This Mac is nearly out of disk space and the Downloads folder is probably the main reason. Please find what can safely be cleared out, WITHOUT deleting anything.

Create a folder called "Safe to Delete - Review First" in this folder, with three subfolders: "Installers", "Duplicates" and "Old Zips". Then move these things (and only these) into them:

- Installers: .dmg and .pkg files that are older than 7 days.
- Duplicates: files whose names end in " (1)", " (2)", " copy" and so on, where the original file with the same name and the same size also exists.
- Old Zips: .zip files older than 30 days where a folder with the same name (without .zip) already exists next to them, meaning it was already unpacked.

Leave everything else exactly where it is: documents, PDFs, photos, spreadsheets, folders, and anything changed in the last 7 days.

Work out the size of everything you moved. Inside "Safe to Delete - Review First", create a note called "What I found.md" with a table of each moved file (name, size, why it was moved), the total space it takes up, and one line explaining how to get that space back: "Look through this folder, then drag it to the Trash and empty the Trash." If nothing qualifies, say so honestly in the report rather than moving unrelated things.

In your report, tell me roughly how many GB can be freed.
```

---

## 3. Day-One Workstation Check (create the session, don't run it)

The "new hire joins and the setup takes two hours" story. The agent audits every project against what the machine actually has, fixes the missing `.env` files, and writes down exactly what is left for a human. It can't install software or fetch secrets under the v0 rules, so it doesn't pretend to: it produces the shortest possible to-do list.

- **Label:** New hire: Priya's MacBook
- **Working folder:** `~/Work` (or wherever the repos live)
- **Model:** `anthropic/claude-sonnet-5.5` (more careful on a multi-step job)
- **Expiry:** `ttl`, 24 hours

```
A new teammate has just joined and this is their laptop. The project folders in here are their code repositories. Check whether the laptop is ready to work on them, and fix what you safely can.

Step 1 – Find the projects. Each folder directly inside this one that contains a ".git" folder is a project.

Step 2 – For each project, work out which tools it needs by looking at files such as README.md, package.json, .nvmrc, .node-version, .python-version, .tool-versions, requirements.txt, pyproject.toml, Gemfile and go.mod. Then check what is installed on this Mac using read-only version checks (for example "node -v", "python3 --version", "git --version", "command -v brew"). Note any tool that is missing or is the wrong version.

Step 3 – Environment variables. For each project that has a ".env.example":
- If there is no ".env", create it by copying ".env.example" (use cp -n so nothing is ever overwritten).
- If a ".env" already exists, do not edit it. Instead compare it with ".env.example" and look for: keys that are missing, keys with empty values, placeholder values such as "changeme", "your-key-here" or "xxx", extra spaces or quotes around "=", duplicate keys, and Windows line endings.
- NEVER write any secret value into your notes or report. Mention variables by name only.

Step 4 – Write ONE new file in this folder called "SETUP-CHECKLIST.md" with:
- A table with one row per project: project name, tools OK or not, .env OK or not (a plain word such as Ready, Needs attention or Blocked).
- "Fixed by Hired Gun": the exact files you created.
- "Needs a human": a numbered to-do list in the order it should be done. Include the exact command for each missing tool (for example "brew install node@20") written as text only, and the names of any secrets that still need real values and who is probably the right person to ask.

Do not install anything, do not run git pull or git fetch or any network command, do not change any file other than creating the new files described above, and do not open or print the contents of any .env file beyond what you need to compare key names.
```

---

## What these deliberately don't do

The offboarding idea (lock out a fired employee, encrypt the disk) and a full environment setup (clone repos, install toolchains, fill in secrets) need things v0 forbids: sudo, installs, network access and acting outside one folder. Those would need a separate "trusted operator" mode with a different system prompt and an explicit confirmation step before the CLI runs it. That belongs in the pitch as "where this goes next", not in a live demo.
