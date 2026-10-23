import Foundation
import SQLite3

/// Reads one `app_settings` value from `greychrist.db`.
///
/// The daemon owns the database; the app only needs two settings (the
/// notification sounds), and asking the daemon over the socket for them would
/// make a banner depend on the connection being up. The file is shared WAL
/// with a busy timeout, so a read here never blocks the daemon's writers.
/// Anything missing — file, table, key — reads as nil.
public struct SettingsReader: Sendable {
    public var path: String
    public init(path: String) { self.path = path }

    public func value(for key: String) -> String? {
        guard FileManager.default.fileExists(atPath: path) else { return nil }
        var db: OpaquePointer?
        // READWRITE without CREATE: a WAL reader may need to touch -shm, and
        // the file must never be created from here.
        guard sqlite3_open_v2(path, &db, SQLITE_OPEN_READWRITE, nil) == SQLITE_OK else {
            sqlite3_close(db)
            return nil
        }
        defer { sqlite3_close(db) }
        sqlite3_busy_timeout(db, 2000)
        var stmt: OpaquePointer?
        guard sqlite3_prepare_v2(db, "SELECT value FROM app_settings WHERE key = ?", -1, &stmt, nil) == SQLITE_OK else { return nil }
        defer { sqlite3_finalize(stmt) }
        let transient = unsafeBitCast(-1, to: sqlite3_destructor_type.self)
        sqlite3_bind_text(stmt, 1, key, -1, transient)
        guard sqlite3_step(stmt) == SQLITE_ROW, let c = sqlite3_column_text(stmt, 0) else { return nil }
        return String(cString: c)
    }

    /// Test fixture: a database with an `app_settings` table (or none, for nil rows).
    static func testCreate(path: String, rows: [String: String]?) throws {
        var db: OpaquePointer?
        guard sqlite3_open(path, &db) == SQLITE_OK else { throw BridgeError("open failed") }
        defer { sqlite3_close(db) }
        guard let rows else { sqlite3_exec(db, "CREATE TABLE other (x)", nil, nil, nil); return }
        sqlite3_exec(db, "CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT)", nil, nil, nil)
        for (k, v) in rows {
            sqlite3_exec(db, "INSERT INTO app_settings (key, value) VALUES ('\(k)', '\(v)')", nil, nil, nil)
        }
    }
}
