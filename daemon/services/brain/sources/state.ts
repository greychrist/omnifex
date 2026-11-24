import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import type { Database } from '../../database';
import { pathsOf, type SourceItem } from './types';

/** `blocked` (never eligible, e.g. no owning account) is distinct from `failed`: different remedies. */
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
  cost: RunCost | null;
}

/** Null fields mean "the CLI did not say", never zero. */
export interface RunCost {
  costUsd: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheCreationTokens: number | null;
  model?: string | null;
}

export interface RecordOptions {
  status: SourceStatus;
  /** Cleared when omitted. */
  error?: string;
  /** Omitted by paths that cost nothing; those leave recorded figures intact. */
  run?: RunCost;
}

export interface SourceStateStore {
  get(accountId: number, sourceId: string, itemKey: string): SourceState | null;
  list(accountId: number, sourceId: string): SourceState[];
  record(item: SourceItem, opts: RecordOptions): Promise<void>;
  hasChanged(item: SourceItem): Promise<boolean>;
  bytesHashed(): number;
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

/** Every file behind an item: a resumed session spans several. Null means changed. Streamed: never readFileSync on the event loop. */
async function hashFiles(paths: string[], onBytes: (n: number) => void): Promise<string | null> {
  const h = createHash('sha256');
  try {
    for (const p of paths) {
      for await (const chunk of createReadStream(p)) {
        const buf = chunk as Buffer;
        h.update(buf);
        onBytes(buf.length);
      }
    }
    return h.digest('hex');
  } catch {
    return null;
  }
}

function fingerprint(item: SourceItem): string {
  return `${pathsOf(item).join('\0')}\0${String(item.size)}\0${String(item.mtimeMs)}`;
}

/** Note content never lives here, only pointers and status. */
export function createSourceStateStore(db: Database): SourceStateStore {
  const raw = db.raw;
  let totalHashed = 0;
  const hashes = new Map<string, { fingerprint: string; hash: Promise<string | null> }>();

  function hashItem(item: SourceItem): Promise<string | null> {
    const key = `${String(item.accountId)}\0${item.sourceId}\0${item.itemKey}`;
    const fp = fingerprint(item);
    const known = hashes.get(key);
    if (known?.fingerprint === fp) return known.hash;
    const hash = hashFiles(pathsOf(item), (n) => {
      totalHashed += n;
    });
    hashes.set(key, { fingerprint: fp, hash });
    // Never cache an unreadable result: try again next time.
    void hash.then((h) => {
      if (h === null && hashes.get(key)?.hash === hash) hashes.delete(key);
    });
    return hash;
  }

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

  async function record(item: SourceItem, opts: RecordOptions): Promise<void> {
    const hash = await hashItem(item);
    // A run that spent nothing leaves the previous figures alone, never nulls them.
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
        hash,
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

  async function hasChanged(item: SourceItem): Promise<boolean> {
    const prior = get(item.accountId, item.sourceId, item.itemKey);
    if (!prior) return true;
    if (prior.mtime === Math.floor(item.mtimeMs)) return false;
    // mtime moving does not imply content moved (restore, branch switch, touch).
    const current = await hashItem(item);
    if (current === null || prior.hash === null) return true;
    return current !== prior.hash;
  }

  return { get, list, record, hasChanged, bytesHashed: () => totalHashed };
}
