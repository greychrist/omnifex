# GreyChrist Rename & Structured Logging — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rename all "opcode" references to "greychrist"/"GreyChrist" and add a structured logging system with SQLite persistence and a Settings Log tab.

**Architecture:** Two-part change. Part 1 is a mechanical rename across configs, source, docs, and build files — no behavioral changes. Part 2 adds a LogService singleton on the frontend that intercepts console calls and backend Tauri log events, batch-writes to SQLite, and surfaces them in a new Log tab in Settings.

**Tech Stack:** Tauri 2, Rust (rusqlite, log crate), React/TypeScript, SQLite

**Spec:** `docs/superpowers/specs/2026-04-08-greychrist-rename-and-logging-design.md`

---

## Part 1: Rename (opcode → greychrist)

### Task 1: Rename Package Metadata

**Files:**
- Modify: `package.json:2`
- Modify: `src-tauri/Cargo.toml:2,17,21`
- Modify: `src-tauri/tauri.conf.json:5`

- [ ] **Step 1: Update `package.json` name**

Change line 2:
```json
"name": "greychrist",
```

- [ ] **Step 2: Update `Cargo.toml` crate, lib, and binary names**

Line 2:
```toml
name = "greychrist"
```

Line 17:
```toml
name = "greychrist_lib"
```

Line 21:
```toml
name = "greychrist-web"
```

- [ ] **Step 3: Update `tauri.conf.json` identifier**

Line 5:
```json
"identifier": "greychrist.asterisk.so",
```

- [ ] **Step 4: Regenerate `package-lock.json`**

```bash
npm install
```

- [ ] **Step 5: Verify Cargo resolves**

```bash
cd src-tauri && cargo check 2>&1 | head -20
```

Expected: Should compile (or show unrelated errors — the crate rename itself just changes the package name in metadata).

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json src-tauri/Cargo.toml src-tauri/tauri.conf.json
git commit -m "chore: rename package metadata from opcode to greychrist"
```

---

### Task 2: Rename Rust Source References

**Files:**
- Modify: `src-tauri/src/main.rs:82`
- Modify: `src-tauri/src/web_main.rs:12`
- Modify: `src-tauri/src/session_manager.rs:347`
- Modify: `src-tauri/src/commands/agents.rs:2021,2037,2040,2065`

- [ ] **Step 1: Update app identifier in `main.rs`**

Change `"opcode.asterisk.so"` to `"greychrist.asterisk.so"` on line 82.

- [ ] **Step 2: Update command name in `web_main.rs`**

Change `#[command(name = "opcode-web")]` to `#[command(name = "greychrist-web")]` on line 12.

- [ ] **Step 3: Update app identifier in `session_manager.rs`**

Change `"opcode.asterisk.so"` to `"greychrist.asterisk.so"` on line 347.

- [ ] **Step 4: Update User-Agent and file format in `commands/agents.rs`**

- Line 2021: Change `"opcode-App"` to `"GreyChrist-App"` in User-Agent header
- Line 2037: Update comment from `.opcode.json` to `.greychrist.json`
- Line 2040: Change `.ends_with(".opcode.json")` to `.ends_with(".greychrist.json")`
- Line 2065: Change `"opcode-App"` to `"GreyChrist-App"` in User-Agent header

- [ ] **Step 5: Verify Rust compiles**

```bash
cd src-tauri && cargo check
```

Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/main.rs src-tauri/src/web_main.rs src-tauri/src/session_manager.rs src-tauri/src/commands/agents.rs
git commit -m "chore: rename opcode references in Rust source to greychrist"
```

---

### Task 3: Rename Frontend Storage Keys with Migration

**Files:**
- Modify: `src/services/tabPersistence.ts:8-10,189`
- Modify: `src/services/sessionPersistence.ts:8-9`
- Modify: `src/contexts/TabContext.tsx:41`
- Modify: `src/lib/analytics/consent.ts:3`

- [ ] **Step 1: Update `tabPersistence.ts` storage keys**

Lines 8-10:
```typescript
const STORAGE_KEY = 'greychrist_tabs_v2';
const ACTIVE_TAB_KEY = 'greychrist_active_tab_v2';
const PERSISTENCE_ENABLED_KEY = 'greychrist_tab_persistence_enabled';
```

- [ ] **Step 2: Expand the migration in `tabPersistence.ts`**

Replace the existing `migrateFromOldFormat()` method (around line 184) with:

```typescript
  static migrateFromOldFormat(): void {
    try {
      // Migrate from opcode_tabs (v1) format
      const oldKey = 'opcode_tabs';
      const oldData = localStorage.getItem(oldKey);
      if (oldData && !localStorage.getItem(STORAGE_KEY)) {
        localStorage.setItem(STORAGE_KEY, oldData);
        localStorage.removeItem(oldKey);
        console.log('Migrated tab data from v1 format');
      }

      // Migrate from opcode_* (v2) keys to greychrist_* keys
      const migrations: [string, string][] = [
        ['opcode_tabs_v2', STORAGE_KEY],
        ['opcode_active_tab_v2', ACTIVE_TAB_KEY],
        ['opcode_tab_persistence_enabled', PERSISTENCE_ENABLED_KEY],
      ];
      for (const [oldK, newK] of migrations) {
        const val = localStorage.getItem(oldK);
        if (val && !localStorage.getItem(newK)) {
          localStorage.setItem(newK, val);
          localStorage.removeItem(oldK);
          console.log(`Migrated storage key ${oldK} → ${newK}`);
        }
      }
    } catch (error) {
      console.error('Failed to migrate old tab data:', error);
    }
  }
```

- [ ] **Step 3: Update `sessionPersistence.ts` storage keys**

Lines 8-9:
```typescript
const STORAGE_KEY_PREFIX = 'greychrist_session_';
const SESSION_INDEX_KEY = 'greychrist_session_index';
```

Add a migration static method to `SessionPersistenceService`:

```typescript
  static migrateFromOldKeys(): void {
    try {
      // Migrate session index
      const oldIndex = localStorage.getItem('opcode_session_index');
      if (oldIndex && !localStorage.getItem(SESSION_INDEX_KEY)) {
        localStorage.setItem(SESSION_INDEX_KEY, oldIndex);
        localStorage.removeItem('opcode_session_index');
      }
      // Migrate individual session entries
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (key && key.startsWith('opcode_session_') && key !== 'opcode_session_index') {
          const newKey = key.replace('opcode_session_', 'greychrist_session_');
          if (!localStorage.getItem(newKey)) {
            localStorage.setItem(newKey, localStorage.getItem(key)!);
            localStorage.removeItem(key);
          }
        }
      }
    } catch (error) {
      console.error('Failed to migrate session keys:', error);
    }
  }
