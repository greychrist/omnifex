import type { JsonlNode } from '@/types/jsonl';
import {
  applyEvents,
  dispatchIndicesFromEvents,
  inferredClosureEvents,
  isTaskLifecycleMarker as _isTaskLifecycleMarker,
  isTaskNotificationCarrier as _isTaskNotificationCarrier,
  messagesToEvents,
  forwardedAgentId,
  forwardedModel,
  forwardedNarration,
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
  prompt?: string;
  status: SubagentStatus;
  startedAt?: string;
  endedAt?: string;
  latest: SubagentProgressEvent | null;
  events: SubagentProgressEvent[];
  summary?: string;
  progressSummary?: string;
  colorIndex: number;
  /** run_in_background: its immediate ACK tool_result is not a completion. */
  isBackground?: boolean;
  error?: string;
  closureSource?: SubagentState['closureSource'];
  ambient?: boolean;
  /** Live from forwarded frames; the disk meta from applySubagentMeta wins once read. */
  model?: string;
  effort?: string;
  parentToolUseId?: string;
  /** Preferred over live `latest.*` totals, which can lag the final tally. */
  finalTotalTokens?: number;
  finalDurationMs?: number;
  finalToolUseCount?: number;
}

export interface SubagentMetaInput {
  agentId?: string;
  agentType?: string;
  description?: string;
  model?: string;
  effort?: string;
  /** agentId of the dispatching subagent; set only at spawnDepth >= 2. */
  parentAgentId?: string;
  spawnDepth?: number;
  totalTokens?: number;
  durationMs?: number;
  toolUseCount?: number;
}

export interface NotificationStats {
  status: 'completed' | 'failed';
  summary?: string;
  totalTokens?: number;
  toolUses?: number;
  durationMs?: number;
}

/** The reducer drops notifications naming no dispatched row, which is a nested subagent's shape; this lets applySubagentMeta reunite them. */
export function notificationStatsByToolUse(
  messages: JsonlNode[],
): Record<string, NotificationStats> {
  const out: Record<string, NotificationStats> = {};
  for (const ev of messagesToEvents(messages)) {
    if (ev.kind !== 'TaskNotificationXml') continue;
    // Last wins: a resumed agent re-notifies with its running totals.
    out[ev.toolUseId] = {
      status: ev.status,
      summary: ev.summary,
      totalTokens: ev.totalTokens,
      toolUses: ev.toolUses,
      durationMs: ev.durationMs,
    };
  }
  return out;
}

export interface ForwardedLive {
  model?: string;
  text?: string;
}

/** Nested rows are synthesised after the reducer, so their forwarded frames are reunited here by agent_id. */
export function forwardedByAgentId(messages: JsonlNode[]): Record<string, ForwardedLive> {
  const out: Record<string, ForwardedLive> = {};
  for (const m of messages) {
    if (m.kind !== 'assistant') continue;
    const raw = (m as unknown as { raw?: Record<string, unknown> }).raw ?? {};
    const agentId = forwardedAgentId(raw);
    if (!agentId) continue;
    const prev = out[agentId] ?? {};
    const model = forwardedModel(raw) ?? prev.model;
    const text = forwardedNarration(raw) || prev.text;
    out[agentId] = {
      ...(model ? { model } : {}),
      ...(text ? { text } : {}),
    };
  }
  return out;
}

