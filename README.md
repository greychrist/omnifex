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

The app drives the **Claude Code CLI** directly (via `node-pty` for terminal mode and `child_process` for structured streaming), so a working, authenticated Claude Code install is required. OmniFex bundles no model of its own.

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
- **Nothing is auto-injected.** The Brain never stuffs itself into your prompts. It costs context only when something actually asks it a question.

### Multi-account routing
- Bind projects to specific Claude accounts using path-prefix rules, with **longest-match-wins** resolution and explicit per-project overrides.
- Auto-discover existing accounts on your machine and scan for new ones.
- Every session, agent, hook, MCP call, usage read, and CLAUDE.md edit runs under the resolved account's `CLAUDE_CONFIG_DIR`.
- An account-resolution explainer shows exactly why a given project maps to a given account.

### Interactive sessions
- **Two view modes** for the same live session: a structured **rich chat** (streaming JSON) with tool-call widgets, and a full **terminal (TUI)** view backed by the real CLI. Toggle between them mid-session.
- Live controls in rich mode: **model picker**, **reasoning effort** (low → max), **extended-thinking** config, and **permission mode** (default / acceptEdits / bypassPermissions / plan).
- **Slash-command picker** (`/`) plus per-session command discovery.
- **Subagent tracking** — subagent runs are surfaced inline with their model and authoritative end-of-run stats (duration, tokens, tool count).
- Image attachments, in-session find, permission and elicitation prompts, and per-tab context-usage / cost readouts.
- Multi-tab layout with per-tab status glyphs (session state, engine, rate-limit warnings) and an aggregate status popover.

### Remote — drive it from the iPad

- **A daemon owns the sessions, not the window.** OmniFex splits into a headless daemon on the Mac and thin clients. Quit the app mid-turn and the CLI keeps running; reopen and catch up.
- **The same UI in Safari.** The daemon serves the renderer over your tailnet, so an iPad gets the real app — chat sessions, prompts, permission cards, streaming output — not a remote-desktop view of one.
- **A Home Screen app with push.** Behind `tailscale serve` (HTTPS), it installs as a standalone app and the daemon pushes a notification when a turn wants your attention.
- **Upgrades take care of themselves.** A new app build replaces an older daemon on launch — at once when nothing is running, otherwise once the last turn finishes.
- Mac-only by nature and unavailable from the iPad: terminal (TUI) sessions, file dialogs, Finder reveal, and the updater.
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

### Usage analytics
- Aggregate token usage and estimated cost across every configured account.
- Break down by model, project, and date range, with per-account comparison.

### Rate limits
- Scrape the CLI `/usage` view to capture five-hour and weekly **utilization %** and reset times.
- Store rate-limit snapshots per account and fire **threshold notifications** (with configurable percentages and sounds) as you approach a limit.

### CLAUDE.md, summaries & editable prompts
- Inline editor with live preview for CLAUDE.md files.
- On-demand, cached **session summaries** generated by a model call.
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
- **Terminal**: `node-pty` + `@xterm/xterm`
- **Claude/Codex integration**: drives the CLI binaries directly — `node-pty` for terminal mode, `child_process` streaming JSON for the rich engine

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
│   │   ├── sessions/      #   session lifecycle, TUI, permissions, subagents
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