```

Call `SessionPersistenceService.migrateFromOldKeys()` at the top of the `restoreSession` or `saveSession` method (whichever runs first), or from `main.tsx` startup alongside `TabPersistenceService.migrateFromOldFormat()`.

- [ ] **Step 4: Update `TabContext.tsx` commented key**

Line 41: Change `'opcode_tabs'` to `'greychrist_tabs'` in the comment.

- [ ] **Step 5: Update `analytics/consent.ts` storage key**

Line 3:
```typescript
const ANALYTICS_STORAGE_KEY = 'greychrist-analytics-settings';
```

Add migration at the top of `ConsentManager.getInstance()` or `getSettings()`:

```typescript
// One-time migration from old analytics key
const oldSettings = localStorage.getItem('opcode-analytics-settings');
if (oldSettings && !localStorage.getItem('greychrist-analytics-settings')) {
  localStorage.setItem('greychrist-analytics-settings', oldSettings);
  localStorage.removeItem('opcode-analytics-settings');
}
```

- [ ] **Step 6: Verify TypeScript compiles**

```bash
npx tsc --noEmit
```

Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/services/tabPersistence.ts src/services/sessionPersistence.ts src/contexts/TabContext.tsx src/lib/analytics/consent.ts
git commit -m "chore: rename storage keys from opcode to greychrist with migration"
```

---

### Task 4: Rename Frontend Display & Analytics References

**Files:**
- Modify: `src/components/NFOCredits.tsx:87,150`
- Modify: `src/lib/analytics/index.ts:86,153,237`
- Modify: `src/components/CCAgents.tsx:194,196,197,225,226,442`
- Modify: `src/components/Agents.tsx:126,146,148`
- Modify: `src/components/GitHubAgentBrowser.tsx:141`

- [ ] **Step 1: Update `NFOCredits.tsx`**

Line 87: Change `"opcode v0.2.1"` to `"GreyChrist v0.2.1"`
Line 150: Change `opcode.NFO` to `GreyChrist.NFO`

- [ ] **Step 2: Update `analytics/index.ts`**

Line 86: Change `app_name: 'opcode'` to `app_name: 'greychrist'`
Line 153: Change `app_context: 'opcode_desktop'` to `app_context: 'greychrist_desktop'`
Line 237: Change `opcode://` to `greychrist://`

- [ ] **Step 3: Update `CCAgents.tsx` agent file format and display names**

All `.opcode.json` references → `.greychrist.json`
All `'opcode Agent'` display names → `'GreyChrist Agent'`

Specific lines:
- Line 194: `.greychrist.json` in filename template
- Line 196: `name: 'GreyChrist Agent'`
- Line 197: `extensions: ['greychrist.json']`
- Line 225: `name: 'GreyChrist Agent'`
- Line 226: `extensions: ['greychrist.json', 'json']`
- Line 442: `title="Export agent to .greychrist.json"`

- [ ] **Step 4: Update `Agents.tsx` agent file format**

- Line 126: `{ name: 'GreyChrist Agent', extensions: ['greychrist.json', 'json'] }`
- Line 146: `.greychrist.json` in filename template
- Line 148: `{ name: 'GreyChrist Agent', extensions: ['greychrist.json'] }`

- [ ] **Step 5: Update `GitHubAgentBrowser.tsx`**

Line 141: Change `.replace(".opcode.json", "")` to `.replace(".greychrist.json", "")`

- [ ] **Step 6: Verify TypeScript compiles**

```bash
npx tsc --noEmit
```

Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/components/NFOCredits.tsx src/lib/analytics/index.ts src/components/CCAgents.tsx src/components/Agents.tsx src/components/GitHubAgentBrowser.tsx
git commit -m "chore: rename opcode display names and analytics to greychrist"
```

---

### Task 5: Rename Agent Files and Documentation

**Files:**
- Rename: `cc_agents/git-commit-bot.opcode.json` → `cc_agents/git-commit-bot.greychrist.json`
- Rename: `cc_agents/security-scanner.opcode.json` → `cc_agents/security-scanner.greychrist.json`
- Rename: `cc_agents/unit-tests-bot.opcode.json` → `cc_agents/unit-tests-bot.greychrist.json`
- Modify: `cc_agents/README.md`
- Modify: `CONTRIBUTING.md`
- Modify: `AGENTS.md`

- [ ] **Step 1: Rename agent JSON files**

```bash
cd /Users/gregorychristie/Repos/personal/greychrist
git mv cc_agents/git-commit-bot.opcode.json cc_agents/git-commit-bot.greychrist.json
git mv cc_agents/security-scanner.opcode.json cc_agents/security-scanner.greychrist.json
git mv cc_agents/unit-tests-bot.opcode.json cc_agents/unit-tests-bot.greychrist.json
```

- [ ] **Step 2: Update `cc_agents/README.md`**

Replace all non-attribution `opcode` references with `GreyChrist` and `.opcode.json` with `.greychrist.json`. Leave GitHub upstream URLs as-is.

Key changes:
- Line 1: `# GreyChrist CC Agents`
- Line 5: `Pre-built AI agents for GreyChrist powered by Claude Code`
- All instructions: `In GreyChrist, navigate to...`
- All file format refs: `.greychrist.json`
- Line 141: `Built with love by the GreyChrist community`

- [ ] **Step 3: Update `CONTRIBUTING.md`**

Replace non-attribution `opcode` mentions with `GreyChrist`. Keep the fork attribution text as-is.

- [ ] **Step 4: Update `AGENTS.md`**

- Line 7: `GreyChrist is a Tauri 2 desktop application...`
- Line 35: `The project has two Rust binaries: \`greychrist\` (desktop) and \`greychrist-web\` (web server).`

- [ ] **Step 5: Commit**

```bash
git add cc_agents/ CONTRIBUTING.md AGENTS.md
git commit -m "chore: rename agent files and docs from opcode to greychrist"
```

---

### Task 6: Rename GitHub Workflows

**Files:**
- Modify: `.github/workflows/release.yml`
- Modify: `.github/workflows/build-macos.yml`

- [ ] **Step 1: Update `release.yml`**

