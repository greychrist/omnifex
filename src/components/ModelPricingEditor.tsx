import { useCallback, useEffect, useMemo, useState } from 'react';
import { Trash2, Plus, ChevronDown, ChevronRight } from 'lucide-react';
import { api } from '@/lib/api';
import { PRICING_FIELDS, type ModelPricingInput, type ModelPricingRow } from '@/lib/pricing';
import { CATEGORICAL_LIGHT } from '@/lib/costChartPalette';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

/**
 * Editor for the `model_pricing` table — the delta layer over the rates this
 * build shipped with.
 *
 * The point of the table is that a model Anthropic releases after this build
 * can still be priced and named correctly without a new release. So the editor
 * is built around adding a row, not around editing a blob: a row is a pattern,
 * a date, and only the fields that differ.
 *
 * The built-in rates are shown read-only underneath rather than copied into
 * the table as editable rows. Copying them would pin this install to whatever
 * the rates were the day it was created, so a shipped price correction would
 * never reach it — the exact drift the table exists to fix.
 */

// Field list and labels come from PRICING_FIELDS, so a rate added to the
// schema shows up in this form automatically instead of being silently
// uneditable until someone notices.
type RateField = (typeof PRICING_FIELDS)[number]['row'];

interface DraftRow {
  pattern: string;
  effectiveFrom: string;
  label: string;
  colorSlot: string;
  rates: Partial<Record<RateField, string>>;
}

const EMPTY_DRAFT: DraftRow = {
  pattern: '',
  effectiveFrom: '1970-01-01',
  label: '',
  colorSlot: '',
  rates: {},
};

/** `""` and whitespace mean "not set" — distinct from 0, which is a real rate
 *  (`<synthetic>` is priced at zero on purpose). */
function toNumber(v: string | undefined): number | undefined {
  if (v == null) return undefined;
  const t = v.trim();
  if (!t) return undefined;
  const n = Number(t);
  return Number.isFinite(n) ? n : Number.NaN;
}

function fmt(v: number | undefined): string {
  return v == null ? '—' : `$${v}`;
}

