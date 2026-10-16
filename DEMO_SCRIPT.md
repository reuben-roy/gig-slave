# Hired Gun demo script (target 4:45, hard cap 5:00)

About 650 words of voiceover. At a relaxed pace that's around 4:30, which leaves room for pauses while things load.

**Before recording:**
- Server deployed on Vercel (or running locally behind `npm run tunnel` if self-hosting); dashboard open in the browser.
- The Desktop has a believable mess on it: screenshots, a `.dmg`, `Resume (1).pdf`, `Resume copy.pdf`, a folder called `New Folder 7`.
- Sessions for prompts 2 and 3 from `DEMO_PROMPTS.md` already created, so they show up on the dashboard.
- A Terminal window sized large, with a big font.
- **Do one full dry run of prompt 1 first** so you know how long it takes and what the report says. Cut the waiting in editing.

---

## 0:00 – 0:25 · Cold open: the phone call

**ON SCREEN:** Black screen, phone ringing sound. Caller ID: **"Dad 📞"**.

**DAD (voice, or you doing a Dad voice):**
> "Hello? The computer is saying it's full. Full of what? I didn't put anything in it."

**YOU (to camera, tired):**
> "Every tech person has had this call. The usual options are a forty-minute screen share where you say 'no, the *other* left click'… or driving over there."

**ON SCREEN:** Title card: **GIGAGENT** · *"remote tech support, without the remote part"*

---

## 0:25 – 0:50 · What it is

**ON SCREEN:** The dashboard.

**YOU:**
> "Hired Gun is option three. I type what needs doing on *my* screen. Dad types one command on *his*. An AI agent does the job on his Mac while I watch it live from here.
>
> It runs on a small, cheap model, so a whole job costs less than the phone call. And it has rules: it stays in one folder, never deletes anything, and writes down every move so the whole thing can be undone."

---

## 0:50 – 2:30 · Live demo: Dad's Desktop

**ON SCREEN:** Click **New invite**. Label: `Dad's Desktop`. Folder: `~/Desktop`. Paste prompt 1. Expiry: **one use**. Create.

**YOU:**
> "Here's the job: 'Make Dad a guide to what's on his Desktop.' It's one use, so the code dies after this."

**ON SCREEN:** The code appears, e.g. `ABCD-EFGH`. Copy it.

**YOU:**
> "I text him this code. That's the whole handover. No accounts, no app store, no 'what's your TeamViewer ID'."

**ON SCREEN:** Cut to the Terminal, which is now "Dad's Mac". Type `npx gigagent ABCD-EFGH`.

**YOU (Dad voice):**
> "It says 'Terminal would like to access your Desktop.' Is that a virus?"

**YOU (normal voice):**
> "It's not a virus, Dad. Click Allow."

**ON SCREEN:** Split screen: Dad's Terminal on the left, the dashboard on the right. Events stream in: `bash: ls -la`, `bash: du -sh`, the status line updating.

**YOU:**
> "On my side I can see everything it does, live: every command and every file it looks at. Dad's side just shows a friendly status line. He can go make tea."

**ON SCREEN:** While it's working, type into the **instructions** box: `Also gently suggest he stops saving everything to the Desktop.` Send.

**YOU:**
> "And I can send it extra instructions mid-job. Something I've been trying to tell my father for eleven years."

**ON SCREEN:** Fast-forward the wait in editing. The report appears on the dashboard. Open `Desktop Overview.md` on the "Dad" side and scroll: the summary line, the Biggest 5, "Looks like clutter".

**YOU:**
> "Done. It wrote him a plain-English guide: what's there, what's huge, and what's clutter. Including *two* copies of his résumé, which he last updated in 2014. The same report also landed in my email and Slack, so I didn't have to sit and stare at the dashboard."
>
> *(Read one real line from the generated report here; it will be funnier than anything scripted.)*

**ON SCREEN:** Run `npx gigagent ABCD-EFGH` again. It's rejected.

**YOU:**
> "Same code again? Dead. One use means one use."

---

## 2:30 – 3:20 · It's not just for Dad

**ON SCREEN:** Dashboard, scrolling to the two pre-made sessions.

**YOU:**
> "Dad's Desktop is the warm-up. Same idea, bigger jobs.
>
> **Disk full?** This one goes through Downloads, finds the forty-seven copies of the Zoom installer, and moves them into a 'Safe to Delete' folder with a note: 'this is 6 GB, drag it to the Trash.' Nothing actually gets deleted until a human says so.
>
> **New hire?** Priya starts Monday. Normally that's two hours of 'which Node version' and 'who has the API key'. This one checks every repo against what's installed on her laptop, creates her missing `.env` files, and hands her a checklist of exactly what's left. Secrets are listed by name only. It won't print your Stripe key into a log file. We checked."

*(Only keep "we checked" if you've actually run prompt 3 against a test folder.)*

---

## 3:20 – 4:15 · The firing bit

**ON SCREEN:** Dramatic zoom. Sad violin. A new invite form with the label typed slowly: `Kevin (former employee)`.

**YOU:**
> "Now. Sometimes you hire Priya… and sometimes you have to let Kevin go. And Kevin still has a company laptop and *opinions*.
>
> So naturally I thought: Hired Gun, axe Kevin's machine. Lock him out, encrypt the disk, wipe the—"

**ON SCREEN:** Freeze frame. Big red stamp: **"NOT IN v0."**

**YOU:**
> "—and that's when I remembered I built it to never delete anything, never use admin powers, and never leave one folder. Which is exactly what you want from something you run on your dad's computer.
>
> So Kevin's laptop is safe. For now. 'Offboarding mode' is on the roadmap, with a big confirmation button and a lawyer."

**ON SCREEN:** Go back to a running session (or start a quick one) and hover over the **Kill** button.

**YOU:**
> "What you *can* fire today is Hired Gun itself. If it ever does something you don't like…"

**ON SCREEN:** Click **Kill**. The session status changes to `killed` and the Terminal side shows it shutting down and cleaning up.

**YOU:**
> "…you're fired. It stops instantly, cleans up after itself and leaves no trace. Honestly, a better exit interview than Kevin's."

---

## 4:15 – 4:45 · Cost and close

**ON SCREEN:** The dashboard session row with token counts. Zoom in on them.

**YOU:**
> "Total cost of fixing Dad's computer: [read the real number off the dashboard]. The phone call alone would have cost me forty minutes and a small piece of my soul.
>
> Hired Gun. Write the job, send the code, go make tea."

**ON SCREEN:** End card: **`npx gigagent`**, plus the GitHub link if it's public by then.

**DAD (voice, offscreen):**
> "…Hello? How do I get the old Desktop back?"

**YOU (to camera):**
> "There's an undo file, Dad."

**CUT.**

---

## If you're running long, cut in this order
1. The mid-job instruction (saves ~15s).
2. The second `npx` rejection (saves ~10s).
3. Shrink the "not just for Dad" section to one line per use case (saves ~20s).

Keep the cold open and the Kevin bit: they're what people will remember.