Replace all `opcode` artifact references:
- `opcode_${{...}}_linux_x86_64.deb` → `greychrist_${{...}}_linux_x86_64.deb`
- `opcode_${{...}}_linux_x86_64.AppImage` → `greychrist_${{...}}_linux_x86_64.AppImage`
- `opcode.dmg` → `greychrist.dmg`
- `opcode.app.zip` → `greychrist.app.zip`
- `opcode-${CLEAN_VERSION}/` → `greychrist-${CLEAN_VERSION}/`
- `name: opcode ${{...}}` → `name: GreyChrist ${{...}}`
- `alt="opcode Logo"` → `alt="GreyChrist Logo"`
- `## opcode ${{...}}` → `## GreyChrist ${{...}}`
- `drag opcode to Applications` → `drag GreyChrist to Applications`

- [ ] **Step 2: Update `build-macos.yml`**

Replace all `opcode` artifact references:
- `opcode.app` → `greychrist.app` (all occurrences)
- `opcode.dmg` → `greychrist.dmg` (all occurrences)
- `"opcode Installer"` → `"GreyChrist Installer"`
- Binary paths: `Contents/MacOS/opcode` → `Contents/MacOS/greychrist`

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/release.yml .github/workflows/build-macos.yml
git commit -m "chore: rename opcode references in GitHub workflows to greychrist"
```

---

### Task 7: Rename CLAUDE.md Files and Design Docs

**Files:**
- Modify: `CLAUDE.md`
- Modify: `src/CLAUDE.md`
- Modify: `src-tauri/CLAUDE.md`
- Modify: `web_server.design.md`
- Modify: `docs/superpowers/specs/2026-04-07-interactive-session-redesign.md`
- Modify: `docs/superpowers/plans/2026-04-06-multi-account.md`
- Modify: `docs/superpowers/plans/2026-04-07-interactive-session-redesign.md`

- [ ] **Step 1: Update root `CLAUDE.md`**

- Line 3 (src/CLAUDE.md context): `React/TypeScript frontend for GreyChrist.`
- References to `opcode-web`: change to `greychrist-web`
- References to `opcode-targeted-workflow` skill: leave as-is (it's a skill name that may need separate renaming)

- [ ] **Step 2: Update `src/CLAUDE.md`**

- Line 3: `React/TypeScript frontend for GreyChrist.`

- [ ] **Step 3: Update `src-tauri/CLAUDE.md`**

- Line 3: `Rust/Tauri backend for GreyChrist.`

- [ ] **Step 4: Update design and plan docs**

In each file, replace:
- `opcode wraps...` → `GreyChrist wraps...`
- `opcode/` path references → `greychrist/`
- `cargo test --bin opcode` → `cargo test --bin greychrist`
- `cargo run --bin opcode` → `cargo run --bin greychrist`
- `Allow opcode to work with...` → `Allow GreyChrist to work with...`

- [ ] **Step 5: Commit**

```bash
git add CLAUDE.md src/CLAUDE.md src-tauri/CLAUDE.md web_server.design.md docs/
git commit -m "chore: rename opcode references in documentation to greychrist"
```

---

### Task 8: Verify Full Rename

- [ ] **Step 1: Run frontend checks**

```bash
npm run check
```

Expected: PASS (tsc + cargo check)

- [ ] **Step 2: Run frontend build**

```bash
npm run build
```

Expected: PASS

- [ ] **Step 3: Run Rust tests**

```bash
cd src-tauri && cargo test
```

Expected: PASS

- [ ] **Step 4: Scan for remaining opcode references**

```bash
rg -i "opcode" --type rust --type ts --type json -g '!node_modules' -g '!target' -g '!dist' -g '!package-lock.json' -g '!*.design.md' -l
```

Review results — remaining hits should only be:
- Upstream GitHub URLs (`github.com/getAsterisk/opcode`)
- Attribution text in README.md and CONTRIBUTING.md
- The `opcode-targeted-workflow` skill name (if not renamed)
- Storage key migration code (references old keys by string)
- The audio asset filename `opcode-nfo.ogg` (binary file, leave as-is)

If any unexpected references remain, fix them.

- [ ] **Step 5: Commit any stragglers**

```bash
git add -A && git commit -m "chore: fix remaining opcode references"
```

(Only if there were fixes in step 4.)

---

## Part 2: Structured Logging System

### Task 9: Create SQLite Log Table and Rust Commands

**Files:**
- Create: `src-tauri/src/commands/logging.rs`
- Modify: `src-tauri/src/commands/mod.rs`
- Modify: `src-tauri/src/main.rs` (register commands, create table)

- [ ] **Step 1: Write tests for log commands**

Add tests at the bottom of the new `src-tauri/src/commands/logging.rs` file:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection;
    use std::sync::Mutex;

    fn setup_test_db() -> AgentDb {
        let conn = Connection::open_in_memory().unwrap();
        create_app_logs_table(&conn).unwrap();
        AgentDb(Mutex::new(conn))
    }

    #[test]
    fn test_create_table() {
        let db = setup_test_db();
        let conn = db.0.lock().unwrap();
        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM app_logs", [], |row| row.get(0))
            .unwrap();
        assert_eq!(count, 0);
    }

    #[test]
    fn test_write_and_count() {
        let db = setup_test_db();
        let entries = vec![
            LogEntry {
                id: None,
                timestamp: "2026-04-08T10:00:00Z".to_string(),
                level: "error".to_string(),
                source: "frontend".to_string(),
                category: Some("api".to_string()),
                message: "Failed to fetch".to_string(),
                metadata: None,
            },
            LogEntry {
                id: None,
                timestamp: "2026-04-08T10:00:01Z".to_string(),
                level: "warn".to_string(),
                source: "backend".to_string(),
                category: None,
                message: "Slow query detected".to_string(),
                metadata: Some("{\"duration_ms\": 5000}".to_string()),
            },
        ];
        write_batch_sync(&db, entries).unwrap();
        let count = count_sync(&db).unwrap();
        assert_eq!(count, 2);
    }

    #[test]
    fn test_query_filter_by_level() {
        let db = setup_test_db();
        let entries = vec![
            LogEntry {
                id: None,
                timestamp: "2026-04-08T10:00:00Z".to_string(),
                level: "error".to_string(),
                source: "frontend".to_string(),
                category: None,
                message: "Error message".to_string(),
                metadata: None,
            },
            LogEntry {
                id: None,
                timestamp: "2026-04-08T10:00:01Z".to_string(),
                level: "info".to_string(),
                source: "frontend".to_string(),
                category: None,
                message: "Info message".to_string(),
                metadata: None,
            },
        ];
        write_batch_sync(&db, entries).unwrap();

        let result = query_sync(&db, Some("error".to_string()), None, None, 50, 0).unwrap();
        assert_eq!(result.total, 1);
        assert_eq!(result.entries.len(), 1);
        assert_eq!(result.entries[0].message, "Error message");
    }

    #[test]
    fn test_query_filter_by_source() {
        let db = setup_test_db();
        let entries = vec![
            LogEntry {
                id: None,
                timestamp: "2026-04-08T10:00:00Z".to_string(),
                level: "error".to_string(),
                source: "frontend".to_string(),
                category: None,
                message: "Frontend error".to_string(),
                metadata: None,
            },
            LogEntry {
                id: None,
                timestamp: "2026-04-08T10:00:01Z".to_string(),
                level: "error".to_string(),
                source: "backend".to_string(),
                category: None,
                message: "Backend error".to_string(),
                metadata: None,
            },
        ];
        write_batch_sync(&db, entries).unwrap();

        let result = query_sync(&db, None, Some("backend".to_string()), None, 50, 0).unwrap();
        assert_eq!(result.total, 1);
        assert_eq!(result.entries[0].message, "Backend error");
    }

    #[test]
    fn test_query_search() {
        let db = setup_test_db();
        let entries = vec![
            LogEntry {
                id: None,
                timestamp: "2026-04-08T10:00:00Z".to_string(),
                level: "error".to_string(),
                source: "frontend".to_string(),
                category: None,
                message: "Permission denied for Bash".to_string(),
                metadata: None,
            },
            LogEntry {
                id: None,
                timestamp: "2026-04-08T10:00:01Z".to_string(),
                level: "error".to_string(),
                source: "frontend".to_string(),
                category: None,
                message: "Network timeout".to_string(),
                metadata: None,
            },
        ];
        write_batch_sync(&db, entries).unwrap();

        let result = query_sync(&db, None, None, Some("Permission".to_string()), 50, 0).unwrap();
        assert_eq!(result.total, 1);
        assert_eq!(result.entries[0].message, "Permission denied for Bash");
    }

    #[test]
    fn test_query_pagination() {
        let db = setup_test_db();
        let mut entries = Vec::new();
        for i in 0..10 {
            entries.push(LogEntry {
                id: None,
                timestamp: format!("2026-04-08T10:00:{:02}Z", i),
                level: "info".to_string(),
                source: "frontend".to_string(),
                category: None,
                message: format!("Message {}", i),
                metadata: None,
            });
        }
        write_batch_sync(&db, entries).unwrap();

        let result = query_sync(&db, None, None, None, 3, 0).unwrap();
        assert_eq!(result.total, 10);
        assert_eq!(result.entries.len(), 3);

        let result2 = query_sync(&db, None, None, None, 3, 3).unwrap();
        assert_eq!(result2.total, 10);
        assert_eq!(result2.entries.len(), 3);
    }

    #[test]
    fn test_prune_by_age() {
        let db = setup_test_db();
        let entries = vec![
            LogEntry {
                id: None,
                timestamp: "2026-03-01T10:00:00Z".to_string(),
                level: "info".to_string(),
                source: "frontend".to_string(),
                category: None,
                message: "Old message".to_string(),
                metadata: None,
            },
            LogEntry {
                id: None,
                timestamp: "2026-04-08T10:00:00Z".to_string(),
                level: "info".to_string(),
                source: "frontend".to_string(),
                category: None,
                message: "New message".to_string(),
                metadata: None,
            },
        ];
        write_batch_sync(&db, entries).unwrap();

        let deleted = prune_sync(&db, Some("1w".to_string())).unwrap();
        assert_eq!(deleted, 1);

        let count = count_sync(&db).unwrap();
        assert_eq!(count, 1);
    }

    #[test]
    fn test_prune_all() {
        let db = setup_test_db();
        let entries = vec![
            LogEntry {
                id: None,
                timestamp: "2026-04-08T10:00:00Z".to_string(),
                level: "info".to_string(),
                source: "frontend".to_string(),
                category: None,
                message: "Message 1".to_string(),
                metadata: None,
            },
            LogEntry {
                id: None,
                timestamp: "2026-04-08T10:00:01Z".to_string(),
                level: "info".to_string(),
                source: "frontend".to_string(),
                category: None,
                message: "Message 2".to_string(),
                metadata: None,
            },
        ];
        write_batch_sync(&db, entries).unwrap();

        let deleted = prune_sync(&db, None).unwrap();
        assert_eq!(deleted, 2);
        assert_eq!(count_sync(&db).unwrap(), 0);
    }
}
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd src-tauri && cargo test --lib commands::logging
```

