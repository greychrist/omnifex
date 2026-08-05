/**
 * Derive subagent state from the Claude CLI stream.
 *
 * Thin facade over `subagentEvents.ts`. Translation, reduction, and the
 * inferred-closure post-pass live there; this file is the renderer-facing
 * shape (`Subagent` rendered by SubagentBar, `clearCompleted` for the
 * "Clear done" button, `hasRunningSubagent` for callers that want to know
 * if any row is still in flight) plus the `colorIndexFor` palette hash.
 */

import type { JsonlNode } from '@/types/jsonl';
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
  // True when dispatched with run_in_background:true. The CLI fires an
  // immediate ACK tool_result for these (a dispatch confirmation, not the
  // actual return value), so the reducer must not flip these to "completed"
  // on the ACK — only TaskNotification(Xml) or the inferred-closure rule
  // do that.
  isBackground?: boolean;
  /** Set from `CliTaskUpdatedMessage.patch.error` when the CLI reports a
   *  subagent failure. Undefined for successful subagents and for failures
   *  that closed via tool_result / TaskNotification (which carry summaries
   *  but not a structured error string). */
  error?: string;
  /** Which carrier finalised this row, if any. `'parent_result'` indicates
   *  the inferred-closure path (no direct closure carrier was seen). */
  closureSource?: SubagentState['closureSource'];
  /** The model the subagent ran on. Merged in from disk via
   *  `applySubagentMeta` — never present in the live message stream. */
  model?: string;
  /** The subagent's OWN reasoning effort, which can differ from the
   *  session's when the dispatch set `effort:`. Same provenance as `model`.
   *  Undefined when the run used the session default. */
  effort?: string;
  /** For a NESTED subagent (spawnDepth >= 2): the `toolUseId` of the row that
   *  dispatched it. Undefined on rows dispatched from the main stream.
   *  Rows carrying this were synthesised from sidecars — the main stream has
   *  no dispatch for them. */
  parentToolUseId?: string;
  /** Authoritative end-of-run totals from the parent Task's `toolUseResult`,
   *  merged in via `applySubagentMeta`. Preferred over the live
   *  `latest.*` numbers when present (the stream's running totals can lag
   *  the final tally). */
  finalTotalTokens?: number;
  finalDurationMs?: number;
  finalToolUseCount?: number;
}

/**
 * Per-subagent metadata sourced from disk (model + authoritative totals),
 * keyed by the dispatching Task's `tool_use_id`. Mirrors the main-process
 * `SubagentMeta` shape without coupling this module to the IPC layer.
 */
export interface SubagentMetaInput {
  agentId?: string;
  agentType?: string;
  model?: string;
  effort?: string;
  /** agentId of the dispatching subagent; set only at spawnDepth >= 2. */
  parentAgentId?: string;
  spawnDepth?: number;
  totalTokens?: number;
  durationMs?: number;
  toolUseCount?: number;
}

/**
 * Merge disk-sourced metadata onto derived subagent rows by `toolUseId`.
 * Pure — returns a new array and never mutates the input. Rows without a
 * matching entry pass through untouched. `agentType` is only filled when the
 * dispatch didn't already supply one (the dispatch's `subagent_type` wins).
 */
