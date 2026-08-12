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
  limit?: number;
}

export interface VaultIndex {
  upsert(notePath: string, title: string, note: ParsedNote): void;
  remove(notePath: string): void;
  search(query: string, opts?: SearchOptions): SearchHit[];
  /** Reindex the whole vault from disk. Returns the number of notes indexed. */
  rebuild(vault: Vault): number;
  close(): void;
}

const DEFAULT_LIMIT = 20;

/**
 * Column weights for bm25, in declaration order:
 *   note_path, type, title, aliases, keywords, summary, body
 * UNINDEXED columns get 0. Title, aliases and keywords dominate so that a note
 * which *is* about a subject outranks one that mentions it in passing — the
 * aliases field is what makes FTS5 competitive with semantic search here.
 */
const BM25_WEIGHTS = '0.0, 0.0, 10.0, 8.0, 6.0, 3.0, 1.0';

/** Ordinal of the body column, for snippet(). */
const BODY_COLUMN = 6;

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

export function createVaultIndex(dbPath: string): VaultIndex {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new BetterSqlite3(dbPath);
  db.pragma('journal_mode = WAL');

  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS brain_fts USING fts5(
      note_path UNINDEXED, type UNINDEXED,
      title, aliases, keywords, summary, body,
      tokenize = "porter unicode61 tokenchars '-_'"
    );
  `);

  const deleteStmt = db.prepare('DELETE FROM brain_fts WHERE note_path = ?');
  const insertStmt = db.prepare(
    `INSERT INTO brain_fts (note_path, type, title, aliases, keywords, summary, body)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
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
      const match = toFtsQuery(query);
      // An empty MATCH is a syntax error, so bail before touching SQLite.
      if (!match) return [];

      const limit = opts.limit ?? DEFAULT_LIMIT;
      const typeClause = opts.type ? 'AND type = ?' : '';
      const params: unknown[] = opts.type ? [match, opts.type, limit] : [match, limit];

      const rows = db
        .prepare(
          `SELECT note_path AS notePath,
                  type,
                  title,
                  snippet(brain_fts, ${BODY_COLUMN}, '[', ']', '…', 12) AS snippet,
                  bm25(brain_fts, ${BM25_WEIGHTS}) AS score
             FROM brain_fts
            WHERE brain_fts MATCH ?
              ${typeClause}
            ORDER BY score ASC
            LIMIT ?`,
        )
        .all(...params) as SearchHit[];

      return rows;
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
