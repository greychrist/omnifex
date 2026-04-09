# Electron Migration

**Date:** 2026-04-09
**Status:** Approved

## Overview

Migrate GreyChrist from Tauri 2 (Rust + React) to Electron (Node.js + React). The React frontend transfers as-is. The Rust backend is rewritten in TypeScript and runs in Electron's main process. The Claude Agent SDK runs natively in Node.js, eliminating the WebView/Node.js impedance mismatch that made the SDK unusable under Tauri.

## Problem

The Claude Agent SDK requires Node.js runtime APIs (`child_process`, `fs`, `crypto`, `events`). Tauri's frontend runs in a WebView (browser context) where these APIs don't exist. The Vite production build fails because the SDK imports `setMaxListeners` from `events`, which Vite's browser externalization stub doesn't export. Even if the build were fixed, the SDK's core functionality (spawning the Claude CLI via `child_process.spawn()`) cannot work in a browser.

The previous Rust session manager (`session_manager.rs`) attempted to work around this by spawning the CLI from Rust and piping JSON via stdin/stdout with `--permission-prompt-tool stdio`. This protocol doesn't work reliably in Claude Code 2.1.97 — permission requests cause sessions to hang.

Electron solves both problems: the SDK runs in the main process (Node.js), and the React frontend runs in the renderer process (Chromium). One language, one runtime, no impedance mismatch.

## Decisions

- **Runtime:** Electron with Electron Forge (official toolchain)
- **Build:** Vite plugin for Forge (`@electron-forge/plugin-vite`)
- **Platform:** Cross-platform (macOS primary, Windows/Linux supported)
- **Web mode:** Dropped. No Axum server port.
- **Storage:** SQLite via `better-sqlite3` (replaces `rusqlite`)
- **Testing:** Vitest, fresh TypeScript test suite, TDD, 80% line coverage target
- **Migration strategy:** Big bang — new Electron app built alongside existing Tauri app, Tauri deleted after cutover
- **Code signing:** Apple Developer account in progress, signing deferred until distribution

---

## Architecture

### Before (Tauri)

```
Renderer (WebView)              Rust Backend
├── React components            ├── session_manager.rs (broken)
├── api.ts ──invoke()──────────→├── commands/claude.rs
├── apiAdapter.ts               ├── commands/agents.rs
│   (desktop vs web routing)    ├── accounts/mod.rs
└── Tauri event listeners       ├── checkpoint/
                                ├── web_server.rs (Axum)
                                └── rusqlite
```

### After (Electron)

```
Renderer (Chromium)             Main Process (Node.js)
├── React components            ├── services/sessions.ts (SDK)
├── api.ts ──IPC invoke()──────→├── services/claude.ts
│                               ├── services/agents.ts
└── IPC event listeners         ├── services/accounts.ts
                                ├── services/checkpoints.ts
                                ├── services/usage.ts
                                ├── better-sqlite3
                                └── ipc/handlers.ts
```

### What stays in the renderer

All React components, hooks, state management, UI libraries (Radix, Tailwind, Lucide, framer-motion). The entire `src/` directory transfers with minimal changes — only `api.ts`, `apiAdapter.ts`, and 22 files with Tauri imports need updating.

### What moves to the main process

All backend logic currently in Rust: account resolution, SQLite operations, process spawning, usage aggregation, checkpoint management, settings read/write. Plus the Claude Agent SDK, which couldn't run in the Tauri WebView.

### What gets dropped

- `web_server.rs` (886 lines) — web mode removed
- `session_manager.rs` (605 lines) — replaced by SDK
- `apiAdapter.ts` web mode code path — simplified to Electron IPC only
- All Tauri plugins and Tauri-specific state management
- Rust async runtime (Tokio) — replaced by native Node.js async/await

---

## Project Structure

