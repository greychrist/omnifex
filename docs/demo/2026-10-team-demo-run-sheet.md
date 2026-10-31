# OmniFex team demo — run sheet

30 minutes, live, mixed room (execs, devs, support/ops/PMs). OmniFex is the
stage; Claude Code is the subject.

Placeholders, filled in during prep: `PI-A` / `PI-B` (ticket keys),
`<pi-repo>` (Pi-tuitive checkout), `<base>` (base branch), `<label …>`
(the labels being changed).

## The three messages

| Audience | Message | Proof on screen |
|---|---|---|
| Support (PMs, ops) | Claude Code isn't only for code | `/mac-health` reading system logs; `/jira-review`, `/timesheet` doing process work — read in Modern, like a conversation |
| Devs | Skills encode your process; worktrees run tickets in parallel | PI-A + PI-B: Jira → worktree + environment → label change → merge, teardown, Jira updated — read in Verbose, every step |
| Execs | Many concurrent streams, visible spend, isolated accounts | Six live tabs, Cost Report, Brain, work vs personal accounts |

**The through-line:** one transcript, four lenses. The same session reads as
a conversation for a PM (Modern) and as a full audit trail for a dev
(Verbose / All). Switching costs one click.

## Run of show

| Clock | Segment | Do | Point at |
|---|---|---|---|
| 0:00 | Intro (90s) | Two lines, no slides (see Script) | The app, already open, no tabs running |
| 1:30 | Launch (2 min) | Open six tabs (see Tab plan), fire each command | Account-coloured tab glyphs; Modern trace building live; Sessions popover |
| 3:30 | Execs (5.5 min) | Talk while tabs run | Cost Report; Test Account Resolution; Brain stats |
| 9:00 | Support (6 min) | Follow the pings into finished tabs | `/mac-health`, `/jira-review`, `/timesheet` in Modern; flip one to Verbose |
| 15:00 | Devs (9 min) | Change the labels, before/after, resolve both | Verbose steps; context rail; status bar; permission cards; two localhost ports; Jira |
| 24:00 | Remote (3 min) | Browser beside the app; prompt in one, watch the other | Status-bar daemon readout; Sessions popover "Open in App / Open in Browser" |
| 27:00 | Q&A | | Leave Sessions popover open |

## Tab plan (fire in this order at 1:30)

Slowest first, so they finish in segment order.

| # | Project | Account | Command | Done by ~ | Shown in |
|---|---|---|---|---|---|
| 1 | `<pi-repo>` | Work | `/work-on-ticket PI-A` | ? (dry-run) | Devs |
| 2 | `<pi-repo>` | Work | `/work-on-ticket PI-B` | ? (dry-run) | Devs |
| 3 | `~/Repos/work/management` | Work | `/jira-review` | ? | Support |
| 4 | `~/Repos/work/management` | Work | `/timesheet this` (no `write` — draft only) | ? | Support |
| 5 | any personal project | **Personal** | `/mac-health quick` | ~3 min | Support |
| 6 | spare | — | held for live questions / Remote segment | — | Remote |

Tab 5 is the only personal-account tab — it is the account-isolation proof.

Cmd+T opens a tab with the project list → "Launch". Typing `/` opens the
"Slash Commands" picker — let the room see the autocomplete once.

## Script

### 0:00 Intro (90s)

- "Claude Code is an agent that reads, runs and changes things on a computer —
  driven by plain English and by written procedures we call **skills**."
- "OmniFex is a Mac app I built on top of it: many of those agents on one
  screen, with their insides made visible."
- "Everything you'll see is live. I'm going to start six jobs now and talk
  while they run."

### 1:30 Launch

- Fire tabs 1–6. Call out as you go: two Pi-tuitive tickets (dev), two
  work-process skills (support), one Mac log check on my personal account
  (support + exec).
