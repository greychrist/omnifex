# Multi-Account Support for Opcode

**Date:** 2026-04-06
**Status:** Design approved

## Problem

Opcode hardcodes `~/.claude` as the sole config directory. The user runs two Claude accounts via shell aliases (`claude-personal` → `CLAUDE_CONFIG_DIR=~/.claude-personal`, `claude-work` → `CLAUDE_CONFIG_DIR=~/.claude-work`). Opcode cannot see projects, sessions, or settings from either account because it only reads from the nearly-empty `~/.claude`.

## Design Decisions

- **Per-project account binding** — each project is associated with an account. Multiple accounts can be active simultaneously across different projects.
- **Directory-based convention** — path prefix rules auto-assign accounts (e.g., `~/Repos/personal/**` → personal). Manual override per-project when no rule matches.
- **Auto-discovery on first launch** — scan `~/.claude-*` directories to bootstrap accounts.
- **Agents are global, runs are account-scoped** — agent definitions are shared; agent runs record which account was used.
- **Prompt on unknown paths** — when a project doesn't match any rule or override, the user picks an account. Choice is persisted as an override.

## Data Model

### `accounts` table

| Column | Type | Notes |
|--------|------|-------|
| id | INTEGER PK | Auto-increment |
| name | TEXT UNIQUE NOT NULL | "personal", "work" |
| config_dir | TEXT NOT NULL | Absolute path, e.g. `/Users/greg/.claude-personal` |
| is_default | BOOLEAN DEFAULT 0 | Fallback when no rule matches |
| created_at | TEXT | Timestamp |
| updated_at | TEXT | Timestamp |

### `account_path_rules` table

| Column | Type | Notes |
|--------|------|-------|
| id | INTEGER PK | Auto-increment |
| account_id | INTEGER FK | → accounts.id, ON DELETE CASCADE |
| path_prefix | TEXT NOT NULL | e.g. `/Users/greg/Repos/personal/` |
| priority | INTEGER DEFAULT 0 | Higher wins; ties broken by longest prefix |

### `project_account_overrides` table

| Column | Type | Notes |
|--------|------|-------|
| project_path | TEXT PK | Canonical absolute path |
| account_id | INTEGER FK | → accounts.id, ON DELETE CASCADE |

### `agent_runs` migration

Add column: `account_id INTEGER` (nullable for backwards compat). New runs record which account was used. Existing rows get NULL.

## Account Resolution Algorithm

```
resolve_account(project_path) → Result<Account>:
  1. Check project_account_overrides for exact match → return account
  2. Check account_path_rules, longest matching prefix → return account
  3. Check accounts where is_default = true → return account
  4. Return Err (frontend must prompt user to pick)
```

All path comparisons use canonical absolute paths (resolve `~`, symlinks).

## Backend Architecture

### New module: `src-tauri/src/accounts/`

- `mod.rs` — `Account` struct, `AccountManager` struct
- `AccountManager` is registered as Tauri managed state (`AccountManagerState`)
- Shares the SQLite connection with `AgentDb` (same `agents.db` file)

### AccountManager API

```rust
pub struct AccountManager { db: Arc<Mutex<Connection>> }

impl AccountManager {
    // Resolution
    fn resolve(&self, project_path: &str) -> Result<Account>
    fn resolve_config_dir(&self, project_path: &str) -> Result<PathBuf>

    // CRUD
    fn list_accounts(&self) -> Vec<Account>
    fn create_account(&self, name, config_dir, is_default) -> Result<Account>
    fn delete_account(&self, id) -> Result<()>
    fn set_default(&self, id) -> Result<()>
    fn update_account(&self, id, name, config_dir) -> Result<()>

    // Path rules
    fn add_path_rule(&self, account_id, path_prefix) -> Result<()>
    fn remove_path_rule(&self, rule_id) -> Result<()>
    fn list_path_rules(&self) -> Vec<PathRule>

    // Overrides
    fn set_project_override(&self, project_path, account_id) -> Result<()>

    // Auto-discovery
    fn discover_accounts() -> Vec<(String, PathBuf)>  // scans ~/.claude-*
}
```

### New Tauri commands (in `src-tauri/src/commands/accounts.rs`)

- `list_accounts`, `create_account`, `delete_account`, `set_default_account`
- `list_path_rules`, `add_path_rule`, `remove_path_rule`
- `resolve_account_for_project`, `set_project_account_override`
- `discover_accounts` (for first-launch flow)

