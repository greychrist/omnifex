import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { Database } from '../../database';
import { pathsOf, type SourceItem } from './types';

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
  /** What the last run that spent anything on this item cost. See RunCost. */
  cost: RunCost | null;
}

/**
 * What one model-backed run cost, as the CLI itself reported it.
 *
 * Null fields mean "the CLI did not say", never "zero" — an envelope that
 * stops carrying a field must degrade to unknown rather than to free.
 */
export interface RunCost {
  costUsd: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheCreationTokens: number | null;
}

export interface RecordOptions {
  status: SourceStatus;
  /** Cleared when omitted, so a fixed failure stops being reported. */
  error?: string;
  /**
   * What this run spent, when it spent anything. Omitted by every path that
   * costs nothing — a gate rejection, a translating source, an unchanged item
   * — and those leave any previously recorded figures intact.
   */
  run?: RunCost;
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
  cost_usd: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cache_read_tokens: number | null;
  cache_creation_tokens: number | null;
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
    // All-null means nothing was ever spent here; the object would be five
    // nulls saying the same thing, so the whole thing is null instead.
    cost:
      row.cost_usd === null &&
      row.input_tokens === null &&
      row.output_tokens === null &&
      row.cache_read_tokens === null &&
      row.cache_creation_tokens === null
        ? null
        : {
            costUsd: row.cost_usd,
            inputTokens: row.input_tokens,
            outputTokens: row.output_tokens,
            cacheReadTokens: row.cache_read_tokens,
            cacheCreationTokens: row.cache_creation_tokens,
          },
  };
}

/**
 * sha256 of the file's bytes, or null when it cannot be read.
 *
 * Null is treated as "changed" by every caller. A file that vanished between
 * discovery and hashing is exactly the case where re-examining it is correct.
 */
/**
 * One hash over every file behind an item, in order.
 *
 * Not just `item.path`: a session resumed in another cwd spans several files
 * (see `SourceItem.paths`), and hashing only the newest would miss an edit to
 * an earlier half — the note would stay built from content that had changed
 * underneath it. Any unreadable file makes the whole hash null, which reads as
 * "cannot tell", and `hasChanged` treats that as changed.
 */
function hashItem(item: Pick<SourceItem, 'path' | 'paths'>): string | null {
  try {
    const h = createHash('sha256');
    for (const p of pathsOf(item)) h.update(readFileSync(p));
    return h.digest('hex');
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
    // A run that spent nothing (a gate rejection, a translating source) leaves
    // the previous figures alone rather than nulling them: what an item cost to
    // index is still true after a later run declined to index it again.
    const run = opts.run;
    raw
      .prepare(
        `INSERT INTO brain_sources
           (account_id, source_id, item_key, mtime, hash, last_indexed_at, status, error,
            cost_usd, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (account_id, source_id, item_key) DO UPDATE SET
           mtime = excluded.mtime,
           hash = excluded.hash,
           last_indexed_at = excluded.last_indexed_at,
           status = excluded.status,
           error = excluded.error,
           cost_usd = COALESCE(excluded.cost_usd, brain_sources.cost_usd),
           input_tokens = COALESCE(excluded.input_tokens, brain_sources.input_tokens),
           output_tokens = COALESCE(excluded.output_tokens, brain_sources.output_tokens),
           cache_read_tokens = COALESCE(excluded.cache_read_tokens, brain_sources.cache_read_tokens),
           cache_creation_tokens =
             COALESCE(excluded.cache_creation_tokens, brain_sources.cache_creation_tokens)`,
      )
      .run(
        item.accountId,
        item.sourceId,
        item.itemKey,
        Math.floor(item.mtimeMs),
        hashItem(item),
        new Date().toISOString(),
        opts.status,
        opts.error ?? null,
        run?.costUsd ?? null,
        run?.inputTokens ?? null,
        run?.outputTokens ?? null,
        run?.cacheReadTokens ?? null,
        run?.cacheCreationTokens ?? null,
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
    const current = hashItem(item);
    if (current === null || prior.hash === null) return true;
    return current !== prior.hash;
  }

  return { get, list, record, hasChanged };
}
