import * as React from 'react';
import { ReadoutLabel } from '@/components/ui/readout-label';
import { fireAndLog } from '@/lib/fireAndLog';
import { Clock, Brain, Wifi, WifiLow, WifiOff, Pencil, Sparkles } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useSecondTick } from '@/hooks/useSecondTick';
import { formatToolElapsed } from '@/components/claude/tools/ToolProgressChip';
import { CacheTimerRow } from '@/components/CacheTimerRow';
import { InlineDivider } from '@/components/ui/inline-divider';
import { Popover } from '@/components/ui/popover';
import { AgentsStatusItem, ShellsStatusItem, type BackgroundWork } from '@/components/BackgroundWorkItems';
import { DaemonStatusItem } from '@/components/DaemonStatusItem';
import type { SessionActivity } from '@/lib/signals/emitters';
import type { SessionSignal } from '@/lib/signals/types';

// Not `formatTokens`: it rounds to whole thousands, and a thinking burst needs the decimal.
function formatThinkingTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

type ConnectionState = 'connected' | 'connecting' | 'reconnecting' | 'disconnected';

export interface LinkState {
  connection: ConnectionState | null;
  delivering: boolean;
}

// The socket is per client but delivery is per subscription: a healthy socket can still carry nothing for this session.
export function LinkGlyph({ connection, delivering }: LinkState): React.JSX.Element | null {
  if (connection === null) return null;

  if (connection !== 'connected') {
    const reconnecting = connection === 'reconnecting' || connection === 'connecting';
    return (
      <span
        aria-label={reconnecting ? 'reconnecting to daemon' : 'disconnected from daemon'}
        title={
          reconnecting
            ? 'Reconnecting to the daemon. Nothing is being delivered right now.'
            : 'Not connected to the daemon. This session is not receiving anything.'
        }
        className={cn(
          'inline-flex items-center gap-1',
          reconnecting ? 'text-amber-500 animate-pulse' : 'text-red-500',
        )}
      >
        <WifiOff className="h-3.5 w-3.5" />
        <ReadoutLabel>daemon</ReadoutLabel>
        <span>{reconnecting ? 'reconnecting' : 'offline'}</span>
      </span>
    );
  }

  if (!delivering) {
    return (
      <span
        aria-label="connected, session not receiving"
        title={
          'Connected to the daemon, but it is not sending this session’s events — '
          + 'nothing new will appear here. Reloading the window re-subscribes.'
        }
        className="inline-flex items-center gap-1 text-amber-500"
      >
        <WifiLow className="h-3.5 w-3.5" />
        <ReadoutLabel>daemon</ReadoutLabel>
        <span>no events</span>
      </span>
    );
  }

  return (
    <span
      aria-label="connected"
      title="Connected to the daemon, and receiving this session’s events."
      className="inline-flex items-center gap-1 text-emerald-400"
    >
      <Wifi className="h-3.5 w-3.5" />
      <ReadoutLabel>daemon</ReadoutLabel>
      <span>live</span>
    </span>
  );
}