export function ModelPricingEditor() {
  const [rows, setRows] = useState<ModelPricingRow[]>([]);
  const [shipped, setShipped] = useState<ModelPricingInput[]>([]);
  const [draft, setDraft] = useState<DraftRow>(EMPTY_DRAFT);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [showShipped, setShowShipped] = useState(false);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    const [r, s] = await Promise.all([api.modelPricingList(), api.modelPricingShipped()]);
    setRows(r);
    setShipped(s);
  }, []);

  useEffect(() => {
    void reload()
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
  }, [reload]);

  const save = async () => {
    setError(null);
    try {
      const rates: Record<string, number> = {};
      for (const { row: field } of PRICING_FIELDS) {
        const n = toNumber(draft.rates[field]);
        if (n === undefined) continue;
        if (Number.isNaN(n)) throw new Error(`${field} is not a number`);
        rates[field] = n;
      }
      const slot = toNumber(draft.colorSlot);
      if (slot !== undefined && Number.isNaN(slot)) throw new Error('Colour is not a number');

      await api.modelPricingUpsert({
        pattern: draft.pattern,
        effectiveFrom: draft.effectiveFrom,
        ...rates,
        ...(draft.label.trim() ? { label: draft.label.trim() } : {}),
        ...(slot !== undefined ? { colorSlot: slot } : {}),
      });
      setDraft(EMPTY_DRAFT);
      setStatus('Saved — applies to the next priced turn and the next cost rescan.');
      setTimeout(() => setStatus(null), 4000);
      await reload();
    } catch (e) {
      // The service rejects rather than coerces, and its message names the
      // offending field. Surface it verbatim instead of a generic "invalid".
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const remove = async (id: number) => {
    setError(null);
    try {
      await api.modelPricingDelete(id);
      await reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const shippedByPattern = useMemo(() => {
    const m = new Map<string, ModelPricingInput[]>();
    for (const s of shipped) {
      const list = m.get(s.pattern) ?? [];
      list.push(s);
      m.set(s.pattern, list);
    }
    return m;
  }, [shipped]);

  return (
    <div className="space-y-3">
      <div className="text-sm font-medium">Model pricing</div>
      <p className="text-xs text-muted-foreground">
        Rates in USD per million tokens. A row states only what differs from the built-in
        table below — one wrong field is a one-field row, not a restated model. Patterns are
        model-id substrings, longest match wins (<code>fable-5-1</code> beats <code>fable</code>).
        Applies to the session cost widget, per-message costs, and the Cost Report on the next
        turn or rescan.
      </p>
      <p className="text-xs text-muted-foreground">
        For a price <em>change</em>, add a row with a new effective date rather than editing the
        old one. Editing in place re-prices every past day at the new rate the next time costs
        are rescanned.
      </p>

      {loading ? (
        <div className="text-xs text-muted-foreground">Loading…</div>
      ) : (
        <>
          {rows.length > 0 && (
            <div className="overflow-x-auto rounded border">
              <table className="w-full text-xs">
                <thead className="bg-muted/50">
                  <tr>
                    <th className="p-2 text-left font-medium">Pattern</th>
                    <th className="p-2 text-left font-medium">From</th>
                    {PRICING_FIELDS.map(({ row: f, label }) => (
                      <th key={f} className="p-2 text-right font-medium">{label}</th>
                    ))}
                    <th className="p-2 text-left font-medium">Label</th>
                    <th className="p-2 text-left font-medium">Colour</th>
                    <th className="p-2" />
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.id} className="border-t">
                      <td className="p-2 font-mono">{r.pattern}</td>
                      <td className="p-2 font-mono text-muted-foreground">{r.effectiveFrom}</td>
                      {PRICING_FIELDS.map(({ row: f }) => (
                        <td key={f} className="p-2 text-right tabular-nums">{fmt(r[f])}</td>
                      ))}
                      <td className="p-2">{r.label ?? '—'}</td>
                      <td className="p-2">
                        {r.colorSlot == null ? (
                          '—'
                        ) : (
                          <span
                            className="inline-block h-3 w-3 rounded-sm align-middle"
                            style={{ background: CATEGORICAL_LIGHT[r.colorSlot] }}
                            title={`Slot ${r.colorSlot}`}
                          />
                        )}
                      </td>
                      <td className="p-2 text-right">
                        <button
                          type="button"
                          aria-label={`Remove pricing row for ${r.pattern}`}
                          className="text-muted-foreground hover:text-red-400"
                          onClick={() => void remove(r.id)}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <div className="space-y-2 rounded border p-3">
            <div className="text-xs font-medium">Add or replace a row</div>
            <div className="flex flex-wrap gap-2">
              <Input
                className="h-8 w-40 text-xs"
                placeholder="pattern e.g. fable-5-1"
                aria-label="Model pattern"
                value={draft.pattern}
                onChange={(e) => setDraft((d) => ({ ...d, pattern: e.target.value }))}
              />
              <Input
                className="h-8 w-32 text-xs"
                placeholder="YYYY-MM-DD"
                aria-label="Effective from"
                value={draft.effectiveFrom}
                onChange={(e) => setDraft((d) => ({ ...d, effectiveFrom: e.target.value }))}
              />
              {PRICING_FIELDS.map(({ row: f, label }) => (
                <Input
                  key={f}
                  className="h-8 w-24 text-xs"
                  placeholder={label}
                  aria-label={label}
                  value={draft.rates[f] ?? ''}
                  onChange={(e) => setDraft((d) => ({ ...d, rates: { ...d.rates, [f]: e.target.value } }))}
                />
              ))}
              <Input
                className="h-8 w-36 text-xs"
                placeholder="Chart label"
                aria-label="Chart label"
                value={draft.label}
                onChange={(e) => setDraft((d) => ({ ...d, label: e.target.value }))}
              />
              <Input
                className="h-8 w-24 text-xs"
                placeholder={`Colour 0-${CATEGORICAL_LIGHT.length - 1}`}
                aria-label="Colour slot"
                value={draft.colorSlot}
                onChange={(e) => setDraft((d) => ({ ...d, colorSlot: e.target.value }))}
              />
            </div>
            <div className="flex items-center gap-2">
              <Button size="sm" onClick={() => void save()}>
                <Plus className="mr-1 h-3.5 w-3.5" /> Save row
              </Button>
              {status && <span className="text-xs text-green-400">{status}</span>}
              {error && <span className="text-xs text-red-400">{error}</span>}
            </div>
          </div>

          <div>
            <button
              type="button"
              className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
              onClick={() => setShowShipped((v) => !v)}
            >
              {showShipped ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
              Built-in rates ({shippedByPattern.size} models)
            </button>
            {showShipped && (
              <div className="mt-2 overflow-x-auto rounded border">
                <table className="w-full text-xs">
                  <thead className="bg-muted/50">
                    <tr>
                      <th className="p-2 text-left font-medium">Pattern</th>
                      <th className="p-2 text-left font-medium">From</th>
                      {PRICING_FIELDS.map(({ row: f, label }) => (
                        <th key={f} className="p-2 text-right font-medium">{label}</th>
                      ))}
                      <th className="p-2 text-left font-medium">Label</th>
                    </tr>
                  </thead>
                  <tbody>
                    {shipped.map((s) => (
                      <tr key={`${s.pattern}@${s.effectiveFrom}`} className="border-t">
                        <td className="p-2 font-mono">{s.pattern}</td>
                        <td className="p-2 font-mono text-muted-foreground">{s.effectiveFrom}</td>
                        {PRICING_FIELDS.map(({ row: f }) => (
                          <td key={f} className="p-2 text-right tabular-nums">{fmt(s[f])}</td>
                        ))}
                        <td className="p-2">{s.label ?? '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <p className="p-2 text-[11px] text-muted-foreground">
                  These ship with the app and improve with each release. They are not copied
                  into your table — add a row above to override one.
                </p>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
