import type { Database } from './database';
import type { LogLevel, LogSource } from './log-sources';

export type { LogLevel, LogSource };

// ---------------------------------------------------------------------------
// Public interfaces
// ---------------------------------------------------------------------------

export interface LogEntry {
  timestamp: string;
  level: LogLevel;
  source: LogSource;
  category?: string;
  message: string;
  metadata?: string;
}

/**
 * Columns the renderer can sort on. Kept narrow on purpose — anything
 * passed for `orderBy` that isn't in this union is rejected by the
 * service and the query falls back to the default (timestamp DESC).
 * That serves two purposes: (1) preserves the previous behavior for
 * callers that don't specify a sort, and (2) closes the SQL-injection
 * surface that an unfiltered string-substitution into ORDER BY would
 * open.
 */
export type LogOrderBy = 'timestamp' | 'level' | 'source' | 'category' | 'message';
export type LogOrderDir = 'asc' | 'desc';

export interface LogQueryFilters {
  levels?: string[];
  sources?: string[];
  search?: string;
  since?: string;
  until?: string;
  limit?: number;
  offset?: number;
  /**
   * Column to sort by. Default: `timestamp`.
   *
   * `level` sorts by severity (error > warn > info > debug), not
   * alphabetically — alphabetical level ordering would put `debug` first
   * and `warn` last, which is the opposite of what a user triaging the
   * Log tab wants.
   */
  orderBy?: LogOrderBy;
  /** Sort direction. Default: `desc`. */
  orderDir?: LogOrderDir;
}

export interface LogQueryResult {
  entries: (LogEntry & { id: number })[];
  total: number;
}

/**
 * Optional construction-time options for {@link createLoggingService}.
 *
 * `shouldAccept` is evaluated once per entry on every `writeBatch` call —
 * returning `false` drops the entry before it hits SQLite. Use it to gate
 * known-noisy info/debug streams (claude-hooks, usage-runner) behind a
 * user setting without sprinkling guards across every call site.
 */
export interface LoggingServiceOptions {
  shouldAccept?: (entry: LogEntry) => boolean;
  /**
   * Fired once per error-level entry that survives `shouldAccept` and is
   * successfully persisted. Used by main.ts to broadcast a renderer toast
   * so the user can correlate the error with whatever they were just doing.
   *
   * Handler exceptions are swallowed — a misbehaving observer must never
   * break the write path.
   */
  onError?: (entry: LogEntry) => void;
}

export interface LoggingService {
  writeBatch(entries: LogEntry[]): void;
  query(filters: LogQueryFilters): LogQueryResult;
  /**
   * Return the total number of entries matching the given filters.
   * Accepts the same filter shape as {@link query}, but ignores
   * `limit` / `offset` (count is a total, not a page).
   */
  count(filters: LogQueryFilters): number;
  /**
   * Delete log entries older than the given cutoff.
   *
   * - `olderThan` may be an ISO timestamp, a relative duration
   *   (`"1d"`, `"1w"`, `"1m"`, `"1h"`), or omitted entirely.
   * - If omitted, all entries are deleted.
   *
   * Returns the number of rows removed.
   */
  prune(olderThan?: string): number;
}

// ---------------------------------------------------------------------------
// Duration parsing for prune()
// ---------------------------------------------------------------------------

const DURATION_UNIT_MS: Record<string, number> = {
  h: 60 * 60 * 1000,
  d: 24 * 60 * 60 * 1000,
  w: 7 * 24 * 60 * 60 * 1000,
  m: 30 * 24 * 60 * 60 * 1000, // month ≈ 30d
};

/**
 * Parse an olderThan string into an ISO cutoff timestamp.
 * Accepts:
 *   - A full ISO timestamp (`2024-01-01T00:00:00Z`) → returned as-is.
 *   - A short duration (`1d`, `2w`, `1m`, `6h`) → computed relative to now.
 *
 * Returns null if the input is not recognized, in which case prune()
 * should fall back to "delete nothing" behavior to avoid accidental wipes.
 */
