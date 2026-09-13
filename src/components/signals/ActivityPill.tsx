import { cn } from '@/lib/utils';
import { useSecondTick } from '@/hooks/useSecondTick';
import type { SessionActivity } from '@/lib/signals/emitters';
import type { SessionSignal } from '@/lib/signals/types';

export interface ActivityPillProps {
  /** The `session.activity` state signal, or undefined before one exists. */
  signal: SessionSignal | undefined;
  className?: string;
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
 * The usage-limit notice, as a pill beside the session-status one.
 *
 * This used to carry `active` and `thinking` too. Those became glyphs in
 * SessionStatusBar: each is a METRIC (how long, how many tokens) and reads
 * better as an icon with a number than as a word. A usage limit is not a
 * metric — it is the session blocked on something outside it, with a countdown
 * to when that ends — and shrinking it to an icon would have made the one
 * genuinely alarming state the quietest thing on the row.
 *
 * Still deliberately not merged with the session-status pill above it. That
 * one reports `sessionStatus` — is the CLI process up — which the main process
 * owns and docs/session-lifecycle.md forbids the renderer from keeping a
 * second copy of.
 */
export function ActivityPill({ signal, className }: ActivityPillProps) {
  const meta = signal?.meta as
    | { status?: SessionActivity; resetsAt?: number | null }
    | undefined;
  const status = meta?.status;

  // Only subscribe to the clock while the countdown is actually running.
  const nowMs = useSecondTick(status === 'usage-limit');

  // Everything else the session can be doing is either legible from the status
  // pill above and the composer's own state, or is a glyph in
  // SessionStatusBar. A pill repeating either would be noise.
  if (status !== 'usage-limit') return null;

  const label =
    meta?.resetsAt != null ? `limit · ${resetLabel(meta.resetsAt, nowMs)}` : 'usage limit';

  return (
    <span
      title="Waiting for the usage limit to reset — the CLI still owns this turn"
      className={cn(
        'inline-flex items-center gap-1 rounded px-1.5 py-0.5',
        'text-[10px] font-medium lowercase tracking-wide tabular-nums',
        'bg-amber-500/15 text-amber-500',
        className,
      )}
    >
      {label}
    </span>
  );
}