Expected: FAIL — module doesn't exist yet.

- [ ] **Step 3: Create `src-tauri/src/commands/logging.rs`**

```rust
use super::agents::AgentDb;
use chrono::{Duration, Utc};
use rusqlite::params;
use serde::{Deserialize, Serialize};
use std::sync::Mutex;

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct LogEntry {
    pub id: Option<i64>,
    pub timestamp: String,
    pub level: String,
    pub source: String,
    pub category: Option<String>,
    pub message: String,
    pub metadata: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct LogQueryResult {
    pub entries: Vec<LogEntry>,
    pub total: u64,
}

pub fn create_app_logs_table(conn: &rusqlite::Connection) -> Result<(), String> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS app_logs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            timestamp TEXT NOT NULL,
            level TEXT NOT NULL,
            source TEXT NOT NULL,
            category TEXT,
            message TEXT NOT NULL,
            metadata TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_logs_timestamp ON app_logs(timestamp);
        CREATE INDEX IF NOT EXISTS idx_logs_level ON app_logs(level);",
    )
    .map_err(|e| e.to_string())
}

// Sync helpers for both Tauri commands and tests
pub fn write_batch_sync(db: &AgentDb, entries: Vec<LogEntry>) -> Result<(), String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    for entry in entries {
        conn.execute(
            "INSERT INTO app_logs (timestamp, level, source, category, message, metadata) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                entry.timestamp,
                entry.level,
                entry.source,
                entry.category,
                entry.message,
                entry.metadata,
            ],
        )
        .map_err(|e| e.to_string())?;
    }
    Ok(())
}

pub fn query_sync(
    db: &AgentDb,
    level: Option<String>,
    source: Option<String>,
    search: Option<String>,
    limit: u32,
    offset: u32,
) -> Result<LogQueryResult, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;

    let mut conditions: Vec<String> = Vec::new();
    let mut param_values: Vec<Box<dyn rusqlite::types::ToSql>> = Vec::new();

    if let Some(ref l) = level {
        conditions.push(format!("level = ?{}", param_values.len() + 1));
        param_values.push(Box::new(l.clone()));
    }
    if let Some(ref s) = source {
        conditions.push(format!("source = ?{}", param_values.len() + 1));
        param_values.push(Box::new(s.clone()));
    }
    if let Some(ref q) = search {
        conditions.push(format!("message LIKE ?{}", param_values.len() + 1));
        param_values.push(Box::new(format!("%{}%", q)));
    }

    let where_clause = if conditions.is_empty() {
        String::new()
    } else {
        format!("WHERE {}", conditions.join(" AND "))
    };

    // Get total count
    let count_sql = format!("SELECT COUNT(*) FROM app_logs {}", where_clause);
    let params_ref: Vec<&dyn rusqlite::types::ToSql> = param_values.iter().map(|p| p.as_ref()).collect();
    let total: u64 = conn
        .query_row(&count_sql, params_ref.as_slice(), |row| row.get(0))
        .map_err(|e| e.to_string())?;

    // Get entries
    let query_sql = format!(
        "SELECT id, timestamp, level, source, category, message, metadata FROM app_logs {} ORDER BY timestamp DESC LIMIT ?{} OFFSET ?{}",
        where_clause,
        param_values.len() + 1,
        param_values.len() + 2,
    );
    param_values.push(Box::new(limit));
    param_values.push(Box::new(offset));

    let params_ref2: Vec<&dyn rusqlite::types::ToSql> = param_values.iter().map(|p| p.as_ref()).collect();
    let mut stmt = conn.prepare(&query_sql).map_err(|e| e.to_string())?;
    let entries = stmt
        .query_map(params_ref2.as_slice(), |row| {
            Ok(LogEntry {
                id: row.get(0)?,
                timestamp: row.get(1)?,
                level: row.get(2)?,
                source: row.get(3)?,
                category: row.get(4)?,
                message: row.get(5)?,
                metadata: row.get(6)?,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;

    Ok(LogQueryResult { entries, total })
}

pub fn prune_sync(db: &AgentDb, older_than: Option<String>) -> Result<u64, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;

    let deleted = match older_than.as_deref() {
        Some("1w") => {
            let cutoff = (Utc::now() - Duration::weeks(1)).to_rfc3339();
            conn.execute("DELETE FROM app_logs WHERE timestamp < ?1", params![cutoff])
                .map_err(|e| e.to_string())?
        }
        Some("1m") => {
            let cutoff = (Utc::now() - Duration::days(30)).to_rfc3339();
            conn.execute("DELETE FROM app_logs WHERE timestamp < ?1", params![cutoff])
                .map_err(|e| e.to_string())?
        }
        None => {
            conn.execute("DELETE FROM app_logs", [])
                .map_err(|e| e.to_string())?
        }
        Some(other) => return Err(format!("Invalid older_than value: {}", other)),
    };

    Ok(deleted as u64)
}

pub fn count_sync(db: &AgentDb) -> Result<u64, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    let count: u64 = conn
        .query_row("SELECT COUNT(*) FROM app_logs", [], |row| row.get(0))
        .map_err(|e| e.to_string())?;
    Ok(count)
}

// Tauri commands
#[tauri::command]
pub async fn log_write_batch(
    db: tauri::State<'_, AgentDb>,
    entries: Vec<LogEntry>,
) -> Result<(), String> {
    write_batch_sync(&db, entries)
}

#[tauri::command]
pub async fn log_query(
    db: tauri::State<'_, AgentDb>,
    level: Option<String>,
    source: Option<String>,
    search: Option<String>,
    limit: u32,
    offset: u32,
) -> Result<LogQueryResult, String> {
    query_sync(&db, level, source, search, limit, offset)
}

#[tauri::command]
pub async fn log_prune(
    db: tauri::State<'_, AgentDb>,
    older_than: Option<String>,
) -> Result<u64, String> {
    prune_sync(&db, older_than)
}

#[tauri::command]
pub async fn log_count(db: tauri::State<'_, AgentDb>) -> Result<u64, String> {
    count_sync(&db)
}
```

