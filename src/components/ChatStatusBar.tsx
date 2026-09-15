import * as React from 'react';
import { ServerCog, Brain, Wifi, WifiLow, WifiOff } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useSecondTick } from '@/hooks/useSecondTick';
import { formatToolElapsed } from '@/components/claude/tools/ToolProgressChip';
import { CacheTimerRow } from '@/components/CacheTimerRow';
import { InlineDivider } from '@/components/ui/inline-divider';
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

interface ActivityMeta {
  status?: SessionActivity;
  thinkingTokens?: number | null;
  turnStartedAt?: number | null;
  lastTurnMs?: number | null;
  lastThinkingTokens?: number | null;
}

export interface ChatStatusBarProps {
  link: LinkState;
  /** The `session.activity` state signal, or undefined before one exists. */
  activitySignal?: SessionSignal;
  /** Last assistant turn's timestamp — when the cache TTL last restarted. */
  cacheAnchorMs: number | null;
  /** TTL the CLI actually used, observed from usage.cache_creation. */
  cacheTtlMs: number | null;
  /** True while a main turn is in flight. */
  cacheBusy: boolean;
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
  activitySignal,
  cacheAnchorMs,
  cacheTtlMs,
  cacheBusy,
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

  // The live burst total wins over the frozen one: mid-burst, the frozen value
  // is the PREVIOUS burst and showing it would be stale by a whole round.
  const thinkingTokens = meta?.thinkingTokens ?? meta?.lastThinkingTokens ?? null;
  const thinkingLive = status === 'thinking';

  // `CacheTimerRow` hides itself when it has nothing to count; the same
  // condition has to be known HERE too, or the row renders a divider with
  // nothing after it.
  const showCache = cacheAnchorMs !== null && cacheTtlMs !== null;

  // Built as a list so dividers land strictly BETWEEN what is actually on
  // screen. Every readout is conditional, so hard-coding separators into the
  // markup puts a stray hairline at either end of a half-empty bar.
  const items: React.JSX.Element[] = [];

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
          'inline-flex items-center gap-1 text-emerald-400',
          running && 'animate-pulse',
        )}
      >
        <ServerCog className="h-3.5 w-3.5" />
        <span className="opacity-70">turn</span>
        <span>{formatToolElapsed(elapsedMs / 1000)}</span>
      </span>,
    );
  }

  if (thinkingTokens !== null) {
    items.push(
      <span
        key="thinking"
        aria-label={thinkingLive ? 'thinking' : 'thinking — last burst'}
        title={
          thinkingLive
            ? 'Extended thinking in progress'
            : "The previous turn's thinking burst"
        }
        className={cn(
          'inline-flex items-center gap-1 text-violet-400',
          thinkingLive && 'animate-pulse',
        )}
      >
        <Brain className="h-3.5 w-3.5" />
        <span className="opacity-70">thinking</span>
        <span>{formatThinkingTokens(thinkingTokens)}</span>
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
    <div
      data-testid="chat-status-bar"
      role="status"
      aria-label="Session status"
      className={cn(
        'shrink-0 flex items-center gap-2 px-3 py-1 border-b bg-background/60',
        'text-[10px] font-mono tabular-nums',
        className,
      )}
    >
      {items.map((item, i) => (
        <React.Fragment key={item.key}>
          {i > 0 && <InlineDivider data-testid="status-divider" />}
          {item}
        </React.Fragment>
      ))}
    </div>
  );
}