// Show "Untitled" and the pencil even with no name: resumed sessions arrive untitled.
function SessionTitle({
  title,
  canRename,
  onRename,
  onSuggest,
}: {
  title: string | null;
  canRename: boolean;
  onRename: (title: string) => Promise<boolean> | boolean;
  onSuggest?: () => Promise<string | null>;
}): React.JSX.Element {
  const [open, setOpen] = React.useState(false);
  const [draft, setDraft] = React.useState('');
  const [failed, setFailed] = React.useState(false);
  const [suggesting, setSuggesting] = React.useState(false);
  const [noSuggestion, setNoSuggestion] = React.useState(false);

  const openEditor = (next: boolean): void => {
    if (next && !canRename) return;
    if (next) {
      setDraft(title ?? '');
      setFailed(false);
      setNoSuggestion(false);
    }
    setOpen(next);
  };

  // Writes nothing: the proposal lands in the field; only Save sends it.
  const suggest = async (): Promise<void> => {
    if (!onSuggest || suggesting) return;
    setSuggesting(true);
    setNoSuggestion(false);
    try {
      const proposed = await onSuggest();
      if (proposed) setDraft(proposed);
      else setNoSuggestion(true);
    } finally {
      setSuggesting(false);
    }
  };

  const submit = async (e: React.SubmitEvent): Promise<void> => {
    e.preventDefault();
    // A blank custom title clears the CLI's rename; never send one.
    const next = draft.trim();
    if (!next) return;
    const ok = await onRename(next);
    if (ok) setOpen(false);
    else setFailed(true);
  };

  return (
    // No `min-w-0`: the name must wrap its own text, never be clipped.
    <div className="flex items-center gap-1.5">
      <span
        data-testid="session-title"
        title={title ?? 'This session has no name yet'}
        className="inline-flex items-center gap-1 text-muted-foreground"
      >
        <ReadoutLabel>name</ReadoutLabel>
        <span
          className={cn(
            'break-words',
            title ? 'text-foreground/80' : 'text-muted-foreground/60 italic',
          )}
        >
          {title ?? 'Untitled'}
        </span>
      </span>
      <Popover
        open={open}
        onOpenChange={openEditor}
        align="start"
        side="bottom"
        className="p-2"
        trigger={
          <button
            type="button"
            aria-label="Rename session"
            disabled={!canRename}
            title={
              canRename
                ? 'Rename this session'
                : 'Renaming needs a running session — the CLI takes the rename over its control channel'
            }
            className={cn(
              'flex-none inline-flex items-center rounded p-0.5 text-muted-foreground',
              canRename
                ? 'hover:text-foreground hover:bg-muted/60'
                : 'opacity-40 cursor-not-allowed',
            )}
          >
            <Pencil className="h-3 w-3" aria-hidden="true" />
          </button>
        }
        content={
          <form data-testid="rename-form" onSubmit={fireAndLog('chat-status-bar:rename-submit', submit)} className="flex flex-col gap-2 w-64">
            <label htmlFor="session-rename-input" className="text-[10px] uppercase tracking-wide text-muted-foreground">
              Session name
            </label>
            <div className="flex items-center gap-1.5">
              <input
                id="session-rename-input"
                autoFocus
                value={draft}
                onChange={(e) => { setDraft(e.target.value); }}
                className="min-w-0 flex-1 rounded border border-border bg-background px-2 py-1 text-xs font-sans"
                placeholder="Name this session"
              />
              {onSuggest && (
                <button
                  type="button"
                  aria-label="Suggest a name"
                  title="Ask the CLI to suggest a name from the first prompt. Nothing is saved until you press Save."
                  disabled={suggesting}
                  onClick={() => { void suggest(); }}
                  className="flex-none inline-flex items-center gap-1 rounded border border-border px-1.5 py-1 text-[10px] text-muted-foreground hover:text-foreground hover:bg-muted/60 disabled:opacity-40"
                >
                  <Sparkles className={cn('h-3 w-3', suggesting && 'animate-pulse')} aria-hidden="true" />
                  Suggest
                </button>
              )}
            </div>
            {failed && (
              <span className="text-[10px] text-red-400">
                The rename didn’t reach the session.
              </span>
            )}
            {noSuggestion && (
              <span className="text-[10px] text-muted-foreground">
                No suggestion came back.
              </span>
            )}
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => { setOpen(false); }}
                className="rounded px-2 py-1 text-xs text-muted-foreground hover:text-foreground"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={!draft.trim()}
                className="rounded bg-primary px-2 py-1 text-xs text-primary-foreground disabled:opacity-40"
              >
                Save
              </button>
            </div>
          </form>
        }
      />
    </div>
  );
}

interface ActivityMeta {
  status?: SessionActivity;
  thinkingTokens?: number | null;
  turnStartedAt?: number | null;
  lastTurnMs?: number | null;
  turnThinkingTokens?: number | null;
}

export interface ChatStatusBarProps {
  link: LinkState;
  title?: string | null;
  canRename?: boolean;
  onRename?: (title: string) => Promise<boolean> | boolean;
  onSuggest?: () => Promise<string | null>;
  activitySignal?: SessionSignal;
  cacheAnchorMs: number | null;
  cacheTtlMs: number | null;
  controls?: React.ReactNode;
  account?: React.ReactNode;
  session?: React.ReactNode;
  background?: BackgroundWork;
  className?: string;
}

export const STATUS_BAR_SURFACE = cn(
  'flex flex-wrap items-center gap-x-2 gap-y-1 px-3 py-1 rounded-md border-0 bg-background/60',
  'shadow-[0_0_0_1px_color-mix(in_oklch,var(--color-muted-foreground)_30%,transparent)]',
  'text-[10px] font-mono tabular-nums',
);

