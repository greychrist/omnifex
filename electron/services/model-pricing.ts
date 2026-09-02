import type { Database } from './database';
import {
  PRICING_FIELDS,
  SHIPPED_PRICING,
  type ModelPricingInput,
  type ModelPricingRow,
} from '../../src/lib/pricing';
import { CATEGORICAL_LIGHT } from '../../src/lib/costChartPalette';

export type { ModelPricingInput, ModelPricingRow } from '../../src/lib/pricing';

/**
 * User-editable model pricing.
 *
 * OmniFex prices tokens it did not meter, for models Anthropic ships on its
 * own cadence. Before this table the rates lived only in `src/lib/pricing.ts`,
 * so a new model — or a price change on an existing one — could not be costed
 * correctly without cutting a release. Fable 5.1 made that concrete: it landed
 * in CLI 2.1.257 with a cache-read rate no formula in the code predicted, and
 * every Fable 5.1 session was mispriced until a build shipped.
 *
 * The shape is deliberately a DELTA layer, not a seeded copy of the shipped
 * table:
 *
 *  - `SHIPPED_PRICING` in `src/lib/pricing.ts` stays the base layer. It ships
 *    with the app and every release keeps improving it. Rates and chart
 *    display metadata live on the same row there, so this table needs no
 *    second shape for either.
 *  - This table holds only what the user has said differs. Rows win over the
 *    base layer, field by field, longest matching pattern first.
 *
 * Seeding the table from the code constants was the obvious alternative and is
 * a trap: the moment a release corrects a shipped rate, every existing install
 * is pinned to the old copy in its own database and silently keeps mispricing.
 * A delta layer has no such drift — untouched models always track the build,
 * and a user row is only ever the thing the user actually asked for.
 *
 * `pattern` is a model-id substring (`fable-5-1`, `opus-4-8`), matched
 * case-insensitively, longest match first. `effective_from` makes a rate change
 * additive: append a period rather than editing one, or the next cost re-scan
 * silently re-prices all of history at the new rate.
 */

/** The palette's own width — not a second copy of the number. */
const MAX_COLOR_SLOT = CATEGORICAL_LIGHT.length - 1;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export interface ModelPricingService {
  list(): ModelPricingRow[];
  upsert(input: ModelPricingInput): ModelPricingRow;
  remove(id: number): void;
  /** The user layer, in the shape the pure resolver consumes. */
  toOverrides(): ModelPricingInput[] | undefined;
  /** The shipped base layer, for display in the editor. */
  shipped(): readonly ModelPricingInput[];
}

/** The row as SQLite hands it back. Column names are asserted against
 *  `PRICING_FIELDS` by the schema-contract test, so a column added to one and
 *  not the other fails loudly instead of silently reading back null. */
type RawRow = {
  id: number;
  pattern: string;
  effective_from: string;
  label: string | null;
  color_slot: number | null;
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
  if (r.color_slot !== null) out.colorSlot = r.color_slot;
  return out;
}

/**
 * Reject rather than coerce. A silently-clamped colour slot paints two models
 * the same hue, and a silently-dropped bad date applies a rate from the wrong
 * day — both are wrong answers that look like right ones, which is the whole
 * failure mode a cost report cannot afford.
 */
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

  if (input.colorSlot != null) {
    const slot = input.colorSlot;
    if (!Number.isInteger(slot) || slot < 0 || slot > MAX_COLOR_SLOT) {
      throw new Error(
        `model pricing: colorSlot must be an integer 0-${MAX_COLOR_SLOT}, got ${String(slot)}`,
      );
    }
    clean.colorSlot = slot;
    states = true;
  }

  // A row that states nothing would shadow the shipped entry with silence and
  // read as "this model has no price", which is worse than having no row.
  if (!states) throw new Error('model pricing: a row must set at least one rate or label');

  return clean;
}

// Column and placeholder lists are generated from PRICING_FIELDS rather than
// typed out three more times (insert, values, on-conflict). A hand-written
// list that falls one column behind the schema does not fail — it silently
// stops persisting that rate.
const RATE_COLUMNS = PRICING_FIELDS.map((f) => f.column);
const INSERT_COLUMNS = ['pattern', 'effective_from', ...RATE_COLUMNS, 'label', 'color_slot'];
const INSERT_PARAMS = ['@pattern', '@effectiveFrom', ...PRICING_FIELDS.map((f) => `@${f.row}`), '@label', '@colorSlot'];
const UPDATE_ASSIGNMENTS = [...RATE_COLUMNS, 'label', 'color_slot']
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
      colorSlot: v.colorSlot ?? null,
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

  // The rows ARE the user layer — same shape the resolver takes, so there is
  // nothing to convert. Undefined for empty is the "everything tracks the
  // shipped rates" case.
  function toOverrides(): ModelPricingInput[] | undefined {
    const rows = list();
    return rows.length > 0 ? rows : undefined;
  }

  // Handed back as-is. The editor shows what it is overriding; it does not get
  // its own copy to drift from.
  function shipped(): readonly ModelPricingInput[] {
    return SHIPPED_PRICING;
  }

  return { list, upsert, remove, toOverrides, shipped };
}
