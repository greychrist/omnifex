import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createDatabase, runMigrations, type Database } from '../services/database';
import { createModelPricingService } from '../services/model-pricing';
import { resolveRates, PRICING_FIELDS, SHIPPED_PRICING } from '../../src/lib/pricing';
import { modelLabel, modelColor } from '../../src/lib/costChartPalette';

const MTOK = 1_000_000;
const perM = (rate: number) => Math.round(rate * MTOK * 1e6) / 1e6;

let db: Database;

beforeEach(() => {
  db = createDatabase(':memory:');
});

afterEach(() => {
  db.close();
});

describe('model_pricing schema', () => {
  /**
   * PRICING_FIELDS is the one description of the rate columns — the service's
   * SQL, the IPC adapter and the editor all derive from it. The migration's
   * DDL is deliberately NOT derived (a migration must describe the schema as
   * of its own version forever), so this is what keeps the two in step. Add a
   * field to one and not the other and this fails loudly, instead of the value
   * saving, reading back null, and quietly mispricing.
   */
  it('has exactly the rate columns PRICING_FIELDS describes', () => {
    const columns = (db.raw.prepare('PRAGMA table_info(model_pricing)').all() as Array<{ name: string }>)
      .map((c) => c.name);
    for (const { column } of PRICING_FIELDS) {
      expect(columns).toContain(column);
    }
    const rateColumns = columns.filter((c) => c.endsWith('_per_m'));
    expect(rateColumns.sort()).toEqual(PRICING_FIELDS.map((f) => f.column).sort());
  });

  it('round-trips every field PRICING_FIELDS describes', () => {
    // A column that saves but reads back null is the failure this catches.
    const svc = createModelPricingService(db);
    const input: Record<string, unknown> = { pattern: 'roundtrip-9', effectiveFrom: '2026-01-01' };
    PRICING_FIELDS.forEach((f, i) => { input[f.row] = i + 1; });
    const saved = svc.upsert(input as never);
    PRICING_FIELDS.forEach((f, i) => {
      expect(saved[f.row]).toBe(i + 1);
    });
    expect(svc.list()[0]).toMatchObject(saved);
  });

  it('exists on a fresh install, not only after a migration', () => {
    const t = db.raw
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='model_pricing'")
      .get();
    expect(t).toBeDefined();
  });

  it('refuses two rows for the same pattern on the same effective date', () => {
    const ins = db.raw.prepare(
      'INSERT INTO model_pricing (pattern, effective_from, input_per_m) VALUES (?, ?, ?)',
    );
    ins.run('opus-9', '2026-01-01', 5);
    expect(() => ins.run('opus-9', '2026-01-01', 6)).toThrow();
    // A different date for the same pattern is a rate change, and is allowed.
    expect(() => ins.run('opus-9', '2026-06-01', 6)).not.toThrow();
  });
});

