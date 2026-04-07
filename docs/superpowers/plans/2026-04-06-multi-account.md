# Multi-Account Support Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow opcode to work with multiple Claude accounts (e.g., claude-personal and claude-work) by making the config directory account-aware, with per-project account binding via path prefix rules.

**Architecture:** New `AccountManager` Tauri managed state resolves which `CLAUDE_CONFIG_DIR` to use for a given project path. Resolution uses a three-table model: explicit per-project overrides, path prefix rules, and a default account fallback. All existing commands that hardcode `~/.claude` are updated to resolve through the AccountManager. The frontend adds account badges to projects, a picker dialog for unresolved projects, and an Accounts settings tab.

**Tech Stack:** Rust (Tauri 2, rusqlite, tokio), TypeScript (React 18, shadcn/ui), SQLite

**Spec:** `docs/superpowers/specs/2026-04-06-multi-account-design.md`

---

## File Structure

### New Files (Backend)
- `src-tauri/src/accounts/mod.rs` — `Account`, `PathRule`, `ProjectOverride` structs + `AccountManager` with resolution logic, CRUD, and auto-discovery
- `src-tauri/src/commands/accounts.rs` — Tauri command handlers for account management

### New Files (Frontend)
- `src/components/AccountBadge.tsx` — Colored pill badge showing account name
- `src/components/AccountPickerDialog.tsx` — Modal for selecting account when project has no matching rule
- `src/components/AccountSettings.tsx` — Settings tab for managing accounts and path rules

### Modified Files (Backend)
- `src-tauri/src/main.rs` — Register AccountManager state, auto-discover on first launch, register new commands
- `src-tauri/src/commands/mod.rs` — Add `pub mod accounts;`
- `src-tauri/src/lib.rs` or `src-tauri/src/main.rs` — Add `mod accounts;`
- `src-tauri/src/commands/agents.rs` — Add `account_id` column migration to `init_database()`, pass `CLAUDE_CONFIG_DIR` in process spawning, update hardcoded `.claude` paths
- `src-tauri/src/commands/claude.rs` — Replace `get_claude_dir()` calls with account-aware resolution in `list_projects`, `get_project_sessions`, `load_session_history`, settings commands, checkpoint commands
- `src-tauri/src/commands/usage.rs` — Replace 4 hardcoded `.claude` paths with account-aware aggregation
- `src-tauri/src/checkpoint/state.rs` — Remove global `claude_dir` field, accept `claude_dir` as parameter in `get_or_create_manager`

### Modified Files (Frontend)
- `src/lib/api.ts` — Add `Account`, `PathRule` types; add account API functions; extend `Project` with `account_id`/`account_name`
- `src/components/ProjectList.tsx` — Render `AccountBadge` per project
- `src/components/Settings.tsx` — Add "Accounts" tab
- `src/components/App.tsx` — Integrate `AccountPickerDialog` into open-project flow
- `src/components/AgentRunsList.tsx` — Show account badge on runs

---

## Task 1: Database Schema — Account Tables

**Files:**
- Modify: `src-tauri/src/commands/agents.rs` (inside `init_database()`, after line 343)

- [ ] **Step 1: Add account tables to init_database()**

In `src-tauri/src/commands/agents.rs`, add the following after the `app_settings` trigger creation (after line 343, before `Ok(conn)`):

```rust
    // Create accounts table
    conn.execute(
        "CREATE TABLE IF NOT EXISTS accounts (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT UNIQUE NOT NULL,
            config_dir TEXT NOT NULL,
            is_default BOOLEAN NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        )",
        [],
    )?;

    conn.execute(
        "CREATE TRIGGER IF NOT EXISTS update_accounts_timestamp
         AFTER UPDATE ON accounts
         FOR EACH ROW
         BEGIN
             UPDATE accounts SET updated_at = CURRENT_TIMESTAMP WHERE id = NEW.id;
         END",
        [],
    )?;

    // Create account path rules table
    conn.execute(
        "CREATE TABLE IF NOT EXISTS account_path_rules (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            account_id INTEGER NOT NULL,
            path_prefix TEXT NOT NULL,
            priority INTEGER NOT NULL DEFAULT 0,
            FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
        )",
        [],
    )?;

    // Create project account overrides table
    conn.execute(
        "CREATE TABLE IF NOT EXISTS project_account_overrides (
            project_path TEXT PRIMARY KEY,
            account_id INTEGER NOT NULL,
            FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
        )",
        [],
    )?;

    // Add account_id column to agent_runs (nullable for backwards compat)
    let _ = conn.execute(
        "ALTER TABLE agent_runs ADD COLUMN account_id INTEGER",
        [],
    );
```

- [ ] **Step 2: Verify it compiles**

Run: `cd src-tauri && cargo check 2>&1 | tail -5`
Expected: Compiles with no errors (warnings OK)

- [ ] **Step 3: Commit**

```bash
git add src-tauri/src/commands/agents.rs
git commit -m "feat(db): add account tables schema to init_database

Add accounts, account_path_rules, and project_account_overrides tables.
Add account_id column to agent_runs for tracking which account ran an agent."
```

---

## Task 2: AccountManager Module — Core Logic

**Files:**
- Create: `src-tauri/src/accounts/mod.rs`

- [ ] **Step 1: Create the accounts module**

Create `src-tauri/src/accounts/mod.rs`:

