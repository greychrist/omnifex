import * as React from 'react';
import { Clock, Brain, Wifi, WifiLow, WifiOff, Pencil, Sparkles } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useSecondTick } from '@/hooks/useSecondTick';
import { formatToolElapsed } from '@/components/claude/tools/ToolProgressChip';
import { CacheTimerRow } from '@/components/CacheTimerRow';
import { InlineDivider } from '@/components/ui/inline-divider';
import { Popover } from '@/components/ui/popover';
import type { SessionActivity } from '@/lib/signals/emitters';
import type { SessionSignal } from '@/lib/signals/types';

/**
 * `12.4k`, matching the context gauge in the session widget.
 *
 * Not `formatTokens` from contextPressure: that rounds to the nearest
 * thousand, so a 12,400-token burst and a 12,000-token one both read `12k`.
 * At the scale a single thinking burst lives at, the decimal is the signal.
 */
function formatThinkingTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

type ConnectionState = 'connected' | 'connecting' | 'reconnecting' | 'disconnected';

export interface LinkState {
  /** Socket state, or null when this page has no daemon at all (legacy IPC). */
  connection: ConnectionState | null;
  /** Whether the daemon is actually delivering THIS session's events. */
  delivering: boolean;
}

/**
 * The daemon link: the subject named, then its state — `daemon live`,
 * `daemon no events`, `daemon reconnecting`, `daemon offline`. Same
 * label-then-value shape as `turn 12s` and `thinking 12.4k` beside it, so a
 * wifi icon is not left carrying the whole meaning on its own.
 *
 * Two facts, deliberately not collapsed into one. The socket is global — one
 * per client — but the daemon fans a session out only to clients that
 * subscribed to it, so "connected" and "this session is reaching me" can
 * disagree. They did: a restored tab sat on a healthy socket with no
 * subscription, and every answer went to an empty subscriber set. A green
 * link alone would have been reassuring and wrong, which is why the middle
 * state below exists at all.
 */
export function LinkGlyph({ connection, delivering }: LinkState): React.JSX.Element | null {
  // No daemon on this page: nothing to report, so report nothing rather than
  // showing a permanent "disconnected" for a mode that never connects.
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
        <span className="opacity-70">daemon</span>
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
        <span className="opacity-70">daemon</span>
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
      <span className="opacity-70">daemon</span>
      <span>live</span>
    </span>
  );
}

/**
 * The session's name, and the pencil that changes it.
 *
 * The name comes from the transcript — the CLI's own `ai-title`, or a
 * `custom-title` if the session was renamed (see `deriveSessionTitle`) — and
 * the pencil sends the CLI's own `rename_session` control request, which is
 * what writes that `custom-title` record. So the bar is not displaying a
 * name OmniFex invented and keeps in sync; it is displaying the CLI's name
 * for the session, and renaming through the CLI's own door.
 *
 * "Untitled" is shown rather than nothing because untitled is the COMMON
 * case, not an edge one: the CLI only titles a fresh conversation, so every
 * resumed session and everything older than CLI 2.1.268 arrives with no name
 * at all. Those are exactly the sessions worth naming, so the affordance
 * cannot be hidden behind already having a name.
 */