describe('createModelPricingService', () => {
  it('starts empty — the shipped table is the base layer, not seeded rows', () => {
    const svc = createModelPricingService(db);
    expect(svc.list()).toEqual([]);
    // and costing still works off the shipped defaults
    expect(perM(resolveRates('claude-opus-5', svc.toOverrides()).rates.input)).toBe(5);
  });

  it('prices a model that did not exist when this build shipped', () => {
    const svc = createModelPricingService(db);
    svc.upsert({
      pattern: 'brandnew-9',
      effectiveFrom: '2026-01-01',
      inputPerM: 7,
      outputPerM: 35,
      label: 'Brand New 9',
      colorSlot: 5,
    });

    const o = svc.toOverrides();
    const { rates, estimated } = resolveRates('claude-brandnew-9', o, { date: '2026-05-05' });
    expect(perM(rates.input)).toBe(7);
    expect(perM(rates.output)).toBe(35);
    expect(estimated).toBe(false);
    expect(modelLabel('claude-brandnew-9', o)).toBe('Brand New 9');
    expect(modelColor('claude-brandnew-9', 'light', o)).toBe('#4a3aa7');
  });

  it('lets one field be corrected without restating the rest', () => {
    const svc = createModelPricingService(db);
    // The Fable 5.1 shape: only the cache-read rate is wrong.
    svc.upsert({ pattern: 'opus-5', effectiveFrom: '1970-01-01', cacheReadPerM: 0.4 });
    const { rates } = resolveRates('claude-opus-5', svc.toOverrides());
    expect(perM(rates.input)).toBe(5);
    expect(perM(rates.output)).toBe(25);
    expect(perM(rates.cacheRead)).toBe(0.4);
  });

  it('keeps rate history rather than re-pricing the past', () => {
    const svc = createModelPricingService(db);
    svc.upsert({ pattern: 'opus-5', effectiveFrom: '2026-01-01', inputPerM: 5, outputPerM: 25 });
    svc.upsert({ pattern: 'opus-5', effectiveFrom: '2026-06-01', inputPerM: 4, outputPerM: 20 });

    const o = svc.toOverrides();
    expect(perM(resolveRates('claude-opus-5', o, { date: '2026-03-01' }).rates.input)).toBe(5);
    expect(perM(resolveRates('claude-opus-5', o, { date: '2026-09-01' }).rates.input)).toBe(4);
  });

  it('updates a row in place on the same (pattern, date) instead of duplicating', () => {
    const svc = createModelPricingService(db);
    svc.upsert({ pattern: 'opus-5', effectiveFrom: '2026-01-01', inputPerM: 5 });
    svc.upsert({ pattern: 'opus-5', effectiveFrom: '2026-01-01', inputPerM: 6 });
    expect(svc.list()).toHaveLength(1);
    expect(svc.list()[0].inputPerM).toBe(6);
  });

  it('removes a row, restoring the shipped rate', () => {
    const svc = createModelPricingService(db);
    const row = svc.upsert({ pattern: 'opus-5', effectiveFrom: '1970-01-01', inputPerM: 99 });
    expect(perM(resolveRates('claude-opus-5', svc.toOverrides()).rates.input)).toBe(99);
    svc.remove(row.id);
    expect(svc.list()).toEqual([]);
    expect(perM(resolveRates('claude-opus-5', svc.toOverrides()).rates.input)).toBe(5);
  });

  it('rejects a row with no pattern and a colorSlot outside the palette', () => {
    const svc = createModelPricingService(db);
    expect(() => svc.upsert({ pattern: '  ', effectiveFrom: '1970-01-01', inputPerM: 1 })).toThrow();
    expect(() => svc.upsert({ pattern: 'x', effectiveFrom: '1970-01-01', colorSlot: 8 })).toThrow();
    expect(() => svc.upsert({ pattern: 'x', effectiveFrom: 'not-a-date', inputPerM: 1 })).toThrow();
  });

  it('rejects a row that states nothing at all', () => {
    const svc = createModelPricingService(db);
    expect(() => svc.upsert({ pattern: 'x', effectiveFrom: '1970-01-01' })).toThrow();
  });

  it('hands back the shipped table itself, not a copy that can drift', () => {
    const svc = createModelPricingService(db);
    expect(svc.shipped()).toBe(SHIPPED_PRICING);
    const fable51 = svc.shipped().find((r) => r.pattern === 'fable-5-1');
    expect(fable51).toMatchObject({ inputPerM: 10, outputPerM: 50, cacheReadPerM: 0.25 });
    expect(fable51?.label).toBe('Fable 5.1');
    // Display-only shipped rows (no rate of their own) still surface.
    expect(svc.shipped().find((r) => r.pattern === 'sonnet-4-6')?.label).toBe('Sonnet 4.6');
  });
});

describe('migration 25 — folding the legacy pricing_overrides blob in', () => {
  it('imports an existing blob as editable rows and clears it', () => {
    // Simulate an install that predates the table.
    db.raw.exec('DROP TABLE model_pricing');
    db.raw.prepare('DELETE FROM schema_version WHERE version >= 25').run();
    db.saveSetting(
      'pricing_overrides',
      JSON.stringify({
        'fable-5-1': { cacheRead: 0.25 },
        'opus-4-8': [
          { from: '2024-01-01', input: 5, output: 25 },
          { from: '2026-09-01', input: 4, output: 20 },
        ],
      }),
    );

    runMigrations(db.raw);

    const svc = createModelPricingService(db);
    const rows = svc.list();
    expect(rows.filter((r) => r.pattern === 'opus-4-8')).toHaveLength(2);
    expect(rows.find((r) => r.pattern === 'fable-5-1')?.cacheReadPerM).toBe(0.25);
    // The blob is the old mechanism; leaving it populated would mean two
    // sources of truth disagreeing the moment either is edited.
    expect(db.getSetting('pricing_overrides')).toBeNull();
  });

  it('is a no-op when there was no blob', () => {
    db.raw.exec('DROP TABLE model_pricing');
    db.raw.prepare('DELETE FROM schema_version WHERE version >= 25').run();
    runMigrations(db.raw);
    expect(createModelPricingService(db).list()).toEqual([]);
  });
});