export function applySubagentMeta(
  subs: Subagent[],
  meta: Record<string, SubagentMetaInput>,
  notifications: Record<string, NotificationStats> = {},
  live: Record<string, ForwardedLive> = {},
): Subagent[] {
  const merged = subs.map((sub) => {
    const m = meta[sub.toolUseId];
    if (!m) return sub;
    return {
      ...sub,
      agentType: sub.agentType ?? m.agentType,
      // The task id IS the agent id; a foreground row reloaded from disk only has it from meta.
      taskId: sub.taskId ?? m.agentId,
      model: m.model ?? sub.model,
      effort: m.effort ?? sub.effort,
      finalTotalTokens: m.totalTokens ?? sub.finalTotalTokens,
      finalDurationMs: m.durationMs ?? sub.finalDurationMs,
      finalToolUseCount: m.toolUseCount ?? sub.finalToolUseCount,
    };
  });

  const rowByAgentId = new Map<string, Subagent>();
  for (const row of merged) {
    const agentId = meta[row.toolUseId]?.agentId;
    if (agentId) rowByAgentId.set(agentId, row);
  }

  // Nested entries only: a depth-1 entry without a row hasn't been read yet, and inventing one would duplicate it.
  const nested: { parent: Subagent; row: Subagent }[] = [];
  for (const [toolUseId, m] of Object.entries(meta)) {
    if (!m.parentAgentId) continue;
    if (merged.some((s) => s.toolUseId === toolUseId)) continue;
    const parent = rowByAgentId.get(m.parentAgentId);
    if (!parent) continue;
    const notif = notifications[toolUseId];
    const liveFrames = m.agentId ? live[m.agentId] : undefined;
    const description = m.description ?? parent.description;
    const latest: SubagentProgressEntry | null = notif
      ? {
          description: notif.summary ?? description,
          totalTokens: notif.totalTokens,
          toolUses: notif.toolUses,
          durationMs: notif.durationMs,
        }
      : liveFrames?.text
        ? { description: liveFrames.text }
        : null;
    nested.push({
      parent,
      row: {
        toolUseId,
        taskId: m.agentId,
        parentToolUseId: parent.toolUseId,
        agentType: m.agentType,
        description,
        // Since CLI 2.1.232 a finished parent no longer implies finished children.
        status: notif?.status ?? (parent.status === 'running' ? 'running' : 'completed_inferred'),
        closureSource: notif ? 'task_notification_xml' : undefined,
        summary: notif?.summary,
        latest,
        events: latest ? [latest] : [],
        colorIndex: parent.colorIndex,
        model: m.model ?? liveFrames?.model,
        effort: m.effort,
      },
    });
  }
  if (nested.length === 0) return merged;

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

export interface SubagentColorAllocator {
  acquire(toolUseId: string): number;
  release(toolUseId: string): void;
}

export function createSubagentColorAllocator(): SubagentColorAllocator {
  const assigned = new Map<string, number>();
  const used = new Set<number>();

  return {
    acquire(toolUseId: string): number {
      const existing = assigned.get(toolUseId);
      if (existing !== undefined) return existing;
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
      // Hash-mod fallback can give several ids the same index.
      for (const otherIdx of assigned.values()) {
        if (otherIdx === idx) return;
      }
      used.delete(idx);
    },
  };
}

export const isTaskLifecycleMarker = _isTaskLifecycleMarker;
export const isTaskNotificationCarrier = _isTaskNotificationCarrier;

export function deriveSubagents(
  messages: JsonlNode[],
  allocator?: SubagentColorAllocator,
): Subagent[] {
  const baseEvents = messagesToEvents(messages);
  const states = applyEvents(baseEvents);
  // A resume moves the inferred-closure anchor: an earlier result says nothing about the new run.
  const anchors = dispatchIndicesFromEvents(baseEvents);
  for (const ev of baseEvents) {
    if (ev.kind !== 'AgentResumed') continue;
    for (const s of states.values()) {
      if (s.taskId === ev.taskId) anchors.set(s.toolUseId, ev.messageIdx);
    }
  }
  const closureEvents = inferredClosureEvents(messages, states, anchors);
  for (const ev of closureEvents) {
    if (ev.kind !== 'ClosedByParentResult') continue;
    const s = states.get(ev.toolUseId);
    if (!s) continue;
    if (s.status !== 'running') continue;
    s.status = 'completed_inferred';
    s.closureSource = 'parent_result';
    s.endedAt = s.endedAt ?? new Date().toISOString();
  }

  const all = Array.from(states.values());
  const toRow = (s: SubagentState, colorIndex: number): Subagent => ({
    toolUseId: s.toolUseId,
    taskId: s.taskId,
    agentType: s.agentType,
    description: s.description,
    prompt: s.prompt,
    status: s.status,
    startedAt: s.startedAt,
    endedAt: s.endedAt,
    latest: s.latest,
    events: s.events,
    summary: s.summary,
    progressSummary: s.progressSummary,
    colorIndex,
    isBackground: s.isBackground,
    error: s.error,
    parentToolUseId: s.parentToolUseId,
    closureSource: s.closureSource,
    ambient: s.ambient,
    model: s.model,
  });

  // Owners first: a nested row shares its owner's color and never takes a palette slot.
  const rows = new Map<string, Subagent>();
  for (const s of all) {
    if (s.parentToolUseId) continue;
    rows.set(s.toolUseId, toRow(s, allocator ? allocator.acquire(s.toolUseId) : colorIndexFor(s.toolUseId)));
  }
  const owned: Subagent[] = [];
  for (const s of all) {
    if (!s.parentToolUseId) continue;
    const owner = rows.get(s.parentToolUseId);
    // A visible orphan beats a task that ran invisibly.
    owned.push(toRow(s, owner ? owner.colorIndex : (allocator ? allocator.acquire(s.toolUseId) : colorIndexFor(s.toolUseId))));
  }
  if (owned.length === 0) return Array.from(rows.values());

  const out: Subagent[] = [];
  for (const row of rows.values()) {
    out.push(row);
    for (const child of owned) {
      if (child.parentToolUseId === row.toolUseId) out.push(child);
    }
  }
  for (const child of owned) {
    if (!rows.has(child.parentToolUseId ?? '')) out.push(child);
  }
  return out;
}

export function clearCompleted(subs: Subagent[]): Subagent[] {
  return subs.filter((s) => s.status === 'running');
}

/** Not an in-flight signal: a stuck-running row must not fake a live turn. */
export function hasRunningSubagent(subs: Subagent[]): boolean {
  return subs.some((s) => s.status === 'running');
}

/** Ambient tasks are not activity (CLI contract); a badge wants this, not hasRunningSubagent. */
export function countActiveSubagents(subs: Subagent[]): number {
  return subs.reduce((n, s) => (s.status === 'running' && !s.ambient ? n + 1 : n), 0);
}
