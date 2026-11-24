import type { Database } from './database';
import type { LogLevel, LogSource } from './log-sources';

export type { LogLevel, LogSource };

export interface LogEntry {
  timestamp: string;
  level: LogLevel;
  source: LogSource;
  category?: string;
  message: string;
  metadata?: string;
}

/** Closed union: ORDER BY is never built from a caller string. */
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
  orderBy?: LogOrderBy;
  orderDir?: LogOrderDir;
}

export interface LogQueryResult {
  entries: (LogEntry & { id: number })[];
  total: number;
}

export interface LoggingServiceOptions {
  shouldAccept?: (entry: LogEntry) => boolean;
  /** Handler exceptions are swallowed: an observer must never break the write path. */
  onError?: (entry: LogEntry) => void;
}

export interface LoggingService {
  writeBatch(entries: LogEntry[]): void;
  query(filters: LogQueryFilters): LogQueryResult;
  count(filters: LogQueryFilters): number;
  prune(olderThan?: string): number;
}

const DURATION_UNIT_MS: Record<string, number> = {
  h: 60 * 60 * 1000,
  d: 24 * 60 * 60 * 1000,
  w: 7 * 24 * 60 * 60 * 1000,
  m: 30 * 24 * 60 * 60 * 1000,
};

function parseOlderThan(input: string): string | null {
  if (input.includes('T') || /^\d{4}-\d{2}-\d{2}/.test(input)) {
    const parsed = new Date(input);
    if (!isNaN(parsed.getTime())) {
      return parsed.toISOString();
    }
  }

  const match = /^(\d+)([hdwm])$/.exec(input);
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

    // After commit, so handlers see only durable state.
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

  // Whitelisted builders: never substitute a caller string into ORDER BY.
  // `level` sorts by severity; empty categories stay last in either direction.
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
    // Tie-breakers keep page boundaries stable.
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

  /**
   * VACUUM, then checkpoint: in WAL mode the main file keeps its size until the WAL is truncated.
   * Never fails the prune: the rows are already gone.
   */
  function reclaimDiskSpace(): void {
    try {
      // The only cheap place to convert pre-INCREMENTAL databases: SQLite changes auto_vacuum only during a full VACUUM.
      raw.pragma('auto_vacuum = INCREMENTAL');
      raw.exec('VACUUM');
      raw.pragma('wal_checkpoint(TRUNCATE)');
    } catch (err) {
      writeBatch([
        {
          timestamp: new Date().toISOString(),
          level: 'warn',
          source: 'backend',
          message: 'log prune succeeded but reclaiming disk space failed',
          metadata: JSON.stringify({
            error: err instanceof Error ? err.message : String(err),
          }),
        },
      ]);
    }
  }

  function prune(olderThan?: string): number {
    if (olderThan === undefined) {
      const result = raw.prepare(`DELETE FROM app_logs`).run();
      if (result.changes > 0) reclaimDiskSpace();
      return result.changes;
    }

    // Unparseable: delete nothing. Callers wanting everything pass undefined.
    const cutoff = parseOlderThan(olderThan);
    if (cutoff === null) {
      return 0;
    }

    const result = raw
      .prepare(`DELETE FROM app_logs WHERE timestamp < ?`)
      .run(cutoff);
    // A no-op prune must not pay for a whole-database VACUUM.
    if (result.changes > 0) reclaimDiskSpace();
    return result.changes;
  }

  return { writeBatch, query, count, prune };
}
