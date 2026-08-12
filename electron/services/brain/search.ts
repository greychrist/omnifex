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
  /** Raw bm25 score. More negative is a better match. */
  score: number;
}

export interface SearchOptions {
  type?: string;
  /** Exact frontmatter `project` value, e.g. "[[Projects/omnifex]]". */
  project?: string;
  limit?: number;
}

/**
 * The read half of a vault index. `openVaultIndexReadOnly` returns one of
 * these; the read-write `VaultIndex` is a superset. The MCP server takes this
 * narrower type because it must never be able to write — it runs in a separate
 * process from the indexing worker, and a second writer is contention the
 * design deliberately avoids.
 */
export interface ReadonlyVaultIndex {
  search(query: string, opts?: SearchOptions): SearchHit[];
  close(): void;
}

export interface VaultIndex extends ReadonlyVaultIndex {
  upsert(notePath: string, title: string, note: ParsedNote): void;
  remove(notePath: string): void;
  /** Reindex the whole vault from disk. Returns the number of notes indexed. */
  rebuild(vault: Vault): number;
}

/** No usable index at a path: missing, unreadable, or on an older schema. */
export class BrainIndexUnavailableError extends Error {}

const DEFAULT_LIMIT = 20;

/**
 * The FTS5 column list. `project` is UNINDEXED and sits beside `type` because
 * both are filters rather than search targets — matching a project name as
 * free text would rank every note in a project against a query naming it.
 */
const COLUMNS =
  'note_path UNINDEXED, type UNINDEXED, project UNINDEXED, title, aliases, keywords, summary, body';

const TOKENIZER = `tokenize = "porter unicode61 tokenchars '-_'"`;

/**
 * Column weights for bm25, in declaration order:
 *   note_path, type, project, title, aliases, keywords, summary, body
 * UNINDEXED columns get 0. Title, aliases and keywords dominate so that a note
 * which *is* about a subject outranks one that mentions it in passing — the
 * aliases field is what makes FTS5 competitive with semantic search here.
 */
const BM25_WEIGHTS = '0.0, 0.0, 0.0, 10.0, 8.0, 6.0, 3.0, 1.0';

/** Ordinal of the body column, for snippet(). */
const BODY_COLUMN = 7;

/**
 * The one search query, shared by the read-write and read-only openers.
 *
 * Shared rather than copied: the MCP server and the Brain tab must rank the
 * same corpus identically, and two copies of the weights would drift without
 * any test noticing.
 */
function runSearch(
  db: BetterSqlite3.Database,
  query: string,
  opts: SearchOptions,
): SearchHit[] {
  const match = toFtsQuery(query);
  // An empty MATCH is a syntax error, so bail before touching SQLite.
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

/**
 * Whether an existing `brain_fts` carries the `project` column.
 *
 * This is the schema version check. A bare version number in a side table
 * would be one more thing to keep in step with the table it describes; asking
 * the table what it has cannot go stale.
 */
function hasProjectColumn(db: BetterSqlite3.Database): boolean {
  try {
    const cols = db.prepare('PRAGMA table_info(brain_fts)').all() as { name: string }[];
    return cols.some((c) => c.name === 'project');
  } catch {
    return false;
  }
}

/**
 * Row count of an existing index, or null when there is no readable index.
 *
 * Deliberately separate from `createVaultIndex`, which CREATES the database it
 * is handed — a status probe must be able to report "configured but never
 * indexed" without bringing the thing it is reporting on into existence.
 * `fileMustExist` is what enforces that; `readonly` keeps a probe from
 * migrating a schema or writing a WAL into a vault nobody opened.
 */
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
    // A file that exists but has no brain_fts table is corrupt, not empty.
    // Null means "unknown", which is what the tab should show.
    return null;
  } finally {
    db.close();
  }
}

/**
 * Open an existing index for reading only.
 *
 * This is what the Brain MCP server uses. It never creates the database, never
 * migrates a schema, and never writes a WAL — a separate process holding a
 * write handle on the index the worker owns is exactly the contention the
 * design set out to avoid.
 *
 * Throws rather than returning null: every failure mode here is one the caller
 * must report to the model as a tool error naming a remedy, and a bare null
 * would collapse "no index" and "empty vault" into the same answer.
 */
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
    close: () => { db.close(); },
  };
}

export function createVaultIndex(dbPath: string): VaultIndex {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new BetterSqlite3(dbPath);
  db.pragma('journal_mode = WAL');

  db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS brain_fts USING fts5(${COLUMNS}, ${TOKENIZER});`);

  // An index written before `project` existed is dropped and recreated rather
  // than migrated. The index is derived from the vault and disposable, so the
  // cost is one rebuild; ALTER on an FTS5 virtual table is not available.
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

  /**
   * The Summary section, used as its own weighted column. Falls back to empty
   * when a note has no Summary heading. Line-scanned rather than regex-matched:
   * "everything until the next H2, or end of file" has no clean JS regex form
   * (there is no \Z anchor), and getting it subtly wrong would silently weight
   * every note's summary as empty.
   */
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

    rebuild(vault: Vault): number {
      // The index is derived, so a rebuild starts from empty. This is also how
      // notes deleted on disk leave the index.
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
