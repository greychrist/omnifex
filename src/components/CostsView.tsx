import { useCallback, useEffect, useMemo, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { api, type CostHistoryPeriod, type CostSessionRow } from '@/lib/api';
import { useAccounts } from '@/contexts/AccountsContext';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

type GroupBy = 'day' | 'week' | 'month';

function utcMonthStart(): string {
  return new Date().toISOString().slice(0, 8) + '01';
}

function fmtUsd(v: number): string {
  return v >= 0.01 || v === 0 ? `$${v.toFixed(2)}` : `$${v.toFixed(4)}`;
}

const RANGE_PRESETS = [
  { key: 'month', label: 'This month (UTC)' },
  { key: '30d', label: 'Last 30 days' },
  { key: '90d', label: 'Last 90 days' },
  { key: 'all', label: 'All time' },
] as const;

function rangeFor(key: (typeof RANGE_PRESETS)[number]['key']): { startDate?: string } {
  if (key === 'month') return { startDate: utcMonthStart() };
  if (key === 'all') return {};
  const days = key === '30d' ? 30 : 90;
  const d = new Date(Date.now() - days * 86_400_000);
  return { startDate: d.toISOString().slice(0, 10) };
}

export function CostsView() {
  const { accounts } = useAccounts();
  const [rangeKey, setRangeKey] = useState<(typeof RANGE_PRESETS)[number]['key']>('month');
  const [groupBy, setGroupBy] = useState<GroupBy>('day');
  const [accountName, setAccountName] = useState<string>('all');
  const [periods, setPeriods] = useState<CostHistoryPeriod[]>([]);
  const [sessions, setSessions] = useState<CostSessionRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [rescanning, setRescanning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const filters = {
        ...rangeFor(rangeKey),
        ...(accountName !== 'all' ? { accountName } : {}),
      };
      const [p, s] = await Promise.all([
        api.sessionCostHistory({ ...filters, groupBy }),
        api.sessionCostSessions(filters),
      ]);
      setPeriods(p);
      setSessions(s);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [rangeKey, groupBy, accountName]);

  useEffect(() => { void load(); }, [load]);

  const total = useMemo(() => periods.reduce((acc, p) => acc + p.cost_usd, 0), [periods]);
  const maxPeriod = useMemo(() => Math.max(1e-9, ...periods.map((p) => p.cost_usd)), [periods]);
  const anyEstimated = periods.some((p) => p.is_estimated === 1);

  const rescan = useCallback(async () => {
    setRescanning(true);
    try {
      await api.sessionCostRescan();
      await load();
    } finally {
      setRescanning(false);
    }
  }, [load]);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-2">
        {RANGE_PRESETS.map((r) => (
          <Button key={r.key} size="sm" variant={rangeKey === r.key ? 'default' : 'outline'}
            onClick={() => setRangeKey(r.key)}>{r.label}</Button>
        ))}
        <div className="mx-2 h-5 w-px bg-border" />
        {(['day', 'week', 'month'] as const).map((g) => (
          <Button key={g} size="sm" variant={groupBy === g ? 'default' : 'outline'}
            onClick={() => setGroupBy(g)}>{g}</Button>
        ))}
        <div className="mx-2 h-5 w-px bg-border" />
        <select
          className="h-8 rounded border bg-background px-2 text-xs"
          value={accountName}
          onChange={(e) => setAccountName(e.target.value)}
        >
          <option value="all">All accounts</option>
          {accounts.map((a) => (
            <option key={a.name} value={a.name}>{a.name}</option>
          ))}
        </select>
        <div className="flex-1" />
        <Button size="sm" variant="outline" onClick={() => void rescan()} disabled={rescanning}
          title="Re-scan all surviving transcripts and rebuild history rows">
          <RefreshCw className={cn('mr-1 h-3.5 w-3.5', rescanning && 'animate-spin')} />
          Rescan
        </Button>
      </div>

      <div className="text-sm text-muted-foreground">
        Total for range: <span className="font-mono text-foreground">{anyEstimated ? '~' : ''}{fmtUsd(total)}</span>
        <span className="ml-3 text-xs">
          &#9432; Anthropic's console bills the org in UTC months and includes usage OmniFex can't see
          (other machines, teammates, pre-tracking sessions) — expect OmniFex &le; console.
        </span>
      </div>

      {error && <div className="text-sm text-red-400">{error}</div>}
      {loading ? (
        <div className="text-sm text-muted-foreground">Loading…</div>
      ) : (
        <>
          <table className="w-full text-xs">
            <thead>
              <tr className="text-left text-muted-foreground">
                <th className="py-1 pr-2 font-medium">Period</th>
                <th className="py-1 pr-2 font-medium">Cost</th>
                <th className="py-1 pr-2 font-medium w-1/2"></th>
                <th className="py-1 pr-2 font-medium text-right">Tokens (in/out)</th>
                <th className="py-1 font-medium text-right">Cache (r/w)</th>
              </tr>
            </thead>
            <tbody>
              {periods.map((p) => (
                <tr key={p.period} className="border-t border-border/50">
                  <td className="py-1 pr-2 font-mono">{p.period}</td>
                  <td className="py-1 pr-2 font-mono">{p.is_estimated ? '~' : ''}{fmtUsd(p.cost_usd)}</td>
                  <td className="py-1 pr-2">
                    <div className="h-2 rounded bg-primary/70" style={{ width: `${(p.cost_usd / maxPeriod) * 100}%` }} />
                  </td>
                  <td className="py-1 pr-2 text-right font-mono text-muted-foreground">
                    {p.input_tokens.toLocaleString()} / {p.output_tokens.toLocaleString()}
                  </td>
                  <td className="py-1 text-right font-mono text-muted-foreground">
                    {p.cache_read_tokens.toLocaleString()} / {p.cache_write_tokens.toLocaleString()}
                  </td>
                </tr>
              ))}
              {periods.length === 0 && (
                <tr><td colSpan={5} className="py-3 text-muted-foreground">No cost history in this range. Try Rescan.</td></tr>
              )}
            </tbody>
          </table>

          <div>
            <div className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
              Sessions in range (by cost)
            </div>
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
                {sessions.slice(0, 50).map((s) => (
                  <tr key={s.session_id} className="border-t border-border/50">
                    <td className="py-1 pr-2 font-mono truncate max-w-[16ch]" title={s.session_id}>{s.session_id.slice(0, 12)}…</td>
                    <td className="py-1 pr-2">{s.account_name}</td>
                    <td className="py-1 pr-2 truncate max-w-[32ch]" title={s.project_path ?? ''}>{s.project_path}</td>
                    <td className="py-1 pr-2 font-mono">{s.first_date === s.last_date ? s.first_date : `${s.first_date} → ${s.last_date}`}</td>
                    <td className="py-1 text-right font-mono">{fmtUsd(s.cost_usd)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
