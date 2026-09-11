import { cn } from '@/lib/utils';
import { useSecondTick } from '@/hooks/useSecondTick';
import type { SessionActivity } from '@/lib/signals/emitters';
import type { SessionSignal } from '@/lib/signals/types';

export interface ActivityPillProps {
  /** The `session.activity` state signal, or undefined before one exists. */
  signal: SessionSignal | undefined;
  className?: string;
}

/** Elapsed as `12s` / `4m 20s` — a pill, so no decimals and no hours-first. */
function elapsedLabel(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  if (minutes < 60) return `${minutes}m ${totalSeconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

/** Coarse countdown to a usage-limit reset. Minutes are enough for a pill. */
function resetLabel(resetsAtSeconds: number, nowMs: number): string {
  const remainingMs = resetsAtSeconds * 1000 - nowMs;
  if (remainingMs <= 0) return 'any moment';
  const minutes = Math.floor(remainingMs / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

/**
 * What the session is *doing*, as a second pill under the session-status one.
 *
 * Deliberately not merged with the status pill above it. That one reports
 * `sessionStatus` — is the CLI process up — which the main process owns and
 * docs/session-lifecycle.md forbids the renderer from keeping a second copy of.
 * This reports the orthogonal axis. Two pills that each answer one question beat
 * one pill that blurs two.
 *
 * The accent is a tint only, never a colour change: this ticks every second
 * while a turn runs, and a pill that changed hue on a one-second cadence next
 * to a status pill that means something else would read as an alarm.
 */
export function ActivityPill({ signal, className }: ActivityPillProps) {
  const meta = signal?.meta as
    | { status?: SessionActivity; startedAt?: number | null; thinkingTokens?: number | null; resetsAt?: number | null }
    | undefined;
  const status = meta?.status;

  // Only subscribe to the clock when something is actually counting.
  const ticking = status === 'thinking' || status === 'usage-limit';
  const nowMs = useSecondTick(ticking);

  if (!status || status === 'idle' || status === 'stopped') {
    // `idle` and `stopped` are already legible from the status pill above and
    // the composer's own state; a second pill saying so is noise.
    return null;
  }

  let label: string;
  let title: string;

  if (status === 'thinking') {
    const elapsed = meta?.startedAt != null ? elapsedLabel(nowMs - meta.startedAt) : null;
    label = elapsed ? `thinking ${elapsed}` : 'thinking';
    title =
      meta?.thinkingTokens != null
        ? `~${meta.thinkingTokens.toLocaleString()} thinking tokens`
        : 'Extended thinking in progress';
  } else if (status === 'usage-limit') {
    label = meta?.resetsAt != null ? `limit · ${resetLabel(meta.resetsAt, nowMs)}` : 'usage limit';
    title = 'Waiting for the usage limit to reset — the CLI still owns this turn';
  } else {
    label = 'working';
    title = 'A turn is in flight';
  }

  return (
    <span
      title={title}
      className={cn(
        'inline-flex items-center gap-1 rounded px-1.5 py-0.5',
        'text-[10px] font-medium lowercase tracking-wide tabular-nums',
        'bg-primary/10 text-primary/90',
        status === 'thinking' && 'animate-pulse',
        className,
      )}
    >
      {label}
    </span>
  );
}
