// Cost Report — the analysis page behind the titlebar's Cost button.
//
// Port of ~/Repos/work/management/scripts/ai-cost-report.py. Its value was
// never the tables; it was four interpretations the Anthropic console has no
// way to produce — per-project attribution, cost by component, caching ROI,
// and main-loop vs subagent efficiency. Each of those renders here as a
// SENTENCE above its table, because "87% of spend is context" changes what you
// do and "$518.70" does not.
//
// Design: docs/superpowers/specs/2026-08-26-cost-report-page-design.md

import { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, RefreshCw } from 'lucide-react';
import {
  api,
  type CachingRoi,
  type CostByModel,
  type CostByProject,
  type CostByProjectModel,
  type CostComponents,
  type CostFacets,
  type CostHistoryPeriodModel,
  type CostSessionRow,
  type CostTotals,
  type SubagentSplitRow,
  type UnpricedModel,
} from '@/lib/api';
import { useThemeContext } from '@/contexts/ThemeContext';
import { useAccounts } from '@/contexts/AccountsContext';
import { AccountPicker } from '@/components/AccountPicker';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { modelColor, modelLabel, type ChartMode } from '@/lib/costChartPalette';
import {
  RANGE_PRESETS,
  loadFilterState,
  saveFilterState,
  fmtPercent,
  fmtRatio,
  fmtTokens,
  fmtUsd,
  toFilterParams,
  utcToday,
  type CostFilterState,
} from '@/lib/costReportFilters';
import { MultiSelectFilter } from '@/components/cost-report/MultiSelectFilter';
import { FilterCard } from '@/components/cost-report/FilterCard';
import { Card } from '@/components/ui/card';
import { CostChart, CostChartLegend } from '@/components/cost-report/CostChart';

interface ReportData {
  periods: CostHistoryPeriodModel[];
  byProject: CostByProject[];
  byModel: CostByModel[];
  byProjectModel: CostByProjectModel[];
  components: CostComponents | null;
  roi: CachingRoi | null;
  subagents: SubagentSplitRow[];
  unpriced: UnpricedModel[];
  sessions: CostSessionRow[];
  totals: CostTotals | null;
}

/** Trim a project path to its last two segments — enough to tell repos apart
 *  without giving a table column a 60-character cell. */
function shortProject(path: string | null): string {
  if (!path) return '(unknown)';
  const parts = path.split('/').filter(Boolean);
  return parts.slice(-2).join('/') || path;
}

function Panel({
  title,
  subtitle,
  actions,
  testId,
  children,
}: {
  title: string;
  subtitle?: React.ReactNode;
  /** Display controls that belong to this panel rather than to the filters —
   *  they change how the data is drawn, not which rows are counted. */
  actions?: React.ReactNode;
  testId?: string;
  children: React.ReactNode;
}) {
  return (
    <Card data-testid={testId} className="space-y-2 p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">{title}</h3>
          {subtitle && <p className="mt-1 text-sm text-foreground">{subtitle}</p>}
        </div>
        {actions && <div className="flex shrink-0 items-center gap-1">{actions}</div>}
      </div>
      {children}
    </Card>
  );
}

function Kpi({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <Card className="px-3 py-2">
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</div>
      <div className="font-mono text-lg text-foreground">{value}</div>
      {hint && <div className="text-[10px] text-muted-foreground">{hint}</div>}
    </Card>
  );
}

