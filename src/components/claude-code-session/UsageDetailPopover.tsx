import * as React from 'react';
import { Loader2, RefreshCw } from 'lucide-react';
import { Popover } from '@/components/ui/popover';
import { cn } from '@/lib/utils';
import type { UsageRunResult } from '@/lib/api';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  trigger: React.ReactNode;
  data: UsageRunResult | null;
  loading: boolean;
  onRefresh: () => void;
  nowMs?: number;
  align?: 'start' | 'center' | 'end';
}

const WINDOW_LABELS: Record<string, string> = {
  current_session: 'Current session (5h)',
  week_all_models: 'Current week (all models)',
  week_sonnet: 'Current week (Sonnet only)',
};

function ageLabel(observedAt: number, now: number): string {
  const ms = now - observedAt;
  if (ms < 60_000) return 'just now';
  const min = Math.floor(ms / 60_000);
  if (min < 60) return `${min}m ago`;
  const hrs = Math.floor(min / 60);
  return `${hrs}h ${min % 60}m ago`;
}

function pctColor(pct: number): string {
  if (pct >= 90) return 'bg-red-400';
  if (pct >= 75) return 'bg-orange-400';
  if (pct >= 50) return 'bg-yellow-400';
  return 'bg-green-400';
}

export function UsageDetailPopover({
  open,
  onOpenChange,
  trigger,
  data,
  loading,
  onRefresh,
  nowMs,
  align = 'end',
}: Props) {
  const now = nowMs ?? Date.now();

  const content = (
    <div className="w-[420px] max-h-[70vh] overflow-y-auto">
      {data == null && (
        <div className="text-sm text-muted-foreground">No usage data yet.</div>
      )}
      {data && data.ok === false && (
        <div className="space-y-2">
          <div className="text-sm font-medium text-red-400">Couldn't fetch /usage</div>
          <div className="text-xs text-muted-foreground">{data.error}</div>
          {data.raw && (
            <details>
              <summary className="cursor-pointer text-xs text-muted-foreground">Raw output</summary>
              <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap text-[11px] text-muted-foreground">
                {data.raw}
              </pre>
            </details>
          )}
        </div>
      )}
      {data && data.ok && (
        <div className="space-y-4">
          <Section title="Session">
            <KV k="Cost" v={`$${data.parsed.session.cost_usd.toFixed(4)}`} />
            <KV k="API duration" v={`${data.parsed.session.api_duration_s}s`} />
            <KV k="Wall duration" v={`${data.parsed.session.wall_duration_s}s`} />
            <KV
              k="Code"
              v={`+${data.parsed.session.code_added} / -${data.parsed.session.code_removed}`}
            />
            <KV
              k="Tokens"
              v={`${data.parsed.session.input_tokens} in / ${data.parsed.session.output_tokens} out`}
            />
            <KV
              k="Cache"
              v={`${data.parsed.session.cache_read} read / ${data.parsed.session.cache_write} write`}
            />
          </Section>

          <Section title="Limits">
            {data.parsed.windows.map((w) => (
              <div key={w.label} className="space-y-1">
                <div className="flex justify-between text-xs">
                  <span>{WINDOW_LABELS[w.label] ?? w.label}</span>
                  <span className="font-mono">{w.pct_used.toFixed(0)}%</span>
                </div>
                <div className="h-1.5 w-full overflow-hidden rounded bg-foreground/10">
                  <div
                    className={cn('h-full', pctColor(w.pct_used))}
                    style={{ width: `${Math.min(100, Math.max(0, w.pct_used))}%` }}
                  />
                </div>
                <div className="text-[11px] text-muted-foreground">
                  Resets {w.resets_at_label}
                </div>
              </div>
            ))}
          </Section>

          {data.parsed.contributing.length > 0 && (
            <Section title="What's contributing">
              {data.parsed.contributing.map((c, i) => (
                <div key={i} className="space-y-0.5">
                  <div className="text-xs font-medium">{c.headline}</div>
                  <div className="text-[11px] text-muted-foreground">{c.detail}</div>
                </div>
              ))}
            </Section>
          )}

          <div className="flex items-center justify-between pt-2 border-t border-border">
            <span className="text-[11px] text-muted-foreground">
              observed {ageLabel(data.observed_at, now)}
            </span>
            <button
              type="button"
              onClick={onRefresh}
              disabled={loading}
              className={cn(
                'inline-flex items-center gap-1 rounded px-2 py-1 text-xs font-medium',
                'hover:bg-foreground/10 disabled:opacity-50',
              )}
            >
              {loading
                ? <Loader2 className="h-3 w-3 animate-spin" />
                : <RefreshCw className="h-3 w-3" />}
              Refresh
            </button>
          </div>
        </div>
      )}
    </div>
  );

  return (
    <Popover
      trigger={trigger}
      content={content}
      open={open}
      onOpenChange={onOpenChange}
      align={align}
    />
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="space-y-2">
      <div className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
        {title}
      </div>
      <div className="space-y-1.5">{children}</div>
    </div>
  );
}

function KV({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex justify-between text-xs">
      <span className="text-muted-foreground">{k}</span>
      <span className="font-mono">{v}</span>
    </div>
  );
}