- Stay on tab 5 (`/mac-health`) for ~20 seconds, in **Modern**:
  - The skill folds into its own step, in the skill's card colours.
  - "Thinking" streams live, then settles to "Thought for 5s".
  - Work folds into one line — "Worked in 5 steps · 32s" — with a status
    chip per step.
  - "This is what Claude is doing, without the noise."
- Open the title-bar **Sessions** popover: one card per session, status pill,
  context gauge, "N agents". "Six jobs, one pane."

### 3:30 Execs — concurrency, cost, isolation, memory

1. **Cost Report** (title bar → Cost).
   - Date range: last 30 days. "Spend over time" → the heaviest days.
   - "By project" and "Most expensive sessions" — what the work cost, per stream.
   - "Main loop vs subagents" and "Caching ROI" — where money goes and what
     caching saves.
   - PDF export button: "this is what goes in a monthly report."
   - Per-account usage: shown separately from Claude's own usage report.
2. **Account isolation** (Settings → Accounts).
   - "Path Rules": `~/Repos/personal/` → Personal, work repos → Work.
   - **Test Account Resolution**: paste `<pi-repo>`, then a personal repo —
     two different accounts. Point back at the tab glyphs: tab 5's colour
     differs from the rest.
3. **Brain** (title bar → Brain).
   - "Notes in vault", "Cost of one recall", "Spent indexing".
   - Message: "Every session's lessons are distilled into notes the next
     session reads, so we stop paying to rediscover the same thing."
   - Search the vault for one term the room knows.
