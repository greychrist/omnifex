import * as React from 'react';
import { Timer, RotateCw, ShieldCheck } from 'lucide-react';
import { useSecondTick } from '@/hooks/useSecondTick';
import { useClaudeSessionStore } from '@/stores/claudeSessionStore';
import type { ToolProgressEntry } from '@/lib/toolProgress';

export function formatToolElapsed(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const seconds = s % 60;
  const minutes = Math.floor(s / 60) % 60;
  const hours = Math.floor(s / 3600);
  const ss = String(seconds).padStart(2, '0');
  if (hours === 0) return `${minutes}:${ss}`;
  return `${hours}:${String(minutes).padStart(2, '0')}:${ss}`;
}

export interface ToolProgressChipProps {
  entry: ToolProgressEntry | null | undefined;
  /** The render-time kill switch: a stale entry never paints, so the progress map can be pruned lazily. */
  done: boolean;
  checkingPermission?: boolean;
}

// tool_progress is live-only (never on disk), so nothing may outlive the call; the clock is subscribed only while showing.
export const ToolProgressChip: React.FC<ToolProgressChipProps> = ({ entry, done, checkingPermission = false }) => {
  const live = !!entry && !done;
  const nowMs = useSecondTick(live);
  if (done || (!entry && !checkingPermission)) return null;

  const seconds = entry ? entry.elapsedSeconds + Math.max(0, (nowMs - entry.arrivedAtMs) / 1000) : 0;
  const retry = entry?.retry ?? null;

  return (
    <span className="ml-6 inline-flex items-center gap-2 text-[10px] font-mono tabular-nums">
      {checkingPermission && (
        <span
          className="inline-flex items-center gap-1 text-amber-500 animate-pulse"
          title="Waiting on the automatic permission check (auto mode's classifier)"
        >
          <ShieldCheck className="h-3 w-3" />
          checking permission
        </span>
      )}
      {entry && (
        <span
          className="inline-flex items-center gap-1 text-muted-foreground"
          title="Still running — the CLI reports progress every 30s"
        >
          <Timer className="h-3 w-3" />
          {formatToolElapsed(seconds)}
        </span>
      )}
      {retry && (
        <span
          className="inline-flex items-center gap-1 text-amber-500"
          title={
            retry.errorStatus !== null
              ? `HTTP ${retry.errorStatus} — retrying in ${retry.retryDelayMs}ms`
              : `Retrying in ${retry.retryDelayMs}ms`
          }
        >
          <RotateCw className="h-3 w-3 animate-spin" />
          attempt {retry.attempt}/{retry.maxRetries} · {retry.errorCategory}
        </span>
      )}
    </span>
  );
};

// Subscribes per leaf: a map prop changes identity every beat and would re-render every mounted message.
export const ConnectedToolProgressChip: React.FC<{
  tabId: string;
  toolUseId: string | undefined;
  done: boolean;
}> = ({ tabId, toolUseId, done }) => {
  const entry = useClaudeSessionStore((s) =>
    toolUseId ? (s.tabs[tabId]?.toolProgress.get(toolUseId) ?? null) : null,
  );
  const checkingPermission = useClaudeSessionStore((s) =>
    toolUseId ? (s.tabs[tabId]?.permissionChecks.has(toolUseId) ?? false) : false,
  );
  return <ToolProgressChip entry={entry} done={done} checkingPermission={checkingPermission} />;
};
