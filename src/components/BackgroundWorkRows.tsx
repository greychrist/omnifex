import React, { useEffect, useState } from 'react';
import {
  ChevronDown,
  ChevronRight,
  Bot,
  CheckCircle2,
  CircleDashed,
  AlertCircle,
  Ghost,
  X,
  SquareTerminal,
  Square,
  ArrowDownToLine,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import type { SubagentCost } from '@/lib/api';
import type { Subagent } from '@/lib/subagentStreams';
import { subagentRunStats } from '@/lib/subagentRunStats';
import { useSecondTick } from '@/hooks/useSecondTick';
import { formatCost } from '@/components/claude-code-session/CostWidget';
import { plainTaskOutput, type BackgroundShell, type TaskOutputTail } from '@/lib/backgroundShells';

const PALETTE: { border: string; bg: string; dot: string; text: string }[] = [
  { border: 'border-sky-400/40',     bg: 'bg-sky-400/10',     dot: 'bg-sky-400',     text: 'text-sky-400' },
  { border: 'border-indigo-400/40',  bg: 'bg-indigo-400/10',  dot: 'bg-indigo-400',  text: 'text-indigo-400' },
  { border: 'border-cyan-400/40',    bg: 'bg-cyan-400/10',    dot: 'bg-cyan-400',    text: 'text-cyan-400' },
  { border: 'border-teal-400/40',    bg: 'bg-teal-400/10',    dot: 'bg-teal-400',    text: 'text-teal-400' },
  { border: 'border-violet-400/40',  bg: 'bg-violet-400/10',  dot: 'bg-violet-400',  text: 'text-violet-400' },
  { border: 'border-emerald-400/40', bg: 'bg-emerald-400/10', dot: 'bg-emerald-400', text: 'text-emerald-400' },
  { border: 'border-rose-400/40',    bg: 'bg-rose-400/10',    dot: 'bg-rose-400',    text: 'text-rose-400' },
  { border: 'border-orange-400/40',  bg: 'bg-orange-400/10',  dot: 'bg-orange-400',  text: 'text-orange-400' },
  { border: 'border-amber-400/40',   bg: 'bg-amber-400/10',   dot: 'bg-amber-400',   text: 'text-amber-400' },
  { border: 'border-lime-400/40',    bg: 'bg-lime-400/10',    dot: 'bg-lime-400',    text: 'text-lime-400' },
  { border: 'border-green-400/40',   bg: 'bg-green-400/10',   dot: 'bg-green-400',   text: 'text-green-400' },
  { border: 'border-blue-400/40',    bg: 'bg-blue-400/10',    dot: 'bg-blue-400',    text: 'text-blue-400' },
  { border: 'border-purple-400/40',  bg: 'bg-purple-400/10',  dot: 'bg-purple-400',  text: 'text-purple-400' },
  { border: 'border-fuchsia-400/40', bg: 'bg-fuchsia-400/10', dot: 'bg-fuchsia-400', text: 'text-fuchsia-400' },
  { border: 'border-pink-400/40',    bg: 'bg-pink-400/10',    dot: 'bg-pink-400',    text: 'text-pink-400' },
  { border: 'border-yellow-400/40',  bg: 'bg-yellow-400/10',  dot: 'bg-yellow-400',  text: 'text-yellow-400' },
];

function formatElapsed(ms?: number): string {
  if (!ms || ms <= 0) return '';
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const r = s % 60;
  return m > 0 ? `${m}m ${String(r).padStart(2, '0')}s` : `${r}s`;
}

function formatModel(model?: string): string {
  if (!model) return '';
  return model.replace(/^claude-/, '').replace(/-\d{8}$/, '');
}

const kTokens = (n: number): string => `${Math.round(n / 1000)}k`;

// The row stays until the CLI's task events move it: the request answers before the task ends.
function useRowAction(): {
  busy: boolean;
  error: string | null;
  run: (fn: () => Promise<string | null>) => void;
} {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = (fn: () => Promise<string | null>) => {
    setBusy(true);
    setError(null);
    fn()
      .then((problem) => { setError(problem); })
      .catch((err: unknown) => { setError(err instanceof Error ? err.message : String(err)); })
      .finally(() => { setBusy(false); });
  };
  return { busy, error, run };
}

// A span, not a button: it sits inside the row's header button.
function RowActionButton({
  label, icon, busy, onActivate,
}: {
  label: string;
  icon: React.ReactNode;
  busy: boolean;
  onActivate: () => void;
}): React.JSX.Element {
  return (
    <span
      role="button"
      aria-label={label}
      aria-disabled={busy || undefined}
      title={label}
      onClick={(e) => {
        e.stopPropagation();
        if (!busy) onActivate();
      }}
      className={cn(
        'ml-1 inline-flex h-4 w-4 items-center justify-center rounded-sm text-muted-foreground hover:text-foreground hover:bg-white/10 shrink-0',
        busy && 'animate-pulse opacity-50',
      )}
    >
      {icon}
    </span>
  );
}

function RowActionError({ error }: { error: string | null }): React.JSX.Element | null {
  if (!error) return null;
  return (
    <div role="alert" className="mx-3 mb-1.5 rounded bg-destructive/5 px-1.5 py-1 text-[11px] text-destructive">
      {error}
    </div>
  );
}

interface SubagentRowProps {
  sub: Subagent;
  onDismiss?: (toolUseId: string) => void;
  costs?: Record<string, SubagentCost> | null;
  onStop?: (taskId: string) => Promise<void>;
  onBackground?: (toolUseId: string) => Promise<boolean>;
}

export const SubagentRow: React.FC<SubagentRowProps> = ({ sub, onDismiss, costs, onStop, onBackground }) => {
  const [expanded, setExpanded] = useState(false);
  const action = useRowAction();
  const color = PALETTE[sub.colorIndex % PALETTE.length];
  const latest = sub.latest;
  const dim = sub.status !== 'running';
  const dismissable = onDismiss && sub.status !== 'running';

  const statusIcon =
    sub.status === 'completed' ? (
      <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400" />
    ) : sub.status === 'completed_inferred' ? (
      <span title="Completion inferred from parent result — no task-notification was delivered.">
        <CircleDashed className={cn('h-3.5 w-3.5', color.text, 'opacity-60')} />
      </span>
    ) : sub.status === 'failed' ? (
      <AlertCircle className="h-3.5 w-3.5 text-destructive" />
    ) : sub.status === 'abandoned' ? (
      <span title="Session ended before this returned">
        <Ghost className="h-3.5 w-3.5 text-muted-foreground" />
      </span>
    ) : (
      <span className={cn('inline-block h-2 w-2 rounded-full animate-pulse', color.dot)} />
    );

  const nowMs = useSecondTick(sub.status === 'running');
  const stats = subagentRunStats(sub, costs, nowMs);

  const tokenCount = sub.finalTotalTokens ?? latest?.totalTokens;
  const toolCount = sub.finalToolUseCount ?? latest?.toolUses;
  const model = formatModel(sub.model);
  const effort = sub.effort ? `${sub.effort} effort` : '';
  const tokens = stats.contextTokens === undefined && tokenCount ? `${kTokens(tokenCount)} tok` : '';
  const tools = toolCount ? `${toolCount} tools` : '';
  const metaBits = [model, effort, tools, tokens].filter(Boolean).join(' · ');
  const statBits = [
    stats.contextTokens !== undefined
      ? `${stats.contextPct !== undefined ? `ctx ${stats.contextPct}% · ` : ''}${kTokens(stats.contextTokens)}`
      : '',
    stats.usd !== undefined ? `≈${formatCost(stats.usd)}` : '',
    formatElapsed(stats.elapsedMs),
  ].filter(Boolean);

  const barState =
    sub.status === 'completed' ? 'done'
      : sub.status === 'completed_inferred' ? 'inferred'
        : sub.status;

  const nowLabel = barState === 'running' ? sub.progressSummary ?? null : null;

  const purpose = sub.description || latest?.description || 'Working…';
  const agentLabel = sub.agentType ?? 'Agent';

  const nested = !!sub.parentToolUseId;
  const running = sub.status === 'running';
  const canStop = onStop && running && !!sub.taskId;
  const canBackground = onBackground && running && sub.isBackground !== true && !nested;

  const mode =
    sub.isBackground === true
      ? { label: 'bg', title: 'Background — the session carries on while it runs' }
      : sub.isBackground === false
        ? { label: 'fg', title: 'Foreground — the turn waits for it' }
        : null;

  return (
    <div
      data-subagent-row
      data-nested={nested ? 'true' : undefined}
      className={cn(
        'border-l-2 transition-opacity',
        // `!` because the unlayered `* { border-color }` in styles.css beats border-color utilities.
        'border-b last:border-b-0 [border-bottom-color:color-mix(in_oklch,var(--color-muted-foreground)_30%,transparent)]!',
        color.border,
        color.bg,
        dim && 'opacity-60',
        nested && 'ml-4',
      )}
    >
      <button
        type="button"
        onClick={() => { setExpanded((v) => !v); }}
        className="w-full px-3 py-1.5 text-xs text-left hover:bg-white/5"
      >
        <span className="flex items-start gap-2">
          <span className="flex items-center justify-center w-4 h-4 shrink-0">{statusIcon}</span>
          <Bot className={cn('h-3.5 w-3.5 mt-px shrink-0', color.text)} />
          <span className={cn('font-mono font-medium shrink-0', color.text)}>{agentLabel}</span>
          {mode && (
            <span
              title={mode.title}
              className="shrink-0 rounded px-1 font-mono text-[10px] leading-4 text-muted-foreground bg-white/5"
            >
              {mode.label}
            </span>
          )}
          <span className="text-muted-foreground shrink-0">·</span>
          <span data-subagent-purpose className="flex-1 min-w-0 break-words text-foreground/90">{purpose}</span>
          {expanded ? (
            <ChevronDown className="h-3.5 w-3.5 mt-px text-muted-foreground shrink-0" />
          ) : (
            <ChevronRight className="h-3.5 w-3.5 mt-px text-muted-foreground shrink-0" />
          )}
          {canBackground && (
            <RowActionButton
              label="Move to background"
              icon={<ArrowDownToLine className="h-3 w-3" />}
              busy={action.busy}
              onActivate={() => {
                action.run(async () => (await onBackground(sub.toolUseId)) ? null : 'It had already finished.');
              }}
            />
          )}
          {canStop && sub.taskId && (
            <RowActionButton
              label="Stop"
              icon={<Square className="h-2.5 w-2.5 fill-current" />}
              busy={action.busy}
              onActivate={() => {
                const taskId = sub.taskId as string;
                action.run(async () => { await onStop(taskId); return null; });
              }}
            />
          )}
          {dismissable && (
            <span
              role="button"
              aria-label="Dismiss"
              title="Dismiss"
              onClick={(e) => {
                e.stopPropagation();
                onDismiss(sub.toolUseId);
              }}
              className="ml-1 inline-flex h-4 w-4 items-center justify-center rounded-sm text-muted-foreground hover:text-foreground hover:bg-white/10 shrink-0"
            >
              <X className="h-3 w-3" />
            </span>
          )}
        </span>
        {(metaBits || statBits.length > 0) && (
          <span className="flex items-center gap-2 pl-6 pt-0.5 text-[11px] text-muted-foreground">
            <span data-subagent-meta className="truncate flex-1 min-w-0">{metaBits}</span>
            {statBits.length > 0 && (
              <span data-subagent-stats className="shrink-0 flex gap-2 tabular-nums">
                {statBits.map((bit) => <span key={bit}>{bit}</span>)}
              </span>
            )}
          </span>
        )}
        {nowLabel && (
          <span data-subagent-summary className="block pl-6 pt-0.5 text-[11px] text-foreground/80 truncate">
            {nowLabel}
          </span>
        )}
        <span
          data-subagent-bar
          data-state={barState}
          className="mt-1 ml-6 block h-0.5 rounded-full bg-white/10 overflow-hidden"
        >
          <span
            className={cn(
              'block h-full rounded-full',
              barState === 'running' ? cn('brain-indeterminate-bar w-1/3', color.dot) : 'w-full',
              barState === 'done' && 'bg-emerald-400',
              barState === 'inferred' && cn(color.dot, 'opacity-60'),
              barState === 'failed' && 'bg-destructive',
              barState === 'abandoned' && 'bg-muted-foreground/40',
            )}
          />
        </span>
      </button>
      <RowActionError error={action.error} />

      {expanded && (
        <div className="px-3 pb-2 pt-0.5 border-t border-white/5 space-y-0.5">
          {sub.prompt && (
            // A <div>, not a <pre>: the narrow/touch layout forces every <pre> to one unwrapped line.
            <div
              data-subagent-prompt
              className="mb-1 max-h-48 overflow-y-auto rounded bg-black/20 px-2 py-1 text-[11px] font-sans leading-snug whitespace-pre-wrap break-words text-foreground/80"
            >
              {sub.prompt}
            </div>
          )}
          {sub.events.length === 0 && (
            <div className="text-[11px] text-muted-foreground italic py-1">
              {sub.status === 'running'
                ? 'Waiting for first progress event…'
                : sub.status === 'completed_inferred'
                  ? 'Completed (no progress reported)'
                  : 'No steps to show — the step log is kept only while the app is open.'}
            </div>
          )}
          {sub.events.map((ev, i) => {
            const description = ev.summary ?? (ev.description || '…');
            const bits = [
              ev.lastToolName,
              ev.toolUses ? `${ev.toolUses} tools` : '',
              ev.totalTokens ? `${Math.round(ev.totalTokens / 1000)}k tok` : '',
              formatElapsed(ev.durationMs),
            ].filter(Boolean).join(' · ');
            return (
              <div key={i} data-subagent-log-entry className="flex items-start gap-2 text-[11px] font-mono leading-snug">
                <span className={cn('mt-[5px] h-1 w-1 rounded-full shrink-0', color.dot)} />
                <span className={cn('flex-1 min-w-0 break-words', ev.summary ? 'text-foreground' : 'text-foreground/80')}>
                  {description}
                </span>
                {bits && <span className="text-muted-foreground shrink-0 tabular-nums">{bits}</span>}
              </div>
            );
          })}
          {sub.status === 'completed' && sub.summary && (
            <div className="flex items-start gap-2 text-[11px] pt-1">
              <CheckCircle2 className="h-3 w-3 mt-0.5 shrink-0 text-emerald-400" />
              <span className="text-foreground/70 italic">{sub.summary}</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
};

const SHELL_POLL_MS = 2000;

// A null read (task evicted, session gone) keeps the last output rather than blanking it.
function useShellOutput(
  taskId: string,
  running: boolean,
  open: boolean,
  read: (taskId: string) => Promise<TaskOutputTail | null>,
): { tail: TaskOutputTail | null; loaded: boolean } {
  const [tail, setTail] = useState<TaskOutputTail | null>(null);
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const fetchOnce = () => {
      read(taskId)
        .then((next) => {
          if (cancelled) return;
          if (next) setTail(next);
          setLoaded(true);
        })
        .catch(() => { if (!cancelled) setLoaded(true); });
    };
    fetchOnce();
    const timer = running ? setInterval(fetchOnce, SHELL_POLL_MS) : null;
    return () => {
      cancelled = true;
      if (timer) clearInterval(timer);
    };
  }, [taskId, running, open, read]);
  return { tail, loaded };
}

interface ShellRowProps {
  shell: BackgroundShell;
  read: (taskId: string) => Promise<TaskOutputTail | null>;
  onDismiss?: (taskId: string) => void;
  onStop?: (taskId: string) => Promise<void>;
}

export const ShellRow: React.FC<ShellRowProps> = ({ shell, read, onDismiss, onStop }) => {
  const [expanded, setExpanded] = useState(false);
  const action = useRowAction();
  const running = shell.status === 'running';
  const { tail, loaded } = useShellOutput(shell.taskId, running, expanded, read);
  const dismissable = onDismiss && !running;
  const text = tail ? plainTaskOutput(tail.output) : '';

  return (
    <div
      data-shell-row
      className={cn('border-l-2 border-zinc-400/40 bg-zinc-400/10 transition-opacity', !running && 'opacity-60')}
    >
      <button
        type="button"
        onClick={() => { setExpanded((v) => !v); }}
        className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-left hover:bg-white/5"
      >
        <span className="flex items-center justify-center w-4 shrink-0">
          {running ? (
            <span className="inline-block h-2 w-2 rounded-full animate-pulse bg-zinc-400" />
          ) : (
            <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400" />
          )}
        </span>
        <SquareTerminal className="h-3.5 w-3.5 shrink-0 text-zinc-400" />
        <span className="font-mono font-medium shrink-0 text-zinc-400">Shell</span>
        <span className="text-muted-foreground shrink-0">·</span>
        <span className="truncate flex-1 text-foreground/90 font-mono">{shell.description}</span>
        {expanded ? (
          <ChevronDown className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
        ) : (
          <ChevronRight className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
        )}
        {onStop && running && (
          <RowActionButton
            label="Stop"
            icon={<Square className="h-2.5 w-2.5 fill-current" />}
            busy={action.busy}
            onActivate={() => { action.run(async () => { await onStop(shell.taskId); return null; }); }}
          />
        )}
        {dismissable && (
          <span
            role="button"
            aria-label="Dismiss"
            title="Dismiss"
            onClick={(e) => {
              e.stopPropagation();
              onDismiss(shell.taskId);
            }}
            className="ml-1 inline-flex h-4 w-4 items-center justify-center rounded-sm text-muted-foreground hover:text-foreground hover:bg-white/10 shrink-0"
          >
            <X className="h-3 w-3" />
          </span>
        )}
      </button>
      <RowActionError error={action.error} />

      {expanded && (
        <div className="px-3 pb-2 pt-1 border-t border-white/5 space-y-1">
          <div data-shell-description className="text-[11px] font-mono leading-snug whitespace-pre-wrap break-words text-foreground/90">
            {shell.description}
          </div>
          {!loaded ? (
            <div className="text-[11px] text-muted-foreground italic py-1">Reading output…</div>
          ) : !tail ? (
            <div className="text-[11px] text-muted-foreground italic py-1">
              Output not available — the CLI no longer holds this task.
            </div>
          ) : (
            <>
              {tail.truncated && (
                <div className="text-[10px] text-muted-foreground py-0.5">Showing the last 8 KiB</div>
              )}
              {text ? (
                // A <div>, not a <pre>: the narrow/touch layout forces every <pre> to one unwrapped line.
                <div
                  data-shell-output
                  className="rounded bg-black/20 px-2 py-1 text-[11px] font-mono leading-snug whitespace-pre-wrap break-words text-foreground/80 max-h-64 overflow-y-auto"
                >
                  {text}
                </div>
              ) : (
                <div className="text-[11px] text-muted-foreground italic py-1">No output yet</div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
};