### Changes to existing commands

**Pattern:** `get_claude_dir()` → `account_mgr.resolve_config_dir(project_path)`

**Project-scoped commands** (already receive a project_path, just need account resolution):
- `get_session_messages`, `get_session_todos`
- `get_project_settings`, `save_project_settings`
- `get_claude_md_content`, `save_claude_md_content`
- `get_session_checkpoints`, `restore_checkpoint`, `fork_session`

**Listing commands** (must aggregate across all accounts):
- `get_projects` — iterate all accounts, merge project lists, tag each with account info
- `get_project_sessions` — resolve account from project path, read from correct config dir
- `get_usage_data` (usage.rs) — aggregate across accounts or filter by account

**Process spawning** (agents.rs, claude.rs):
- Resolve account for the target project
- Set `CLAUDE_CONFIG_DIR` env var on the spawned `claude` process
- Record `account_id` on new `agent_runs` rows

### CheckpointState changes

Remove the global `claude_dir: Arc<RwLock<Option<PathBuf>>>` field. Instead, callers of `get_or_create_manager` must pass the resolved `claude_dir` (obtained from `AccountManager.resolve_config_dir()` in the Tauri command handler). This keeps CheckpointState decoupled from AccountManager — the command layer does the resolution, checkpoint layer receives the path. The `set_claude_dir()` call in `main.rs` is removed.

### Initialization (main.rs)

```
1. init_database() — creates tables including new account tables
2. Create AccountManager with shared DB connection
3. Register AccountManagerState as Tauri managed state
4. If accounts table is empty → run discover_accounts()
   - Scan ~/.claude-* directories
   - Create account rows for each discovered dir
   - Name derived from dir suffix (e.g., "personal" from ".claude-personal")
```

## Frontend Architecture

### New TypeScript types (api.ts)

```typescript
interface Account {
  id: number;
  name: string;
  config_dir: string;
  is_default: boolean;
}

interface PathRule {
  id: number;
  account_id: number;
  account_name: string;  // joined for display
  path_prefix: string;
  priority: number;
}

// Extend existing Project type
interface Project {
  // ...existing fields
  account_id?: number;
  account_name?: string;
}
```

### New API functions (api.ts)

- `listAccounts()`, `createAccount()`, `deleteAccount()`, `setDefaultAccount()`
- `listPathRules()`, `addPathRule()`, `removePathRule()`
- `resolveAccountForProject(path)`, `setProjectAccountOverride(path, accountId)`
- `discoverAccounts()`

### New components

- **`AccountBadge.tsx`** — colored pill showing account name. Used in ProjectList and SessionList.
- **`AccountPickerDialog.tsx`** — modal shown when opening a project with no matching rule. Lists accounts, has "Remember for this project" checkbox.
- **`AccountSettings.tsx`** — new tab in Settings. Lists accounts (add/remove/set default), lists path rules (add/remove), shows overrides.

### Changes to existing components

- **`ProjectList.tsx`** — render `AccountBadge` next to each project. Projects now include `account_name`.
- **`Settings.tsx`** — add "Accounts" tab that renders `AccountSettings`.
- **`App.tsx`** — when navigating to a project, check account resolution. If unresolved, show `AccountPickerDialog` before proceeding.
- **`SessionList.tsx`** — no structural changes; sessions are already scoped by project, which is now scoped by account.
- **`AgentRunsList.tsx`** — show account badge on runs that have `account_id`.

## Auto-Discovery Flow (First Launch)

```
1. App starts, init_database creates account tables
2. AccountManager checks: SELECT COUNT(*) FROM accounts
3. If 0 → run discover_accounts():
   a. List directories matching ~/.claude-* in home dir
   b. Filter to dirs that look like Claude config dirs (contain projects/ or settings.json or .claude.json)
   c. For each: extract name from suffix, create account row
   d. If multiple accounts found, mark none as default (user picks in settings)
   e. If only one found, mark it as default
4. Frontend detects accounts exist, renders normally
```

## Edge Cases

- **No accounts discovered**: App shows a setup prompt directing user to add an account in Settings. Existing `~/.claude` is offered as a candidate if it has content.
- **Account config dir deleted**: Commands that try to read from it get a clear error. Account remains in DB but is marked as unavailable in the UI.
- **Same project opened with different accounts**: The override table stores one account per project. Changing it re-scopes future sessions. Historical sessions remain in the original account's config dir.
- **Account name collision during discovery**: Append a number (e.g., "personal-2").
