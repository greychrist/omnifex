<div align="center">
  <img src="icons/icon.png" alt="OmniFex Logo" width="120" height="120">

  <h1>OmniFex</h1>

  <p>
    <strong>A desktop GUI for Claude Code with first-class multi-account support.</strong>
  </p>
  <p>
    Route projects to specific accounts, run interactive Claude Code sessions in a rich chat
    or full terminal view, manage MCP servers, slash commands, hooks and permissions, and
    track token usage and rate limits — all without leaving the app. Then give Claude a
    persistent, searchable memory of everything you have already worked out.
  </p>
</div>

> [!NOTE]
> This project is not affiliated with, endorsed by, or sponsored by Anthropic. Claude is a trademark of Anthropic, PBC. This is an independent project that drives the Claude Code CLI you install yourself.
>
> OmniFex is a long-running fork of [opcode](https://github.com/getAsterisk/opcode) by Asterisk, licensed under AGPL-3.0. It has since been rewritten on Electron and reshaped around multi-account workflows; little of the original Tauri/Rust codebase remains.

## Status

OmniFex is **macOS (Apple Silicon) only**. Builds are signed with a Developer ID and notarized by Apple, so they open normally — no Gatekeeper right-click dance.

The app drives the **Claude Code CLI** directly (`child_process` with structured streaming), so a working, authenticated Claude Code install is required. OmniFex bundles no model of its own.

## Features

### The Brain — persistent memory across sessions

A new Claude Code session starts knowing nothing about why your code is shaped the way it is, what you already tried, or what broke last time. Its built-in auto-memory helps, but is scoped to the repo you are currently sitting in. Your transcripts hold the rest of the answers, and in practice they are write-only — nobody reopens a `.jsonl` file.

The Brain is a per-account **memory vault** distilled from those transcripts.

- **Distilled, not archived.** Finished sessions, repo instruction files (`CLAUDE.md`, `AGENTS.md`), and Claude Code's own auto-memory are condensed into short Markdown notes — the decisions, the constraints, and the gotchas that cost real time — instead of being stored as raw transcripts.
- **Queryable mid-session.** The vault is exposed to the CLI as an MCP server, so Claude searches it on its own initiative (`brain_search`, `brain_read`) and can save durable facts back (`brain_remember`). A `/recall` dialog and a Brain tab give you the same view by hand.
- **Cross-project by design.** One vault spans every project under an account, so a constraint learned in one repo surfaces while you are working in another — the thing per-repo memory structurally cannot do.
- **Plain Markdown you own.** Notes live in `~/OmniFex Brain/<account>/`, git-versioned, deliberately outside app storage so they open in Obsidian and back up normally — and deliberately outside `~/Documents` and `~/Desktop`, which iCloud Drive can evict to placeholder stubs. The search index is derived and disposable; delete it and it rebuilds.
- **Per-account isolation.** Each account gets its own vault, enforced by the MCP server's process environment rather than by a query filter — a work vault is not reachable from a personal session, by construction.
- **Auxiliary by contract.** Indexing is throttled, never touches a transcript that is still being written to, and never blocks the UI. A failed item never blocks the queue. Every model call it makes is recorded in an append-only cost ledger you can read in the app.
- **No note is auto-injected.** The Brain never stuffs its contents into your prompts — a note costs context only when something actually asks it a question. What every session does get is a few lines saying how many notes exist for the project you are in and when consulting them is worth it, because a memory nothing remembers to open is not a memory.

### Multi-account routing
- Bind projects to specific Claude accounts using path-prefix rules, with **longest-match-wins** resolution and explicit per-project overrides.
- Auto-discover existing accounts on your machine and scan for new ones.
- Every session, agent, hook, MCP call, usage read, and CLAUDE.md edit runs under the resolved account's `CLAUDE_CONFIG_DIR`.
- An account-resolution explainer shows exactly why a given project maps to a given account.

### Interactive sessions
- A structured **rich chat** (streaming JSON) with tool-call widgets, backed by the real CLI.
- Live controls, changeable mid-session: **model picker**, **reasoning effort** (low → max), and **permission mode** (default / acceptEdits / bypassPermissions / plan) read out on the session status bar and open their pickers from there, plus **extended-thinking** config.
- **Slash-command picker** (`/`) plus per-session command discovery.
- **Subagent tracking** — subagent runs are surfaced inline with their model and authoritative end-of-run stats (duration, tokens, tool count).
- **Live tool progress** — a tool call that runs past thirty seconds shows a timer on its row until the result lands, and a subagent being retried after an API error says which attempt it is on.
- **Status bar in the session header** — set into the header alongside the account, branch and session cards rather than sitting over the transcript: the session's name on the left, with a pencil to rename it; the readouts to the right. Renaming goes back through Claude Code's own rename channel, so the name is the session's real one and shows up wherever the session is listed; a Suggest button in that popover asks the CLI to propose one from the session's opening prompt, which you can accept or edit before saving. The readouts: the model, the reasoning effort and the permission mode, each opening its picker; how long the current turn has run, the size of the current thinking burst, and the prompt-cache countdown, each holding the previous round's figure once the turn ends. Beside them, whether this session is receiving anything: connectivity is global but delivery is per-session, so a live daemon connection that is sending this tab no events says so instead of looking like a quiet session. The session widget keeps the count of subagents running.
- **Diffs render as diffs** — output from `git diff`, `git show` or a patch tool is laid out with line numbers down both sides and each changed line marked, matching the Edit and patch views rather than arriving as a wall of monospace.
- **Review the working tree without leaving the session** — a side-by-side diff of everything you have changed, with a file tree on one side and the old and new file on the other, each with its own line numbers and syntax highlighting. Unchanged stretches stay folded with a count of what is hidden and a control to open them, up to the whole file. The diff is against your last commit rather than the index, so work you have already staged is shown rather than reading as an unchanged file, and files git is not yet tracking appear as all-additions instead of being left out.
- **See what shaped the session** — a panel listing the instruction files, nested memory, MCP servers, agents, skills and deferred tools actually loaded, in arrival order, with what is still in effect marked. It reads Claude Code's own record of what it loaded rather than searching the disk for files named `CLAUDE.md`, so nothing a filename search would miss is left out.
- Image attachments, in-session find, permission and elicitation prompts, per-tab context-usage / cost readouts, and a per-command summary of the files a Bash command changed.
- Multi-tab layout. A chat tab's icon is tinted with the account the session runs under and carries that account's mark, so which account a tab is spending belongs to is readable without opening it. Under the project name sits the session's own name, so two tabs on one project are told apart by what you are doing in each — or, set to compact, tabs collapse to a single line and the session name moves to the hover tooltip. Per-tab status glyphs (session state, engine, rate-limit warnings) and an aggregate status popover. Closing a tab is what ends its session — unlike quitting the app, which leaves it running — so a tab with a turn in flight asks before it goes. The popover lists every session the daemon is running, not only the ones with a tab open — a session you closed the tab on, or started from the iPad, shows up as detached and opens back into a tab on click. Each row carries its session id.

### Remote — drive it from the iPad

- **A daemon owns the sessions, not the window.** OmniFex splits into a headless daemon on the Mac and thin clients. Quit the app mid-turn and the CLI keeps running; reopen and catch up.
- **The same UI in Safari.** The daemon serves the renderer over your tailnet, so an iPad gets the real app — chat sessions, prompts, permission cards, streaming output — not a remote-desktop view of one.
- **A Home Screen app with push.** Behind `tailscale serve` (HTTPS), it installs as a standalone app and the daemon pushes a notification when a turn wants your attention.
- **Upgrades take care of themselves.** A new app build replaces an older daemon on launch — at once when nothing is running, otherwise once the last turn finishes.
- Mac-only by nature and unavailable from the iPad: file dialogs, Finder reveal, and the updater.
- See [docs/remote-access.md](docs/remote-access.md) for setup, and the `Daemon` panel in the title bar for live status.

### Context tracking & compaction

- **Live context gauge** per tab, measured against the session's *real* window — the size the running CLI reports, not a guess from the model name, so resumed 1M-window sessions read correctly.
- **Context-pressure banner** with a budget you set: either a percentage of the window or an absolute token count. It escalates in two steps — amber at 80% of your budget, red at 100% — and applies live, so you can retune it mid-session.
- **Context timeline rail** (opt-in) plots context size per message down the transcript, answering the question the live gauges can't: *which message made this session expensive?*
- **Post-compaction directive.** Compaction replaces earlier turns with a summary, and a model working from that summary will still answer confidently about exact line numbers and literal output — reconstructing specifics from the gist, which reads exactly like a memory. OmniFex sends a short directive on the near side of every compaction boundary telling the model its context just went lossy and to re-read before quoting. It fires on auto-compaction and a hand-typed `/compact`, not just OmniFex's own banner, and the text is editable in settings.

### Cost tracking

- **Durable cost history** in local SQLite. Rows survive the CLI's own transcript pruning, so a session's cost is still there after the JSONL that produced it is gone.
- **Backfill across every configured account**, including sessions run outside OmniFex entirely — monthly totals reconcile against what Anthropic's console reports rather than counting only what this app launched.
- A dedicated **Costs view**: preset ranges (this month, last 30/90 days, all time), grouped by day, week, or month, drilling into per-session rows.
- **Pricing overrides** for when published rates change or your account is priced differently.

### Multi-engine (Claude + Codex)
- **Claude Code** is fully wired: sessions, agents, MCP, hooks, slash commands, permissions, and usage.
- **OpenAI Codex** is partially wired today: you can create Codex-engine accounts and sign in (OAuth via `codex login`, or `OPENAI_API_KEY`), and browse on-disk Codex sessions. Full Codex session execution is still in progress.

### MCP server management
- Add, edit, remove, and test MCP servers (command- or URL-based) from the UI.
- Import server configs from Claude Desktop.
- Scope servers at the user, local, or project level, and view live per-session server status.

### Slash commands, hooks & permissions
- Create and manage custom **slash commands** (with `description` and `allowed-tools` frontmatter) at user, local, or project scope.
- View, edit, and validate Claude Code **hooks** across scopes.
- Edit **permission rules** (allow/deny) at user, local, or project scope; new rules are pushed live to the active session.
- See what the **running session** actually has in force, including rules no settings file can show you — supplied by a plugin, set for this session only, or managed centrally — plus any rule a file lists that the session is ignoring.

### Usage analytics
- Aggregate token usage and estimated cost across every configured account.
- Break down by model, project, and date range, with per-account comparison.

### Rate limits
- Scrape the CLI `/usage` view to capture five-hour and weekly **utilization %** and reset times.
- Store rate-limit snapshots per account and fire **threshold notifications** (with configurable percentages and sounds) as you approach a limit.

### CLAUDE.md, summaries & editable prompts
- Inline editor with live preview for CLAUDE.md files.
- Session rows are headed by the session's name — the one Claude Code gave it, or the one you gave it — with an **on-demand, cached summary** generated by a model call sitting underneath it.
- **CLI drift review.** OmniFex tracks which Claude Code version it has been reviewed against. When the CLI you have installed moves past that watermark, the Updates popover says so and can launch a changelog-review session — the wrapper tells you when the thing it wraps has changed underneath it.
- Every prompt OmniFex sends on your behalf — session summary, post-compaction directive, CLI drift review — ships as a documented default with an **override you can edit in settings**, no rebuild required.

### Git awareness
- Show the current branch per project, list **git worktrees**, and assign **per-project branch colors**.
- A lightweight watcher refreshes the branch badge as your working tree changes.

### Appearance & the rest
- Deep theming: color palettes, typography, terminal fonts, and per-message-kind icons, with JSON export/import.
- **Lima VM viewer** — list and start/stop Lima VMs and their Docker containers.
- HTTP/HTTPS **proxy** settings, OS **notifications** with sound preview, and an in-app **auto-updater** that pulls new builds from GitHub Releases.

## Install

### Download (recommended)

Grab the latest macOS arm64 build from the [Releases page](https://github.com/greychrist/omnifex/releases/latest):

- `OmniFex-<version>-arm64.dmg` — drag-install to `/Applications`.
- `OmniFex-darwin-arm64-<version>.zip` — used by the in-app auto-updater.

The build is signed with a Developer ID and notarized, so it opens on first launch without a Gatekeeper prompt.

Once installed, OmniFex checks `releases/latest` on launch and offers in-place updates when a new version is published.

### Prerequisites

- **Claude Code CLI** installed and authenticated. See [Anthropic's setup guide](https://docs.anthropic.com/en/docs/claude-code).
- Apple Silicon Mac running a current macOS.
- *(Optional)* the **Codex CLI** and **Lima** on your `PATH` if you want the Codex-account and VM-viewer features.

## Build from source

```bash
git clone https://github.com/greychrist/omnifex.git
cd omnifex
npm install
npm start            # run in dev (Electron Forge + Vite)
```

For a production build:

```bash
npm run make         # produces .dmg and .zip in out/make/
```

Other useful scripts:

```bash
npm run check              # tsc --noEmit across renderer and main process
npm test                   # vitest one-shot
npm run test:coverage
npm run rebuild:electron   # rebuild better-sqlite3 / node-pty for Electron's ABI
```

## Tech stack

- **Runtime**: Electron 41 (Node 22, Chromium)
- **Renderer**: React 19 + TypeScript + Vite 6 + Tailwind v4 + Radix / shadcn
- **Main process**: TypeScript on Node, services wired through a typed, allow-listed IPC layer
- **Remote**: a headless daemon (the same Electron binary under `ELECTRON_RUN_AS_NODE`) speaking a versioned WebSocket protocol to the Electron app and to a browser client
- **Persistence**: `better-sqlite3`
- **Terminal**: `node-pty` + `@xterm/xterm` (the `/usage` scraper and Codex sign-in)
- **Claude/Codex integration**: drives the CLI binaries directly over `child_process` streaming JSON

## Project structure

```
omnifex/
├── electron/              # Main process
│   ├── main.ts            # App bootstrap, service wiring
│   ├── preload.ts         # contextBridge (publishes __omnifexNative)
│   ├── ipc/               # IPC handlers + the channel allow-list (channels.ts)
│   ├── remote/            # OmniFex Remote: daemon, protocol server, push
│   ├── omnifex-server.ts  # Daemon entry point (the `omnifexd` process)
│   ├── services/          # Business logic
│   │   ├── accounts.ts    #   multi-account resolution & path rules
│   │   ├── sessions/      #   session lifecycle, permissions, subagents
│   │   ├── agents/        #   Claude & Codex engine layer
│   │   ├── auth/          #   Codex auth
│   │   ├── usage*.ts      #   usage aggregation + /usage scraping
│   │   ├── cost/          #   durable cost history, session cost, pricing
│   │   ├── rate-limits.ts #   rate-limit snapshots & notifications
│   │   ├── mcp.ts         #   MCP management
│   │   ├── brain/         #   the memory vault: sources, distill, merge, index
│   │   └── …              #   slash commands, hooks, lima, git, updater, …
│   └── __tests__/         # Vitest suites for main-process code
├── src/                   # Renderer (React)
│   ├── components/        # UI (sessions, accounts, MCP, usage, settings, …)
│   ├── contexts/          # Theme, tabs, accounts, message rendering
│   ├── stores/            # Zustand stores
│   ├── protocol/          # Wire types shared by daemon and clients
│   └── lib/               # Typed API surface (api.ts), IPC adapter,
│                          #   and lib/remote/ — the WebSocket bridge
├── web/                   # Browser-client shell (manifest, service worker)
├── icons/                 # App icon assets
└── assets/                # Source design files (PSDs, audio)
```

## Security and privacy

- All persistence is local (SQLite + your existing Claude/Codex config dirs). No telemetry, no analytics, no remote logging.
- Remote access is opt-out, not opt-in: the daemon listens on your Tailscale address when one is up and on loopback otherwise, never on `0.0.0.0` unless you write that into `~/.omnifex/server.json` yourself. It has no login — reaching the address *is* the authentication — so the tailnet is the boundary. Set `remote.enabled=false` (or `OMNIFEX_REMOTE=0`) to keep everything in-process. The channels a remote client may reach are allow-listed server-side; dialogs, the updater, terminals and raw SQL are refused there regardless of what the client asks for.
- OmniFex talks to model providers only through the CLI binaries you install and authenticate; it sends nothing to Anthropic or OpenAI itself.
- Per-session permission gating for tool use, mirroring Claude Code's native permission model.
- Brain vaults are plain files on your disk, one per account, and never leave it. Distilling a session is a call to the CLI under that account's own credentials; the transcripts those calls produce are archived and priced like any other session rather than discarded, and the vault a session can reach is fixed by the process it was launched with.

## License

AGPL-3.0 — see [LICENSE](LICENSE).

OmniFex is published by GreyChrist.

## Acknowledgments

- Originally forked from [opcode](https://github.com/getAsterisk/opcode) by [Asterisk](https://asterisk.so/).
- Built on [Electron](https://www.electronjs.org/) and [Claude Code](https://docs.anthropic.com/en/docs/claude-code).
- [Claude](https://claude.ai) by Anthropic.
