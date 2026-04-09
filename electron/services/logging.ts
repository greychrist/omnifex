import type { Database } from './database';

// ---------------------------------------------------------------------------
// Public interfaces
// ---------------------------------------------------------------------------

export interface LogEntry {
  timestamp: string;
  level: string;
  source: string;
  category?: string;
  message: string;
  metadata?: string;
}

export interface LogQueryFilters {
  levels?: string[];
  sources?: string[];
  search?: string;
  since?: string;
  until?: string;
  limit?: number;
  offset?: number;
}

export interface LogQueryResult {
  entries: (LogEntry & { id: number })[];
  total: number;
}

export interface LoggingService {
  writeBatch(entries: LogEntry[]): void;
  query(filters: LogQueryFilters): LogQueryResult;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createLoggingService(db: Database): LoggingService {
  const raw = db.raw;

  function writeBatch(entries: LogEntry[]): void {
    if (entries.length === 0) return;

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
  }

  function query(filters: LogQueryFilters): LogQueryResult {
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
      conditions.push(`message LIKE ?`);
      params.push(`%${filters.search}%`);
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

    const total = (
      raw
        .prepare(`SELECT COUNT(*) as count FROM app_logs ${whereClause}`)
        .get(...(params as [])) as { count: number }
    ).count;

    const limit = filters.limit ?? 100;
    const offset = filters.offset ?? 0;

    const entries = raw
      .prepare(
        `SELECT id, timestamp, level, source, category, message, metadata
         FROM app_logs
         ${whereClause}
         ORDER BY timestamp DESC
         LIMIT ? OFFSET ?`
      )
      .all(...(params as []), limit, offset) as (LogEntry & { id: number })[];

    return { entries, total };
  }

  return { writeBatch, query };
}
