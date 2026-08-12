import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { Database } from '../../database';
import type { SourceItem } from './types';

/**
 * Where an item stands with the indexer.
 *
 * `blocked` is distinct from `failed` on purpose: failed means the pipeline
 * tried and something went wrong, blocked means it was never eligible (no
 * owning account, per spec §4's "no silent default-account fallback"). They
 * need different remedies, so they cannot share a status.
 */
export type SourceStatus = 'pending' | 'indexed' | 'skipped' | 'failed' | 'blocked';

export interface SourceState {
  accountId: number;
  sourceId: string;
  itemKey: string;
  mtime: number | null;
  hash: string | null;
  lastIndexedAt: string | null;
  status: SourceStatus;
  error: string | null;
}

export interface RecordOptions {
  status: SourceStatus;
  /** Cleared when omitted, so a fixed failure stops being reported. */
  error?: string;
}

export interface SourceStateStore {
  get(accountId: number, sourceId: string, itemKey: string): SourceState | null;
  list(accountId: number, sourceId: string): SourceState[];
  /** Upsert. Stamps mtime and a fresh content hash from the item's file. */
  record(item: SourceItem, opts: RecordOptions): void;
  /** Rowboat's hybrid: mtime first, sha256 only when mtime disagrees. */
  hasChanged(item: SourceItem): boolean;
}

interface Row {
  account_id: number;
  source_id: string;
  item_key: string;
  mtime: number | null;
  hash: string | null;
  last_indexed_at: string | null;
  status: string;
  error: string | null;
}

function toState(row: Row): SourceState {
  return {
    accountId: row.account_id,
    sourceId: row.source_id,
    itemKey: row.item_key,
    mtime: row.mtime,
    hash: row.hash,
    lastIndexedAt: row.last_indexed_at,
    status: row.status as SourceStatus,
    error: row.error,
  };
}

/**
 * sha256 of the file's bytes, or null when it cannot be read.
 *
 * Null is treated as "changed" by every caller. A file that vanished between
 * discovery and hashing is exactly the case where re-examining it is correct.
 */
function hashFile(path: string): string | null {
  try {
    return createHash('sha256').update(readFileSync(path)).digest('hex');
  } catch {
    return null;
  }
}

/**
 * Change detection and status for every source adapter.
 *
 * State lives in SQLite rather than Rowboat's `knowledge_graph_state.json`
 * (spec §5): the DB, its migrations and the `createDatabase(':memory:')` test
 * harness already exist, and a JSON blob rewritten per item is a corruption
 * risk their design simply accepts.
 *
 * Note CONTENT never lives here — only pointers and status (spec §4).
 */
export function createSourceStateStore(db: Database): SourceStateStore {
  const raw = db.raw;

  function get(accountId: number, sourceId: string, itemKey: string): SourceState | null {
    const row = raw
      .prepare(
        'SELECT * FROM brain_sources WHERE account_id = ? AND source_id = ? AND item_key = ?',
      )
      .get(accountId, sourceId, itemKey) as Row | undefined;
    return row ? toState(row) : null;
  }

  function list(accountId: number, sourceId: string): SourceState[] {
    const rows = raw
      .prepare(
        'SELECT * FROM brain_sources WHERE account_id = ? AND source_id = ? ORDER BY item_key',
      )
      .all(accountId, sourceId) as Row[];
    return rows.map(toState);
  }

  function record(item: SourceItem, opts: RecordOptions): void {
    raw
      .prepare(
        `INSERT INTO brain_sources
           (account_id, source_id, item_key, mtime, hash, last_indexed_at, status, error)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (account_id, source_id, item_key) DO UPDATE SET
           mtime = excluded.mtime,
           hash = excluded.hash,
           last_indexed_at = excluded.last_indexed_at,
           status = excluded.status,
           error = excluded.error`,
      )
      .run(
        item.accountId,
        item.sourceId,
        item.itemKey,
        Math.floor(item.mtimeMs),
        hashFile(item.path),
        new Date().toISOString(),
        opts.status,
        opts.error ?? null,
      );
  }

  function hasChanged(item: SourceItem): boolean {
    const prior = get(item.accountId, item.sourceId, item.itemKey);
    if (!prior) return true;
    // Fast path: an untouched mtime means untouched bytes on every filesystem
    // this app runs on, and it costs one integer compare instead of a full
    // file read.
    if (prior.mtime === Math.floor(item.mtimeMs)) return false;
    // Slow path. mtime moving does NOT imply the content moved — a restore, a
    // branch switch, or a `touch` all rewrite timestamps over identical bytes,
    // and treating those as edits would re-index an entire vault for nothing.
    const current = hashFile(item.path);
    if (current === null || prior.hash === null) return true;
    return current !== prior.hash;
  }

  return { get, list, record, hasChanged };
}
