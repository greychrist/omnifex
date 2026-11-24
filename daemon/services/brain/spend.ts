import type { Database } from '../database';
import type { RunCost } from './sources/state';

/** Append-only, summed at read time. Denormalized name, no FK: deleting an account must not shrink a reported month. */

export type SpendKind = 'index' | 'curation';

/** A retry adds to the first attempt; null plus a number is that number. */
export function addRunCosts(
  a: RunCost | undefined,
  b: RunCost | undefined,
): RunCost | undefined {
  if (!a) return b;
  if (!b) return a;
  const sum = (x: number | null, y: number | null): number | null =>
    x === null && y === null ? null : (x ?? 0) + (y ?? 0);
  return {
    costUsd: sum(a.costUsd, b.costUsd),
    inputTokens: sum(a.inputTokens, b.inputTokens),
    outputTokens: sum(a.outputTokens, b.outputTokens),
    cacheReadTokens: sum(a.cacheReadTokens, b.cacheReadTokens),
    cacheCreationTokens: sum(a.cacheCreationTokens, b.cacheCreationTokens),
    model: b.model ?? a.model ?? null,
  };
}

export interface SpendEntry extends RunCost {
  accountId: number;
  accountName: string;
  kind: SpendKind;
  sourceId: string | null;
  itemKey: string;
  model: string;
  /** Local YYYY-MM-DD, stored: deriving it from spentAt reintroduces the timezone rollover. */
  date: string;
  spentAt: string;
}

export interface BrainSpendStore {
  record(entry: SpendEntry): void;
  byMonth(month: string): SpendEntry[];
  total(accountId?: number): number;
}

interface Row {
  account_id: number;
  account_name: string;
  kind: string;
  source_id: string | null;
  item_key: string;
  model: string;
  date: string;
  spent_at: string;
  input_tokens: number | null;
  output_tokens: number | null;
  cache_read_tokens: number | null;
  cache_creation_tokens: number | null;
  cost_usd: number | null;
}

function toEntry(row: Row): SpendEntry {
  return {
    accountId: row.account_id,
    accountName: row.account_name,
    kind: row.kind as SpendKind,
    sourceId: row.source_id,
    itemKey: row.item_key,
    model: row.model,
    date: row.date,
    spentAt: row.spent_at,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    cacheReadTokens: row.cache_read_tokens,
    cacheCreationTokens: row.cache_creation_tokens,
    costUsd: row.cost_usd,
  };
}

/** Local, not toISOString (UTC): an evening run would land on the next day or month. */
export function localDate(at: Date): string {
  const y = at.getFullYear();
  const m = String(at.getMonth() + 1).padStart(2, '0');
  const d = String(at.getDate()).padStart(2, '0');
  return `${String(y)}-${m}-${d}`;
}

export function createBrainSpendStore(db: Database): BrainSpendStore {
  const raw = db.raw;

  return {
    record(entry) {
      raw
        .prepare(
          `INSERT INTO brain_spend
             (account_id, account_name, kind, source_id, item_key, model, date, spent_at,
              input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, cost_usd)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          entry.accountId,
          entry.accountName,
          entry.kind,
          entry.sourceId,
          entry.itemKey,
          entry.model,
          entry.date,
          entry.spentAt,
          entry.inputTokens,
          entry.outputTokens,
          entry.cacheReadTokens,
          entry.cacheCreationTokens,
          entry.costUsd,
        );
    },

    byMonth(month) {
      // Prefix match on the local date; BETWEEN on instants reintroduces the timezone problem.
      const rows = raw
        .prepare('SELECT * FROM brain_spend WHERE date LIKE ? ORDER BY spent_at, id')
        .all(`${month}-%`) as Row[];
      return rows.map(toEntry);
    },

    total(accountId) {
      const row = (
        accountId === undefined
          ? raw.prepare('SELECT COALESCE(SUM(cost_usd), 0) AS total FROM brain_spend').get()
          : raw
              .prepare(
                'SELECT COALESCE(SUM(cost_usd), 0) AS total FROM brain_spend WHERE account_id = ?',
              )
              .get(accountId)
      ) as { total: number };
      return row.total;
    },
  };
}