export function applySubagentMeta(
  subs: Subagent[],
  meta: Record<string, SubagentMetaInput>,
): Subagent[] {
  const merged = subs.map((sub) => {
    const m = meta[sub.toolUseId];
    if (!m) return sub;
    return {
      ...sub,
      agentType: sub.agentType ?? m.agentType,
      model: m.model ?? sub.model,
      effort: m.effort ?? sub.effort,
      finalTotalTokens: m.totalTokens ?? sub.finalTotalTokens,
      finalDurationMs: m.durationMs ?? sub.finalDurationMs,
      finalToolUseCount: m.toolUseCount ?? sub.finalToolUseCount,
    };
  });

  // agentId -> the row it belongs to, so a nested entry's `parentAgentId`
  // can be resolved to the toolUseId that rows are actually keyed by.
  const rowByAgentId = new Map<string, Subagent>();
  for (const row of merged) {
    const agentId = meta[row.toolUseId]?.agentId;
    if (agentId) rowByAgentId.set(agentId, row);
  }

  // Synthesise rows for nested subagents. Only entries with a parentAgentId
  // qualify: a depth-1 entry without a row means the dispatch simply hasn't
  // been read yet, and inventing one would duplicate it when it arrives.
  const nested: { parent: Subagent; row: Subagent }[] = [];
  for (const [toolUseId, m] of Object.entries(meta)) {
    if (!m.parentAgentId) continue;
    if (merged.some((s) => s.toolUseId === toolUseId)) continue;
    const parent = rowByAgentId.get(m.parentAgentId);
    // An orphan has nothing to attach to — a floating row with no context
    // reads worse than omitting it.
    if (!parent) continue;
    nested.push({
      parent,
      row: {
        toolUseId,
        parentToolUseId: parent.toolUseId,
        agentType: m.agentType,
        description: parent.description,
        // Neither the sidecar nor any stream carries a nested agent's status.
        // The parent's is a sound stand-in: a child cannot outlive the Task
        // that dispatched it, so a returned parent means the child is done.
        status: parent.status,
        latest: null,
        events: [],
        colorIndex: parent.colorIndex,
        model: m.model,
        effort: m.effort,
      },
    });
  }
  if (nested.length === 0) return merged;

  // Splice each child in directly after its parent so the branch reads as a
  // group rather than as unexplained rows at the end of the list.
  const out: Subagent[] = [];
  for (const row of merged) {
    out.push(row);
    for (const n of nested) {
      if (n.parent.toolUseId === row.toolUseId) out.push(n.row);
    }
  }
  return out;
}

export const SUBAGENT_PALETTE_SIZE = 16;

export function colorIndexFor(toolUseId: string): number {
  let hash = 0;
  for (let i = 0; i < toolUseId.length; i++) {
    hash = (hash + toolUseId.charCodeAt(i)) >>> 0;
  }
  return hash % SUBAGENT_PALETTE_SIZE;
}

/**
 * Color allocator for subagent rows. Stateful within a session — tracks
 * which palette indices are currently held by live tool_use_ids so new
 * subagents get a guaranteed-unique index until the palette saturates.
 *
 * Stability contract:
 *  - Same toolUseId → same index for the allocator's lifetime
 *  - Different toolUseIds → different indices when ≤ palette size are live
 *  - On release(toolUseId), the index frees up for the next allocation
 *  - When > palette size are live simultaneously, the overflow falls back
 *    to hash-mod and accepts collisions
 */
export interface SubagentColorAllocator {
  /** Get-or-assign the color index for this toolUseId. */
  acquire(toolUseId: string): number;
  /** Release the slot held by toolUseId. Safe to call on unknown ids. */
  release(toolUseId: string): void;
}

export function createSubagentColorAllocator(): SubagentColorAllocator {
  const assigned = new Map<string, number>();
  const used = new Set<number>();

  return {
    acquire(toolUseId: string): number {
      const existing = assigned.get(toolUseId);
      if (existing !== undefined) return existing;
      // Pick lowest unused index, hash-mod fallback if all used.
      let chosen = -1;
      for (let i = 0; i < SUBAGENT_PALETTE_SIZE; i++) {
        if (!used.has(i)) { chosen = i; break; }
      }
      if (chosen === -1) chosen = colorIndexFor(toolUseId);
      assigned.set(toolUseId, chosen);
      used.add(chosen);
      return chosen;
    },
    release(toolUseId: string): void {
      const idx = assigned.get(toolUseId);
      if (idx === undefined) return;
      assigned.delete(toolUseId);
      // Only free the slot if no other toolUseId holds it (hash-mod fallback
      // can produce collisions where multiple ids map to the same index).
      for (const otherIdx of assigned.values()) {
        if (otherIdx === idx) return;
      }
      used.delete(idx);
    },
  };
}

export const isTaskLifecycleMarker = _isTaskLifecycleMarker;

/**
 * Build the subagent list from the message stream.
 *
 * Pipeline:
 *   1. `messagesToEvents` — pure CLI→event translation
 *   2. `applyEvents` — fold events into per-`tool_use_id` state with an
 *      intrinsic terminal lock
 *   3. `inferredClosureEvents` — generate `ClosedByParentResult` events
 *      for rows still in `running` whose parent emitted a `type: 'result'`
 *      that is not the most recent message
 *   4. Re-apply the inferred events so they go through the same reducer
 *      (preserving terminal-lock semantics)
 */
export function deriveSubagents(
  messages: JsonlNode[],
  allocator?: SubagentColorAllocator,
): Subagent[] {
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
    colorIndex: allocator ? allocator.acquire(s.toolUseId) : colorIndexFor(s.toolUseId),
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