Then append the test module from Step 1 to the bottom of this file.

- [ ] **Step 4: Add module declaration to `commands/mod.rs`**

Add to `src-tauri/src/commands/mod.rs`:
```rust
pub mod logging;
```

- [ ] **Step 5: Register commands and create table in `main.rs`**

Add to the `init_database` section or right after `AgentDb` is managed — call:
```rust
commands::logging::create_app_logs_table(&conn).expect("Failed to create app_logs table");
```

Add to the `tauri::generate_handler![]` macro:
```rust
commands::logging::log_write_batch,
commands::logging::log_query,
commands::logging::log_prune,
commands::logging::log_count,
```

- [ ] **Step 6: Run tests**

```bash
cd src-tauri && cargo test --lib commands::logging
```

Expected: All 8 tests PASS.

- [ ] **Step 7: Run full cargo check**

```bash
cd src-tauri && cargo check
```

Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add src-tauri/src/commands/logging.rs src-tauri/src/commands/mod.rs src-tauri/src/main.rs
git commit -m "feat: add SQLite log commands with tests"
```

---

### Task 10: Create Backend Log Bridge

**Files:**
- Create: `src-tauri/src/logging.rs`
- Modify: `src-tauri/src/main.rs` (register logger)
- Modify: `src-tauri/src/lib.rs` (add module)

- [ ] **Step 1: Create `src-tauri/src/logging.rs`**

```rust
use log::{Level, Log, Metadata, Record};
use std::sync::OnceLock;
use tauri::{AppHandle, Emitter, Manager};

static APP_HANDLE: OnceLock<AppHandle> = OnceLock::new();

pub fn set_app_handle(handle: AppHandle) {
    let _ = APP_HANDLE.set(handle);
}

pub struct TauriLogBridge;

impl Log for TauriLogBridge {
    fn enabled(&self, metadata: &Metadata) -> bool {
        let verbose = std::env::var("GREYCHRIST_VERBOSE_LOG").unwrap_or_default() == "1";
        match metadata.level() {
            Level::Error | Level::Warn => true,
            Level::Info | Level::Debug => verbose,
            Level::Trace => false,
        }
    }