```
greychrist/
├── electron/                    # Electron main process
│   ├── main.ts                  # App entry, window creation, lifecycle
│   ├── preload.ts               # contextBridge IPC exposure
│   ├── services/                # Backend logic (replaces Rust)
│   │   ├── database.ts          # better-sqlite3 setup, schema init
│   │   ├── accounts.ts          # Account resolution, CRUD, path rules
│   │   ├── claude.ts            # Project listing, session history, settings
│   │   ├── sessions.ts          # Claude Agent SDK integration
│   │   ├── agents.ts            # Agent CRUD, execution, output streaming
│   │   ├── usage.ts             # Usage aggregation from JSONL metadata
│   │   ├── checkpoints.ts       # File diff tracking, timeline, zstd
│   │   ├── claude-binary.ts     # Binary discovery (NVM, homebrew, PATH)
│   │   ├── mcp.ts               # MCP server config
│   │   ├── slash-commands.ts    # Slash command registry
│   │   ├── logging.ts           # Structured logging to SQLite
│   │   ├── storage.ts           # SQL inspector (table browser)
│   │   ├── proxy.ts             # Proxy settings
│   │   └── process-registry.ts  # Active process tracking
│   ├── ipc/
│   │   └── handlers.ts          # Maps IPC channels to service methods
│   └── __tests__/               # Vitest tests for all services
├── src/                         # React frontend (renderer) — existing
├── src-tauri/                   # Kept as fallback until cutover
├── forge.config.ts              # Electron Forge configuration
├── vite.config.ts               # Renderer Vite config (existing, modified)
├── vite.main.config.ts          # Main process Vite config
├── vite.preload.config.ts       # Preload script Vite config
└── package.json                 # Modified — Electron + Forge deps
```

---

## IPC Architecture

Three layers connect the renderer to the main process.

### Preload script (`electron/preload.ts`)

Exposes a minimal API surface to the renderer via `contextBridge`:

```typescript
contextBridge.exposeInMainWorld('electronAPI', {
  invoke: (channel: string, params?: any) => ipcRenderer.invoke(channel, params),
  onEvent: (channel: string, callback: (...args: any[]) => void) => {
    const listener = (_event: IpcRendererEvent, ...args: any[]) => callback(...args);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  },
  showOpenDialog: (options: any) => ipcRenderer.invoke('dialog:open', options),
  showSaveDialog: (options: any) => ipcRenderer.invoke('dialog:save', options),
  openExternal: (url: string) => ipcRenderer.invoke('shell:openExternal', url),
});
```

`invoke` for request/response. `onEvent` for streaming (session output, agent output). A handful of specific methods for dialogs and shell — these map to Electron's native APIs in the main process.

### Handler registration (`electron/ipc/handlers.ts`)

Maps IPC channel names to service methods. Channel names match existing Tauri command names so the frontend barely changes:

```typescript
ipcMain.handle('list_accounts', () => accounts.listAccounts());
ipcMain.handle('resolve_account_for_project', (_, { projectPath }) => accounts.resolve(projectPath));
ipcMain.handle('session_start', (_, params) => sessions.start(params));
// ... all 65+ methods
```

### Frontend API swap (`src/lib/api.ts`)

The `apiCall` function changes from Tauri invoke to Electron IPC:

```typescript
async function apiCall<T>(command: string, params?: any): Promise<T> {
  return window.electronAPI.invoke(command, params);
}
```

One line. All 65+ API methods work unchanged because channel names and param shapes are preserved.

### Streaming events

For session output and agent output, the main process pushes events to the renderer:

```typescript
// Main process (in session listener loop)
mainWindow.webContents.send(`session-message:${tabId}`, message);

// Renderer (in ClaudeCodeSession.tsx)
const unlisten = window.electronAPI.onEvent(`session-message:${tabId}`, (message) => {
  handleMessage(message);
});
```

This replaces Tauri's `emit()`/`listen()` pattern with the same semantics.

---

## Session Management (Claude Agent SDK)

