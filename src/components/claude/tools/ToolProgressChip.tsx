import * as React from 'react';
import { Timer, RotateCw } from 'lucide-react';
import { useSecondTick } from '@/hooks/useSecondTick';
import { useClaudeSessionStore } from '@/stores/claudeSessionStore';
import type { ToolProgressEntry } from '@/lib/toolProgress';

/** `0:42`, `12:05`, `1:04:09`. Floors, never rounds up. */
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
  /**
   * True once the tool_result has landed.
   *
   * The render-time kill switch, and the reason the progress map can be pruned
   * lazily rather than in lockstep with the stream: a stale entry can never
   * paint, so the prune is hygiene rather than correctness.
   */
  done: boolean;
}

/**
 * Transient progress for an in-flight tool call: how long it has been running,
 * and a retry banner when a subagent is being retried.
 *
 * Both halves vanish when the result arrives — the data behind them is
 * live-only (the CLI never writes `tool_progress` to disk), so anything that
 * outlived the call would be visible in a live transcript and absent from the
 * same transcript reloaded.
 *
 * The CLI beats every 30 seconds, so showing `elapsed_time_seconds` raw would
 * jump by half-minutes. This interpolates from the last beat's arrival, and
 * subscribes to the shared one-second clock only while it is actually showing
 * something: an idle transcript runs no timer.
 */
export const ToolProgressChip: React.FC<ToolProgressChipProps> = ({ entry, done }) => {
  const live = !!entry && !done;
  const nowMs = useSecondTick(live);
  if (!entry || done) return null;

  const seconds = entry.elapsedSeconds + Math.max(0, (nowMs - entry.arrivedAtMs) / 1000);
  const retry = entry.retry;

  return (
    <span className="ml-6 inline-flex items-center gap-2 text-[10px] font-mono tabular-nums">
      <span
        className="inline-flex items-center gap-1 text-muted-foreground"
        title="Still running — the CLI reports progress every 30s"
      >
        <Timer className="h-3 w-3" />
        {formatToolElapsed(seconds)}
      </span>
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

/**
 * Store-connected wrapper.
 *
 * Subscribes here rather than threading the whole progress map down from
 * `ClaudeTranscript`: the map's identity changes on every beat, and a map prop
 * would re-render every mounted message in the tab twice a minute per running
 * tool. The transcript is unvirtualised and every open tab is mounted at once
 * (see the perf note in the root CLAUDE.md), so that is the expensive shape.
 * The selector returns one entry, whose reference the reducer keeps stable
 * unless its own values moved.
 *
 * Same pattern as `InflightAssistantBubble` — a leaf that takes `tabId` and
 * reads its own slice.
 */
export const ConnectedToolProgressChip: React.FC<{
  tabId: string;
  toolUseId: string | undefined;
  done: boolean;
}> = ({ tabId, toolUseId, done }) => {
  const entry = useClaudeSessionStore((s) =>
    toolUseId ? (s.tabs[tabId]?.toolProgress.get(toolUseId) ?? null) : null,
  );
  return <ToolProgressChip entry={entry} done={done} />;
};