```rust
use anyhow::{Context, Result};
use log::info;
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::Mutex;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Account {
    pub id: i64,
    pub name: String,
    pub config_dir: String,
    pub is_default: bool,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PathRule {
    pub id: i64,
    pub account_id: i64,
    pub account_name: String,
    pub path_prefix: String,
    pub priority: i32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProjectOverride {
    pub project_path: String,
    pub account_id: i64,
    pub account_name: String,
}

pub struct AccountManager {
    db: Mutex<Connection>,
}

/// Tauri managed state wrapper
pub struct AccountManagerState(pub AccountManager);

impl AccountManager {
    pub fn new(conn: Connection) -> Self {
        Self {
            db: Mutex::new(conn),
        }
    }

    // ── Resolution ───────────────────────────────────────────────

    /// Resolve which account a project path belongs to.
    /// Returns None if no match found (caller should prompt user).
    pub fn resolve(&self, project_path: &str) -> Result<Option<Account>> {
        let conn = self.db.lock().map_err(|e| anyhow::anyhow!("{}", e))?;

        // 1. Check explicit project override
        let override_result: Option<Account> = conn
            .query_row(
                "SELECT a.id, a.name, a.config_dir, a.is_default, a.created_at, a.updated_at
                 FROM project_account_overrides o
                 JOIN accounts a ON a.id = o.account_id
                 WHERE o.project_path = ?1",
                params![project_path],
                |row| {
                    Ok(Account {
                        id: row.get(0)?,
                        name: row.get(1)?,
                        config_dir: row.get(2)?,
                        is_default: row.get(3)?,
                        created_at: row.get(4)?,
                        updated_at: row.get(5)?,
                    })
                },
            )
            .ok();

        if let Some(account) = override_result {
            return Ok(Some(account));
        }

        // 2. Check path prefix rules (longest match wins, then priority)
        let mut stmt = conn.prepare(
            "SELECT a.id, a.name, a.config_dir, a.is_default, a.created_at, a.updated_at, r.path_prefix
             FROM account_path_rules r
             JOIN accounts a ON a.id = r.account_id
             ORDER BY LENGTH(r.path_prefix) DESC, r.priority DESC",
        )?;

        let accounts: Vec<(Account, String)> = stmt
            .query_map([], |row| {
                Ok((
                    Account {
                        id: row.get(0)?,
                        name: row.get(1)?,
                        config_dir: row.get(2)?,
                        is_default: row.get(3)?,
                        created_at: row.get(4)?,
                        updated_at: row.get(5)?,
                    },
                    row.get::<_, String>(6)?,
                ))
            })?
            .filter_map(|r| r.ok())
            .collect();

        for (account, prefix) in accounts {
            if project_path.starts_with(&prefix) {
                return Ok(Some(account));
            }
        }

        // 3. Check default account
        let default_result: Option<Account> = conn
            .query_row(
                "SELECT id, name, config_dir, is_default, created_at, updated_at
                 FROM accounts WHERE is_default = 1 LIMIT 1",
                [],
                |row| {
                    Ok(Account {
                        id: row.get(0)?,
                        name: row.get(1)?,
                        config_dir: row.get(2)?,
                        is_default: row.get(3)?,
                        created_at: row.get(4)?,
                        updated_at: row.get(5)?,
                    })
                },
            )
            .ok();

        Ok(default_result)
    }

    /// Resolve the config directory for a project path.
    /// Returns the config_dir PathBuf or an error if unresolved.
    pub fn resolve_config_dir(&self, project_path: &str) -> Result<PathBuf> {
        self.resolve(project_path)?
            .map(|a| PathBuf::from(&a.config_dir))
            .context("No account configured for this project path")
    }

    // ── Account CRUD ─────────────────────────────────────────────

    pub fn list_accounts(&self) -> Result<Vec<Account>> {
        let conn = self.db.lock().map_err(|e| anyhow::anyhow!("{}", e))?;
        let mut stmt = conn.prepare(
            "SELECT id, name, config_dir, is_default, created_at, updated_at
             FROM accounts ORDER BY name",
        )?;
        let accounts = stmt
            .query_map([], |row| {
                Ok(Account {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    config_dir: row.get(2)?,
                    is_default: row.get(3)?,
                    created_at: row.get(4)?,
                    updated_at: row.get(5)?,
                })
            })?
            .filter_map(|r| r.ok())
            .collect();
        Ok(accounts)
    }

    pub fn create_account(
        &self,
        name: &str,
        config_dir: &str,
        is_default: bool,
    ) -> Result<Account> {
        let conn = self.db.lock().map_err(|e| anyhow::anyhow!("{}", e))?;

        // If setting as default, clear existing default
        if is_default {
            conn.execute("UPDATE accounts SET is_default = 0", [])?;
        }

        conn.execute(
            "INSERT INTO accounts (name, config_dir, is_default) VALUES (?1, ?2, ?3)",
            params![name, config_dir, is_default],
        )?;

        let id = conn.last_insert_rowid();
        conn.query_row(
            "SELECT id, name, config_dir, is_default, created_at, updated_at
             FROM accounts WHERE id = ?1",
            params![id],
            |row| {
                Ok(Account {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    config_dir: row.get(2)?,
                    is_default: row.get(3)?,
                    created_at: row.get(4)?,
                    updated_at: row.get(5)?,
                })
            },
        )
        .context("Failed to read created account")
    }

    pub fn update_account(&self, id: i64, name: &str, config_dir: &str) -> Result<()> {
        let conn = self.db.lock().map_err(|e| anyhow::anyhow!("{}", e))?;
        conn.execute(
            "UPDATE accounts SET name = ?1, config_dir = ?2 WHERE id = ?3",
            params![name, config_dir, id],
        )?;
        Ok(())
    }

    pub fn delete_account(&self, id: i64) -> Result<()> {
        let conn = self.db.lock().map_err(|e| anyhow::anyhow!("{}", e))?;
        conn.execute("DELETE FROM accounts WHERE id = ?1", params![id])?;
        Ok(())
    }

    pub fn set_default(&self, id: i64) -> Result<()> {
        let conn = self.db.lock().map_err(|e| anyhow::anyhow!("{}", e))?;
        conn.execute("UPDATE accounts SET is_default = 0", [])?;
        conn.execute(
            "UPDATE accounts SET is_default = 1 WHERE id = ?1",
            params![id],
        )?;
        Ok(())
    }

    // ── Path Rules ───────────────────────────────────────────────

    pub fn list_path_rules(&self) -> Result<Vec<PathRule>> {
        let conn = self.db.lock().map_err(|e| anyhow::anyhow!("{}", e))?;
        let mut stmt = conn.prepare(
            "SELECT r.id, r.account_id, a.name, r.path_prefix, r.priority
             FROM account_path_rules r
             JOIN accounts a ON a.id = r.account_id
             ORDER BY LENGTH(r.path_prefix) DESC, r.priority DESC",
        )?;
        let rules = stmt
            .query_map([], |row| {
                Ok(PathRule {
                    id: row.get(0)?,
                    account_id: row.get(1)?,
                    account_name: row.get(2)?,
                    path_prefix: row.get(3)?,
                    priority: row.get(4)?,
                })
            })?
            .filter_map(|r| r.ok())
            .collect();
        Ok(rules)
    }

    pub fn add_path_rule(
        &self,
        account_id: i64,
        path_prefix: &str,
        priority: i32,
    ) -> Result<()> {
        let conn = self.db.lock().map_err(|e| anyhow::anyhow!("{}", e))?;
        conn.execute(
            "INSERT INTO account_path_rules (account_id, path_prefix, priority) VALUES (?1, ?2, ?3)",
            params![account_id, path_prefix, priority],
        )?;
        Ok(())
    }

    pub fn remove_path_rule(&self, rule_id: i64) -> Result<()> {
        let conn = self.db.lock().map_err(|e| anyhow::anyhow!("{}", e))?;
        conn.execute(
            "DELETE FROM account_path_rules WHERE id = ?1",
            params![rule_id],
        )?;
        Ok(())
    }

    // ── Project Overrides ────────────────────────────────────────

    pub fn set_project_override(&self, project_path: &str, account_id: i64) -> Result<()> {
        let conn = self.db.lock().map_err(|e| anyhow::anyhow!("{}", e))?;
        conn.execute(
            "INSERT OR REPLACE INTO project_account_overrides (project_path, account_id)
             VALUES (?1, ?2)",
            params![project_path, account_id],
        )?;
        Ok(())
    }

    pub fn list_project_overrides(&self) -> Result<Vec<ProjectOverride>> {
        let conn = self.db.lock().map_err(|e| anyhow::anyhow!("{}", e))?;
        let mut stmt = conn.prepare(
            "SELECT o.project_path, o.account_id, a.name
             FROM project_account_overrides o
             JOIN accounts a ON a.id = o.account_id
             ORDER BY o.project_path",
        )?;
        let overrides = stmt
            .query_map([], |row| {
                Ok(ProjectOverride {
                    project_path: row.get(0)?,
                    account_id: row.get(1)?,
                    account_name: row.get(2)?,
                })
            })?
            .filter_map(|r| r.ok())
            .collect();
        Ok(overrides)
    }

    // ── Auto-Discovery ───────────────────────────────────────────

    /// Scan home directory for ~/.claude-* directories that look like Claude config dirs.
    /// Returns (suggested_name, path) pairs.
    pub fn discover_accounts() -> Vec<(String, PathBuf)> {
        let home = match dirs::home_dir() {
            Some(h) => h,
            None => return vec![],
        };

        let mut found = vec![];

        let entries = match std::fs::read_dir(&home) {
            Ok(e) => e,
            Err(_) => return vec![],
        };

        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();

            // Match .claude-* but not .claude itself or .claude.json
            if !name.starts_with(".claude-") || name.contains('.') && !name.starts_with(".claude-") {
                continue;
            }

            let path = entry.path();
            if !path.is_dir() {
                continue;
            }

            // Verify it looks like a Claude config dir
            let has_projects = path.join("projects").is_dir();
            let has_settings = path.join("settings.json").is_file();
            let has_claude_json = path.join(".claude.json").is_file();

            if has_projects || has_settings || has_claude_json {
                // Extract name from suffix: ".claude-personal" -> "personal"
                let suffix = name.strip_prefix(".claude-").unwrap_or(&name);
                info!("Discovered Claude account dir: {} -> {}", suffix, path.display());
                found.push((suffix.to_string(), path));
            }
        }

        found
    }

    /// Check if any accounts exist in the database
    pub fn has_accounts(&self) -> Result<bool> {
        let conn = self.db.lock().map_err(|e| anyhow::anyhow!("{}", e))?;
        let count: i64 = conn.query_row("SELECT COUNT(*) FROM accounts", [], |row| row.get(0))?;
        Ok(count > 0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection;

    fn setup_test_db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute(
            "CREATE TABLE accounts (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT UNIQUE NOT NULL,
                config_dir TEXT NOT NULL,
                is_default BOOLEAN NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            )",
            [],
        )
        .unwrap();
        conn.execute(
            "CREATE TABLE account_path_rules (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                account_id INTEGER NOT NULL,
                path_prefix TEXT NOT NULL,
                priority INTEGER NOT NULL DEFAULT 0,
                FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
            )",
            [],
        )
        .unwrap();
        conn.execute(
            "CREATE TABLE project_account_overrides (
                project_path TEXT PRIMARY KEY,
                account_id INTEGER NOT NULL,
                FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
            )",
            [],
        )
        .unwrap();
        conn
    }

    #[test]
    fn test_create_and_list_accounts() {
        let conn = setup_test_db();
        let mgr = AccountManager::new(conn);

        let account = mgr.create_account("personal", "/home/user/.claude-personal", true).unwrap();
        assert_eq!(account.name, "personal");
        assert!(account.is_default);

        let accounts = mgr.list_accounts().unwrap();
        assert_eq!(accounts.len(), 1);
        assert_eq!(accounts[0].name, "personal");
    }

    #[test]
    fn test_resolve_by_override() {
        let conn = setup_test_db();
        let mgr = AccountManager::new(conn);

        let personal = mgr.create_account("personal", "/home/user/.claude-personal", false).unwrap();
        let _work = mgr.create_account("work", "/home/user/.claude-work", false).unwrap();

        mgr.set_project_override("/home/user/random-project", personal.id).unwrap();

        let resolved = mgr.resolve("/home/user/random-project").unwrap().unwrap();
        assert_eq!(resolved.name, "personal");
    }

    #[test]
    fn test_resolve_by_path_prefix() {
        let conn = setup_test_db();
        let mgr = AccountManager::new(conn);

        let personal = mgr.create_account("personal", "/home/user/.claude-personal", false).unwrap();
        let work = mgr.create_account("work", "/home/user/.claude-work", false).unwrap();

        mgr.add_path_rule(personal.id, "/home/user/repos/personal/", 0).unwrap();
        mgr.add_path_rule(work.id, "/home/user/repos/work/", 0).unwrap();

        let resolved = mgr.resolve("/home/user/repos/personal/my-project").unwrap().unwrap();
        assert_eq!(resolved.name, "personal");

        let resolved = mgr.resolve("/home/user/repos/work/api-gateway").unwrap().unwrap();
        assert_eq!(resolved.name, "work");
    }

    #[test]
    fn test_resolve_longest_prefix_wins() {
        let conn = setup_test_db();
        let mgr = AccountManager::new(conn);

        let personal = mgr.create_account("personal", "/home/user/.claude-personal", false).unwrap();
        let work = mgr.create_account("work", "/home/user/.claude-work", false).unwrap();

        mgr.add_path_rule(personal.id, "/home/user/repos/", 0).unwrap();
        mgr.add_path_rule(work.id, "/home/user/repos/work/", 0).unwrap();

        // Longer prefix should win
        let resolved = mgr.resolve("/home/user/repos/work/project").unwrap().unwrap();
        assert_eq!(resolved.name, "work");

        // Shorter prefix catches everything else
        let resolved = mgr.resolve("/home/user/repos/other/project").unwrap().unwrap();
        assert_eq!(resolved.name, "personal");
    }

    #[test]
    fn test_resolve_falls_back_to_default() {
        let conn = setup_test_db();
        let mgr = AccountManager::new(conn);

        let _personal = mgr.create_account("personal", "/home/user/.claude-personal", true).unwrap();
        let _work = mgr.create_account("work", "/home/user/.claude-work", false).unwrap();

        // No rules, no override — should fall back to default
        let resolved = mgr.resolve("/some/random/path").unwrap().unwrap();
        assert_eq!(resolved.name, "personal");
    }

    #[test]
    fn test_resolve_returns_none_when_no_match() {
        let conn = setup_test_db();
        let mgr = AccountManager::new(conn);

        // Accounts exist but no default, no rules, no override
        let _personal = mgr.create_account("personal", "/home/user/.claude-personal", false).unwrap();

        let resolved = mgr.resolve("/some/random/path").unwrap();
        assert!(resolved.is_none());
    }

    #[test]
    fn test_override_takes_precedence_over_prefix() {
        let conn = setup_test_db();
        let mgr = AccountManager::new(conn);

        let personal = mgr.create_account("personal", "/home/user/.claude-personal", false).unwrap();
        let work = mgr.create_account("work", "/home/user/.claude-work", false).unwrap();

        // Rule says /repos/personal/ -> personal
        mgr.add_path_rule(personal.id, "/home/user/repos/personal/", 0).unwrap();
        // But override says this specific project -> work
        mgr.set_project_override("/home/user/repos/personal/special-project", work.id).unwrap();

        let resolved = mgr.resolve("/home/user/repos/personal/special-project").unwrap().unwrap();
        assert_eq!(resolved.name, "work");
    }

    #[test]
    fn test_set_default_clears_previous() {
        let conn = setup_test_db();
        let mgr = AccountManager::new(conn);

        let personal = mgr.create_account("personal", "/home/user/.claude-personal", true).unwrap();
        let work = mgr.create_account("work", "/home/user/.claude-work", false).unwrap();

        mgr.set_default(work.id).unwrap();

        let accounts = mgr.list_accounts().unwrap();
        let personal_updated = accounts.iter().find(|a| a.id == personal.id).unwrap();
        let work_updated = accounts.iter().find(|a| a.id == work.id).unwrap();

        assert!(!personal_updated.is_default);
        assert!(work_updated.is_default);
    }
}
```