The SDK runs in the main process. `electron/services/sessions.ts` wraps `query()` and manages one `SessionHandle` per tab.

### SessionHandle

Each tab gets its own handle:

- `query: Query` — SDK async generator
- `inputChannel: AsyncChannel<SDKUserMessage>` — push/pull queue for multi-turn
- `sessionId: string | null` — from `system/init` message
- `status: SessionStatus` — starting, running, waiting_permission, stopped, error
- `permissionResolver` — Promise resolver for pending permission callback
- `autoAllowEnabled` / `autoAllowedTools` — per-session auto-allow state

### Message flow

```
Renderer                         Main Process
  │                                │
  ├── invoke('session_start') ────→ sessions.start()
  │                                │  → query({ prompt: inputChannel })
  │                                │  → SDK spawns Claude CLI
  │                                │  → listener loop starts
  │                                │
  │ ←── 'session-message:tabId' ──┤  → each SDKMessage forwarded
  │ ←── 'permission-request:tabId'┤  → PermissionRequest hook fires
  │                                │
  ├── invoke('session_respond') ──→ sessions.respondPermission()
  │                                │  → resolves hook Promise
  │                                │
  ├── invoke('session_send') ────→  sessions.sendMessage()
  │                                │  → pushes to inputChannel
  │                                │
  ├── invoke('session_stop') ────→  sessions.stop()
  │                                │  → query.close()
```

### Permission flow

1. SDK's `PermissionRequest` hook fires in the main process
2. Main process sends `permission-request:${tabId}` event to renderer with `{ toolName, toolInput }`
3. Renderer shows `PermissionPrompt` component
4. User clicks Allow/Deny
5. Renderer calls `invoke('session_respond', { tabId, behavior })`
6. Main process resolves the hook's Promise with `{ behavior }`
7. SDK continues execution

### Auto-allow

Auto-allow logic lives in the `PermissionRequest` hook callback. If `autoAllowEnabled` and the tool is in `autoAllowedTools`, the hook resolves immediately without sending an event to the renderer.

### Multi-turn sessions

`start()` creates an `AsyncChannel<SDKUserMessage>` passed as the `prompt` parameter to `query()`. When the user sends a follow-up message, `sendMessage()` pushes into the channel. The SDK reads it and continues the conversation in the same process with full context.

---

## Backend Services

Each Rust module maps to one TypeScript service file in `electron/services/`.

### Database (`database.ts`)

`better-sqlite3` with synchronous API. Creates a single connection on app startup, passes it to all services. Schema initialization creates the same 7 tables:

- `agents` — agent definitions
- `agent_runs` — execution history
- `app_settings` — KV store (proxy, binary path preferences)
- `accounts` — account definitions
- `account_path_rules` — path prefix → account mapping
- `project_account_overrides` — explicit project → account overrides
- `app_logs` — structured event log

### Accounts (`accounts.ts`)

Port of `accounts/mod.rs` (772 lines). Resolution order preserved exactly:

1. Explicit project override
2. Longest matching path rule
3. Default account
4. Error/prompt when no match exists

CRUD operations: `listAccounts`, `createAccount`, `updateAccount`, `deleteAccount`, `setDefault`. Path rules: `listPathRules`, `addPathRule`, `removePathRule`. Resolution: `resolve(projectPath)`, `explainResolution(projectPath)`. Discovery: `discoverAccounts()` (scan for Claude config directories).

### Claude (`claude.ts`)

Port of `commands/claude.rs` (2749 lines), minus session management (now in `sessions.ts`). Remaining functionality:

- Project listing from Claude config directory
- Session history loading from JSONL files
- Settings read/write (`.claude/settings.json`)
- CLAUDE.md file operations
- Version checking
- System prompt management

### Agents (`agents.ts`)

