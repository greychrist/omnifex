<div align="center">
  <img src="icons/icon.png" alt="OmniFex Logo" width="120" height="120">

  <h1>OmniFex</h1>

  <p>
    <strong>A desktop GUI for Claude Code with first-class multi-account support.</strong>
  </p>
  <p>
    Route projects to specific Claude accounts, run interactive sessions and custom agents,
    manage MCP servers, edit CLAUDE.md files, and track usage — all without leaving the app.
  </p>
</div>

> [!NOTE]
> This project is not affiliated with, endorsed by, or sponsored by Anthropic. Claude is a trademark of Anthropic, PBC. This is an independent project that uses Claude Code.
>
> OmniFex is a long-running fork of [opcode](https://github.com/getAsterisk/opcode) by Asterisk, licensed under AGPL-3.0. It has since been rewritten on Electron and reshaped around multi-account workflows; little of the original Tauri/Rust codebase remains.

## Status

OmniFex is **macOS (Apple Silicon) only** and ships as an **unsigned** build. macOS Gatekeeper will block the first launch — right-click → **Open** to bypass it once. A proper Developer ID signature is on the roadmap.

## Features

### Multi-account routing
- Bind projects to specific Claude accounts via path-prefix rules.
- Longest-match-wins resolution with explicit per-project overrides.
- Each session, agent, hook, MCP, and CLAUDE.md read/write is launched under the resolved account's `CLAUDE_CONFIG_DIR`.

### Interactive Claude Code sessions
- Tabbed chat surface running on top of the official [`@anthropic-ai/claude-agent-sdk`](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk).
- Streaming output, permission prompts, slash commands, and per-tab status.

### Custom agents
- Define agents with custom system prompts, MCP access, and tools.
- Run them as background tasks through the Claude CLI; track history and logs.

### MCP server management
- Add, edit, and test MCP servers from the UI.
- Import server configs from Claude Desktop and Claude Code.

### Usage analytics
- Aggregate token and cost usage across every configured account.
- Breakdowns by model, project, and time period.

### CLAUDE.md and hooks
- Inline editor with live preview for CLAUDE.md files.
- View and edit Claude Code hooks config from the same surface.

## Install

### Download (recommended)

Grab the latest macOS arm64 build from the [Releases page](https://github.com/greychrist/omnifex/releases/latest):

- `OmniFex-<version>-arm64.dmg` — drag-install to `/Applications`.
- `OmniFex-darwin-arm64-<version>.zip` — used by the in-app auto-updater.

On first launch macOS will refuse to open the app because it isn't signed by a Developer ID — right-click the app icon and choose **Open**, then confirm. You only need to do this once.

Once installed, OmniFex checks `releases/latest` on launch and offers in-place updates when a new version is published.

### Prerequisites

- **Claude Code CLI** installed and authenticated. See [Anthropic's setup guide](https://docs.anthropic.com/en/docs/claude-code).
- Apple Silicon Mac running a current macOS.

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
npm run check        # tsc --noEmit across renderer and main process
npm test             # vitest one-shot
npm run test:coverage
npm run rebuild:electron   # rebuild better-sqlite3 / node-pty for Electron's ABI
```

## Tech stack

- **Runtime**: Electron 41 (Node 22, Chromium)
- **Renderer**: React 18 + TypeScript + Vite + Tailwind v4 + Radix / shadcn
- **Main process**: TypeScript on Node, services wired through a typed IPC layer
- **Persistence**: `better-sqlite3`
- **Claude integration**: `@anthropic-ai/claude-agent-sdk` for interactive sessions, Claude CLI for agents

## Project structure

```
omnifex/
├── electron/              # Main process
│   ├── main.ts            # App bootstrap, service wiring
│   ├── preload.ts         # IPC allow-list
│   ├── ipc/               # IPC handlers
│   ├── services/          # Business logic (accounts, sessions, agents, mcp, usage, …)
│   └── __tests__/         # Vitest suites for main-process code
├── src/                   # Renderer (React)
│   ├── components/        # UI
│   ├── contexts/          # Theme, tabs, accounts
│   ├── stores/            # Zustand stores
│   └── lib/               # Typed API surface (api.ts) + IPC adapter
├── icons/                 # App icon assets
└── assets/                # Source design files (PSDs, audio)
```

## Security and privacy

- All persistence is local. No telemetry, no analytics, no remote logging.
- The main process talks to Anthropic only through the Claude Code SDK and CLI you have installed; OmniFex itself sends nothing to Anthropic.
- Per-tab permission gating for tool use, mirroring Claude Code's native permission model.

## License

AGPL-3.0 — see [LICENSE](LICENSE).

OmniFex is published by GreyChrist.

## Acknowledgments

- Originally forked from [opcode](https://github.com/getAsterisk/opcode) by [Asterisk](https://asterisk.so/).
- Built on [Electron](https://www.electronjs.org/) and the [Claude Agent SDK](https://docs.anthropic.com/en/docs/claude-code).
- [Claude](https://claude.ai) by Anthropic.
