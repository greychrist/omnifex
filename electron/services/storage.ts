import type { Database } from './database';

// ---------------------------------------------------------------------------
// Public interfaces
// ---------------------------------------------------------------------------

export interface ColumnInfo {
  name: string;
  type: string;
  notnull: boolean;
  pk: boolean;
}

export interface TableInfo {
  name: string;
  columns: ColumnInfo[];
  rowCount: number;
}

export interface TableData {
  columns: ColumnInfo[];
  rows: Record<string, unknown>[];
  total: number;
  page: number;
  pageSize: number;
}

export interface StorageService {
  listTables(): TableInfo[];
  readTable(
    tableName: string,
    page: number,
    pageSize: number,
    searchQuery?: string
  ): TableData;
  updateRow(
    tableName: string,
    primaryKeyValues: Record<string, unknown>,
    updates: Record<string, unknown>
  ): void;
  deleteRow(
    tableName: string,
    primaryKeyValues: Record<string, unknown>
  ): void;
  insertRow(tableName: string, values: Record<string, unknown>): number;
  executeSql(query: string): any;
  resetDatabase(): void;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface PragmaColumnRow {
  cid: number;
  name: string;
  type: string;
  notnull: number;
  dflt_value: unknown;
  pk: number;
}

function getColumns(db: Database, tableName: string): ColumnInfo[] {
  const rows = db.raw
    .prepare(`PRAGMA table_info(${JSON.stringify(tableName)})`)
    .all() as PragmaColumnRow[];
  return rows.map((r) => ({
    name: r.name,
    type: r.type,
    notnull: r.notnull !== 0,
    pk: r.pk !== 0,
  }));
}

function validateIdentifier(name: string): void {
  // Allow only alphanumeric, underscore, and hyphen characters
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) {
    throw new Error(`Invalid identifier: ${name}`);
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createStorageService(db: Database): StorageService {
  const raw = db.raw;

  function listTables(): TableInfo[] {
    const tableNames = raw
      .prepare(
        `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`
      )
      .all() as { name: string }[];

    return tableNames.map(({ name }) => {
      const columns = getColumns(db, name);
      const countRow = raw
        .prepare(`SELECT COUNT(*) as count FROM ${JSON.stringify(name)}`)
        .get() as { count: number };
      return { name, columns, rowCount: countRow.count };
    });
  }

  function readTable(
    tableName: string,
    page: number,
    pageSize: number,
    searchQuery?: string
  ): TableData {
    validateIdentifier(tableName);
    const columns = getColumns(db, tableName);

    const offset = (page - 1) * pageSize;
    const params: unknown[] = [];
    let whereClause = '';

    if (searchQuery && searchQuery.trim()) {
      const textCols = columns.filter((c) =>
        ['TEXT', 'VARCHAR', 'CHAR', 'CLOB', ''].some((t) =>
          c.type.toUpperCase().includes(t)
        )
      );

      if (textCols.length > 0) {
        const conditions = textCols
          .map((c) => `${JSON.stringify(c.name)} LIKE ?`)
          .join(' OR ');
        whereClause = `WHERE ${conditions}`;
        params.push(...textCols.map(() => `%${searchQuery}%`));
      }
    }

    const total = (
      raw
        .prepare(
          `SELECT COUNT(*) as count FROM ${JSON.stringify(tableName)} ${whereClause}`
        )
        .get(...(params as [])) as { count: number }
    ).count;

    const rows = raw
      .prepare(
        `SELECT * FROM ${JSON.stringify(tableName)} ${whereClause} LIMIT ? OFFSET ?`
      )
      .all(...(params as []), pageSize, offset) as Record<string, unknown>[];

    return { columns, rows, total, page, pageSize };
  }

  function updateRow(
    tableName: string,
    primaryKeyValues: Record<string, unknown>,
    updates: Record<string, unknown>
  ): void {
    validateIdentifier(tableName);

    const setClauses = Object.keys(updates)
      .map((k) => `${JSON.stringify(k)} = ?`)
      .join(', ');
    const whereClauses = Object.keys(primaryKeyValues)
      .map((k) => `${JSON.stringify(k)} = ?`)
      .join(' AND ');

    const params = [
      ...Object.values(updates),
      ...Object.values(primaryKeyValues),
    ];

    raw
      .prepare(
        `UPDATE ${JSON.stringify(tableName)} SET ${setClauses} WHERE ${whereClauses}`
      )
      .run(...(params as []));
  }

  function deleteRow(
    tableName: string,
    primaryKeyValues: Record<string, unknown>
  ): void {
    validateIdentifier(tableName);

    const whereClauses = Object.keys(primaryKeyValues)
      .map((k) => `${JSON.stringify(k)} = ?`)
      .join(' AND ');

    const params = Object.values(primaryKeyValues);

    raw
      .prepare(
        `DELETE FROM ${JSON.stringify(tableName)} WHERE ${whereClauses}`
      )
      .run(...(params as []));
  }

  function insertRow(
    tableName: string,
    values: Record<string, unknown>
  ): number {
    validateIdentifier(tableName);

    const cols = Object.keys(values)
      .map((k) => JSON.stringify(k))
      .join(', ');
    const placeholders = Object.keys(values)
      .map(() => '?')
      .join(', ');
    const params = Object.values(values);

    const info = raw
      .prepare(
        `INSERT INTO ${JSON.stringify(tableName)} (${cols}) VALUES (${placeholders})`
      )
      .run(...(params as []));

    return info.lastInsertRowid as number;
  }

  function executeSql(query: string): any {
    // Admin tool — intentionally runs arbitrary SQL
    const stmt = raw.prepare(query);
    if (stmt.reader) {
      return stmt.all();
    }
    return stmt.run();
  }

  function resetDatabase(): void {
    // Drop all user tables (not sqlite internal ones), then re-init schema
    const tableNames = raw
      .prepare(
        `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`
      )
      .all() as { name: string }[];

    const dropAll = raw.transaction(() => {
      for (const { name } of tableNames) {
        raw.prepare(`DELETE FROM ${JSON.stringify(name)}`).run();
      }
    });

    dropAll();
  }

  return {
    listTables,
    readTable,
    updateRow,
    deleteRow,
    insertRow,
    executeSql,
    resetDatabase,
  };
}
