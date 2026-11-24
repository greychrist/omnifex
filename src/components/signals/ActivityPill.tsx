import { cn } from '@/lib/utils';
import { useSecondTick } from '@/hooks/useSecondTick';
import type { SessionActivity } from '@/lib/signals/emitters';
import type { SessionSignal } from '@/lib/signals/types';

export interface ActivityPillProps {
  signal: SessionSignal | undefined;
  className?: string;
}

function resetLabel(resetsAtSeconds: number, nowMs: number): string {
  const remainingMs = resetsAtSeconds * 1000 - nowMs;
  if (remainingMs <= 0) return 'any moment';
  const minutes = Math.floor(remainingMs / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

// Not merged with the session-status pill: that reports `sessionStatus`, which the renderer must not keep a copy of.
export function ActivityPill({ signal, className }: ActivityPillProps) {
  const meta = signal?.meta as
    | { status?: SessionActivity; resetsAt?: number | null }
    | undefined;
  const status = meta?.status;

  const nowMs = useSecondTick(status === 'usage-limit');

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