Port of `commands/agents.rs` (2193 lines). Agent CRUD (SQLite), execution via `child_process.spawn()` (not SDK — agents are a separate execution surface), output streaming via `webContents.send()`, run history, GitHub import.

### Sessions (`sessions.ts`)

New — wraps Claude Agent SDK. Described in the Session Management section above.

### Usage (`usage.ts`)

Port of `commands/usage.rs` (804 lines). Reads JSONL metadata files from resolved Claude config directories, aggregates token counts and costs by date range. Pure file parsing.

### Checkpoints (`checkpoints.ts`)

Port of `checkpoint/` (1683 lines total). File diff tracking, timeline reconstruction, checkpoint create/restore/fork/list. Uses `fzstd` or `@napi-rs/zstd` for zstd compression of checkpoint data.

### Claude Binary (`claude-binary.ts`)

Port of `claude_binary.rs` (707 lines). Discovery logic: system PATH, NVM installations, homebrew, custom configured path. Version detection via subprocess. Uses `which` npm package.

### Remaining services

- `mcp.ts` — MCP server discovery and config (port of `commands/mcp.rs`, 726 lines)
- `slash-commands.ts` — Custom command registry from markdown + YAML frontmatter (port of `commands/slash_commands.rs`, 690 lines)
- `logging.ts` — Structured logging to SQLite (port of `commands/logging.rs`, 410 lines)
- `storage.ts` — SQL query inspector, table browser (port of `commands/storage.rs`, 530 lines)
- `proxy.ts` — Proxy settings store and apply (port of `commands/proxy.rs`, 162 lines)
- `process-registry.ts` — Active process tracking (port of `process/registry.rs`, 537 lines)

---

## Frontend Changes

### API layer

`api.ts`: Replace `apiCall` implementation (one line). Remove Tauri imports.

`apiAdapter.ts`: Remove web mode code path entirely. Simplify to Electron IPC only. Remove WebSocket streaming code and Tauri event polyfill.

### Tauri import replacements (22 files)

| Tauri import | Electron replacement |
|---|---|
| `@tauri-apps/api/core` → `invoke()` | `window.electronAPI.invoke()` (handled by api.ts) |
| `@tauri-apps/api/event` → `listen()` | `window.electronAPI.onEvent()` |
| `@tauri-apps/plugin-dialog` → `open()`, `save()` | `window.electronAPI.showOpenDialog()`, `showSaveDialog()` |
| `@tauri-apps/plugin-shell` → `open()` | `window.electronAPI.openExternal()` |
| `@tauri-apps/plugin-opener` → `openUrl()` | `window.electronAPI.openExternal()` |
| `@tauri-apps/api/window` → `getCurrentWindow()` | `window.electronAPI.windowControl()` |

### Custom titlebar

`CustomTitlebar.tsx` currently uses Tauri window APIs. Electron equivalent: `BrowserWindow` with `titleBarStyle: 'hidden'` on macOS, `frame: false` on Windows. Titlebar component's minimize/maximize/close handlers change from Tauri commands to Electron IPC calls.

### What doesn't change

All React components' UI (JSX, styling, layout), hooks, state management, context providers, UI libraries (Radix, Tailwind, Lucide, framer-motion), message rendering pipeline.

---

## Testing Strategy

### Framework

Vitest — TypeScript-native, integrates with Vite, fast. One test file per service in `electron/__tests__/`.

### Database tests

Fresh in-memory SQLite database (`:memory:`) per test suite. `better-sqlite3` makes this trivial. Schema init runs in `beforeAll`, no shared state between tests.

### Process spawning tests

Mock `child_process.spawn()` for agent execution and binary discovery. Mock SDK's `query()` for session tests — verify message flow, permission hooks, and error handling without spawning Claude.

### File system tests

`tmp` directories for checkpoint and usage tests that need real files. Clean up in `afterEach`.

### Coverage

80% line coverage target enforced via Vitest `--coverage`. Account resolution module gets extra attention — highest-risk business logic.