export function ChatStatusBar({
  link,
  title = null,
  canRename = false,
  onRename,
  onSuggest,
  activitySignal,
  cacheAnchorMs,
  cacheTtlMs,
  controls,
  account,
  session,
  background,
  className,
}: ChatStatusBarProps): React.JSX.Element {
  const meta = activitySignal?.meta as ActivityMeta | undefined;
  const status = meta?.status;

  const turnStartedAt = meta?.turnStartedAt ?? null;
  const running = turnStartedAt !== null;

  const nowMs = useSecondTick(running);

  const elapsedMs = running
    ? Math.max(0, nowMs - turnStartedAt)
    : (meta?.lastTurnMs ?? null);

  const thinkingTokens = meta?.turnThinkingTokens ?? meta?.thinkingTokens ?? null;
  const thinkingLive = status === 'thinking';

  // Must match `CacheTimerRow`'s own hide condition, or a divider renders with nothing after it.
  const showCache = cacheAnchorMs !== null && cacheTtlMs !== null;

  const items: React.JSX.Element[] = [];

  if (controls) {
    items.push(<React.Fragment key="controls">{controls}</React.Fragment>);
  }

  if (link.connection !== null) {
    items.push(<DaemonStatusItem key="link" link={link} />);
  }

  if (elapsedMs !== null) {
    items.push(
      <span
        key="turn"
        aria-label={running ? 'working' : 'working — last round'}
        title={running ? 'A turn is in flight' : 'How long the previous turn took'}
        className={cn(
          // Sky, not emerald: the daemon glyph beside it owns emerald.
          'inline-flex items-center gap-1 text-sky-400',
          running && 'animate-pulse',
        )}
      >
        <Clock className="h-3.5 w-3.5" />
        <ReadoutLabel>turn</ReadoutLabel>
        <span>{formatToolElapsed(elapsedMs / 1000)}</span>
      </span>,
    );
  }

  if (thinkingTokens !== null) {
    items.push(
      <span
        key="thinking"
        aria-label={thinkingLive ? 'thinking' : 'thought — last turn'}
        title={
          thinkingLive
            ? 'Extended thinking in progress'
            : "Thinking tokens across the previous turn"
        }
        className={cn(
          'inline-flex items-center gap-1 text-violet-400',
          thinkingLive && 'animate-pulse',
        )}
      >
        <Brain className="h-3.5 w-3.5" />
        <ReadoutLabel>{thinkingLive ? 'thinking' : 'thought'}</ReadoutLabel>
        <span>{formatThinkingTokens(thinkingTokens)} tokens</span>
      </span>,
    );
  }

  if (background && background.subagents.length > 0) {
    items.push(
      <AgentsStatusItem
        key="agents"
        subagents={background.subagents}
        costs={background.subagentCost}
        onDismiss={background.onDismissSubagent}
        onDismissAllCompleted={background.onDismissAllCompletedSubagents}
        onStop={background.stopTask}
        onBackground={background.backgroundTask}
      />,
    );
  }

  if (background && background.shells.length > 0) {
    items.push(
      <ShellsStatusItem
        key="shells"
        shells={background.shells}
        readShellOutput={background.readShellOutput}
        onDismiss={background.onDismissShell}
        onDismissAllEnded={background.onDismissAllEndedShells}
        onStop={background.stopTask}
      />,
    );
  }

  if (showCache) {
    items.push(
      <CacheTimerRow
        key="cache"
        anchorMs={cacheAnchorMs}
        ttlMs={cacheTtlMs}
        className="px-0"
      />,
    );
  }

  if (session) {
    items.push(<React.Fragment key="session">{session}</React.Fragment>);
  }

  return (
    <div
      data-testid="chat-status-frame"
      className={cn('shrink-0 bg-muted px-[8px] py-[4px]', className)}
    >
      <div
        data-testid="chat-status-bar"
        role="status"
        aria-label="Session status"
        className={cn(
          // A shadow ring, not a border: the unlayered `* { border-color }` in styles.css overrides border-color utilities.
          STATUS_BAR_SURFACE,
          'flex-col flex-nowrap items-stretch',
        )}
      >
        <div data-testid="chat-status-head" className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <SessionTitle
            title={title}
            canRename={canRename && !!onRename}
            onRename={onRename ?? (() => false)}
            onSuggest={canRename ? onSuggest : undefined}
          />
          {account && (
            <div data-testid="chat-status-account" className="ml-auto flex items-center">
              {account}
            </div>
          )}
        </div>
        {items.length > 0 && (
          <div
            data-testid="chat-status-items"
            className="ml-auto flex flex-wrap items-center justify-end gap-x-2 gap-y-1"
          >
            {items.map((item, i) => (
              // Divider and readout are one flex item so a wrap never strands a hairline.
              <span key={item.key} className="inline-flex flex-wrap items-center gap-x-2 gap-y-1">
                {i > 0 && <InlineDivider data-testid="status-divider" />}
                {item}
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
