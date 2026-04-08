# GreyChrist Rename & Structured Logging

**Date:** 2026-04-08
**Status:** Approved

## Overview

Two changes in one spec:

1. **Rename** all references from "opcode" to "greychrist"/"GreyChrist" across the codebase
2. **Structured logging** system with SQLite persistence and a Log tab in Settings

The permission request fix (already implemented) is a prerequisite — it exposed the need for better error visibility.

---

## Part 1: Rename (opcode → greychrist)

### Scope

All source code, configs, build files, and documentation. Two exclusions:

- **Upstream GitHub URLs** (`github.com/getAsterisk/opcode`) — left as-is, they're valid upstream references
- **Attribution text** in README.md and CONTRIBUTING.md — left as-is

### Rename Map

| Location | From | To |
|---|---|---|
| `package.json` name | `opcode` | `greychrist` |
| `Cargo.toml` crate name | `opcode` | `greychrist` |
| `Cargo.toml` lib name | `opcode_lib` | `greychrist_lib` |
| `Cargo.toml` binary name | `opcode-web` | `greychrist-web` |
| `tauri.conf.json` identifier | `opcode.asterisk.so` | `greychrist.asterisk.so` |
| `main.rs` app identifier | `opcode.asterisk.so` | `greychrist.asterisk.so` |
| `session_manager.rs` identifier | `opcode.asterisk.so` | `greychrist.asterisk.so` |
| `web_main.rs` command name | `opcode-web` | `greychrist-web` |
| Storage keys (`tabPersistence.ts`) | `opcode_tabs_v2`, `opcode_active_tab_v2`, `opcode_tab_persistence_enabled` | `greychrist_tabs_v2`, `greychrist_active_tab_v2`, `greychrist_tab_persistence_enabled` |
| Storage keys (`sessionPersistence.ts`) | `opcode_session_*`, `opcode_session_index` | `greychrist_session_*`, `greychrist_session_index` |
| Storage keys (`TabContext.tsx`) | `opcode_tabs` (commented) | `greychrist_tabs` |
| Analytics (`analytics/index.ts`) | `app_name: 'opcode'`, `app_context: 'opcode_desktop'`, `opcode://` | `app_name: 'greychrist'`, `app_context: 'greychrist_desktop'`, `greychrist://` |
| Analytics (`analytics/consent.ts`) | `opcode-analytics-settings` | `greychrist-analytics-settings` |
| Agent file format | `.opcode.json` | `.greychrist.json` |
| Agent display names (`CCAgents.tsx`, `Agents.tsx`) | `opcode Agent` | `GreyChrist Agent` |
| Agent browser (`GitHubAgentBrowser.tsx`) | `.opcode.json` references | `.greychrist.json` |
| NFO credits (`NFOCredits.tsx`) | `opcode v0.2.1`, `opcode.NFO` | `GreyChrist v0.2.1`, `GreyChrist.NFO` |
| User-Agent header (`commands/agents.rs`) | `opcode-App` | `GreyChrist-App` |
| Agent file filter (`commands/agents.rs`) | `.opcode.json` | `.greychrist.json` |
| GitHub workflow artifacts (`release.yml`) | `opcode_*.deb`, `opcode_*.AppImage`, `opcode.dmg`, `opcode.app.zip` | `greychrist_*.deb`, `greychrist_*.AppImage`, `greychrist.dmg`, `greychrist.app.zip` |
| macOS build workflow (`build-macos.yml`) | `opcode.app`, `opcode.dmg`, `opcode Installer` | `greychrist.app`, `greychrist.dmg`, `greychrist Installer` |
| CLAUDE.md / src/CLAUDE.md / src-tauri/CLAUDE.md | `opcode` descriptions, `opcode-web`, `opcode-targeted-workflow` | `GreyChrist` descriptions, `greychrist-web`, updated skill names |
| AGENTS.md | `opcode` descriptions | `GreyChrist` descriptions |
| CONTRIBUTING.md | non-attribution `opcode` references | `GreyChrist` |
| `cc_agents/README.md` | `opcode` references, `.opcode.json` | `GreyChrist`, `.greychrist.json` |
| `cc_agents/*.opcode.json` files | file names | rename to `*.greychrist.json` |
| Design/plan docs | `cargo test --bin opcode`, `opcode/` paths | `cargo test --bin greychrist`, `greychrist/` paths |
| `web_server.design.md` | `opcode/` | `greychrist/` |

### Storage Key Migration

The `tabPersistence.ts` already has a migration pattern (reads old key, writes new key, deletes old). Apply the same pattern to all renamed storage keys:

1. On first load, check for `opcode_*` keys in localStorage
2. Copy values to `greychrist_*` keys
3. Delete old `opcode_*` keys

This runs once per user, transparently.

---

## Part 2: Structured Logging System

### Architecture

Single LogService on the frontend acts as the central collector. Backend emits log events via Tauri events. LogService buffers and batch-writes to SQLite.

```
Frontend:
  console.error/warn/info/debug ──┐
                                  ▼
                            ┌──────────┐
  Backend log events ──────▶│LogService│
  (Tauri emit)              │singleton │
                            └────┬─────┘
                                 │ batch write (every 2s or 50 entries)
                                 ▼
                          Tauri command
                         "log_write_batch"
                                 │
Backend:                         ▼
  ┌────────────────┐    ┌──────────────────────┐
  │ log_write_batch│───▶│ SQLite: app_logs     │
  │ log_query      │◀───│                      │
  │ log_prune      │───▶│ id, timestamp, level,│
  │ log_count      │◀───│ source, category,    │
  └────────────────┘    │ message, metadata    │
                        └──────────────────────┘
```

