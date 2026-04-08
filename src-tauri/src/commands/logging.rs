use chrono::{Duration, Utc};
use rusqlite::params;
use serde::{Deserialize, Serialize};
use tauri::State;

use super::agents::AgentDb;

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

/// Creates the app_logs table and indexes. Safe to call repeatedly (IF NOT EXISTS).
pub fn create_app_logs_table(conn: &rusqlite::Connection) -> Result<(), String> {
    conn.execute_batch(
        "
        CREATE TABLE IF NOT EXISTS app_logs (
            id        INTEGER PRIMARY KEY AUTOINCREMENT,
            timestamp TEXT    NOT NULL,
            level     TEXT    NOT NULL,
            source    TEXT    NOT NULL,
            category  TEXT,
            message   TEXT    NOT NULL,
            metadata  TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_app_logs_timestamp ON app_logs (timestamp);
        CREATE INDEX IF NOT EXISTS idx_app_logs_level     ON app_logs (level);
        CREATE INDEX IF NOT EXISTS idx_app_logs_source    ON app_logs (source);
        ",
    )
    .map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------
// Sync helpers (usable in tests without async overhead)
// ---------------------------------------------------------------------------

pub fn write_batch_sync(db: &AgentDb, entries: Vec<LogEntry>) -> Result<(), String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    for entry in entries {
        conn.execute(
            "INSERT INTO app_logs (timestamp, level, source, category, message, metadata)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
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

    // Build WHERE clause dynamically
    let mut conditions: Vec<String> = Vec::new();
    let mut params_vec: Vec<Box<dyn rusqlite::types::ToSql>> = Vec::new();
    let mut param_idx: usize = 1;

    if let Some(ref lvl) = level {
        conditions.push(format!("level = ?{}", param_idx));
        params_vec.push(Box::new(lvl.clone()));
        param_idx += 1;
    }
    if let Some(ref src) = source {
        conditions.push(format!("source = ?{}", param_idx));
        params_vec.push(Box::new(src.clone()));
        param_idx += 1;
    }
    if let Some(ref q) = search {
        conditions.push(format!("message LIKE ?{}", param_idx));
        params_vec.push(Box::new(format!("%{}%", q)));
        param_idx += 1;
    }

    let where_clause = if conditions.is_empty() {
        String::new()
    } else {
        format!("WHERE {}", conditions.join(" AND "))
    };

    // Count total matching rows
    let count_sql = format!("SELECT COUNT(*) FROM app_logs {}", where_clause);
    let total: u64 = {
        let refs: Vec<&dyn rusqlite::types::ToSql> =
            params_vec.iter().map(|b| b.as_ref()).collect();
        conn.query_row(&count_sql, refs.as_slice(), |row| row.get(0))
            .map_err(|e| e.to_string())?
    };

    // Pagination params appended after filter params
    let limit_idx = param_idx;
    let offset_idx = param_idx + 1;
    let data_sql = format!(
        "SELECT id, timestamp, level, source, category, message, metadata \
         FROM app_logs {} \
         ORDER BY timestamp DESC \
         LIMIT ?{} OFFSET ?{}",
        where_clause, limit_idx, offset_idx
    );

    let mut all_params: Vec<Box<dyn rusqlite::types::ToSql>> = params_vec;
    all_params.push(Box::new(limit as i64));
    all_params.push(Box::new(offset as i64));

    let refs: Vec<&dyn rusqlite::types::ToSql> = all_params.iter().map(|b| b.as_ref()).collect();

    let mut stmt = conn.prepare(&data_sql).map_err(|e| e.to_string())?;
    let entries = stmt
        .query_map(refs.as_slice(), |row| {
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

/// Parses age strings like "1w" (1 week) or "1m" (30 days) and returns the ISO-8601 cutoff.
/// Returns `None` when the string is unrecognised (treat as "prune all").
fn parse_age_cutoff(older_than: &str) -> Option<String> {
    let trimmed = older_than.trim();
    if trimmed.is_empty() {
        return None;
    }
    let (num_str, unit) = trimmed.split_at(trimmed.len() - 1);
    let n: i64 = num_str.parse().ok()?;
    let duration = match unit {
        "w" => Duration::weeks(n),
        "m" => Duration::days(n * 30),
        "d" => Duration::days(n),
        "h" => Duration::hours(n),
        _ => return None,
    };
    let cutoff = Utc::now() - duration;
    Some(cutoff.to_rfc3339())
}

pub fn prune_sync(db: &AgentDb, older_than: Option<String>) -> Result<u64, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;

    let deleted = match older_than {
        None => conn
            .execute("DELETE FROM app_logs", [])
            .map_err(|e| e.to_string())?,
        Some(ref age_str) => match parse_age_cutoff(age_str) {
            Some(cutoff) => conn
                .execute("DELETE FROM app_logs WHERE timestamp < ?1", params![cutoff])
                .map_err(|e| e.to_string())?,
            None => {
                return Err(format!("Unrecognised age string: '{}'", age_str));
            }
        },
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

// ---------------------------------------------------------------------------
// Tauri commands
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn log_write_batch(db: State<'_, AgentDb>, entries: Vec<LogEntry>) -> Result<(), String> {
    write_batch_sync(&db, entries)
}

#[tauri::command]
pub async fn log_query(
    db: State<'_, AgentDb>,
    level: Option<String>,
    source: Option<String>,
    search: Option<String>,
    limit: Option<u32>,
    offset: Option<u32>,
) -> Result<LogQueryResult, String> {
    query_sync(
        &db,
        level,
        source,
        search,
        limit.unwrap_or(100),
        offset.unwrap_or(0),
    )
}

#[tauri::command]
pub async fn log_prune(db: State<'_, AgentDb>, older_than: Option<String>) -> Result<u64, String> {
    prune_sync(&db, older_than)
}

#[tauri::command]
pub async fn log_count(db: State<'_, AgentDb>) -> Result<u64, String> {
    count_sync(&db)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection;
    use std::sync::Mutex;

    fn make_db() -> AgentDb {
        let conn = Connection::open_in_memory().expect("in-memory db");
        create_app_logs_table(&conn).expect("create table");
        AgentDb(Mutex::new(conn))
    }

    fn entry(level: &str, source: &str, message: &str) -> LogEntry {
        LogEntry {
            id: None,
            timestamp: Utc::now().to_rfc3339(),
            level: level.to_string(),
            source: source.to_string(),
            category: None,
            message: message.to_string(),
            metadata: None,
        }
    }

    #[test]
    fn test_create_table() {
        // Should not panic and should be idempotent
        let conn = Connection::open_in_memory().expect("in-memory db");
        create_app_logs_table(&conn).expect("first call");
        create_app_logs_table(&conn).expect("second call (idempotent)");
    }

    #[test]
    fn test_write_and_count() {
        let db = make_db();
        assert_eq!(count_sync(&db).unwrap(), 0);
        write_batch_sync(&db, vec![entry("info", "test", "hello")]).unwrap();
        assert_eq!(count_sync(&db).unwrap(), 1);
        write_batch_sync(
            &db,
            vec![entry("warn", "svc", "w1"), entry("error", "svc", "e1")],
        )
        .unwrap();
        assert_eq!(count_sync(&db).unwrap(), 3);
    }

    #[test]
    fn test_query_by_level() {
        let db = make_db();
        write_batch_sync(
            &db,
            vec![
                entry("info", "a", "msg1"),
                entry("warn", "b", "msg2"),
                entry("info", "c", "msg3"),
            ],
        )
        .unwrap();

        let result = query_sync(&db, Some("info".into()), None, None, 100, 0).unwrap();
        assert_eq!(result.total, 2);
        assert_eq!(result.entries.len(), 2);
        for e in &result.entries {
            assert_eq!(e.level, "info");
        }
    }

    #[test]
    fn test_query_by_source() {
        let db = make_db();
        write_batch_sync(
            &db,
            vec![
                entry("info", "frontend", "f1"),
                entry("warn", "backend", "b1"),
                entry("info", "frontend", "f2"),
            ],
        )
        .unwrap();

        let result = query_sync(&db, None, Some("frontend".into()), None, 100, 0).unwrap();
        assert_eq!(result.total, 2);
        for e in &result.entries {
            assert_eq!(e.source, "frontend");
        }
    }

    #[test]
    fn test_query_search() {
        let db = make_db();
        write_batch_sync(
            &db,
            vec![
                entry("info", "a", "needle in a haystack"),
                entry("info", "a", "no match here"),
                entry("info", "a", "another needle"),
            ],
        )
        .unwrap();

        let result = query_sync(&db, None, None, Some("needle".into()), 100, 0).unwrap();
        assert_eq!(result.total, 2);
    }

    #[test]
    fn test_pagination() {
        let db = make_db();
        let entries: Vec<LogEntry> = (0..10)
            .map(|i| entry("info", "src", &format!("msg {}", i)))
            .collect();
        write_batch_sync(&db, entries).unwrap();

        let page1 = query_sync(&db, None, None, None, 4, 0).unwrap();
        assert_eq!(page1.total, 10);
        assert_eq!(page1.entries.len(), 4);

        let page2 = query_sync(&db, None, None, None, 4, 4).unwrap();
        assert_eq!(page2.total, 10);
        assert_eq!(page2.entries.len(), 4);

        let page3 = query_sync(&db, None, None, None, 4, 8).unwrap();
        assert_eq!(page3.total, 10);
        assert_eq!(page3.entries.len(), 2);
    }

    #[test]
    fn test_prune_by_age() {
        let db = make_db();
        // Insert one old entry with a past timestamp
        {
            let conn = db.0.lock().unwrap();
            let old_ts = (Utc::now() - Duration::days(10)).to_rfc3339();
            conn.execute(
                "INSERT INTO app_logs (timestamp, level, source, message) VALUES (?1, 'info', 'src', 'old')",
                params![old_ts],
            )
            .unwrap();
        }
        // Insert a recent entry
        write_batch_sync(&db, vec![entry("info", "src", "recent")]).unwrap();

        assert_eq!(count_sync(&db).unwrap(), 2);

        // Prune entries older than 1 week
        let pruned = prune_sync(&db, Some("1w".into())).unwrap();
        assert_eq!(pruned, 1);
        assert_eq!(count_sync(&db).unwrap(), 1);
    }

    #[test]
    fn test_prune_all() {
        let db = make_db();
        write_batch_sync(
            &db,
            vec![
                entry("info", "a", "1"),
                entry("warn", "b", "2"),
                entry("error", "c", "3"),
            ],
        )
        .unwrap();
        assert_eq!(count_sync(&db).unwrap(), 3);

        let pruned = prune_sync(&db, None).unwrap();
        assert_eq!(pruned, 3);
        assert_eq!(count_sync(&db).unwrap(), 0);
    }
}