    fn log(&self, record: &Record) {
        if !self.enabled(record.metadata()) {
            return;
        }

        // Always print to stderr (replaces env_logger for our messages)
        eprintln!(
            "[{}] [{}] {}",
            record.level(),
            record.target(),
            record.args()
        );

        // Emit to frontend via Tauri event
        if let Some(handle) = APP_HANDLE.get() {
            let payload = serde_json::json!({
                "level": record.level().to_string().to_lowercase(),
                "category": record.target(),
                "message": record.args().to_string(),
                "timestamp": chrono::Utc::now().to_rfc3339(),
            });
            let _ = handle.emit("backend-log", payload);
        }
    }

    fn flush(&self) {}
}

static LOGGER: TauriLogBridge = TauriLogBridge;

pub fn init_logger() {
    // Set max log level based on RUST_LOG or default to info
    let level = std::env::var("RUST_LOG")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(log::LevelFilter::Info);

    log::set_logger(&LOGGER)
        .map(|()| log::set_max_level(level))
        .expect("Failed to set logger");
}
```

- [ ] **Step 2: Add module to `lib.rs`**

Add to module declarations:
```rust
pub mod logging;
```

- [ ] **Step 3: Register logger in `main.rs`**

Replace `env_logger::init();` (line 76) with:

```rust
logging::init_logger();
```

After the app handle is available (in the `setup` closure), add:

```rust
logging::set_app_handle(app.handle().clone());
```

- [ ] **Step 4: Verify Rust compiles and tests pass**

```bash
cd src-tauri && cargo check && cargo test
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/logging.rs src-tauri/src/lib.rs src-tauri/src/main.rs
git commit -m "feat: add backend log bridge that emits Tauri events"
```

---

### Task 11: Add Log API Methods

**Files:**
- Modify: `src/lib/api.ts`

- [ ] **Step 1: Add type definitions and API methods**

Add the following types near the top of `api.ts` (after existing interface definitions):

```typescript
export interface LogEntry {
  id?: number;
  timestamp: string;
  level: string;
  source: string;
  category?: string;
  message: string;
  metadata?: string;
}

export interface LogQueryFilters {
  level?: string;
  source?: string;
  search?: string;
  limit: number;
  offset: number;
}

export interface LogQueryResult {
  entries: LogEntry[];
  total: number;
}
```

Add the following methods to the `api` object (after `getSessionInfo`):

```typescript
  // ─── Logging API ────────────────────────────────────────────────

  async logWriteBatch(entries: LogEntry[]): Promise<void> {
    return apiCall("log_write_batch", { entries });
  },

  async logQuery(filters: LogQueryFilters): Promise<LogQueryResult> {
    return apiCall("log_query", {
      level: filters.level,
      source: filters.source,
      search: filters.search,
      limit: filters.limit,
      offset: filters.offset,
    });
  },

  async logPrune(olderThan?: string): Promise<number> {
    return apiCall("log_prune", { olderThan });
  },

  async logCount(): Promise<number> {
    return apiCall("log_count");
  },
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
npx tsc --noEmit
```

Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/lib/api.ts
git commit -m "feat: add log API methods to frontend api layer"
```

---

### Task 12: Create LogService Singleton

**Files:**
- Create: `src/lib/logService.ts`
- Modify: `src/main.tsx` (initialize LogService)

- [ ] **Step 1: Create `src/lib/logService.ts`**

```typescript
import { api, type LogEntry } from './api';

type LogLevel = 'error' | 'warn' | 'info' | 'debug';

const FLUSH_INTERVAL_MS = 2000;
const FLUSH_BATCH_SIZE = 50;

// Patterns to filter out noisy messages
const NOISE_PATTERNS = [
  /Download the React DevTools/,
  /\[HMR\]/,
  /\[vite\]/,
  /Warning: ReactDOM\.render is no longer supported/,
  /act\(\) is not supported in production/,
];

class LogService {
  private static instance: LogService;
  private buffer: LogEntry[] = [];
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private originalConsole: {
    error: typeof console.error;
    warn: typeof console.warn;
    info: typeof console.info;
    debug: typeof console.debug;
  };
  private initialized = false;
  private tauriUnlisten: (() => void) | null = null;

  private constructor() {
    this.originalConsole = {
      error: console.error.bind(console),
      warn: console.warn.bind(console),
      info: console.info.bind(console),
      debug: console.debug.bind(console),
    };
  }

  static getInstance(): LogService {
    if (!LogService.instance) {
      LogService.instance = new LogService();
    }
    return LogService.instance;
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;

    // Wrap console methods
    console.error = (...args: any[]) => {
      this.originalConsole.error(...args);
      this.captureConsole('error', args);
    };
    console.warn = (...args: any[]) => {
      this.originalConsole.warn(...args);
      this.captureConsole('warn', args);
    };
    console.info = (...args: any[]) => {
      this.originalConsole.info(...args);
      this.captureConsole('info', args);
    };
    console.debug = (...args: any[]) => {
      this.originalConsole.debug(...args);
      this.captureConsole('debug', args);
    };

    // Listen for backend log events
    try {
      const { listen } = await import('@tauri-apps/api/event');
      this.tauriUnlisten = await listen('backend-log', (event: any) => {
        const payload = event.payload as {
          level: string;
          category: string;
          message: string;
          timestamp: string;
        };
        this.addEntry({
          timestamp: payload.timestamp,
          level: payload.level,
          source: 'backend',
          category: payload.category,
          message: payload.message,
        });
      });
    } catch {
      // Not in Tauri environment (web mode) — skip backend events
    }

    // Start periodic flush
    this.flushTimer = setInterval(() => this.flush(), FLUSH_INTERVAL_MS);
  }

  private captureConsole(level: LogLevel, args: any[]): void {
    const message = args
      .map((a) => (typeof a === 'string' ? a : JSON.stringify(a)))
      .join(' ');

    // Filter noise
    if (NOISE_PATTERNS.some((p) => p.test(message))) return;

    this.addEntry({
      timestamp: new Date().toISOString(),
      level,
      source: 'frontend',
      message,
    });
  }

  private addEntry(entry: LogEntry): void {
    this.buffer.push(entry);
    if (this.buffer.length >= FLUSH_BATCH_SIZE) {
      this.flush();
    }
  }

  private async flush(): Promise<void> {
    if (this.buffer.length === 0) return;

    const batch = this.buffer.splice(0);
    try {
      await api.logWriteBatch(batch);
    } catch {
      // If write fails, don't re-buffer to avoid infinite loops
      // (the error itself would trigger another console.error → capture → flush)
    }
  }

  async shutdown(): Promise<void> {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    if (this.tauriUnlisten) {
      this.tauriUnlisten();
      this.tauriUnlisten = null;
    }
    await this.flush();
  }
}

export const logService = LogService.getInstance();
```