function SessionTitle({
  title,
  canRename,
  onRename,
  onSuggest,
}: {
  title: string | null;
  canRename: boolean;
  onRename: (title: string) => Promise<boolean> | boolean;
  /** Ask the CLI for a name; resolves null when it has none. Absent when
   *  there is nothing to suggest from (no prompt yet, no live session). */
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

  // On demand, and it writes nothing: the proposal lands in the field, and
  // only Save sends it — through the same rename the user could have typed.
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

  const submit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    // A blank custom title is how the CLI CLEARS a rename — never what
    // pressing Save on an empty field meant.
    const next = draft.trim();
    if (!next) return;
    const ok = await onRename(next);
    if (ok) setOpen(false);
    else setFailed(true);
  };

  return (
    // No `min-w-0`, unlike every other item on the bar: that is what lets a
    // flex line shrink a child below its content, and the name is the one
    // readout that must not give up room — `turn 12s` survives being read as
    // a glyph and a number, a clipped name does not. Left shrinkable only to
    // its min-content width, so a name too long for the whole bar wraps its
    // own text instead of being cut.
    <div className="flex items-center gap-1.5">
      <span
        data-testid="session-title"
        title={title ?? 'This session has no name yet'}
        // One more readout, not a heading over them: the same `label value`
        // shape as `turn 12s` and `cache 3m left (1h)` beside it, and the
        // row's own 10px mono rather than a size and typeface of its own.
        //
        // It was `text-sm font-sans` before, on the reasoning that a name is
        // prose while the bar's mono exists to stop counting numbers from
        // jittering. True of the type, but it made the name the only thing on
        // the bar wearing both its own size and its own family, which read as
        // a title bolted on rather than a field in the set.
        //
        // No glyph, though, where the others all have one: a letter icon was
        // tried and cut. Their glyphs stand in for a quantity you scan for,
        // while the name is already the longest text here and a mark in front
        // of it only crowded the left edge.
        className="inline-flex items-center gap-1 text-muted-foreground"
      >
        <span className="opacity-70">name</span>
        <span
          className={cn(
            // `break-words`, not `truncate`: the bar wraps now, so the name
            // has a second line to grow into and an ellipsis buys nothing.
            // The break only ever fires on an unbroken token wider than the
            // bar itself.
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
          <form data-testid="rename-form" onSubmit={submit} className="flex flex-col gap-2 w-64">
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
  /** The session's name, resolved by `deriveSessionTitle`. Null = untitled. */
  title?: string | null;
  /** Whether a rename can actually be sent (a live session). */
  canRename?: boolean;
  /** Sends the rename; resolves false when it did not reach the CLI. */
  onRename?: (title: string) => Promise<boolean> | boolean;
  /** Asks the CLI for a name (nothing persisted). Omit when there is no
   *  prompt to suggest from. */
  onSuggest?: () => Promise<string | null>;
  /** The `session.activity` state signal, or undefined before one exists. */
  activitySignal?: SessionSignal;
  /** Last assistant turn's timestamp — when the cache TTL last restarted. */
  cacheAnchorMs: number | null;
  /** TTL the CLI actually used, observed from usage.cache_creation. */
  cacheTtlMs: number | null;
  /** True while a main turn is in flight. */
  cacheBusy: boolean;
  /** The session's live controls (model / effort / permissions) as readouts
   *  that open pickers — `SessionControlPickers`. Seated before the state
   *  readouts: what you can change, then what is happening. */
  controls?: React.ReactNode;
  className?: string;
}

/**
 * The strip above the transcript: the facts you want visible while reading,
 * regardless of where the session widget is scrolled to or whether it is
 * open at all.
 *
 * Turn time and thinking tokens used to live in the session widget's bottom
 * row and the cache countdown beside them; all three are about the
 * conversation you are looking at, not about the widget, so they belong over
 * the conversation. The widget keeps what is genuinely about the session as a
 * whole — the context gauge, the agent count, the activity pill.
 *
 * Both readouts hold the PREVIOUS round's value while idle. That is the
 * point: how long the turn took, and how much it thought, are most worth
 * reading in the moment just after the turn that produced them ends.
 */
export function ChatStatusBar({
  link,
  title = null,
  canRename = false,
  onRename,
  onSuggest,
  activitySignal,
  cacheAnchorMs,
  cacheTtlMs,
  cacheBusy,
  controls,
  className,
}: ChatStatusBarProps): React.JSX.Element {
  const meta = activitySignal?.meta as ActivityMeta | undefined;
  const status = meta?.status;

  const turnStartedAt = meta?.turnStartedAt ?? null;
  const running = turnStartedAt !== null;

  // Only subscribe to the shared clock while a turn is actually counting.
  const nowMs = useSecondTick(running);

  const elapsedMs = running
    ? Math.max(0, nowMs - turnStartedAt)
    : (meta?.lastTurnMs ?? null);

  // The turn's tally wins: it already counts the open burst, plus every burst
  // before it since the prompt. The live burst alone is only a fallback.
  const thinkingTokens = meta?.turnThinkingTokens ?? meta?.thinkingTokens ?? null;
  const thinkingLive = status === 'thinking';

  // `CacheTimerRow` hides itself when it has nothing to count; the same
  // condition has to be known HERE too, or the row renders a divider with
  // nothing after it.
  const showCache = cacheAnchorMs !== null && cacheTtlMs !== null;

  // Built as a list so dividers land strictly BETWEEN what is actually on
  // screen. Every readout is conditional, so hard-coding separators into the
  // markup puts a stray hairline at either end of a half-empty bar.
  const items: React.JSX.Element[] = [];

  if (controls) {
    items.push(<React.Fragment key="controls">{controls}</React.Fragment>);
  }

  if (link.connection !== null) {
    items.push(<LinkGlyph key="link" {...link} />);
  }

  if (elapsedMs !== null) {
    items.push(
      <span
        key="turn"
        aria-label={running ? 'working' : 'working — last round'}
        title={running ? 'A turn is in flight' : 'How long the previous turn took'}
        className={cn(
          // Sky, not emerald: the daemon glyph owns emerald and the two sit
          // side by side.
          'inline-flex items-center gap-1 text-sky-400',
          running && 'animate-pulse',
        )}
      >
        <Clock className="h-3.5 w-3.5" />
        <span className="opacity-70">turn</span>
        <span>{formatToolElapsed(elapsedMs / 1000)}</span>
      </span>,
    );
  }

  if (thinkingTokens !== null) {
    items.push(
      <span
        key="thinking"
        // Past tense once the burst is over: the number is what it DID think,
        // not what it is thinking.
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
        <span className="opacity-70">{thinkingLive ? 'thinking' : 'thought'}</span>
        <span>{formatThinkingTokens(thinkingTokens)} tokens</span>
      </span>,
    );
  }

  if (showCache) {
    // Already labelled by its own copy ("cache 3m left (1h)").
    items.push(
      <CacheTimerRow
        key="cache"
        anchorMs={cacheAnchorMs}
        ttlMs={cacheTtlMs}
        busy={cacheBusy}
        className="px-0"
      />,
    );
  }

  return (
    // The frame, not the bar. It carries the session header's own `bg-muted`,
    // so the material showing around the bar is header material and the bar
    // reads as a field SET INTO the header — the same relationship a chat
    // composer has with the bar it sits in.
    //
    // 8px horizontal against 4px vertical, deliberately uneven. The bar runs
    // the full width of the header, so its side margins are the only ones
    // read as margins; the vertical gaps are read as the seam between the bar
    // and what it is seated in, and widening those would unseat it.
    //
    // AgentSession renders this INSIDE the header assembly, below the header
    // row and above the assembly's border and resize handle. That placement is
    // the other half of the effect: the bar is within the header's edge rather
    // than the first thing beneath it.
    <div
      data-testid="chat-status-frame"
      className={cn('shrink-0 bg-muted px-[8px] py-[4px]', className)}
    >
      <div
        data-testid="chat-status-bar"
        role="status"
        aria-label="Session status"
        className={cn(
          // The same ring the account, branch and session widgets above it
          // wear (AccountCard.tsx:130, SessionCard.tsx:176), so the header
          // reads as one family of controls.
          //
          // A `shadow` ring rather than a border, with `border-0` beside it:
          // styles.css declares an unlayered
          // `* { border-color: var(--color-border) }` that outranks every
          // Tailwind border-color utility, so a real border cannot carry this
          // colour — it would come back at full `--color-border` strength.
          // Wraps rather than compressing: three pickers, the daemon glyph,
          // the turn clock, the thinking burst and the cache countdown do not
          // fit beside a name in a narrow window, and the readouts have no
          // spare width to surrender — each is already a label and a value.
          // The row gap is half the column gap so a wrapped line reads as a
          // continuation of the same bar, not as a second bar under it.
          'flex flex-wrap items-center gap-x-2 gap-y-1 px-3 py-1 rounded-md border-0 bg-background/60',
          'shadow-[0_0_0_1px_color-mix(in_oklch,var(--color-muted-foreground)_30%,transparent)]',
          'text-[10px] font-mono tabular-nums',
        )}
      >
        <SessionTitle
          title={title}
          canRename={canRename && !!onRename}
          onRename={onRename ?? (() => false)}
          onSuggest={canRename ? onSuggest : undefined}
        />
        {/* The readouts group right, so the bar reads name-then-state and the
            name keeps a stable left edge as readouts come and go mid-turn.
            `flex-wrap` here as well as on the bar: the group wraps to the
            next line as a block when the name leaves it no room, and its own
            readouts wrap among themselves when even a full line is too
            narrow. */}
        <div
          data-testid="chat-status-items"
          className="ml-auto flex flex-wrap items-center justify-end gap-x-2 gap-y-1"
        >
          {items.map((item, i) => (
            // Divider and the readout it introduces travel as one flex item,
            // so a wrap never strands a hairline at the end of a line with
            // nothing after it.
            // `flex-wrap` on the pair too: `controls` is a fragment of three
            // pickers and two dividers, so this span is where they would
            // otherwise be pinned to one line — the widest item on the bar.
            <span key={item.key} className="inline-flex flex-wrap items-center gap-x-2 gap-y-1">
              {i > 0 && <InlineDivider data-testid="status-divider" />}
              {item}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}
