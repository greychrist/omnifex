import BetterSqlite3 from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { toFtsQuery } from './fts-query';
import type { ParsedNote } from './types';
import type { Vault } from './vault';
import { NoteParseError } from './frontmatter';

export interface SearchHit {
  notePath: string;
  type: string;
  title: string;
  snippet: string;
  /** Raw bm25: more negative is better. */
  score: number;
}

export interface SearchOptions {
  type?: string;
  project?: string;
  limit?: number;
}

export interface ProjectTypeCount {
  project: string;
  type: string;
  count: number;
}

/** The MCP server gets only this: it runs in another process and must never write. */
export interface ReadonlyVaultIndex {
  search(query: string, opts?: SearchOptions): SearchHit[];
  /** Counts, never titles: a table of contents would cost thousands of tokens in every session. */
  projectCounts(): ProjectTypeCount[];
  close(): void;
}

export interface VaultIndex extends ReadonlyVaultIndex {
  upsert(notePath: string, title: string, note: ParsedNote): void;
  remove(notePath: string): void;
  rebuild(vault: Vault): number;
}

export class BrainIndexUnavailableError extends Error {}

const DEFAULT_LIMIT = 20;

/** `project` is UNINDEXED: as free text it would rank a whole project against a query naming it. */
const COLUMNS =
  'note_path UNINDEXED, type UNINDEXED, project UNINDEXED, title, aliases, keywords, summary, body';

const TOKENIZER = `tokenize = "porter unicode61 tokenchars '-_'"`;

/** bm25 weights in COLUMNS order; UNINDEXED columns must be 0. */
const BM25_WEIGHTS = '0.0, 0.0, 0.0, 10.0, 8.0, 6.0, 3.0, 1.0';

/** Must match the body column's ordinal in COLUMNS. */
const BODY_COLUMN = 7;

function runProjectCounts(db: BetterSqlite3.Database): ProjectTypeCount[] {
  return db
    .prepare(
      `SELECT project, type, count(*) AS count
         FROM brain_fts
        GROUP BY project, type`,
    )
    .all() as ProjectTypeCount[];
}

/** Shared by both openers: the MCP server and the Brain tab must rank identically. */
function runSearch(
  db: BetterSqlite3.Database,
  query: string,
  opts: SearchOptions,
): SearchHit[] {
  const match = toFtsQuery(query);
  if (!match) return [];

  const clauses: string[] = [];
  const params: unknown[] = [match];
  if (opts.type) {
    clauses.push('AND type = ?');
    params.push(opts.type);
  }
  if (opts.project) {
    clauses.push('AND project = ?');
    params.push(opts.project);
  }
  params.push(opts.limit ?? DEFAULT_LIMIT);

  return db
    .prepare(
      `SELECT note_path AS notePath,
              type,
              title,
              snippet(brain_fts, ${BODY_COLUMN}, '[', ']', '…', 12) AS snippet,
              bm25(brain_fts, ${BM25_WEIGHTS}) AS score
         FROM brain_fts
        WHERE brain_fts MATCH ?
          ${clauses.join('\n          ')}
        ORDER BY score ASC
        LIMIT ?`,
    )
    .all(...params) as SearchHit[];
}

/** The schema version check: ask the table, never a side-table version. */
function hasProjectColumn(db: BetterSqlite3.Database): boolean {
  try {
    const cols = db.prepare('PRAGMA table_info(brain_fts)').all() as { name: string }[];
    return cols.some((c) => c.name === 'project');
  } catch {
    return false;
  }
}

/** Must never create the database: `fileMustExist` and `readonly` enforce it. */
export function readIndexedCount(dbPath: string): number | null {
  let db: BetterSqlite3.Database;
  try {
    db = new BetterSqlite3(dbPath, { readonly: true, fileMustExist: true });
  } catch {
    return null;
  }
  try {
    const row = db.prepare('SELECT count(*) AS n FROM brain_fts').get() as { n: number } | undefined;
    return row?.n ?? 0;
  } catch {
    // Corrupt, not empty: null means unknown.
    return null;
  } finally {
    db.close();
  }
}

/** Never creates, migrates or writes a WAL. Throws, never null: "no index" and "empty vault" must stay distinct. */
export function openVaultIndexReadOnly(dbPath: string): ReadonlyVaultIndex {
  let db: BetterSqlite3.Database;
  try {
    db = new BetterSqlite3(dbPath, { readonly: true, fileMustExist: true });
  } catch {
    throw new BrainIndexUnavailableError(`no readable Brain index at ${dbPath}`);
  }
  if (!hasProjectColumn(db)) {
    db.close();
    throw new BrainIndexUnavailableError(
      'the Brain index predates the project column; rebuild it from the Brain tab',
    );
  }
  return {
    search: (query, opts = {}) => runSearch(db, query, opts),
    projectCounts: () => runProjectCounts(db),
    close: () => { db.close(); },
  };
}

export function createVaultIndex(dbPath: string): VaultIndex {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new BetterSqlite3(dbPath);
  db.pragma('journal_mode = WAL');

  db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS brain_fts USING fts5(${COLUMNS}, ${TOKENIZER});`);

  // Drop and recreate, never migrate: the index is disposable and FTS5 has no ALTER.
  if (!hasProjectColumn(db)) {
    db.exec('DROP TABLE IF EXISTS brain_fts');
    db.exec(`CREATE VIRTUAL TABLE brain_fts USING fts5(${COLUMNS}, ${TOKENIZER});`);
  }

  const deleteStmt = db.prepare('DELETE FROM brain_fts WHERE note_path = ?');
  const insertStmt = db.prepare(
    `INSERT INTO brain_fts (note_path, type, project, title, aliases, keywords, summary, body)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const clearStmt = db.prepare('DELETE FROM brain_fts');

  /** Line-scanned: JS regex has no \Z, and a subtle miss would weight every summary as empty. */
  function summaryOf(body: string): string {
    const lines = body.split('\n');
    const start = lines.findIndex((l) => /^##\s+Summary\s*$/.test(l));
    if (start === -1) return '';
    const rest = lines.slice(start + 1);
    const end = rest.findIndex((l) => /^##\s/.test(l));
    return (end === -1 ? rest : rest.slice(0, end)).join('\n').trim();
  }

  function write(notePath: string, title: string, note: ParsedNote): void {
    deleteStmt.run(notePath);
    insertStmt.run(
      notePath,
      note.frontmatter.type,
      note.frontmatter.project ?? '',
      title,
      note.frontmatter.aliases.join(' '),
      note.frontmatter.keywords.join(' '),
      summaryOf(note.body),
      note.body,
    );
  }

  return {
    upsert(notePath, title, note): void {
      write(notePath, title, note);
    },

    remove(notePath: string): void {
      deleteStmt.run(notePath);
    },

    search(query: string, opts: SearchOptions = {}): SearchHit[] {
      return runSearch(db, query, opts);
    },

    projectCounts(): ProjectTypeCount[] {
      return runProjectCounts(db);
    },

    rebuild(vault: Vault): number {
      clearStmt.run();
      let count = 0;
      for (const relPath of vault.listNotes()) {
        try {
          write(relPath, vault.noteTitle(relPath), vault.readNote(relPath));
          count++;
        } catch (err) {
          // A hand-edited note with broken frontmatter must not abort the scan.
          if (!(err instanceof NoteParseError)) throw err;
        }
      }
      return count;
    },

    close(): void {
      db.close();
    },
  };
}
