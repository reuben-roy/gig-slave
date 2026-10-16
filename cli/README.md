# gigagent

Someone sent you a GigAgent code? Open **Terminal** and paste:

```
npx gigagent ABCD-EFGH
```

(using your code). A helper does the one job you were asked about on this Mac while the person who sent the code watches. When it's done it shows you a short summary, sends a report back to them, and removes itself.

## What you need

- A Mac.
- Node.js 22 or newer. If Terminal says `command not found: npx`, or GigAgent says your Node.js is too old, install the free LTS version from [nodejs.org](https://nodejs.org) and run the command again.

## What it does and doesn't do

- It only connects with a code from someone who created a job for you, and the code usually works once.
- The AI key stays on the GigAgent server; this Mac only gets a short-lived session token. The sender can stop the helper at any time.
- The helper is instructed to change things only inside the folder the job names, to move files instead of deleting them (every move is recorded in `.gigagent-undo.json` in that folder), and not to use sudo, install software or go online. These are instructions to the agent; the sender sees every command it runs.
- Press **Ctrl+C** to stop it yourself. It cleans up its temporary files when it exits.

Learn more at [gigagent-beta.vercel.app](https://gigagent-beta.vercel.app).