---

## Packaging and Distribution

### Electron Forge makers

| Platform | Format | Maker |
|---|---|---|
| macOS | DMG + `.app` | `@electron-forge/maker-dmg` |
| Windows | Squirrel installer | `@electron-forge/maker-squirrel` |
| Linux | deb + AppImage | `@electron-forge/maker-deb` |

### Code signing

macOS: Apple Developer certificate + notarization via Forge's `osxSign` and `osxNotarize` config. Apple Developer account in progress.

Windows: Optional code signing certificate. Add when distributing to team.

### Native dependencies

`better-sqlite3` is a native Node module — Forge's rebuild plugin handles recompilation for Electron's Node version automatically. Same for any native zstd module.

### Deferred for v1

- Auto-updates (`@electron-forge/plugin-auto-update`)
- CI/CD pipeline for multi-platform builds
- Mac App Store submission

---

## Migration Order

Each step produces a testable, committable unit. The app is bootable after step 3 and progressively gains functionality.

1. **Scaffold** — Electron Forge project with Vite plugin, copy React `src/`, get an empty window rendering
2. **Database** — `better-sqlite3` setup, schema init, connection management
3. **IPC + API swap** — Preload script, handler registration, swap `api.ts` to Electron IPC
4. **Accounts** — Account CRUD, path rules, resolution logic
5. **Claude binary discovery** — Find Claude CLI on disk
6. **Sessions (SDK)** — Claude Agent SDK integration, permission flow
7. **Claude service** — Project listing, session history, settings, CLAUDE.md
8. **Agents** — Agent CRUD, execution, output streaming
9. **Checkpoints** — File diff tracking, timeline
10. **Usage** — JSONL aggregation
11. **Remaining services** — MCP, slash commands, logging, storage inspector, proxy
12. **Frontend cleanup** — Replace 22 Tauri imports
13. **Packaging** — Forge makers, icons, code signing
14. **Delete Tauri** — Remove `src-tauri/`, Tauri deps, old adapter code

---

## Error Handling

- **SDK process crash:** Async generator throws or completes. SessionHandle catches, sets status to stopped, sends error event to renderer. User sees "Session ended unexpectedly" with resume option.
- **Permission timeout:** Session waits indefinitely (same as CLI). No artificial timeout.
- **Account resolution failure:** AccountPickerDialog shows before SDK is involved. Same flow as today.
- **Multiple tabs:** Each tab gets its own SessionHandle with its own Query — independent processes, no shared state.
- **Session resume:** `sessions.resume(tabId, sessionId)` → SDK's `query({ options: { resume: sessionId } })`.
- **App close:** Iterate all active sessions and call `stop()`. Electron's `before-quit` event handles this.
- **Database errors:** `better-sqlite3` throws synchronously. Services catch and return typed error objects via IPC.
- **Native module rebuild failure:** Forge's rebuild plugin logs the error at build time. If `better-sqlite3` fails to load at runtime, app shows a fatal error dialog.

---

## Risk

- **Electron Forge + Vite plugin maturity:** The `@electron-forge/plugin-vite` plugin is stable but less battle-tested than webpack. Mitigation: pin versions, test build early in step 1.
- **`better-sqlite3` native rebuild:** Native modules occasionally break across Electron versions. Mitigation: pin Electron version, test build before each upgrade.
- **Claude Agent SDK (pre-1.0):** SDK is version 0.2.97. API may change. Mitigation: pin version, test before upgrading.
- **Migration scope:** ~12K lines of Rust to ~11-13K lines of TypeScript. Mitigation: TDD ensures behavioral parity; 14-step build order means each step is independently verifiable.

---

## Out of Scope

- Web mode / mobile access (dropped)
- Auto-updates (add post-v1)
- CI/CD multi-platform builds (add post-v1)
- Mac App Store submission (add post-v1)
- SDK subagent features (available but not needed)