- [ ] **Step 2: Register the module in the crate**

Add to `src-tauri/src/main.rs` at the top with the other `mod` declarations:

```rust
mod accounts;
```

- [ ] **Step 3: Run the tests**

Run: `cd src-tauri && cargo test accounts -- --nocapture 2>&1 | tail -20`
Expected: All 8 tests pass

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/accounts/mod.rs src-tauri/src/main.rs
git commit -m "feat(accounts): add AccountManager with resolution logic and tests

Implements account CRUD, path prefix rules, project overrides, and
auto-discovery of ~/.claude-* directories. Resolution algorithm:
override > longest prefix match > default > None."
```

---

## Task 3: Tauri Commands for Account Management

**Files:**
- Create: `src-tauri/src/commands/accounts.rs`
- Modify: `src-tauri/src/commands/mod.rs`

- [ ] **Step 1: Create the commands file**

Create `src-tauri/src/commands/accounts.rs`:

```rust
use crate::accounts::{Account, AccountManagerState, PathRule, ProjectOverride};
use tauri::State;

#[tauri::command]
pub async fn list_accounts(
    state: State<'_, AccountManagerState>,
) -> Result<Vec<Account>, String> {
    state.0.list_accounts().map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn create_account(
    state: State<'_, AccountManagerState>,
    name: String,
    config_dir: String,
    is_default: bool,
) -> Result<Account, String> {
    state
        .0
        .create_account(&name, &config_dir, is_default)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn update_account(
    state: State<'_, AccountManagerState>,
    id: i64,
    name: String,
    config_dir: String,
) -> Result<(), String> {
    state
        .0
        .update_account(id, &name, &config_dir)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn delete_account(
    state: State<'_, AccountManagerState>,
    id: i64,
) -> Result<(), String> {
    state.0.delete_account(id).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn set_default_account(
    state: State<'_, AccountManagerState>,
    id: i64,
) -> Result<(), String> {
    state.0.set_default(id).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn list_path_rules(
    state: State<'_, AccountManagerState>,
) -> Result<Vec<PathRule>, String> {
    state.0.list_path_rules().map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn add_path_rule(
    state: State<'_, AccountManagerState>,
    account_id: i64,
    path_prefix: String,
    priority: i32,
) -> Result<(), String> {
    state
        .0
        .add_path_rule(account_id, &path_prefix, priority)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn remove_path_rule(
    state: State<'_, AccountManagerState>,
    rule_id: i64,
) -> Result<(), String> {
    state
        .0
        .remove_path_rule(rule_id)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn resolve_account_for_project(
    state: State<'_, AccountManagerState>,
    project_path: String,
) -> Result<Option<Account>, String> {
    state.0.resolve(&project_path).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn set_project_account_override(
    state: State<'_, AccountManagerState>,
    project_path: String,
    account_id: i64,
) -> Result<(), String> {
    state
        .0
        .set_project_override(&project_path, account_id)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn list_project_overrides(
    state: State<'_, AccountManagerState>,
) -> Result<Vec<ProjectOverride>, String> {
    state
        .0
        .list_project_overrides()
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn discover_accounts() -> Result<Vec<(String, String)>, String> {
    let discovered = crate::accounts::AccountManager::discover_accounts();
    Ok(discovered
        .into_iter()
        .map(|(name, path)| (name, path.to_string_lossy().to_string()))
        .collect())
}
```

- [ ] **Step 2: Register the module in commands/mod.rs**

Add to `src-tauri/src/commands/mod.rs`:

```rust
pub mod accounts;
```

- [ ] **Step 3: Verify it compiles**

Run: `cd src-tauri && cargo check 2>&1 | tail -5`
Expected: Compiles with no errors

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/commands/accounts.rs src-tauri/src/commands/mod.rs
git commit -m "feat(accounts): add Tauri command handlers for account management

CRUD for accounts, path rules, project overrides, and auto-discovery."
```

---

## Task 4: Wire Up main.rs — State Registration and Auto-Discovery

**Files:**
- Modify: `src-tauri/src/main.rs`

- [ ] **Step 1: Add AccountManager initialization and auto-discovery**

In `src-tauri/src/main.rs`, after the line `app.manage(AgentDb(Mutex::new(conn)));` (line 121), add:

```rust
            // Initialize AccountManager with its own DB connection
            let account_db_path = app_dir.join("agents.db");
            let account_conn = rusqlite::Connection::open(&account_db_path)
                .expect("Failed to open DB for AccountManager");
            let account_manager = crate::accounts::AccountManager::new(account_conn);

            // Auto-discover accounts on first launch
            if !account_manager.has_accounts().unwrap_or(false) {
                let discovered = crate::accounts::AccountManager::discover_accounts();
                let count = discovered.len();
                for (name, path) in discovered {
                    let is_default = count == 1; // Only set default if exactly one found
                    let path_str = path.to_string_lossy().to_string();
                    if let Err(e) = account_manager.create_account(&name, &path_str, is_default) {
                        log::warn!("Failed to create discovered account '{}': {}", name, e);
                    } else {
                        log::info!("Auto-discovered account '{}' at {}", name, path_str);
                    }
                }
            }

            app.manage(crate::accounts::AccountManagerState(account_manager));
```

You'll also need to capture `app_dir` earlier. Find the line where `init_database` is called and capture the app dir path. Look for:
```rust
let conn = init_database(&app.handle()).expect("Failed to initialize agents database");
```

Before that line, add:
```rust
            let app_dir = app.path().app_data_dir().expect("Failed to get app data dir");
```

- [ ] **Step 2: Register the new commands in invoke_handler**

In the `.invoke_handler(tauri::generate_handler![...])` block, add these entries (e.g., after the Proxy Settings section):

```rust
    // Account Management
    commands::accounts::list_accounts,
    commands::accounts::create_account,
    commands::accounts::update_account,
    commands::accounts::delete_account,
    commands::accounts::set_default_account,
    commands::accounts::list_path_rules,
    commands::accounts::add_path_rule,
    commands::accounts::remove_path_rule,
    commands::accounts::resolve_account_for_project,
    commands::accounts::set_project_account_override,
    commands::accounts::list_project_overrides,
    commands::accounts::discover_accounts,
```

- [ ] **Step 3: Remove the old hardcoded CheckpointState claude_dir initialization**

Find and remove this block (lines ~126-140):

```rust
            // Set the Claude directory path
            if let Ok(claude_dir) = dirs::home_dir()
                .ok_or_else(|| "Could not find home directory")
                .and_then(|home| {
                    let claude_path = home.join(".claude");
                    claude_path
                        .canonicalize()
                        .map_err(|_| "Could not find ~/.claude directory")
                })
            {
                let state_clone = checkpoint_state.clone();
                tauri::async_runtime::spawn(async move {
                    state_clone.set_claude_dir(claude_dir).await;
                });
            }
```

Replace with just a comment:
```rust
            // Note: claude_dir is now resolved per-session via AccountManager
```

- [ ] **Step 4: Verify it compiles**

Run: `cd src-tauri && cargo check 2>&1 | tail -10`
Expected: Compiles (may have warnings about unused CheckpointState methods — that's OK, we'll clean those up in Task 8)

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/main.rs
git commit -m "feat(accounts): wire AccountManager into Tauri app lifecycle

Register AccountManager state, auto-discover ~/.claude-* on first launch,
register account management commands, remove hardcoded checkpoint claude_dir."
```

---

## Task 5: Update claude.rs — Account-Aware Project and Session Commands

**Files:**
- Modify: `src-tauri/src/commands/claude.rs`

This is the largest change. The pattern is: replace `get_claude_dir()` with account resolution.

- [ ] **Step 1: Add AccountManagerState import and helper**

At the top of `src-tauri/src/commands/claude.rs`, add the import:

```rust
use crate::accounts::AccountManagerState;
```

Add a helper function next to `get_claude_dir()`:

```rust
/// Gets the claude config dir for a given project path via account resolution.
/// Falls back to the old ~/.claude behavior if no accounts are configured.
fn get_claude_dir_for_project(
    account_mgr: &AccountManagerState,
    project_path: &str,
) -> Result<PathBuf> {
    match account_mgr.0.resolve_config_dir(project_path) {
        Ok(dir) => Ok(dir),
        Err(_) => get_claude_dir(), // fallback for backwards compat
    }
}
```

- [ ] **Step 2: Update list_projects to aggregate across accounts**

Find the `list_projects` command and update its signature and body. The current version calls `get_claude_dir()` once. The new version iterates all accounts:

Update the function signature to accept the account manager state:

```rust
#[tauri::command]
pub async fn list_projects(
    account_state: State<'_, AccountManagerState>,
) -> Result<Vec<Project>, String> {
```

Replace the body's `get_claude_dir()` call. Where it currently does:

```rust
    let claude_dir = get_claude_dir().map_err(|e| e.to_string())?;
    let projects_dir = claude_dir.join("projects");
```

Replace with iteration over all accounts. The function should collect projects from each account's `projects/` directory, and tag each `Project` with the account info. This requires adding `account_id` and `account_name` fields to the `Project` struct.

First, update the `Project` struct (near the top of claude.rs):

```rust
#[derive(Debug, Serialize, Deserialize)]
pub struct Project {
    pub id: String,
    pub path: String,
    pub sessions: Vec<String>,
    pub created_at: u64,
    pub most_recent_session: Option<u64>,
    pub account_id: Option<i64>,
    pub account_name: Option<String>,
}
```

Then update the `list_projects` body to iterate accounts:

```rust
    let accounts = account_state.0.list_accounts().map_err(|e| e.to_string())?;
    let mut all_projects: Vec<Project> = Vec::new();

    for account in &accounts {
        let projects_dir = PathBuf::from(&account.config_dir).join("projects");
        if !projects_dir.exists() {
            continue;
        }
        // ... existing directory iteration logic, but set account_id and account_name on each project
    }
```

Keep the existing per-directory logic intact — just wrap it in the account loop and set `account_id: Some(account.id)` and `account_name: Some(account.name.clone())` on each project. If `accounts` is empty, fall back to the old `get_claude_dir()` behavior with `account_id: None`.

- [ ] **Step 3: Update get_project_sessions to be account-aware**

Add `account_state: State<'_, AccountManagerState>` parameter. Where it currently calls `get_claude_dir()`, instead resolve the account from the project's path. The project_id encodes the path — you can decode it and resolve. Alternatively, since `get_project_sessions` receives a `project_id`, look up the project to get its path, then resolve.

The simplest approach: add a `project_path` parameter to `get_project_sessions`:

```rust
#[tauri::command]
pub async fn get_project_sessions(
    project_id: String,
    project_path: Option<String>,
    account_state: State<'_, AccountManagerState>,
) -> Result<Vec<Session>, String> {
```

Use `project_path` to resolve the account, or fall back to `get_claude_dir()` if not provided.

- [ ] **Step 4: Update load_session_history to be account-aware**

Same pattern — add `account_state` and `project_path` parameters, use them to find the correct config dir:

```rust
#[tauri::command]
pub async fn load_session_history(
    session_id: String,
    project_id: String,
    project_path: Option<String>,
    account_state: State<'_, AccountManagerState>,
) -> Result<Vec<serde_json::Value>, String> {
```

- [ ] **Step 5: Update settings commands**

For `get_claude_settings` and `save_claude_settings` — these read/write `~/.claude/settings.json`. They need to know which account's settings to use. Add `project_path` parameter:

```rust
#[tauri::command]
pub async fn get_claude_settings(
    project_path: Option<String>,
    account_state: State<'_, AccountManagerState>,
) -> Result<ClaudeSettings, String> {
    let claude_dir = match project_path {
        Some(ref path) => get_claude_dir_for_project(&account_state, path)
            .map_err(|e| e.to_string())?,
        None => get_claude_dir().map_err(|e| e.to_string())?,
    };
    let settings_path = claude_dir.join("settings.json");
    // ... rest unchanged
```

Apply the same pattern to `save_claude_settings`, `get_system_prompt`, `save_system_prompt`, `get_claude_md_content`, `save_claude_md_content`.

- [ ] **Step 6: Update scoped settings commands**

The `get_hooks_config` and `update_hooks_config` commands, and the scoped settings reading/writing at the bottom of the file, need the same treatment. The "user" scope should resolve via account.

- [ ] **Step 7: Update checkpoint commands**

For `create_checkpoint`, `list_checkpoints`, `restore_checkpoint`, `fork_from_checkpoint`, `get_session_timeline`, `get_checkpoint_diff`, `track_checkpoint_message`, `check_auto_checkpoint` — these all go through `CheckpointState`. They need to resolve `claude_dir` from the account and pass it. See Task 8 for the CheckpointState changes.

- [ ] **Step 8: Update execute_claude_code and continue_claude_code**

These spawn a claude process. After finding the binary, set `CLAUDE_CONFIG_DIR`:

```rust
    let account = account_state.0.resolve(&project_path).map_err(|e| e.to_string())?;
    // ... when building the command:
    if let Some(account) = &account {
        cmd.env("CLAUDE_CONFIG_DIR", &account.config_dir);
    }
```

- [ ] **Step 9: Verify it compiles**

Run: `cd src-tauri && cargo check 2>&1 | tail -10`
Expected: Compiles (warnings OK)

- [ ] **Step 10: Commit**

```bash
git add src-tauri/src/commands/claude.rs
git commit -m "feat(accounts): make claude.rs commands account-aware

Replace get_claude_dir() calls with account resolution. list_projects
aggregates across all accounts. Session, settings, and checkpoint commands
resolve config dir from project path. Process spawning sets CLAUDE_CONFIG_DIR."
```

---

## Task 6: Update agents.rs — Process Spawning with CLAUDE_CONFIG_DIR

**Files:**
- Modify: `src-tauri/src/commands/agents.rs`

- [ ] **Step 1: Add AccountManagerState to execute_agent**

Update the `execute_agent` function signature to include the account state:

```rust
#[tauri::command]
pub async fn execute_agent(
    app: AppHandle,
    agent_id: i64,
    project_path: String,
    task: String,
    model: Option<String>,
    db: State<'_, AgentDb>,
    registry: State<'_, crate::process::ProcessRegistryState>,
    account_state: State<'_, crate::accounts::AccountManagerState>,
) -> Result<i64, String> {
```

- [ ] **Step 2: Resolve account and set CLAUDE_CONFIG_DIR in process spawning**

After finding the claude binary and before spawning the process, resolve the account:

```rust
    let account = account_state.0.resolve(&project_path).map_err(|e| e.to_string())?;
    let account_id = account.as_ref().map(|a| a.id);
```

In the `create_agent_system_command` function (or wherever the `Command` is built), add the env var:

```rust
    if let Some(ref acct) = account {
        cmd.env("CLAUDE_CONFIG_DIR", &acct.config_dir);
    }
```

- [ ] **Step 3: Record account_id on agent_runs**

When inserting the new agent_run row, include `account_id`:

```rust
    conn.execute(
        "INSERT INTO agent_runs (agent_id, agent_name, agent_icon, task, model, project_path, session_id, status, account_id)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'pending', ?8)",
        params![agent_id, agent.name, agent.icon, task, execution_model, project_path, "", account_id],
    )
```

- [ ] **Step 4: Update AgentRun struct to include account fields**

```rust
pub struct AgentRun {
    // ... existing fields ...
    pub account_id: Option<i64>,
    pub account_name: Option<String>,
}
```

Update the query in `list_agent_runs` and `get_agent_run` to LEFT JOIN accounts:

```rust
    "SELECT r.id, r.agent_id, r.agent_name, r.agent_icon, r.task, r.model,
            r.project_path, r.session_id, r.status, r.pid, r.process_started_at,
            r.created_at, r.completed_at, r.account_id, a.name as account_name
     FROM agent_runs r
     LEFT JOIN accounts a ON a.id = r.account_id
     ORDER BY r.created_at DESC"
```

- [ ] **Step 5: Update hardcoded .claude paths in agents.rs**

Find the `load_agent_session_history` function (line ~1369) and other places that do `dirs::home_dir().join(".claude")`. These should resolve via account. Where a `project_path` is available, use account resolution. Where not (like `load_agent_session_history` which only gets a `session_id`), search across all accounts.

- [ ] **Step 6: Verify it compiles**

Run: `cd src-tauri && cargo check 2>&1 | tail -10`
Expected: Compiles

- [ ] **Step 7: Commit**

```bash
git add src-tauri/src/commands/agents.rs
git commit -m "feat(accounts): set CLAUDE_CONFIG_DIR when spawning agent processes

Resolve account for project, pass config dir as env var, record account_id
on agent_runs, include account_name in run queries."
```

---

## Task 7: Update usage.rs — Aggregate Across Accounts

**Files:**
- Modify: `src-tauri/src/commands/usage.rs`

- [ ] **Step 1: Add AccountManagerState to usage commands**

All four functions (`get_usage_stats`, `get_usage_by_date_range`, `get_usage_details`, `get_session_stats`) hardcode `dirs::home_dir().join(".claude")`. Update each to accept `account_state: State<'_, crate::accounts::AccountManagerState>` and iterate all account config dirs:

```rust
#[tauri::command]
pub async fn get_usage_stats(
    account_state: State<'_, crate::accounts::AccountManagerState>,
) -> Result<UsageStats, String> {
    let accounts = account_state.0.list_accounts().map_err(|e| e.to_string())?;

    let claude_paths: Vec<PathBuf> = if accounts.is_empty() {
        // Fallback to ~/.claude
        vec![dirs::home_dir()
            .ok_or("Failed to get home directory")?
            .join(".claude")]
    } else {
        accounts.iter().map(|a| PathBuf::from(&a.config_dir)).collect()
    };

    // Aggregate usage across all account config dirs
    // ... iterate claude_paths instead of single claude_path
```

- [ ] **Step 2: Verify it compiles**

Run: `cd src-tauri && cargo check 2>&1 | tail -5`

- [ ] **Step 3: Commit**

```bash
git add src-tauri/src/commands/usage.rs
git commit -m "feat(accounts): aggregate usage data across all accounts

Usage commands now iterate all account config dirs instead of hardcoded ~/.claude."
```

---

## Task 8: Update CheckpointState — Remove Global claude_dir

**Files:**
- Modify: `src-tauri/src/checkpoint/state.rs`

- [ ] **Step 1: Remove the claude_dir field and set_claude_dir method**

In the `CheckpointState` struct, remove:
```rust
    claude_dir: Arc<RwLock<Option<PathBuf>>>,
```

Remove the `set_claude_dir` method.

- [ ] **Step 2: Update get_or_create_manager to accept claude_dir as parameter**

Change the signature from:
```rust
pub async fn get_or_create_manager(
    &self,
    session_id: String,
    project_id: String,
    project_path: PathBuf,
) -> Result<Arc<CheckpointManager>, String> {
```

To:
```rust
pub async fn get_or_create_manager(
    &self,
    session_id: String,
    project_id: String,
    project_path: PathBuf,
    claude_dir: PathBuf,
) -> Result<Arc<CheckpointManager>, String> {
```

Remove the internal `claude_dir` read from the RwLock and use the parameter directly.

- [ ] **Step 3: Update all callers in claude.rs**

Find every call to `checkpoint_state.get_or_create_manager(...)` in `commands/claude.rs` and add the `claude_dir` argument. The claude_dir comes from account resolution:

```rust
    let claude_dir = get_claude_dir_for_project(&account_state, &project_path)
        .map_err(|e| e.to_string())?;
    let manager = checkpoint_state
        .get_or_create_manager(session_id, project_id, project_path.into(), claude_dir)
        .await?;
```

- [ ] **Step 4: Update test in state.rs**

Update `test_checkpoint_state_lifecycle` to pass `claude_dir` to `get_or_create_manager`.

- [ ] **Step 5: Verify tests pass**

Run: `cd src-tauri && cargo test checkpoint -- --nocapture 2>&1 | tail -10`
Expected: Tests pass

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/checkpoint/state.rs src-tauri/src/commands/claude.rs
git commit -m "refactor(checkpoint): remove global claude_dir, accept as parameter

Callers now pass the resolved claude_dir from account resolution instead
of relying on a global mutable field."
```

---

## Task 9: Frontend — TypeScript Types and API Functions

**Files:**
- Modify: `src/lib/api.ts`

- [ ] **Step 1: Add Account and PathRule types**

Add near the top of `src/lib/api.ts`, after the existing interface definitions:

```typescript
/**
 * Represents a Claude account (e.g., personal, work)
 */
export interface Account {
  id: number;
  name: string;
  config_dir: string;
  is_default: boolean;
  created_at: string;
  updated_at: string;
}

/**
 * Represents a path prefix rule that maps directories to accounts
 */
export interface PathRule {
  id: number;
  account_id: number;
  account_name: string;
  path_prefix: string;
  priority: number;
}

/**
 * Represents an explicit project-to-account override
 */
export interface ProjectOverride {
  project_path: string;
  account_id: number;
  account_name: string;
}
```

- [ ] **Step 2: Extend Project interface**

Update the existing `Project` interface:

```typescript
export interface Project {
  id: string;
  path: string;
  sessions: string[];
  created_at: number;
  most_recent_session?: number;
  account_id?: number;
  account_name?: string;
}
```

- [ ] **Step 3: Add API functions**

Add these functions to the `api` object (inside the existing api export):

```typescript
  // Account Management
  async listAccounts(): Promise<Account[]> {
    return apiCall<Account[]>('list_accounts');
  },

  async createAccount(name: string, configDir: string, isDefault: boolean): Promise<Account> {
    return apiCall<Account>('create_account', { name, configDir, isDefault });
  },

  async updateAccount(id: number, name: string, configDir: string): Promise<void> {
    return apiCall<void>('update_account', { id, name, configDir });
  },

  async deleteAccount(id: number): Promise<void> {
    return apiCall<void>('delete_account', { id });
  },

  async setDefaultAccount(id: number): Promise<void> {
    return apiCall<void>('set_default_account', { id });
  },

  async listPathRules(): Promise<PathRule[]> {
    return apiCall<PathRule[]>('list_path_rules');
  },

  async addPathRule(accountId: number, pathPrefix: string, priority: number = 0): Promise<void> {
    return apiCall<void>('add_path_rule', { accountId, pathPrefix, priority });
  },

  async removePathRule(ruleId: number): Promise<void> {
    return apiCall<void>('remove_path_rule', { ruleId });
  },

  async resolveAccountForProject(projectPath: string): Promise<Account | null> {
    return apiCall<Account | null>('resolve_account_for_project', { projectPath });
  },

  async setProjectAccountOverride(projectPath: string, accountId: number): Promise<void> {
    return apiCall<void>('set_project_account_override', { projectPath, accountId });
  },

  async listProjectOverrides(): Promise<ProjectOverride[]> {
    return apiCall<ProjectOverride[]>('list_project_overrides');
  },

  async discoverAccounts(): Promise<[string, string][]> {
    return apiCall<[string, string][]>('discover_accounts');
  },
```

- [ ] **Step 4: Verify TypeScript compiles**

Run: `npx tsc --noEmit 2>&1 | tail -10`
Expected: No new errors (existing errors OK)

- [ ] **Step 5: Commit**

```bash
git add src/lib/api.ts
git commit -m "feat(frontend): add Account types and API functions

Add Account, PathRule, ProjectOverride interfaces. Extend Project with
account_id/account_name. Add 12 account management API functions."
```

---

## Task 10: Frontend — AccountBadge Component

**Files:**
- Create: `src/components/AccountBadge.tsx`

- [ ] **Step 1: Create the AccountBadge component**

Create `src/components/AccountBadge.tsx`:

```typescript
import React from "react";
import { cn } from "@/lib/utils";

// Stable color palette for account badges — maps account name to a color
const ACCOUNT_COLORS: Record<string, string> = {
  personal: "bg-blue-500/20 text-blue-400 border-blue-500/30",
  work: "bg-purple-500/20 text-purple-400 border-purple-500/30",
};

const FALLBACK_COLORS = [
  "bg-emerald-500/20 text-emerald-400 border-emerald-500/30",
  "bg-amber-500/20 text-amber-400 border-amber-500/30",
  "bg-rose-500/20 text-rose-400 border-rose-500/30",
  "bg-cyan-500/20 text-cyan-400 border-cyan-500/30",
];

function getColorForAccount(name: string): string {
  if (ACCOUNT_COLORS[name]) return ACCOUNT_COLORS[name];
  // Deterministic fallback based on name hash
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = name.charCodeAt(i) + ((hash << 5) - hash);
  }
  return FALLBACK_COLORS[Math.abs(hash) % FALLBACK_COLORS.length];
}

interface AccountBadgeProps {
  name: string;
  className?: string;
}

export const AccountBadge: React.FC<AccountBadgeProps> = ({ name, className }) => {
  const colorClass = getColorForAccount(name);
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium",
        colorClass,
        className
      )}
    >
      {name}
    </span>
  );
};
```

- [ ] **Step 2: Commit**

```bash
git add src/components/AccountBadge.tsx
git commit -m "feat(frontend): add AccountBadge component

Colored pill badge with stable color mapping for account names."
```

---

## Task 11: Frontend — AccountPickerDialog Component

**Files:**
- Create: `src/components/AccountPickerDialog.tsx`

- [ ] **Step 1: Create the dialog component**

Create `src/components/AccountPickerDialog.tsx`:

```typescript
import React, { useEffect, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { api, type Account } from "@/lib/api";
import { AccountBadge } from "@/components/AccountBadge";
import { cn } from "@/lib/utils";

interface AccountPickerDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectPath: string;
  onAccountSelected: (account: Account) => void;
}

export const AccountPickerDialog: React.FC<AccountPickerDialogProps> = ({
  open,
  onOpenChange,
  projectPath,
  onAccountSelected,
}) => {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [remember, setRemember] = useState(true);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (open) {
      api.listAccounts().then(setAccounts).catch(console.error);
      setSelectedId(null);
    }
  }, [open]);

  const handleConfirm = async () => {
    if (selectedId === null) return;
    setLoading(true);
    try {
      if (remember) {
        await api.setProjectAccountOverride(projectPath, selectedId);
      }
      const account = accounts.find((a) => a.id === selectedId);
      if (account) {
        onAccountSelected(account);
      }
      onOpenChange(false);
    } catch (error) {
      console.error("Failed to set account:", error);
    } finally {
      setLoading(false);
    }
  };

  // Extract project name from path for display
  const projectName = projectPath.split("/").filter(Boolean).pop() || projectPath;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[420px]">
        <DialogHeader>
          <DialogTitle>Which account for this project?</DialogTitle>
          <DialogDescription className="font-mono text-xs">
            {projectName}
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-2 my-2">
          {accounts.map((account) => (
            <button
              key={account.id}
              onClick={() => setSelectedId(account.id)}
              className={cn(
                "flex items-center gap-3 px-4 py-3 rounded-lg border text-left transition-colors",
                selectedId === account.id
                  ? "border-primary bg-primary/10"
                  : "border-border hover:border-primary/50 hover:bg-muted/50"
              )}
            >
              <AccountBadge name={account.name} />
              <span className="text-xs text-muted-foreground truncate">
                {account.config_dir}
              </span>
            </button>
          ))}
        </div>

        <label className="flex items-center gap-2 text-sm text-muted-foreground cursor-pointer">
          <input
            type="checkbox"
            checked={remember}
            onChange={(e) => setRemember(e.target.checked)}
            className="rounded"
          />
          Remember for this project
        </label>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={handleConfirm} disabled={selectedId === null || loading}>
            {loading ? "Saving..." : "Select"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
```

- [ ] **Step 2: Commit**

```bash
git add src/components/AccountPickerDialog.tsx
git commit -m "feat(frontend): add AccountPickerDialog for unresolved projects

Shows when a project has no matching path rule or override. User picks
an account with option to remember the choice."
```

---

## Task 12: Frontend — AccountSettings Component

**Files:**
- Create: `src/components/AccountSettings.tsx`

- [ ] **Step 1: Create the settings component**

Create `src/components/AccountSettings.tsx`:

```typescript
import React, { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api, type Account, type PathRule } from "@/lib/api";
import { AccountBadge } from "@/components/AccountBadge";
import { Trash2, Plus, Star } from "lucide-react";

export const AccountSettings: React.FC = () => {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [pathRules, setPathRules] = useState<PathRule[]>([]);
  const [newAccountName, setNewAccountName] = useState("");
  const [newAccountDir, setNewAccountDir] = useState("");
  const [newRulePrefix, setNewRulePrefix] = useState("");
  const [newRuleAccountId, setNewRuleAccountId] = useState<number | null>(null);
  const [showAddAccount, setShowAddAccount] = useState(false);
  const [showAddRule, setShowAddRule] = useState(false);

  const loadData = async () => {
    try {
      const [accts, rules] = await Promise.all([
        api.listAccounts(),
        api.listPathRules(),
      ]);
      setAccounts(accts);
      setPathRules(rules);
    } catch (error) {
      console.error("Failed to load account data:", error);
    }
  };

  useEffect(() => {
    loadData();
  }, []);

  const handleCreateAccount = async () => {
    if (!newAccountName.trim() || !newAccountDir.trim()) return;
    try {
      await api.createAccount(newAccountName.trim(), newAccountDir.trim(), accounts.length === 0);
      setNewAccountName("");
      setNewAccountDir("");
      setShowAddAccount(false);
      await loadData();
    } catch (error) {
      console.error("Failed to create account:", error);
    }
  };

  const handleDeleteAccount = async (id: number) => {
    try {
      await api.deleteAccount(id);
      await loadData();
    } catch (error) {
      console.error("Failed to delete account:", error);
    }
  };

  const handleSetDefault = async (id: number) => {
    try {
      await api.setDefaultAccount(id);
      await loadData();
    } catch (error) {
      console.error("Failed to set default:", error);
    }
  };

  const handleAddRule = async () => {
    if (!newRulePrefix.trim() || newRuleAccountId === null) return;
    try {
      await api.addPathRule(newRuleAccountId, newRulePrefix.trim());
      setNewRulePrefix("");
      setNewRuleAccountId(null);
      setShowAddRule(false);
      await loadData();
    } catch (error) {
      console.error("Failed to add path rule:", error);
    }
  };

  const handleRemoveRule = async (ruleId: number) => {
    try {
      await api.removePathRule(ruleId);
      await loadData();
    } catch (error) {
      console.error("Failed to remove rule:", error);
    }
  };

  return (
    <div className="space-y-6">
      {/* Accounts Section */}
      <div>
        <h3 className="text-sm font-semibold mb-3">Accounts</h3>
        <div className="space-y-2">
          {accounts.map((account) => (
            <div
              key={account.id}
              className="flex items-center gap-3 px-3 py-2.5 rounded-lg border border-border bg-muted/30"
            >
              <AccountBadge name={account.name} />
              <span className="text-xs text-muted-foreground flex-1 truncate">
                {account.config_dir}
              </span>
              {account.is_default && (
                <span className="text-[10px] font-medium text-emerald-400">DEFAULT</span>
              )}
              {!account.is_default && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 px-2 text-xs text-muted-foreground"
                  onClick={() => handleSetDefault(account.id)}
                  title="Set as default"
                >
                  <Star className="w-3 h-3" />
                </Button>
              )}
              <Button
                variant="ghost"
                size="sm"
                className="h-6 px-2 text-xs text-muted-foreground hover:text-destructive"
                onClick={() => handleDeleteAccount(account.id)}
              >
                <Trash2 className="w-3 h-3" />
              </Button>
            </div>
          ))}
        </div>

        {showAddAccount ? (
          <div className="mt-3 space-y-2 p-3 rounded-lg border border-dashed border-border">
            <Input
              placeholder="Account name (e.g., personal)"
              value={newAccountName}
              onChange={(e) => setNewAccountName(e.target.value)}
              className="h-8 text-sm"
            />
            <Input
              placeholder="Config directory (e.g., ~/.claude-personal)"
              value={newAccountDir}
              onChange={(e) => setNewAccountDir(e.target.value)}
              className="h-8 text-sm"
            />
            <div className="flex gap-2">
              <Button size="sm" onClick={handleCreateAccount} className="h-7 text-xs">
                Add
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => setShowAddAccount(false)}
                className="h-7 text-xs"
              >
                Cancel
              </Button>
            </div>
          </div>
        ) : (
          <Button
            variant="link"
            size="sm"
            className="mt-2 h-6 px-0 text-xs"
            onClick={() => setShowAddAccount(true)}
          >
            <Plus className="w-3 h-3 mr-1" />
            Add account
          </Button>
        )}
      </div>

      {/* Path Rules Section */}
      <div>
        <h3 className="text-sm font-semibold mb-3">Path Rules</h3>
        <p className="text-xs text-muted-foreground mb-3">
          Projects under these paths are automatically assigned to the matching account.
        </p>
        <div className="space-y-2">
          {pathRules.map((rule) => (
            <div
              key={rule.id}
              className="flex items-center gap-3 px-3 py-2.5 rounded-lg border border-border bg-muted/30"
            >
              <code className="text-xs flex-1 text-foreground">{rule.path_prefix}</code>
              <span className="text-muted-foreground text-xs">→</span>
              <AccountBadge name={rule.account_name} />
              <Button
                variant="ghost"
                size="sm"
                className="h-6 px-2 text-xs text-muted-foreground hover:text-destructive"
                onClick={() => handleRemoveRule(rule.id)}
              >
                <Trash2 className="w-3 h-3" />
              </Button>
            </div>
          ))}
        </div>

        {showAddRule ? (
          <div className="mt-3 space-y-2 p-3 rounded-lg border border-dashed border-border">
            <Input
              placeholder="Path prefix (e.g., ~/Repos/personal/)"
              value={newRulePrefix}
              onChange={(e) => setNewRulePrefix(e.target.value)}
              className="h-8 text-sm"
            />
            <select
              value={newRuleAccountId ?? ""}
              onChange={(e) => setNewRuleAccountId(Number(e.target.value) || null)}
              className="w-full h-8 text-sm rounded-md border border-border bg-background px-3"
            >
              <option value="">Select account...</option>
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
            <div className="flex gap-2">
              <Button size="sm" onClick={handleAddRule} className="h-7 text-xs">
                Add
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => setShowAddRule(false)}
                className="h-7 text-xs"
              >
                Cancel
              </Button>
            </div>
          </div>
        ) : (
          <Button
            variant="link"
            size="sm"
            className="mt-2 h-6 px-0 text-xs"
            onClick={() => setShowAddRule(true)}
          >
            <Plus className="w-3 h-3 mr-1" />
            Add rule
          </Button>
        )}
      </div>
    </div>
  );
};
```

- [ ] **Step 2: Commit**

```bash
git add src/components/AccountSettings.tsx
git commit -m "feat(frontend): add AccountSettings component for Settings tab

Manage accounts (add/remove/set default) and path rules (add/remove)."
```

---

## Task 13: Frontend — Integrate into ProjectList

**Files:**
- Modify: `src/components/ProjectList.tsx`

- [ ] **Step 1: Add AccountBadge to project items**

Import the badge:
```typescript
import { AccountBadge } from "@/components/AccountBadge";
```

In the project item rendering (the button/card that shows each project), add the badge after the project path display. Find the element that renders each project and add:

```typescript
{project.account_name && (
  <AccountBadge name={project.account_name} />
)}
```

Place it in the flex container alongside the project name and path, typically at the right side.

- [ ] **Step 2: Commit**

```bash
git add src/components/ProjectList.tsx
git commit -m "feat(frontend): show account badges in ProjectList

Each project displays its resolved account name as a colored badge."
```

---

## Task 14: Frontend — Show Account Badge on Agent Runs

**Files:**
- Modify: `src/components/AgentRunsList.tsx`

- [ ] **Step 1: Add AccountBadge to agent run items**

Import the badge:
```typescript
import { AccountBadge } from "@/components/AccountBadge";
```

In the run item rendering, add the badge next to the status badge when `account_name` is present:

```typescript
{run.account_name && (
  <AccountBadge name={run.account_name} className="ml-2" />
)}
```

- [ ] **Step 2: Commit**

```bash
git add src/components/AgentRunsList.tsx
git commit -m "feat(frontend): show account badge on agent run items"
```

---

## Task 15: Frontend — Add Accounts Tab to Settings


**Files:**
- Modify: `src/components/Settings.tsx`

- [ ] **Step 1: Import AccountSettings**

Add at the top:
```typescript
import { AccountSettings } from "@/components/AccountSettings";
```

- [ ] **Step 2: Add the tab trigger and content**

In the `TabsList`, add a new trigger. Update the `grid-cols-8` to `grid-cols-9`:

```typescript
<TabsTrigger value="accounts">Accounts</TabsTrigger>
```

Add the corresponding content:

```typescript
<TabsContent value="accounts">
  <AccountSettings />
</TabsContent>
```

- [ ] **Step 3: Commit**

```bash
git add src/components/Settings.tsx
git commit -m "feat(frontend): add Accounts tab to Settings

Renders AccountSettings component for managing accounts and path rules."
```

---

## Task 16: Frontend — Integrate AccountPickerDialog into App

**Files:**
- Modify: `src/App.tsx`

- [ ] **Step 1: Add state and imports**

```typescript
import { AccountPickerDialog } from "@/components/AccountPickerDialog";
import type { Account } from "@/lib/api";
```

Add state:
```typescript
const [showAccountPicker, setShowAccountPicker] = useState(false);
const [pendingProjectPath, setPendingProjectPath] = useState<string>("");
```

- [ ] **Step 2: Add account resolution to the open-project flow**

In the `handleOpenProject` flow (or wherever `api.createProject(path)` is called after FilePicker selection), add account resolution before proceeding:

```typescript
const handleProjectWithAccountCheck = async (projectPath: string) => {
  try {
    const account = await api.resolveAccountForProject(projectPath);
    if (account === null) {
      // No matching rule — prompt user
      setPendingProjectPath(projectPath);
      setShowAccountPicker(true);
      return;
    }
    // Account resolved — proceed normally
    const project = await api.createProject(projectPath);
    await loadProjects();
    await handleProjectClick(project);
  } catch (error) {
    console.error("Failed to open project:", error);
  }
};
```

Update the FilePicker's `onSelect` to call `handleProjectWithAccountCheck` instead of directly calling `api.createProject`.

- [ ] **Step 3: Add the dialog to the JSX**

```typescript
<AccountPickerDialog
  open={showAccountPicker}
  onOpenChange={setShowAccountPicker}
  projectPath={pendingProjectPath}
  onAccountSelected={async () => {
    const project = await api.createProject(pendingProjectPath);
    await loadProjects();
    await handleProjectClick(project);
  }}
/>
```

- [ ] **Step 4: Verify the app builds**

Run: `npm run build 2>&1 | tail -10`
Expected: Build succeeds

- [ ] **Step 5: Commit**

```bash
git add src/App.tsx
git commit -m "feat(frontend): integrate AccountPickerDialog into project open flow

When opening a project that has no matching account rule, prompt the user
to select an account before proceeding."
```

---

## Task 17: Final Integration Test

- [ ] **Step 1: Run full cargo test**

Run: `cd src-tauri && cargo test 2>&1 | tail -20`
Expected: All tests pass

- [ ] **Step 2: Run cargo check for warnings**

Run: `cd src-tauri && cargo check 2>&1`
Expected: Compiles cleanly

- [ ] **Step 3: Run frontend build**

Run: `npm run build 2>&1 | tail -10`
Expected: Build succeeds

- [ ] **Step 4: Run cargo fmt**

Run: `cd src-tauri && cargo fmt`

- [ ] **Step 5: Final commit**

```bash
git add -A
git commit -m "chore: format and clean up multi-account implementation"
```
