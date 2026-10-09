/**
 * The rows behind the status bar's `agents` and `shells` readouts
 * (`BackgroundWorkItems.tsx`): one per subagent, one per background shell or
 * Monitor. Each row expands in place — a subagent to its progress log, a
 * shell to the tail of its output.
 */
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
} from 'lucide-react';
import { cn } from '@/lib/utils';
import type { SubagentCost } from '@/lib/api';
import type { Subagent } from '@/lib/subagentStreams';
import { subagentRunStats } from '@/lib/subagentRunStats';
import { useSecondTick } from '@/hooks/useSecondTick';
import { formatCost } from '@/components/claude-code-session/CostWidget';
import { plainTaskOutput, type BackgroundShell, type TaskOutputTail } from '@/lib/backgroundShells';

// 16-slot palette — one distinct hue per slot so concurrent subagents never
// share a colour until all 16 are live simultaneously (extremely rare).
// The allocator in subagentStreams guarantees ordered assignment so slot 0
// always goes to the first dispatched subagent, slot 1 to the second, etc.
const PALETTE: { border: string; bg: string; dot: string; text: string }[] = [
  // 0–5 original set
  { border: 'border-sky-400/40',     bg: 'bg-sky-400/10',     dot: 'bg-sky-400',     text: 'text-sky-400' },
  { border: 'border-indigo-400/40',  bg: 'bg-indigo-400/10',  dot: 'bg-indigo-400',  text: 'text-indigo-400' },
  { border: 'border-cyan-400/40',    bg: 'bg-cyan-400/10',    dot: 'bg-cyan-400',    text: 'text-cyan-400' },
  { border: 'border-teal-400/40',    bg: 'bg-teal-400/10',    dot: 'bg-teal-400',    text: 'text-teal-400' },
  { border: 'border-violet-400/40',  bg: 'bg-violet-400/10',  dot: 'bg-violet-400',  text: 'text-violet-400' },
  { border: 'border-emerald-400/40', bg: 'bg-emerald-400/10', dot: 'bg-emerald-400', text: 'text-emerald-400' },
  // 6–15 ten new hues, evenly spaced around the wheel
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

// Compact a CLI model id for the dense row meta: drop the `claude-` vendor
// prefix and any trailing `-YYYYMMDD` date stamp, e.g.
// `claude-haiku-4-5-20251001` → `haiku-4-5`. Leaves unrecognised shapes
// (local models, already-short ids) untouched.
function formatModel(model?: string): string {
  if (!model) return '';
  return model.replace(/^claude-/, '').replace(/-\d{8}$/, '');
}

const kTokens = (n: number): string => `${Math.round(n / 1000)}k`;

interface SubagentRowProps {
  sub: Subagent;
  onDismiss?: (toolUseId: string) => void;
  /** Per-agent cost and context from the session cost watcher, keyed by
   *  agent id. Absent until its first snapshot. */
  costs?: Record<string, SubagentCost> | null;
}

export const SubagentRow: React.FC<SubagentRowProps> = ({ sub, onDismiss, costs }) => {
  const [expanded, setExpanded] = useState(false);
  const color = PALETTE[sub.colorIndex % PALETTE.length];
  const latest = sub.latest;
  const dim = sub.status !== 'running';
  const dismissable = onDismiss && sub.status !== 'running';

  const statusIcon =
    sub.status === 'completed' ? (
      // Mirrors the TaskList's completed row — green check, not the
      // per-subagent palette color, so "done" reads the same way across
      // both bars at a glance.
      <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400" />
    ) : sub.status === 'completed_inferred' ? (
      // Distinct icon for inferred completion — the parent emitted a
      // `result` and moved on, but we never received a direct closure
      // carrier (task_notification SystemMessage or
      // queue-operation/attachment XML). The work is done, but we lack
      // the summary/usage data the carriers would have provided. The
      // dashed-ring variant makes this visible at a glance vs the solid
      // CheckCircle2 used for verified completions.
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

  // Ticks only while this agent runs; a finished row holds still.
  const nowMs = useSecondTick(sub.status === 'running');
  const stats = subagentRunStats(sub, costs, nowMs);

  // Prefer the authoritative end-of-run totals (merged from disk via
  // applySubagentMeta) over the live `latest.*` running tally, which can lag
  // the final numbers.
  const tokenCount = sub.finalTotalTokens ?? latest?.totalTokens;
  const toolCount = sub.finalToolUseCount ?? latest?.toolUses;
  const model = formatModel(sub.model);
  // Only rendered when the subagent reports its own effort — most runs
  // inherit the session default and carry none, and a placeholder there
  // would be noise on every row.
  const effort = sub.effort ? `${sub.effort} effort` : '';
  // The CLI's token tally only when the transcript gave us no context figure.
  const tokens = stats.contextTokens === undefined && tokenCount ? `${kTokens(tokenCount)} tok` : '';
  const tools = toolCount ? `${toolCount} tools` : '';
  const metaBits = [model, effort, tools, tokens].filter(Boolean).join(' · ');
  // Context, cost and time, read off the agent's own transcript. Cost is
  // `≈`: on a subscription account it is what the tokens would cost at API
  // rates, and it lags the final totals by up to a poll.
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

  // How far through its work the agent says it is — only while it runs. Once
  // it ends, the state (done, failed) is the truer answer than its last guess.
  const step = barState === 'running' ? sub.stepProgress : undefined;
  const stepLabel = step
    ? `${step.done}/${step.total}${step.note ? ` · ${step.note}` : ''}`
    : null;

  // The purpose is what the parent said the agent is for; it holds still.
  // What it is doing right now is in the expanded log, not under it: that
  // line carries the run stats.
  const purpose = sub.description || latest?.description || 'Working…';
  const agentLabel = sub.agentType ?? 'Agent';

  // A nested subagent (dispatched by another subagent, not by the main
  // session) is indented under its parent. It shares the parent's colour, so
  // the indent is what distinguishes it from a sibling.
  const nested = !!sub.parentToolUseId;

  // Foreground or background, as the dispatch, the CLI's launch ACK or a
  // later `is_backgrounded` patch last set it. Nested rows are synthesised
  // from the sidecar and carry no flag — no tag beats a guessed one.
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
        // Row divider. The colour has to be an important arbitrary property:
        // styles.css's unlayered `* { border-color }` beats every plain
        // Tailwind border-colour utility.
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
        {/* Top-aligned so a purpose that wraps keeps the icons on its first line. */}
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
        {stepLabel && (
          <span data-subagent-step className="block pl-6 pt-0.5 text-[11px] text-foreground/80 truncate tabular-nums">
            {stepLabel}
          </span>
        )}
        {/* How far along the agent says it is, when it reports its steps
            through the bundled mod's progress tool; otherwise the run's state.
            It used to fill to context %, which on a 1M-window model sat at
            2–3% for the whole run. */}
        <span
          data-subagent-bar
          data-state={barState}
          data-progress={step ? `${step.done}/${step.total}` : undefined}
          className="mt-1 ml-6 block h-0.5 rounded-full bg-white/10 overflow-hidden"
        >
          <span
            style={step ? { width: `${Math.round((step.done / step.total) * 100)}%` } : undefined}
            className={cn(
              'block h-full rounded-full',
              step ? cn('transition-[width] duration-500', color.dot)
                : barState === 'running' ? cn('brain-indeterminate-bar w-1/3', color.dot) : 'w-full',
              barState === 'done' && 'bg-emerald-400',
              barState === 'inferred' && cn(color.dot, 'opacity-60'),
              barState === 'failed' && 'bg-destructive',
              barState === 'abandoned' && 'bg-muted-foreground/40',
            )}
          />
        </span>
      </button>

      {expanded && (
        <div className="px-3 pb-2 pt-0.5 border-t border-white/5 space-y-0.5">
          {sub.prompt && (
            <pre
              data-subagent-prompt
              className="mb-1 max-h-48 overflow-y-auto rounded bg-black/20 px-2 py-1 text-[11px] font-sans leading-snug whitespace-pre-wrap break-words text-foreground/80"
            >
              {sub.prompt}
            </pre>
          )}
          {sub.events.length === 0 && (
            <div className="text-[11px] text-muted-foreground italic py-1">
              {sub.status === 'completed_inferred'
                ? 'Completed (no progress reported)'
                : 'Waiting for first progress event…'}
            </div>
          )}
          {sub.events.map((ev, i) => {
            const bits = [
              ev.lastToolName,
              ev.toolUses ? `${ev.toolUses} tools` : '',
              ev.totalTokens ? `${Math.round(ev.totalTokens / 1000)}k tok` : '',
              formatElapsed(ev.durationMs),
            ].filter(Boolean).join(' · ');
            return (
              <div key={i} className="flex items-start gap-2 text-[11px] font-mono leading-snug">
                <span className={cn('mt-[5px] h-1 w-1 rounded-full shrink-0', color.dot)} />
                <span className="flex-1 text-foreground/80 break-words">{ev.description || '…'}</span>
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

/** How often an open, running shell row re-reads its output. */
const SHELL_POLL_MS = 2000;

/**
 * The open row's output tail. Reads only while the row is open: once on
 * open, then every SHELL_POLL_MS while the shell runs. A read that comes back
 * null (task evicted, session gone) keeps the last output rather than
 * blanking it.
 */
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
}

export const ShellRow: React.FC<ShellRowProps> = ({ shell, read, onDismiss }) => {
  const [expanded, setExpanded] = useState(false);
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

      {expanded && (
        <div className="px-3 pb-2 pt-0.5 border-t border-white/5">
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
                <pre className="text-[11px] font-mono leading-snug whitespace-pre-wrap break-words text-foreground/80 max-h-64 overflow-y-auto">
                  {text}
                </pre>
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