### SQLite Schema

```sql
CREATE TABLE IF NOT EXISTS app_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp TEXT NOT NULL,      -- ISO 8601
  level TEXT NOT NULL,          -- error, warn, info, debug
  source TEXT NOT NULL,         -- frontend, backend
  category TEXT,                -- optional grouping
  message TEXT NOT NULL,
  metadata TEXT                 -- JSON blob, nullable
);
CREATE INDEX idx_logs_timestamp ON app_logs(timestamp);
CREATE INDEX idx_logs_level ON app_logs(level);
```

### LogService (`src/lib/logService.ts`)

- Singleton initialized in `main.tsx` at app startup
- Wraps `console.error`, `console.warn`, `console.info`, `console.debug`
  - Calls original method first (devtools still work)
  - Creates a log entry and adds to buffer
- Listens for `backend-log` Tauri events
- Buffer flush: every 2 seconds or when buffer reaches 50 entries, whichever comes first
- Filters out noisy messages (React dev warnings, HMR hot-reload messages)
- Entry shape: `{ timestamp: string, level: string, source: "frontend"|"backend", category?: string, message: string, metadata?: string }`

### Backend Log Bridge (`src-tauri/src/logging.rs`)

- Implements the `log` crate `Log` trait as a custom logger
- Chains with existing `env_logger` — stderr output unchanged
- For `error` and `warn` levels: emits Tauri event `backend-log` with `{ level, category (Rust module path), message, timestamp }`
- For `info` and `debug` levels: only emits if `GREYCHRIST_VERBOSE_LOG=1` environment variable is set
- Registered in `main.rs` during Tauri app setup, after `env_logger::init()`

### Tauri Commands (`src-tauri/src/commands/logging.rs`)

Four commands:

**`log_write_batch(entries: Vec<LogEntry>)`**
- Bulk insert into `app_logs` table
- Each entry validated for required fields

**`log_query(level?: String, source?: String, search?: String, limit: u32, offset: u32) -> LogQueryResult`**
- Filtered reads with pagination
- `search` does a `LIKE %term%` on message column
- Returns `{ entries: Vec<LogEntry>, total: u64 }` for pagination UI
- Ordered by timestamp DESC (newest first)

**`log_prune(older_than?: String)`**
- `older_than` values: `"1w"` (1 week), `"1m"` (1 month), or `null` (all records)
- Returns count of deleted rows

**`log_count() -> u64`**
- Total row count, used for startup check

### API Layer (`src/lib/api.ts`)

```typescript
async logWriteBatch(entries: LogEntry[]): Promise<void>
async logQuery(filters: LogQueryFilters): Promise<LogQueryResult>
async logPrune(olderThan?: string): Promise<number>
async logCount(): Promise<number>
```

Follows existing `apiCall()` pattern.

### Log Tab UI (`src/components/LogTab.tsx`)

Added as the 10th tab in `Settings.tsx`. Grid changes from `grid-cols-9` to `grid-cols-10`.

**Filter bar:**
- Level dropdown: All, Error, Warn, Info, Debug
- Source dropdown: All, Frontend, Backend
- Search text field (debounced 300ms, filters on message content)
- Refresh button

**Log table (scrollable, 50 entries per page):**
- Timestamp — formatted to local time, compact
- Level — color-coded: red=error, yellow=warn, blue=info, gray=debug
- Source — badge (frontend/backend)
- Category — if present
- Message — truncated to 1 line, click row to expand full message + metadata JSON

**Footer:**
- Pagination: "Showing 1-50 of 1,234" with Prev/Next buttons
- Clear buttons:
  - "Older than 1 week" — confirms with count of records to delete
  - "Older than 1 month" — confirms with count of records to delete
  - "Clear all" — confirms with total count

### Startup Warning

On app init (in `main.tsx` or `App.tsx`), after LogService initialization:

1. Call `logCount()`
2. If count > 5,000, show a toast notification: "You have X log entries. Review and prune old records in Settings → Log."
3. Toast includes a link/button to navigate to Settings → Log tab

### Files Created

- `src/lib/logService.ts` — LogService singleton
- `src/components/LogTab.tsx` — Log tab UI component
- `src-tauri/src/logging.rs` — Backend log bridge (custom Log trait impl + Tauri event emitter)
- `src-tauri/src/commands/logging.rs` — SQLite log commands

### Files Modified

- `src/main.tsx` — initialize LogService at startup, startup count check
- `src-tauri/src/main.rs` — register custom logger, register new Tauri commands, create `app_logs` table
- `src-tauri/src/lib.rs` — add `logging` module declaration
- `src/lib/api.ts` — add log API methods
- `src/components/Settings.tsx` — add Log tab (grid-cols-10), import LogTab
- Plus all rename files from Part 1

---

## Out of Scope

- Web mode (`greychrist-web`) log endpoints — desktop only for now
- Log export (CSV/JSON download)
- Log level configuration UI (controlled by env vars for backend)
- Real-time log streaming in the Log tab (manual refresh for now)
