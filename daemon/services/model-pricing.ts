import type { Database } from './database';
import {
  PRICING_FIELDS,
  SHIPPED_PRICING,
  type ModelPricingInput,
  type ModelPricingRow,
} from '../../src/lib/pricing';

export type { ModelPricingInput, ModelPricingRow } from '../../src/lib/pricing';

/**
 * A delta layer over SHIPPED_PRICING, never a seeded copy: a seeded copy pins installs to old rates.
 * `effective_from` is additive: append a period, never edit one, or the next re-scan re-prices history.
 */

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export interface ModelPricingService {
  list(): ModelPricingRow[];
  upsert(input: ModelPricingInput): ModelPricingRow;
  remove(id: number): void;
  toOverrides(): ModelPricingInput[] | undefined;
  shipped(): readonly ModelPricingInput[];
}

type RawRow = {
  id: number;
  pattern: string;
  effective_from: string;
  label: string | null;
  context_window: number | null;
  updated_at: string;
} & Record<string, number | string | null>;

function toRow(r: RawRow): ModelPricingRow {
  const out: ModelPricingRow = {
    id: r.id,
    pattern: r.pattern,
    effectiveFrom: r.effective_from,
    updatedAt: r.updated_at,
  };
  for (const { row: field, column } of PRICING_FIELDS) {
    const v = r[column];
    if (typeof v === 'number') out[field] = v;
  }
  if (r.label !== null) out.label = r.label;
  if (r.context_window != null) out.contextWindow = r.context_window;
  return out;
}

/** Reject rather than coerce: a clamped or dropped value is a wrong answer that looks right. */
function validate(input: ModelPricingInput): ModelPricingInput {
  const pattern = (input.pattern ?? '').trim().toLowerCase();
  if (!pattern) throw new Error('model pricing: pattern is required');

  const effectiveFrom = (input.effectiveFrom ?? '').trim();
  if (!ISO_DATE.test(effectiveFrom)) {
    throw new Error(`model pricing: effectiveFrom must be YYYY-MM-DD, got "${input.effectiveFrom}"`);
  }

  const clean: ModelPricingInput = { pattern, effectiveFrom };
  let states = false;

  for (const { row: field } of PRICING_FIELDS) {
    const v = input[field];
    if (v == null) continue;
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) {
      throw new Error(`model pricing: ${field} must be a non-negative number, got ${String(v)}`);
    }
    clean[field] = v;
    states = true;
  }

  if (input.label != null) {
    const label = String(input.label).trim();
    if (label) {
      clean.label = label;
      states = true;
    }
  }

  if (input.contextWindow != null) {
    const w = input.contextWindow;
    if (!Number.isInteger(w) || w <= 0) {
      throw new Error(`model pricing: contextWindow must be a positive integer, got ${String(w)}`);
    }
    clean.contextWindow = w;
    states = true;
  }

  // A row that states nothing would shadow the shipped entry and read as "no price".
  if (!states) throw new Error('model pricing: a row must set at least one rate, label or context window');

  return clean;
}

// Generated from PRICING_FIELDS: a hand-written list that falls behind silently stops persisting a rate.
const RATE_COLUMNS = PRICING_FIELDS.map((f) => f.column);
const INSERT_COLUMNS = ['pattern', 'effective_from', ...RATE_COLUMNS, 'label', 'context_window'];
const INSERT_PARAMS = ['@pattern', '@effectiveFrom', ...PRICING_FIELDS.map((f) => `@${f.row}`), '@label', '@contextWindow'];
const UPDATE_ASSIGNMENTS = [...RATE_COLUMNS, 'label', 'context_window']
  .map((c) => `${c} = excluded.${c}`)
  .join(', ');

const UPSERT_SQL = `
  INSERT INTO model_pricing (${INSERT_COLUMNS.join(', ')}, updated_at)
  VALUES (${INSERT_PARAMS.join(', ')}, CURRENT_TIMESTAMP)
  ON CONFLICT(pattern, effective_from) DO UPDATE SET
    ${UPDATE_ASSIGNMENTS}, updated_at = CURRENT_TIMESTAMP
`;

export function createModelPricingService(db: Database): ModelPricingService {
  const listStmt = db.raw.prepare(
    'SELECT * FROM model_pricing ORDER BY pattern ASC, effective_from ASC',
  );

  function list(): ModelPricingRow[] {
    return (listStmt.all() as RawRow[]).map(toRow);
  }

  function upsert(input: ModelPricingInput): ModelPricingRow {
    const v = validate(input);
    const params: Record<string, number | string | null> = {
      pattern: v.pattern,
      effectiveFrom: v.effectiveFrom,
      label: v.label ?? null,
      contextWindow: v.contextWindow ?? null,
    };
    for (const { row: field } of PRICING_FIELDS) params[field] = v[field] ?? null;

    db.raw.prepare(UPSERT_SQL).run(params);

    const row = db.raw
      .prepare('SELECT * FROM model_pricing WHERE pattern = ? AND effective_from = ?')
      .get(v.pattern, v.effectiveFrom) as RawRow;
    return toRow(row);
  }

  function remove(id: number): void {
    db.raw.prepare('DELETE FROM model_pricing WHERE id = ?').run(id);
  }

  function toOverrides(): ModelPricingInput[] | undefined {
    const rows = list();
    return rows.length > 0 ? rows : undefined;
  }

  function shipped(): readonly ModelPricingInput[] {
    return SHIPPED_PRICING;
  }

  return { list, upsert, remove, toOverrides, shipped };
}