- [ ] **Step 2: Initialize LogService in `main.tsx`**

After `analytics.initialize();` (line 13), add:

```typescript
import { logService } from './lib/logService';

// Initialize structured logging
logService.initialize();
```

- [ ] **Step 3: Verify TypeScript compiles**

```bash
npx tsc --noEmit
```

Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/lib/logService.ts src/main.tsx
git commit -m "feat: add LogService singleton with console interception and Tauri bridge"
```

---

### Task 13: Create LogTab UI Component

**Files:**
- Create: `src/components/LogTab.tsx`

- [ ] **Step 1: Create `src/components/LogTab.tsx`**

```typescript
import React, { useState, useEffect, useCallback } from "react";
import {
  Search,
  RefreshCw,
  ChevronLeft,
  ChevronRight,
  Trash2,
  AlertTriangle,
  Loader2,
  ScrollText,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { api, type LogEntry, type LogQueryResult } from "@/lib/api";

const PAGE_SIZE = 50;

const LEVEL_COLORS: Record<string, string> = {
  error: "text-red-400",
  warn: "text-yellow-400",
  info: "text-blue-400",
  debug: "text-gray-400",
};

const LEVEL_BG: Record<string, string> = {
  error: "bg-red-500/10",
  warn: "bg-yellow-500/10",
  info: "bg-blue-500/10",
  debug: "bg-gray-500/10",
};

export const LogTab: React.FC = () => {
  const [entries, setEntries] = useState<LogEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(0);
  const [loading, setLoading] = useState(false);
  const [levelFilter, setLevelFilter] = useState<string>("all");
  const [sourceFilter, setSourceFilter] = useState<string>("all");
  const [searchQuery, setSearchQuery] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [pruneDialog, setPruneDialog] = useState<{ open: boolean; olderThan?: string; label: string }>({
    open: false,
    label: "",
  });
  const [pruneCount, setPruneCount] = useState<number | null>(null);

  // Debounce search
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(searchQuery), 300);
    return () => clearTimeout(timer);
  }, [searchQuery]);

  const fetchLogs = useCallback(async () => {
    setLoading(true);
    try {
      const result: LogQueryResult = await api.logQuery({
        level: levelFilter === "all" ? undefined : levelFilter,
        source: sourceFilter === "all" ? undefined : sourceFilter,
        search: debouncedSearch || undefined,
        limit: PAGE_SIZE,
        offset: page * PAGE_SIZE,
      });
      setEntries(result.entries);
      setTotal(result.total);
    } catch (err) {
      console.error("Failed to fetch logs:", err);
    } finally {
      setLoading(false);
    }
  }, [levelFilter, sourceFilter, debouncedSearch, page]);

  useEffect(() => {
    fetchLogs();
  }, [fetchLogs]);

  // Reset to page 0 when filters change
  useEffect(() => {
    setPage(0);
  }, [levelFilter, sourceFilter, debouncedSearch]);

  const totalPages = Math.ceil(total / PAGE_SIZE);

  const handlePruneClick = async (olderThan: string | undefined, label: string) => {
    try {
      const count = await api.logCount();
      setPruneCount(count);
      setPruneDialog({ open: true, olderThan, label });
    } catch (err) {
      console.error("Failed to get log count:", err);
    }
  };

  const confirmPrune = async () => {
    try {
      await api.logPrune(pruneDialog.olderThan);
      setPruneDialog({ open: false, label: "" });
      setPruneCount(null);
      setPage(0);
      fetchLogs();
    } catch (err) {
      console.error("Failed to prune logs:", err);
    }
  };

  const formatTimestamp = (ts: string) => {
    try {
      return new Date(ts).toLocaleString(undefined, {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      });
    } catch {
      return ts;
    }
  };

  return (
    <Card className="p-6">
      <div className="flex items-center gap-2 mb-4">
        <ScrollText className="w-5 h-5 text-foreground/70" />
        <h3 className="text-lg font-semibold">Application Logs</h3>
        <span className="text-sm text-muted-foreground ml-auto">
          {total.toLocaleString()} total entries
        </span>
      </div>

      {/* Filter bar */}
      <div className="flex items-center gap-3 mb-4">
        <Select value={levelFilter} onValueChange={setLevelFilter}>
          <SelectTrigger className="w-32">
            <SelectValue placeholder="Level" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Levels</SelectItem>
            <SelectItem value="error">Error</SelectItem>
            <SelectItem value="warn">Warn</SelectItem>
            <SelectItem value="info">Info</SelectItem>
            <SelectItem value="debug">Debug</SelectItem>
          </SelectContent>
        </Select>

        <Select value={sourceFilter} onValueChange={setSourceFilter}>
          <SelectTrigger className="w-32">
            <SelectValue placeholder="Source" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Sources</SelectItem>
            <SelectItem value="frontend">Frontend</SelectItem>
            <SelectItem value="backend">Backend</SelectItem>
          </SelectContent>
        </Select>

        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <Input
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search messages..."
            className="pl-9"
          />
        </div>

        <Button variant="outline" size="sm" onClick={fetchLogs} disabled={loading}>
          {loading ? (
            <Loader2 className="w-4 h-4 animate-spin" />
          ) : (
            <RefreshCw className="w-4 h-4" />
          )}
        </Button>
      </div>

      {/* Log table */}
      <div className="border rounded-lg overflow-hidden">
        <div className="max-h-[500px] overflow-y-auto">
          {entries.length === 0 ? (
            <div className="p-8 text-center text-muted-foreground">
              {loading ? "Loading..." : "No log entries found"}
            </div>
          ) : (
            <table className="w-full text-sm">
              <thead className="bg-muted/50 sticky top-0">
                <tr>
                  <th className="text-left px-3 py-2 font-medium w-40">Time</th>
                  <th className="text-left px-3 py-2 font-medium w-16">Level</th>
                  <th className="text-left px-3 py-2 font-medium w-20">Source</th>
                  <th className="text-left px-3 py-2 font-medium w-24">Category</th>
                  <th className="text-left px-3 py-2 font-medium">Message</th>
                </tr>
              </thead>
              <tbody>
                {entries.map((entry) => (
                  <React.Fragment key={entry.id}>
                    <tr
                      className={`border-t cursor-pointer hover:bg-muted/30 ${LEVEL_BG[entry.level] || ""}`}
                      onClick={() =>
                        setExpandedId(expandedId === entry.id ? null : (entry.id ?? null))
                      }
                    >
                      <td className="px-3 py-2 font-mono text-xs text-muted-foreground whitespace-nowrap">
                        {formatTimestamp(entry.timestamp)}
                      </td>
                      <td className={`px-3 py-2 font-mono text-xs font-bold uppercase ${LEVEL_COLORS[entry.level] || ""}`}>
                        {entry.level}
                      </td>
                      <td className="px-3 py-2">
                        <span className={`text-xs px-1.5 py-0.5 rounded ${
                          entry.source === "backend"
                            ? "bg-purple-500/20 text-purple-300"
                            : "bg-sky-500/20 text-sky-300"
                        }`}>
                          {entry.source}
                        </span>
                      </td>
                      <td className="px-3 py-2 text-xs text-muted-foreground truncate max-w-[120px]">
                        {entry.category || "-"}
                      </td>
                      <td className="px-3 py-2 text-xs truncate max-w-[400px]">
                        {entry.message}
                      </td>
                    </tr>
                    {expandedId === entry.id && (
                      <tr className="border-t bg-muted/20">
                        <td colSpan={5} className="px-4 py-3">
                          <pre className="text-xs font-mono whitespace-pre-wrap break-all">
                            {entry.message}
                          </pre>
                          {entry.metadata && (
                            <div className="mt-2 pt-2 border-t border-border/50">
                              <span className="text-xs font-semibold text-muted-foreground">Metadata:</span>
                              <pre className="text-xs font-mono whitespace-pre-wrap break-all mt-1">
                                {(() => {
                                  try {
                                    return JSON.stringify(JSON.parse(entry.metadata!), null, 2);
                                  } catch {
                                    return entry.metadata;
                                  }
                                })()}
                              </pre>
                            </div>
                          )}
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>

      {/* Footer: pagination + clear */}
      <div className="flex items-center justify-between mt-4">
        <div className="flex items-center gap-2">
          <span className="text-sm text-muted-foreground">
            {total > 0
              ? `Showing ${page * PAGE_SIZE + 1}-${Math.min((page + 1) * PAGE_SIZE, total)} of ${total.toLocaleString()}`
              : "No entries"}
          </span>
          <Button
            variant="outline"
            size="sm"
            disabled={page === 0}
            onClick={() => setPage((p) => p - 1)}
          >
            <ChevronLeft className="w-4 h-4" />
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={page >= totalPages - 1}
            onClick={() => setPage((p) => p + 1)}
          >
            <ChevronRight className="w-4 h-4" />
          </Button>
        </div>

        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => handlePruneClick("1w", "older than 1 week")}
          >
            <Trash2 className="w-3 h-3 mr-1" />
            Older than 1 week
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => handlePruneClick("1m", "older than 1 month")}
          >
            <Trash2 className="w-3 h-3 mr-1" />
            Older than 1 month
          </Button>
          <Button
            variant="destructive"
            size="sm"
            onClick={() => handlePruneClick(undefined, "all")}
          >
            <Trash2 className="w-3 h-3 mr-1" />
            Clear all
          </Button>
        </div>
      </div>

      {/* Prune confirmation dialog */}
      <Dialog open={pruneDialog.open} onOpenChange={(open) => !open && setPruneDialog({ open: false, label: "" })}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <AlertTriangle className="w-5 h-5 text-yellow-500" />
              Clear Log Entries
            </DialogTitle>
            <DialogDescription>
              This will permanently delete {pruneDialog.label === "all" ? "all" : ""}{" "}
              {pruneCount !== null ? `${pruneCount.toLocaleString()} ` : ""}
              log entries{pruneDialog.label !== "all" ? ` ${pruneDialog.label}` : ""}. This action
              cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPruneDialog({ open: false, label: "" })}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={confirmPrune}>
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
};
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
npx tsc --noEmit
```

Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/components/LogTab.tsx
git commit -m "feat: add LogTab component with filtering, pagination, and pruning"
```

---

### Task 14: Wire LogTab into Settings and Add Startup Check

**Files:**
- Modify: `src/components/Settings.tsx` (add tab, import)
- Modify: `src/main.tsx` (startup log count check)

- [ ] **Step 1: Add LogTab import to `Settings.tsx`**

Add to imports at the top of the file:
```typescript
import { LogTab } from "./LogTab";
```

- [ ] **Step 2: Update tab grid and add trigger**

Change `grid-cols-9` to `grid-cols-10` on the TabsList:
```typescript
<TabsList className="grid grid-cols-10 w-full mb-6 h-auto p-1">
```

Add the new tab trigger after the proxy trigger:
```typescript
<TabsTrigger value="log" className="py-2.5 px-3">Log</TabsTrigger>
```

- [ ] **Step 3: Add LogTab content**

After the proxy `TabsContent` block and before the closing `</Tabs>`, add:

```typescript
{/* Log Tab */}
<TabsContent value="log">
  <LogTab />
</TabsContent>
```

- [ ] **Step 4: Add startup log count check in `main.tsx`**

After `logService.initialize();`, add:

```typescript
// Check log count and warn if excessive
api.logCount().then((count) => {
  if (count > 5000) {
    console.warn(
      `You have ${count.toLocaleString()} log entries. Review and prune old records in Settings → Log.`
    );
  }
}).catch(() => {
  // Ignore — DB may not be ready yet
});
```

Add the api import:
```typescript
import { api } from './lib/api';
```

- [ ] **Step 5: Verify TypeScript compiles**

```bash
npx tsc --noEmit
```

Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/components/Settings.tsx src/main.tsx
git commit -m "feat: wire LogTab into Settings and add startup log count warning"
```

---

### Task 15: Full Verification

- [ ] **Step 1: Run TypeScript check**

```bash
npm run check
```

Expected: PASS (tsc + cargo check)

- [ ] **Step 2: Run frontend build**

```bash
npm run build
```

Expected: PASS

- [ ] **Step 3: Run Rust tests**

```bash
cd src-tauri && cargo test
```

Expected: All tests PASS, including the 8 new logging tests.

- [ ] **Step 4: Verify no remaining unexpected opcode references**

```bash
rg -i "opcode" --type rust --type ts --type json -g '!node_modules' -g '!target' -g '!dist' -g '!package-lock.json' -l
```

Review and ensure only expected files remain (attribution, upstream URLs, migration code, asset filenames).

- [ ] **Step 5: Run cargo fmt**

```bash
cd src-tauri && cargo fmt
```

- [ ] **Step 6: Commit formatting if needed**

```bash
git add -A && git diff --cached --quiet || git commit -m "style: cargo fmt"
```
