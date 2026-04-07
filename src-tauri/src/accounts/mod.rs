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
    /// Account type: "max" (no cost, usage limits only), "enterprise" (has cost),
    /// "pro" (has cost), "free" (has cost)
    pub account_type: String,
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
                "SELECT a.id, a.name, a.config_dir, a.is_default, a.account_type, a.created_at, a.updated_at
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
                        account_type: row.get(4)?,
                        created_at: row.get(5)?,
                        updated_at: row.get(6)?,
                    })
                },
            )
            .ok();

        if let Some(account) = override_result {
            return Ok(Some(account));
        }

        // 2. Check path prefix rules (longest match wins, then priority)
        let mut stmt = conn.prepare(
            "SELECT a.id, a.name, a.config_dir, a.is_default, a.account_type, a.created_at, a.updated_at, r.path_prefix
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
                        account_type: row.get(4)?,
                        created_at: row.get(5)?,
                        updated_at: row.get(6)?,
                    },
                    row.get::<_, String>(7)?,
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
                "SELECT id, name, config_dir, is_default, account_type, created_at, updated_at
                 FROM accounts WHERE is_default = 1 LIMIT 1",
                [],
                |row| {
                    Ok(Account {
                        id: row.get(0)?,
                        name: row.get(1)?,
                        config_dir: row.get(2)?,
                        is_default: row.get(3)?,
                        account_type: row.get(4)?,
                        created_at: row.get(5)?,
                        updated_at: row.get(6)?,
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
            "SELECT id, name, config_dir, is_default, account_type, created_at, updated_at
             FROM accounts ORDER BY name",
        )?;
        let accounts = stmt
            .query_map([], |row| {
                Ok(Account {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    config_dir: row.get(2)?,
                    is_default: row.get(3)?,
                    account_type: row.get(4)?,
                    created_at: row.get(5)?,
                    updated_at: row.get(6)?,
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
        account_type: &str,
    ) -> Result<Account> {
        let conn = self.db.lock().map_err(|e| anyhow::anyhow!("{}", e))?;

        // If setting as default, clear existing default
        if is_default {
            conn.execute("UPDATE accounts SET is_default = 0", [])?;
        }

        conn.execute(
            "INSERT INTO accounts (name, config_dir, is_default, account_type) VALUES (?1, ?2, ?3, ?4)",
            params![name, config_dir, is_default, account_type],
        )?;

        let id = conn.last_insert_rowid();
        conn.query_row(
            "SELECT id, name, config_dir, is_default, account_type, created_at, updated_at
             FROM accounts WHERE id = ?1",
            params![id],
            |row| {
                Ok(Account {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    config_dir: row.get(2)?,
                    is_default: row.get(3)?,
                    account_type: row.get(4)?,
                    created_at: row.get(5)?,
                    updated_at: row.get(6)?,
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

    pub fn add_path_rule(&self, account_id: i64, path_prefix: &str, priority: i32) -> Result<()> {
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
            if !name.starts_with(".claude-") || name.contains('.') && !name.starts_with(".claude-")
            {
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
                info!(
                    "Discovered Claude account dir: {} -> {}",
                    suffix,
                    path.display()
                );
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
                account_type TEXT NOT NULL DEFAULT 'pro',
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

        let account = mgr
            .create_account("personal", "/home/user/.claude-personal", true, "pro")
            .unwrap();
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

        let personal = mgr
            .create_account("personal", "/home/user/.claude-personal", false, "pro")
            .unwrap();
        let _work = mgr
            .create_account("work", "/home/user/.claude-work", false, "enterprise")
            .unwrap();

        mgr.set_project_override("/home/user/random-project", personal.id)
            .unwrap();

        let resolved = mgr.resolve("/home/user/random-project").unwrap().unwrap();
        assert_eq!(resolved.name, "personal");
    }

    #[test]
    fn test_resolve_by_path_prefix() {
        let conn = setup_test_db();
        let mgr = AccountManager::new(conn);

        let personal = mgr
            .create_account("personal", "/home/user/.claude-personal", false, "pro")
            .unwrap();
        let work = mgr
            .create_account("work", "/home/user/.claude-work", false, "enterprise")
            .unwrap();

        mgr.add_path_rule(personal.id, "/home/user/repos/personal/", 0)
            .unwrap();
        mgr.add_path_rule(work.id, "/home/user/repos/work/", 0)
            .unwrap();

        let resolved = mgr
            .resolve("/home/user/repos/personal/my-project")
            .unwrap()
            .unwrap();
        assert_eq!(resolved.name, "personal");

        let resolved = mgr
            .resolve("/home/user/repos/work/api-gateway")
            .unwrap()
            .unwrap();
        assert_eq!(resolved.name, "work");
    }

    #[test]
    fn test_resolve_longest_prefix_wins() {
        let conn = setup_test_db();
        let mgr = AccountManager::new(conn);

        let personal = mgr
            .create_account("personal", "/home/user/.claude-personal", false, "pro")
            .unwrap();
        let work = mgr
            .create_account("work", "/home/user/.claude-work", false, "enterprise")
            .unwrap();

        mgr.add_path_rule(personal.id, "/home/user/repos/", 0)
            .unwrap();
        mgr.add_path_rule(work.id, "/home/user/repos/work/", 0)
            .unwrap();

        // Longer prefix should win
        let resolved = mgr
            .resolve("/home/user/repos/work/project")
            .unwrap()
            .unwrap();
        assert_eq!(resolved.name, "work");

        // Shorter prefix catches everything else
        let resolved = mgr
            .resolve("/home/user/repos/other/project")
            .unwrap()
            .unwrap();
        assert_eq!(resolved.name, "personal");
    }

    #[test]
    fn test_resolve_falls_back_to_default() {
        let conn = setup_test_db();
        let mgr = AccountManager::new(conn);

        let _personal = mgr
            .create_account("personal", "/home/user/.claude-personal", true, "pro")
            .unwrap();
        let _work = mgr
            .create_account("work", "/home/user/.claude-work", false, "enterprise")
            .unwrap();

        // No rules, no override — should fall back to default
        let resolved = mgr.resolve("/some/random/path").unwrap().unwrap();
        assert_eq!(resolved.name, "personal");
    }

    #[test]
    fn test_resolve_returns_none_when_no_match() {
        let conn = setup_test_db();
        let mgr = AccountManager::new(conn);

        // Accounts exist but no default, no rules, no override
        let _personal = mgr
            .create_account("personal", "/home/user/.claude-personal", false, "pro")
            .unwrap();

        let resolved = mgr.resolve("/some/random/path").unwrap();
        assert!(resolved.is_none());
    }

    #[test]
    fn test_override_takes_precedence_over_prefix() {
        let conn = setup_test_db();
        let mgr = AccountManager::new(conn);

        let personal = mgr
            .create_account("personal", "/home/user/.claude-personal", false, "pro")
            .unwrap();
        let work = mgr
            .create_account("work", "/home/user/.claude-work", false, "enterprise")
            .unwrap();

        // Rule says /repos/personal/ -> personal
        mgr.add_path_rule(personal.id, "/home/user/repos/personal/", 0)
            .unwrap();
        // But override says this specific project -> work
        mgr.set_project_override("/home/user/repos/personal/special-project", work.id)
            .unwrap();

        let resolved = mgr
            .resolve("/home/user/repos/personal/special-project")
            .unwrap()
            .unwrap();
        assert_eq!(resolved.name, "work");
    }

    #[test]
    fn test_set_default_clears_previous() {
        let conn = setup_test_db();
        let mgr = AccountManager::new(conn);

        let personal = mgr
            .create_account("personal", "/home/user/.claude-personal", true, "pro")
            .unwrap();
        let work = mgr
            .create_account("work", "/home/user/.claude-work", false, "enterprise")
            .unwrap();

        mgr.set_default(work.id).unwrap();

        let accounts = mgr.list_accounts().unwrap();
        let personal_updated = accounts.iter().find(|a| a.id == personal.id).unwrap();
        let work_updated = accounts.iter().find(|a| a.id == work.id).unwrap();

        assert!(!personal_updated.is_default);
        assert!(work_updated.is_default);
    }
}