- Pings will start arriving here. Acknowledge them ("that's the Mac check
  finishing") and keep going — they cue the next segment.

### 9:00 Support — not just for code

1. **`/mac-health` tab** (tab glyph shows Completed), in Modern.
   - "No code here. It read a day of macOS logs, crash reports and power
     events and wrote this."
   - Ops tie-in: "same pattern for install logs, upgrade checks, a customer's
     support bundle."
2. **`/jira-review` tab**: the prioritised digest (🔴 / 🟡 / ✅).
   - "A PM's morning triage, as one command. It cross-checks Jira against
     merged PRs so 'shipped but still open' surfaces on its own."
3. **`/timesheet` tab**: the drafted week from calendar + commits.
   - "Drafted, not written. The skill only writes when I say `write`. Humans
     stay in the loop on anything that leaves the building."
4. **Four lenses** — on the `/jira-review` tab, use the chat-format switch
   beside the composer:
   - **Modern** → **Compact** → **Verbose** → **All**, then back to Modern.
   - Verbose: every Jira query and PR lookup it ran. All: even the records
     normally hidden.
   - Open one Modern step: "Ran <command>", the result, hover → copy / raw JSON.
   - "A PM reads the answer; a dev audits every step. Same session, one click."
   - Optional (cut first): Settings → Chats → Message kinds — recolour one
     kind live.

### 15:00 Devs — skills that run the process

1. **PI-A tab**: point at the report — ticket summary, worktree path,
   branch, base, live URL; Jira moved to In Progress.
2. **PI-B tab**: same, different port. Open both URLs side by side on the
   screens with the labels. "Two tickets, two isolated environments, one
   checkout, no collisions."
3. Switch both tabs to **Verbose**. In each: **"Do the ticket, then /commit."**
   - While it runs, the per-session **status bar**: `turn`, `thinking`,
     `agents`, `cache … left`, `session … (16%)`.
   - **Context rail** (bottom-left toggle, "Show context timeline"): the
     gutter shows how much of Claude's working memory each turn used, with
     level badges. "This is why long sessions get compacted."
   - If a **permission card** appears: "Allow once / Allow for Session / Deny
     — and the Rule field shows exactly what you're granting."
4. Reload both browser windows: **before → after** on each label.
5. In one tab: **`/resolve-ticket PI-A PI-B`**.
   - Narrate the report: merge into `<base>`, push, worktrees + environments
     torn down, Jira comment posted, status moved.
6. Open Jira on both tickets: Claude's comment, the status change.
   - "Everything a ticket needs to touch — git, environment, Jira — in two
     commands."

### 24:00 Remote — on-machine and anywhere

1. In any tab's status bar, click the **`daemon live`** readout: Version,
   Address, Clients, Sessions, Uptime.
   - "The app is a window. The work runs in a background service."
2. Browser (pre-opened at that Address) beside the app.
   - Same tabs, same transcripts, same chat formats.
3. Open the **Sessions** popover in each: rows read **Open Here / Open in
   App / Open in Browser**.
4. Type a prompt in tab 6 **in the browser**; watch it stream in the app.
   - "Same thing on an iPad — I start work at my desk and check it from the
     couch. Closing one window doesn't stop the work."

## Prep (do the Pi-tuitive items from a claude-work session)

### Before the dry run

- [ ] Confirm Pi-tuitive has `/work-on-ticket` and `/resolve-ticket`
      equivalents (ticket → worktree + environment → git + Jira wrap-up).
      Build or adapt them if not.
- [ ] Pick the two labels — **on different screens/files**, so merging both
      into `<base>` cannot conflict. Note where each appears in the running
      app.

### The day before

- [ ] Full timed dry run of the Tab plan, on throwaway tickets; fill in the
      "Done by" column. Reorder if the Pi-tuitive tickets aren't ready by 15:00.
- [ ] Skim one `/mac-health quick` and one `/jira-review` output for anything
      not for this room — in **All**, not just Modern; All shows everything.
- [ ] Note which Modern step in `/jira-review` is the best one to open.

### 30 minutes before

- [ ] Settings → General → **Default chat format: Modern**.
- [ ] Create the two demo tickets (see Demo tickets), To Do. Put their keys
      into the Tab plan in place of PI-A / PI-B.
- [ ] Rate-limit headroom on **both** accounts (account card meters):
      < 50% of the 5-hour window. The work account carries five of the six
      tabs.
- [ ] Settings → General → Notifications: sounds on; Play test sound.
- [ ] Whatever Pi-tuitive's environment needs (Docker etc.) is running.
- [ ] Status-bar daemon readout green; browser tab open at its Address;
      reload once.
- [ ] Jira open on both demo tickets in a browser tab.
- [ ] Close every OmniFex tab except one empty one.
- [ ] Meeting: share with **computer audio** so the room hears completion
      sounds.

## Demo tickets

**PI-A — Change label `<label A old>` to `<label A new>`**

> On `<screen A>`, the label `<label A old>` should read `<label A new>`.
>
> Acceptance criteria
> - `<screen A>` shows `<label A new>`.
> - No other labels or behaviour change.

**PI-B** — same shape, `<screen B>` / `<label B old>` → `<label B new>`.

If `/work-on-ticket` asks which base branch, answer and say aloud that a
skill asking when it's unsure is the design, not a failure.

## When things go wrong

| Symptom | Line | Action |
|---|---|---|
| A tab is slow | "Real work takes real time — that's why we started it first." | Move on; come back later. |
| A turn wanders | "Watch me steer it." | Stop it, give a one-line correction. |
| Environments not up by 15:00 | "Still building — let's look at what it's done so far." | Show the report so far; resolve whichever is ready. |
| Label didn't change on reload | "Hot reload hasn't picked it up." | Hard-reload; or show the diff in Verbose instead. |
| `/resolve-ticket` stops | "It refuses to close a ticket it can't account for — by design." | Read its reason aloud; fix and rerun. |
| A format switch shows a skeleton | "It's re-drawing a long session." | Wait a beat; it fills in. |
| No sound heard by room | | Ignore; point at the tab badge instead. |
| Rate-limited | "Even agents have quotas — here's the meter." | Show the account card; switch to a finished tab. |

## Cut order if running long

1. Settings → Chats recolour (already optional).
2. Four lenses → Modern ↔ Verbose only.
3. Brain → one stat ("Cost of one recall").
4. Tab 6 spare.
5. Remote — never cut; it's the closer.