function parseOlderThan(input: string): string | null {
  // Try ISO first (cheap: contains 'T' or '-' in expected positions)
  if (input.includes('T') || /^\d{4}-\d{2}-\d{2}/.test(input)) {
    const parsed = new Date(input);
    if (!isNaN(parsed.getTime())) {
      return parsed.toISOString();
    }
  }

  // Try duration (e.g. "1d", "2w", "30d", "12h")
  const match = input.match(/^(\d+)([hdwm])$/);
  if (match) {
    const amount = Number(match[1]);
    const unit = match[2];
    const ms = amount * (DURATION_UNIT_MS[unit] ?? 0);
    if (ms > 0) {
      return new Date(Date.now() - ms).toISOString();
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createLoggingService(
  db: Database,
  options: LoggingServiceOptions = {},
): LoggingService {
  const raw = db.raw;
  const { shouldAccept, onError } = options;

  function writeBatch(entries: LogEntry[]): void {
    if (entries.length === 0) return;
    if (shouldAccept) {
      entries = entries.filter(shouldAccept);
      if (entries.length === 0) return;
    }

    const insert = raw.prepare(
      `INSERT INTO app_logs (timestamp, level, source, category, message, metadata)
       VALUES (?, ?, ?, ?, ?, ?)`
    );

    const insertMany = raw.transaction((rows: LogEntry[]) => {
      for (const row of rows) {
        insert.run(
          row.timestamp,
          row.level,
          row.source,
          row.category ?? null,
          row.message,
          row.metadata ?? null
        );
      }
    });

    insertMany(entries);

    // Notify observers about error-level entries after the transaction
    // commits, so handlers see only durable state. A misbehaving handler
    // must not break logging — each callback is isolated in its own
    // try/catch.
    if (onError) {
      for (const entry of entries) {
        if (entry.level !== 'error') continue;
        try {
          onError(entry);
        } catch {
          // intentionally swallowed
        }
      }
    }
  }

  /**
   * Build the WHERE clause and bound parameters for a filter set.
   * Shared between query() and count() so filter semantics can't drift.
   */
  function buildWhere(filters: LogQueryFilters): {
    whereClause: string;
    params: unknown[];
  } {
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (filters.levels && filters.levels.length > 0) {
      const placeholders = filters.levels.map(() => '?').join(', ');
      conditions.push(`level IN (${placeholders})`);
      params.push(...filters.levels);
    }

    if (filters.sources && filters.sources.length > 0) {
      const placeholders = filters.sources.map(() => '?').join(', ');
      conditions.push(`source IN (${placeholders})`);
      params.push(...filters.sources);
    }

    if (filters.search) {
      conditions.push(
        `(message LIKE ? OR metadata LIKE ? OR category LIKE ?)`
      );
      const like = `%${filters.search}%`;
      params.push(like, like, like);
    }

    if (filters.since) {
      conditions.push(`timestamp >= ?`);
      params.push(filters.since);
    }

    if (filters.until) {
      conditions.push(`timestamp <= ?`);
      params.push(filters.until);
    }

    const whereClause =
      conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    return { whereClause, params };
  }

  // SQL fragments per sortable column. Whitelisting columns this way is
  // the only safe path: we never substitute a caller-supplied string into
  // ORDER BY directly. Each builder returns a complete clause for both
  // direction values.
  //
  // - `level` uses a CASE expression so DESC lands errors at the top
  //   (alphabetical level ordering would put `debug` first and `warn`
  //   last — the opposite of what a user triaging the log wants).
  // - `category` keeps NULL/empty rows pinned to the bottom regardless
  //   of direction: an extra ASC-ordered "is empty" tag column puts real
  //   categories first; the user-chosen direction then orders within
  //   the non-empty bucket.
  const ORDER_BY_SQL: Record<LogOrderBy, (dir: 'ASC' | 'DESC') => string> = {
    timestamp: (dir) => `timestamp ${dir}`,
    level: (dir) =>
      `(CASE level
          WHEN 'error' THEN 4
          WHEN 'warn'  THEN 3
          WHEN 'info'  THEN 2
          WHEN 'debug' THEN 1
          ELSE 0
        END) ${dir}`,
    source: (dir) => `source ${dir}`,
    category: (dir) =>
      `(CASE WHEN category IS NULL OR category = '' THEN 1 ELSE 0 END) ASC, category ${dir}`,
    message: (dir) => `message ${dir}`,
  };

  function resolveOrderClause(filters: LogQueryFilters): string {
    const requested = filters.orderBy;
    const builder = requested && Object.prototype.hasOwnProperty.call(ORDER_BY_SQL, requested)
      ? ORDER_BY_SQL[requested]
      : ORDER_BY_SQL.timestamp;
    const dir = filters.orderDir === 'asc' ? 'ASC' : 'DESC';
    // Tie-breakers: newest first, then id DESC. Keeps page boundaries
    // stable when many rows share the same value on the primary sort
    // column (very common for `level` / `source`).
    return `${builder(dir)}, timestamp DESC, id DESC`;
  }

  function query(filters: LogQueryFilters): LogQueryResult {
    const { whereClause, params } = buildWhere(filters);

    const total = (
      raw
        .prepare(`SELECT COUNT(*) as count FROM app_logs ${whereClause}`)
        .get(...(params as [])) as { count: number }
    ).count;

    const limit = filters.limit ?? 100;
    const offset = filters.offset ?? 0;
    const orderClause = resolveOrderClause(filters);

    const entries = raw
      .prepare(
        `SELECT id, timestamp, level, source, category, message, metadata
         FROM app_logs
         ${whereClause}
         ORDER BY ${orderClause}
         LIMIT ? OFFSET ?`
      )
      .all(...(params as []), limit, offset) as (LogEntry & { id: number })[];

    return { entries, total };
  }

  function count(filters: LogQueryFilters): number {
    const { whereClause, params } = buildWhere(filters);
    const row = raw
      .prepare(`SELECT COUNT(*) as count FROM app_logs ${whereClause}`)
      .get(...(params as [])) as { count: number };
    return row.count;
  }

  function prune(olderThan?: string): number {
    // No cutoff → delete everything.
    if (olderThan === undefined) {
      const result = raw.prepare(`DELETE FROM app_logs`).run();
      return result.changes;
    }

    // Unparseable cutoff → treat as "delete nothing" to avoid accidental wipes.
    // (Callers that want to delete all should pass `undefined` explicitly.)
    const cutoff = parseOlderThan(olderThan);
    if (cutoff === null) {
      return 0;
    }

    const result = raw
      .prepare(`DELETE FROM app_logs WHERE timestamp < ?`)
      .run(cutoff);
    return result.changes;
  }

  return { writeBatch, query, count, prune };
}