export function CostReportView() {
  const { theme } = useThemeContext();
  const mode: ChartMode = theme === 'light' ? 'light' : 'dark';

  const { accounts } = useAccounts();
  // Read synchronously on first render, so the page opens already filtered
  // rather than flashing the defaults.
  const [filters, setFilters] = useState<CostFilterState>(loadFilterState);
  const [facets, setFacets] = useState<CostFacets | null>(null);
  const [data, setData] = useState<ReportData | null>(null);
  const [loading, setLoading] = useState(true);
  const [rescanning, setRescanning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Names of the panels whose query failed on the last load. */
  const [failed, setFailed] = useState<string[]>([]);

  const params = useMemo(() => toFilterParams(filters, utcToday()), [filters]);
  const patch = useCallback(
    (next: Partial<CostFilterState>) => setFilters((f) => ({ ...f, ...next })),
    [],
  );

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);

    // allSettled, NOT all. Eleven independent queries feed eleven independent
    // panels, so one failure must cost one panel — not the page. `Promise.all`
    // rejected the whole load the first time a renderer hot-reload started
    // calling a channel the still-running main process had no handler for, and
    // one missing handler blanked every panel at once.
    const queries = [
      ['trend', () => api.sessionCostHistoryByModel({ ...params, groupBy: filters.groupBy })],
      ['projects', () => api.sessionCostByProject(params)],
      ['models', () => api.sessionCostByModel(params)],
      ['project × model', () => api.sessionCostByProjectModel(params)],
      ['component split', () => api.sessionCostComponents(params)],
      ['caching ROI', () => api.sessionCostCachingRoi(params)],
      ['subagent split', () => api.sessionCostSubagentSplit(params)],
      ['unpriced models', () => api.sessionCostUnpriced(params)],
      ['sessions', () => api.sessionCostSessions(params)],
      ['filters', () => api.sessionCostFacets(params)],
      ['totals', () => api.sessionCostTotals(params)],
    ] as const;

    const settled = await Promise.allSettled(queries.map(([, run]) => run()));
    const value = <T,>(i: number, fallback: T): T => {
      const r = settled[i];
      return r.status === 'fulfilled' ? ((r.value ?? fallback) as T) : fallback;
    };

    const failedNames: string[] = queries
      .filter((_, i) => settled[i].status === 'rejected')
      .map(([name]) => name);

    setData({
      periods: value(0, []),
      byProject: value(1, []),
      byModel: value(2, []),
      byProjectModel: value(3, []),
      components: value(4, null),
      roi: value(5, null),
      subagents: value(6, []),
      unpriced: value(7, []),
      sessions: value(8, []),
      totals: value(10, null),
    });
    setFacets(value(9, null));
    setFailed(failedNames);
    setLoading(false);
  }, [params, filters.groupBy]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => { saveFilterState(filters); }, [filters]);

  // Choosing an account narrows the project list, so a project picked under a
  // different account would stay selected while no longer being on screen —
  // a filter quietly excluding rows with no visible control to undo it. Drop
  // any selection the current account scope can no longer offer.
  useEffect(() => {
    if (!facets || filters.projects.length === 0) return;
    const available = new Set(facets.projects);
    const kept = filters.projects.filter((p) => available.has(p));
    if (kept.length !== filters.projects.length) patch({ projects: kept });
  }, [facets, filters.projects, patch]);

  const rescan = useCallback(async () => {
    setRescanning(true);
    setError(null);
    try {
      await api.sessionCostRescan();
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRescanning(false);
    }
  }, [load]);

  const total = data?.components?.cost_usd ?? 0;
  const requests = data?.totals?.request_count ?? 0;
  const sessionCount = data?.totals?.session_count ?? 0;

  /**
   * Subscription accounts (Max, Pro) are not billed per token, so their dollar
   * figure is what the usage WOULD have cost at API rates — not money spent.
   * Saying so is the one thing the old Usage dashboard did better; it printed
   * "Included" rather than a number. Keeping the number is more useful (it is
   * how you compare accounts at all), but it must never read as a bill.
   */
  const notionalAccounts = useMemo(() => {
    const inScope = filters.accounts.length
      ? accounts.filter((a) => filters.accounts.includes(a.name))
      : accounts;
    return inScope
      .filter((a) => /^(max|pro)$/i.test(a.subscription_label ?? ''))
      .map((a) => a.name);
  }, [accounts, filters.accounts]);
  const activeDays = useMemo(
    () => new Set((data?.periods ?? []).map((p) => p.period)).size,
    [data],
  );
  const chartModels = useMemo(
    () => [...new Set((data?.periods ?? []).map((p) => p.model))],
    [data],
  );

  const main = data?.subagents.find((s) => s.is_subagent === 0);
  const sub = data?.subagents.find((s) => s.is_subagent === 1);

  /** The two or three heaviest days. Aggregate months look alarming and are
   *  usually a couple of heavy sessions; naming the days defuses that. */
  const heaviestDays = useMemo(() => {
    const byDay = new Map<string, number>();
    for (const p of data?.periods ?? []) {
      byDay.set(p.period, (byDay.get(p.period) ?? 0) + p.cost_usd);
    }
    return [...byDay.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3);
  }, [data]);

  const burstShare = useMemo(
    () => (total > 0 ? heaviestDays.reduce((n, [, v]) => n + v, 0) / total : 0),
    [heaviestDays, total],
  );

  return (
    <div className="h-full overflow-auto">
      <div className="mx-auto max-w-6xl space-y-8 p-6">
        <header className="space-y-1">
          <h2 className="text-lg font-semibold">Cost Report</h2>
          <p className="text-xs text-muted-foreground">
            Per-project attribution, cost by component, caching ROI, and main-loop vs subagent
            efficiency — the numbers the Anthropic console can&apos;t produce. The console remains
            the billing source of truth; these figures are derived from local transcripts and will
            read low where usage happened elsewhere.
          </p>
        </header>

        {/* ── Filters ─────────────────────────────────────────────────── */}
        {/* Grouped into labelled cards by category. Previously one flex-wrap
            row put date presets, account, models, projects, scope and the
            day/week/month grouping shoulder to shoulder, separated only by
            hairline dividers — same size, same weight, no labels.

            Account and project share the top card because they are one
            question, not two: a project belongs to an account, and the
            project list narrows to whatever accounts are selected.

            The grouping control is deliberately NOT here: it changes how the
            trend is drawn, not which rows are counted, so it lives with the
            chart. Mixing a display control into the filters implies changing
            it changes the totals, and it does not. */}
        <div data-testid="cost-filters" className="space-y-3">
          <FilterCard label="Account & project" testId="filter-accounts">
            <AccountPicker
              mode="multi"
              accounts={facets?.accounts ?? []}
              selected={filters.accounts}
              onChange={(next) => patch({ accounts: next })}
            />
            <MultiSelectFilter
              label="Projects"
              options={facets?.projects ?? []}
              selected={filters.projects}
              onChange={(projects) => patch({ projects })}
              renderOption={shortProject}
              searchable
            />
            <div className="flex-1" />
            <Button
              size="sm"
              variant="outline"
              onClick={() => void rescan()}
              disabled={rescanning}
              title="Re-read every surviving transcript and rebuild the history rows"
            >
              <RefreshCw className={cn('mr-1 h-3.5 w-3.5', rescanning && 'animate-spin')} />
              Rescan
            </Button>
          </FilterCard>

          <div className="grid gap-3 lg:grid-cols-2">
            <FilterCard label="Date range" testId="filter-date-range">
              {/* Three presets, one line. w-full then drops the explicit
                  dates onto their own row, so they read as an override of the
                  presets rather than a fourth one. */}
              {RANGE_PRESETS.map((r) => (
                <Button
                  key={r.key}
                  size="sm"
                  variant={filters.rangeKey === r.key && !filters.customStart && !filters.customEnd ? 'default' : 'outline'}
                  onClick={() => patch({ rangeKey: r.key, customStart: '', customEnd: '' })}
                >
                  {r.label}
                </Button>
              ))}

              <div className="flex w-full items-center gap-1.5 pt-0.5">
                <input
                  type="date"
                  aria-label="Custom start date"
                  value={filters.customStart}
                  min={facets?.minDate ?? undefined}
                  max={facets?.maxDate ?? undefined}
                  onChange={(e) => patch({ customStart: e.target.value })}
                  className="min-w-0 flex-1 rounded border border-border bg-background px-2"
                  title="Custom start date (overrides the preset)"
                />
                <span className="text-[11px] text-muted-foreground">→</span>
                <input
                  type="date"
                  aria-label="Custom end date"
                  value={filters.customEnd}
                  min={facets?.minDate ?? undefined}
                  max={facets?.maxDate ?? undefined}
                  onChange={(e) => patch({ customEnd: e.target.value })}
                  className="min-w-0 flex-1 rounded border border-border bg-background px-2"
                  title="Custom end date (overrides the preset)"
                />
              </div>
            </FilterCard>

            <FilterCard label="Model & scope" testId="filter-model-scope">
              <MultiSelectFilter
                label="Models"
                options={facets?.models ?? []}
                selected={filters.models}
                onChange={(models) => patch({ models })}
                renderOption={modelLabel}
              />
              <div className="mx-0.5 h-5 w-px shrink-0 bg-border" />
              {([
                { key: 'all', label: 'Both' },
                { key: 'main', label: 'Main loop' },
                { key: 'subagent', label: 'Subagents' },
              ] as const).map((sc) => (
                <Button
                  key={sc.key}
                  size="sm"
                  variant={filters.scope === sc.key ? 'default' : 'outline'}
                  onClick={() => patch({ scope: sc.key })}
                >
                  {sc.label}
                </Button>
              ))}
            </FilterCard>
          </div>
        </div>

        {error && <div className="text-sm text-red-400">{error}</div>}

        {failed.length > 0 && (
          <div className="flex items-start gap-2 rounded-md border border-red-500/40 bg-red-500/10 px-3 py-2 text-xs">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-red-400" />
            <div>
              <div className="font-medium text-foreground">
                Some panels could not load: {failed.join(', ')}
              </div>
              <div className="text-muted-foreground">
                Everything else on this page is still accurate. If this followed an update,
                restarting OmniFex usually clears it.
              </div>
            </div>
          </div>
        )}

        {data && data.unpriced.length > 0 && (
          <div className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" />
            <div>
              <div className="font-medium text-foreground">
                {data.unpriced.length} model{data.unpriced.length > 1 ? 's are' : ' is'} billed at
                the fallback rate
              </div>
              <div className="text-muted-foreground">
                {data.unpriced.map((u) => `${u.model} (${u.request_count} requests, ${fmtUsd(u.cost_usd)})`).join(', ')}
                {' — '}these matched no entry in the rate table, so their cost is a Sonnet-tier
                guess. Add a rate before trusting the total.
              </div>
            </div>
          </div>
        )}

        {loading && !data ? (
          <div className="text-sm text-muted-foreground">Loading…</div>
        ) : (
          <>
            {/* ── Headline ────────────────────────────────────────────── */}
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
              <Kpi
                label={notionalAccounts.length > 0 ? 'Total (notional)' : 'Total'}
                value={fmtUsd(total)}
                hint={notionalAccounts.length > 0 ? 'not billed per token' : undefined}
              />
              <Kpi label="Sessions" value={sessionCount.toLocaleString()} />
              <Kpi label="Requests" value={requests.toLocaleString()} />
              <Kpi label="Active periods" value={String(activeDays)} hint={filters.groupBy} />
              <Kpi label="Per request" value={requests > 0 ? fmtUsd(total / requests) : '—'} />
            </div>

            {notionalAccounts.length > 0 && (
              <p className="text-xs text-muted-foreground">
                {notionalAccounts.join(' and ')}{' '}
                {notionalAccounts.length > 1 ? 'are subscription accounts' : 'is a subscription account'},
                so {notionalAccounts.length > 1 ? 'their' : 'its'} tokens are not billed per use.
                The dollar figures below are what this usage <em>would</em> have cost at API rates —
                useful for comparison, not a bill.
              </p>
            )}

            {/* ── Trend ───────────────────────────────────────────────── */}
            <Panel
              title="Spend over time"
              testId="trend-panel"
              actions={
                <>
                  {(['day', 'week', 'month'] as const).map((g) => (
                    <Button
                      key={g}
                      size="sm"
                      data-testid={`group-by-${g}`}
                      variant={filters.groupBy === g ? 'default' : 'outline'}
                      onClick={() => patch({ groupBy: g })}
                    >
                      {g}
                    </Button>
                  ))}
                </>
              }
              subtitle={
                heaviestDays.length > 0 && burstShare >= 0.25 ? (
                  <>
                    The {heaviestDays.length} heaviest {filters.groupBy === 'day' ? 'days' : 'periods'} —{' '}
                    <span className="font-mono">{heaviestDays.map(([d]) => d).join(', ')}</span> — account for{' '}
                    <strong>{fmtPercent(burstShare)}</strong> of the total. This range is bursty,
                    not sustained.
                  </>
                ) : undefined
              }
            >
              <CostChart rows={data?.periods ?? []} mode={mode} />
              <CostChartLegend models={chartModels} mode={mode} />
            </Panel>

            {/* ── Component split ─────────────────────────────────────── */}
            {data?.components && total > 0 && (
              <Panel
                title="Cost by component"
                subtitle={
                  <>
                    <strong>{fmtPercent(data.components.context_share)}</strong> of spend is
                    context, <strong>{fmtPercent(1 - data.components.context_share)}</strong> is
                    generated output. Most of the bill is re-sending what the model already
                    read — a different and more fixable problem than &ldquo;we spend a lot on AI&rdquo;.
                  </>
                }
              >
                <table className="w-full text-xs">
                  <thead>
                    <tr className="text-left text-muted-foreground">
                      <th className="py-1 pr-2 font-medium">Component</th>
                      <th className="py-1 pr-2 font-medium text-right">Cost</th>
                      <th className="py-1 font-medium text-right">Share</th>
                    </tr>
                  </thead>
                  <tbody>
                    {([
                      ['Cache read', data.components.cache_read_usd],
                      ['Cache write', data.components.cache_write_usd],
                      ['Generated output', data.components.output_usd],
                      ['Fresh input', data.components.input_usd],
                    ] as const).map(([label, usd]) => (
                      <tr key={label} className="border-t border-border/50">
                        <td className="py-1 pr-2">{label}</td>
                        <td className="py-1 pr-2 text-right font-mono">{fmtUsd(usd)}</td>
                        <td className="py-1 text-right font-mono text-muted-foreground">
                          {fmtPercent(usd / total)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </Panel>
            )}

            {/* ── Caching ROI ─────────────────────────────────────────── */}
            {data?.roi && data.roi.cache_write_tokens > 0 && (
              <Panel
                title="Caching ROI"
                subtitle={
                  data.roi.below_break_even ? (
                    <span className="text-amber-500">
                      Read:write is <strong>{fmtRatio(data.roi.read_write_ratio)}</strong>, at or
                      below the ~2:1 break-even. Caching is currently costing more than it saves —
                      this is worth investigating, not just noting.
                    </span>
                  ) : (
                    <>
                      Read:write is <strong>{fmtRatio(data.roi.read_write_ratio)}</strong>, well
                      above the ~2:1 break-even, saving about{' '}
                      <strong>{fmtUsd(data.roi.saved_usd)}</strong> against paying full input rate.
                    </>
                  )
                }
              >
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                  <Kpi label="Cache reads" value={fmtTokens(data.roi.cache_read_tokens)} hint={fmtUsd(data.roi.cache_read_usd)} />
                  <Kpi label="Cache writes" value={fmtTokens(data.roi.cache_write_tokens)} hint={fmtUsd(data.roi.cache_write_usd)} />
                  <Kpi label="Read : write" value={fmtRatio(data.roi.read_write_ratio)} hint="break-even ≈ 2:1" />
                  <Kpi label="1h TTL premium" value={fmtUsd(data.roi.premium_1h_usd)} hint={`${fmtTokens(data.roi.cache_write_1h_tokens)} at 2× vs 1.25×`} />
                </div>
              </Panel>
            )}

            {/* ── Subagent efficiency ─────────────────────────────────── */}
            {main && sub && sub.request_count > 0 && main.request_count > 0 && (
              <Panel
                title="Main loop vs subagents"
                subtitle={
                  <>
                    Subagents cost <strong>{fmtUsd(sub.usd_per_request)}</strong> per request
                    against <strong>{fmtUsd(main.usd_per_request)}</strong> on the main loop —{' '}
                    <strong>{(main.usd_per_request / sub.usd_per_request).toFixed(1)}×</strong>{' '}
                    cheaper, because they carry less context. They are{' '}
                    {fmtPercent(sub.request_count / (sub.request_count + main.request_count))} of
                    requests for {fmtPercent(sub.cost_usd / total)} of spend.
                  </>
                }
              >
                <table className="w-full text-xs">
                  <thead>
                    <tr className="text-left text-muted-foreground">
                      <th className="py-1 pr-2 font-medium">Scope</th>
                      <th className="py-1 pr-2 font-medium text-right">Cost</th>
                      <th className="py-1 pr-2 font-medium text-right">Requests</th>
                      <th className="py-1 font-medium text-right">Per request</th>
                    </tr>
                  </thead>
                  <tbody>
                    {[{ ...main, name: 'Main loop' }, { ...sub, name: 'Subagents' }].map((r) => (
                      <tr key={r.name} className="border-t border-border/50">
                        <td className="py-1 pr-2">{r.name}</td>
                        <td className="py-1 pr-2 text-right font-mono">{fmtUsd(r.cost_usd)}</td>
                        <td className="py-1 pr-2 text-right font-mono">{r.request_count.toLocaleString()}</td>
                        <td className="py-1 text-right font-mono">{fmtUsd(r.usd_per_request)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </Panel>
            )}

            {/* ── By model ────────────────────────────────────────────── */}
            <Panel title="By model">
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-left text-muted-foreground">
                    <th className="py-1 pr-2 font-medium">Model</th>
                    <th className="py-1 pr-2 font-medium text-right">Cost</th>
                    <th className="py-1 pr-2 font-medium text-right">Requests</th>
                    <th className="py-1 pr-2 font-medium text-right">Per request</th>
                    <th className="py-1 font-medium text-right">Cache r/w</th>
                  </tr>
                </thead>
                <tbody>
                  {(data?.byModel ?? []).map((m) => (
                    <tr key={m.model} className="border-t border-border/50">
                      <td className="py-1 pr-2">
                        <span className="inline-flex items-center gap-1.5">
                          <span
                            className="h-2.5 w-2.5 rounded-sm"
                            style={{ background: modelColor(m.model, mode) }}
                            aria-hidden
                          />
                          {modelLabel(m.model)}
                        </span>
                      </td>
                      <td className="py-1 pr-2 text-right font-mono">{fmtUsd(m.cost_usd)}</td>
                      <td className="py-1 pr-2 text-right font-mono">{m.request_count.toLocaleString()}</td>
                      <td className="py-1 pr-2 text-right font-mono">
                        {m.request_count > 0 ? fmtUsd(m.cost_usd / m.request_count) : '—'}
                      </td>
                      <td className="py-1 text-right font-mono text-muted-foreground">
                        {fmtTokens(m.cache_read_tokens)} / {fmtTokens(m.cache_write_tokens)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Panel>

            {/* ── By project ──────────────────────────────────────────── */}
            <Panel
              title="By project"
              subtitle={
                data && data.byProject.length > 1 && total > 0 ? (
                  <>
                    <span className="font-mono">{shortProject(data.byProject[0].project_path)}</span>{' '}
                    is <strong>{fmtPercent(data.byProject[0].cost_usd / total)}</strong> of the
                    range. Worth checking that matches where the attention actually went — a repo
                    still burning money after its branch merged is what this catches.
                  </>
                ) : undefined
              }
            >
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-left text-muted-foreground">
                    <th className="py-1 pr-2 font-medium">Project</th>
                    <th className="py-1 pr-2 font-medium text-right">Cost</th>
                    <th className="py-1 pr-2 font-medium text-right">Share</th>
                    <th className="py-1 pr-2 font-medium text-right">Sessions</th>
                    <th className="py-1 font-medium text-right">Requests</th>
                  </tr>
                </thead>
                <tbody>
                  {(data?.byProject ?? []).slice(0, 25).map((p) => (
                    <tr key={p.project_path ?? '(unknown)'} className="border-t border-border/50">
                      <td className="py-1 pr-2 truncate max-w-[40ch]" title={p.project_path ?? ''}>
                        {shortProject(p.project_path)}
                      </td>
                      <td className="py-1 pr-2 text-right font-mono">{fmtUsd(p.cost_usd)}</td>
                      <td className="py-1 pr-2 text-right font-mono text-muted-foreground">
                        {total > 0 ? fmtPercent(p.cost_usd / total) : '—'}
                      </td>
                      <td className="py-1 pr-2 text-right font-mono">{p.session_count.toLocaleString()}</td>
                      <td className="py-1 text-right font-mono">{p.request_count.toLocaleString()}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {(data?.byProject.length ?? 0) > 25 && (
                <p className="text-[10px] text-muted-foreground">
                  Showing the 25 most expensive of {data?.byProject.length} projects.
                </p>
              )}
            </Panel>

            {/* ── Project × model ─────────────────────────────────────── */}
            <Panel title="Project × model">
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-left text-muted-foreground">
                    <th className="py-1 pr-2 font-medium">Project</th>
                    <th className="py-1 pr-2 font-medium">Model</th>
                    <th className="py-1 pr-2 font-medium text-right">Cost</th>
                    <th className="py-1 font-medium text-right">Requests</th>
                  </tr>
                </thead>
                <tbody>
                  {(data?.byProjectModel ?? []).slice(0, 30).map((r) => (
                    <tr key={`${r.project_path}|${r.model}`} className="border-t border-border/50">
                      <td className="py-1 pr-2 truncate max-w-[32ch]" title={r.project_path ?? ''}>
                        {shortProject(r.project_path)}
                      </td>
                      <td className="py-1 pr-2">
                        <span className="inline-flex items-center gap-1.5">
                          <span
                            className="h-2.5 w-2.5 rounded-sm"
                            style={{ background: modelColor(r.model, mode) }}
                            aria-hidden
                          />
                          {modelLabel(r.model)}
                        </span>
                      </td>
                      <td className="py-1 pr-2 text-right font-mono">{fmtUsd(r.cost_usd)}</td>
                      <td className="py-1 text-right font-mono">{r.request_count.toLocaleString()}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {(data?.byProjectModel.length ?? 0) > 30 && (
                <p className="text-[10px] text-muted-foreground">
                  Showing the 30 most expensive of {data?.byProjectModel.length} combinations.
                </p>
              )}
            </Panel>

            {/* ── Sessions ────────────────────────────────────────────── */}
            <Panel title="Most expensive sessions">
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-left text-muted-foreground">
                    <th className="py-1 pr-2 font-medium">Session</th>
                    <th className="py-1 pr-2 font-medium">Account</th>
                    <th className="py-1 pr-2 font-medium">Project</th>
                    <th className="py-1 pr-2 font-medium">Dates</th>
                    <th className="py-1 font-medium text-right">Cost</th>
                  </tr>
                </thead>
                <tbody>
                  {(data?.sessions ?? []).slice(0, 25).map((s) => (
                    <tr key={s.session_id} className="border-t border-border/50">
                      <td className="py-1 pr-2 font-mono" title={s.session_id}>{s.session_id.slice(0, 8)}…</td>
                      <td className="py-1 pr-2">{s.account_name}</td>
                      <td className="py-1 pr-2 truncate max-w-[28ch]" title={s.project_path ?? ''}>
                        {shortProject(s.project_path)}
                      </td>
                      <td className="py-1 pr-2 font-mono text-muted-foreground">
                        {s.first_date === s.last_date ? s.first_date : `${s.first_date} → ${s.last_date}`}
                      </td>
                      <td className="py-1 text-right font-mono">{fmtUsd(s.cost_usd)}</td>
                    </tr>
                  ))}
                  {(data?.sessions.length ?? 0) === 0 && (
                    <tr>
                      <td colSpan={5} className="py-3 text-muted-foreground">
                        No cost history in this range. Try Rescan.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </Panel>
          </>
        )}
      </div>
    </div>
  );
}
