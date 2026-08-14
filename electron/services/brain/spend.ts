import type { Database } from '../database';
import type { RunCost } from './sources/state';

/**
 * The Brain's spend ledger (Plan 8 §3).
 *
 * Append-only. One row per model-backed run, aggregated with `SUM` at read
 * time, so re-indexing an item appends a second row and the month is correct
 * with no read-modify-write arithmetic for a writer to get wrong.
 *
 * This exists because two other places that look like they should answer
 * "what has the Brain cost me" cannot:
 *
 *  - `brain_sources.cost_usd` is a snapshot keyed by item. Re-indexing
 *    overwrites it, so it answers "what did this item last cost" and nothing
 *    about a period.
 *  - The user's monthly report prices tokens by scanning session JSONL, and
 *    `extract.ts`'s runner sweeps the throwaway transcript each run writes. So
 *    every Brain run to date has been invisible to it.
 *
 * The table carries `account_name` denormalised and no foreign key on purpose:
 * money spent is history, and deleting an account must not silently shrink a
 * month that has already been reported.
 */

/** What the money bought. Kept separate so a report can price curation alone. */
export type SpendKind = 'index' | 'curation';

/**
 * Add two runs together.
 *
 * A retry is money spent on top of the first attempt, not instead of it —
 * reporting only the successful call would understate every item that needed
 * one. Null plus a number is that number: one leg failing to report must not
 * erase the leg that did.
 *
 * Lives here rather than in `extract.ts` because curation retries too, and two
 * copies of this would drift the moment one of them learned about a new usage
 * field.
 */
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
  };
}

export interface SpendEntry extends RunCost {
  accountId: number;
  accountName: string;
  kind: SpendKind;
  /** The adapter, or the curation sentinel. Null when it does not apply. */
  sourceId: string | null;
  itemKey: string;
  model: string;
  /** Local date, `YYYY-MM-DD`. See the DDL for why it is stored, not derived. */
  date: string;
  /** ISO instant, for ordering within a day. */
  spentAt: string;
}

export interface BrainSpendStore {
  record(entry: SpendEntry): void;
  /** Every row in a `YYYY-MM` month, oldest first. */
  byMonth(month: string): SpendEntry[];
  /** Total USD, for one account or for all of them. Zero when nothing spent. */
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

/**
 * Local `YYYY-MM-DD` for an instant.
 *
 * Not `toISOString().slice(0, 10)`, which is UTC: a run at 9pm EDT would land
 * on the next day, and one on the last evening of a month would land in the
 * next month. That is the same rollover trap the user's own cost report
 * documents at length.
 */
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
      // Prefix match on the stored local date. A BETWEEN on instants would
      // reintroduce exactly the timezone question `date` exists to settle.
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
