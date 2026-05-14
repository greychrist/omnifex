/**
 * Derive subagent state from the Claude Agent SDK stream.
 *
 * Thin facade over `subagentEvents.ts`. Translation, reduction, and the
 * inferred-closure post-pass live there; this file is the renderer-facing
 * shape (`Subagent` rendered by SubagentBar, `clearCompleted` for the
 * "Clear done" button, `hasRunningSubagent` for callers that want to know
 * if any row is still in flight) plus the `colorIndexFor` palette hash.
 */

import type { ClaudeStreamMessage } from '@/types/claudeStream';
import {
  applyEvents,
  dispatchIndicesFromEvents,
  inferredClosureEvents,
  isTaskLifecycleMarker as _isTaskLifecycleMarker,
  messagesToEvents,
  type SubagentProgressEntry,
  type SubagentState,
  type SubagentStatus,
} from './subagentEvents';

export type { SubagentStatus } from './subagentEvents';
export type SubagentProgressEvent = SubagentProgressEntry;

export interface Subagent {
  toolUseId: string;
  taskId?: string;
  agentType?: string;
  description: string;
  status: SubagentStatus;
  startedAt?: string;
  endedAt?: string;
  latest: SubagentProgressEvent | null;
  events: SubagentProgressEvent[];
  summary?: string;
  colorIndex: number;
  // True when dispatched with run_in_background:true. The SDK fires an
  // immediate ACK tool_result for these (a dispatch confirmation, not the
  // actual return value), so the reducer must not flip these to "completed"
  // on the ACK — only TaskNotification(Xml) or the inferred-closure rule
  // do that.
  isBackground?: boolean;
  /** Set from `SDKTaskUpdatedMessage.patch.error` when the SDK reports a
   *  subagent failure. Undefined for successful subagents and for failures
   *  that closed via tool_result / TaskNotification (which carry summaries
   *  but not a structured error string). */
  error?: string;
  /** Which carrier finalised this row, if any. `'parent_result'` indicates
   *  the inferred-closure path (no direct closure carrier was seen). */
  closureSource?: SubagentState['closureSource'];
}

export const SUBAGENT_PALETTE_SIZE = 6;

export function colorIndexFor(toolUseId: string): number {
  let hash = 0;
  for (let i = 0; i < toolUseId.length; i++) {
    hash = (hash + toolUseId.charCodeAt(i)) >>> 0;
  }
  return hash % SUBAGENT_PALETTE_SIZE;
}

export const isTaskLifecycleMarker = _isTaskLifecycleMarker;

/**
 * Build the subagent list from the message stream.
 *
 * Pipeline:
 *   1. `messagesToEvents` — pure SDK→event translation
 *   2. `applyEvents` — fold events into per-`tool_use_id` state with an
 *      intrinsic terminal lock
 *   3. `inferredClosureEvents` — generate `ClosedByParentResult` events
 *      for rows still in `running` whose parent emitted a `type: 'result'`
 *      that is not the most recent message
 *   4. Re-apply the inferred events so they go through the same reducer
 *      (preserving terminal-lock semantics)
 */
export function deriveSubagents(messages: ClaudeStreamMessage[]): Subagent[] {
  const baseEvents = messagesToEvents(messages);
  const states = applyEvents(baseEvents);
  const closureEvents = inferredClosureEvents(
    messages,
    states,
    dispatchIndicesFromEvents(baseEvents),
  );
  // Apply closure events directly to the existing state map. We don't
  // re-run them through `applyEvents` because that starts from an empty
  // map; the inferred-closure semantics are simple enough to inline here
  // and the terminal-lock check below preserves the same invariant
  // (`isTerminal` ↔ status ∈ TERMINAL_STATUSES).
  for (const ev of closureEvents) {
    if (ev.kind !== 'ClosedByParentResult') continue;
    const s = states.get(ev.toolUseId);
    if (!s) continue;
    if (s.status !== 'running') continue; // terminal lock
    s.status = 'completed_inferred';
    s.closureSource = 'parent_result';
    s.endedAt = s.endedAt ?? new Date().toISOString();
  }

  return Array.from(states.values()).map((s) => ({
    toolUseId: s.toolUseId,
    taskId: s.taskId,
    agentType: s.agentType,
    description: s.description,
    status: s.status,
    startedAt: s.startedAt,
    endedAt: s.endedAt,
    latest: s.latest,
    events: s.events,
    summary: s.summary,
    colorIndex: colorIndexFor(s.toolUseId),
    isBackground: s.isBackground,
    error: s.error,
    closureSource: s.closureSource,
  }));
}

export function clearCompleted(subs: Subagent[]): Subagent[] {
  return subs.filter((s) => s.status === 'running');
}

/**
 * True when at least one subagent is still in `running` status. Kept for
 * callers that want the predicate, but the typing-bubble bridge in
 * `ClaudeCodeSession.tsx` no longer routes through it — a stuck-running
 * row must not fake a live turn. See the design spec
 * `docs/superpowers/specs/2026-05-11-subagent-tracking-refactor-design.md`.
 */
export function hasRunningSubagent(subs: Subagent[]): boolean {
  return subs.some((s) => s.status === 'running');
}
