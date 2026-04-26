import type { ClaudeStreamMessage } from '@/types/claudeStream';

export type SubagentStatus = 'running' | 'completed' | 'failed';

export interface SubagentProgressEvent {
  description: string;
  lastToolName?: string;
  totalTokens?: number;
  toolUses?: number;
  durationMs?: number;
}

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
}

export const SUBAGENT_PALETTE_SIZE = 6;

export function colorIndexFor(toolUseId: string): number {
  let hash = 0;
  for (let i = 0; i < toolUseId.length; i++) {
    hash = (hash + toolUseId.charCodeAt(i)) >>> 0;
  }
  return hash % SUBAGENT_PALETTE_SIZE;
}

export function isTaskLifecycleMarker(m: unknown): boolean {
  const msg = m as { type?: string; subtype?: string } | null;
  return !!msg && msg.type === 'system' && typeof msg.subtype === 'string' && msg.subtype.startsWith('task_');
}

function ensureSubagent(
  byId: Map<string, Subagent>,
  toolUseId: string,
  initialDescription = '',
): Subagent {
  let sub = byId.get(toolUseId);
  if (!sub) {
    sub = {
      toolUseId,
      description: initialDescription,
      status: 'running',
      latest: null,
      events: [],
      colorIndex: colorIndexFor(toolUseId),
    };
    byId.set(toolUseId, sub);
  }
  return sub;
}

export function deriveSubagents(messages: ClaudeStreamMessage[]): Subagent[] {
  const byToolUseId = new Map<string, Subagent>();
  // Subagents for which task_notification already set a final status — used
  // so a later (or earlier) tool_result doesn't overwrite richer notification
  // data. The SDK's notification carries the summary + usage; tool_result only
  // tells us "the subagent returned."
  const notificationFinalized = new Set<string>();

  for (const raw of messages) {
    const m = raw as any;

    // 1. The parent Agent/Task tool_use block (surfaces a subagent as soon as it's dispatched)
    if (m?.type === 'assistant' && Array.isArray(m.message?.content)) {
      for (const block of m.message.content) {
        if (block?.type === 'tool_use' && (block.name === 'Agent' || block.name === 'Task') && block.id) {
          const sub = ensureSubagent(byToolUseId, block.id, block.input?.description ?? '');
          sub.agentType = sub.agentType ?? block.input?.subagent_type;
          if (!sub.description) sub.description = block.input?.description ?? '';
        }
      }
      continue;
    }

    // 2. Tool results for a subagent tool_use — the parent session received the
    //    subagent's return value, so the subagent has finished. Only used as a
    //    fallback when task_notification never arrives (some streams emit the
    //    tool_result but not the richer lifecycle marker).
    if (m?.type === 'user' && Array.isArray(m.message?.content)) {
      for (const block of m.message.content) {
        if (block?.type !== 'tool_result') continue;
        const id: string | undefined = block.tool_use_id;
        if (!id) continue;
        const sub = byToolUseId.get(id);
        if (!sub) continue;
        if (notificationFinalized.has(id)) continue;
        sub.status = block.is_error ? 'failed' : 'completed';
        sub.endedAt = sub.endedAt ?? new Date().toISOString();
      }
      continue;
    }

    // 3. Task lifecycle markers (task_started / task_progress / task_notification)
    if (isTaskLifecycleMarker(m)) {
      const id: string | undefined = m.tool_use_id;
      if (!id) continue;
      const sub = ensureSubagent(byToolUseId, id, m.description ?? '');

      if (m.subtype === 'task_started') {
        sub.taskId = m.task_id;
        if (!sub.description) sub.description = m.description ?? '';
        sub.startedAt = sub.startedAt ?? new Date().toISOString();
      } else if (m.subtype === 'task_progress') {
        const event: SubagentProgressEvent = {
          description: m.description ?? '',
          lastToolName: m.last_tool_name,
          totalTokens: m.usage?.total_tokens,
          toolUses: m.usage?.tool_uses,
          durationMs: m.usage?.duration_ms,
        };
        sub.events.push(event);
        sub.latest = event;
        sub.taskId = sub.taskId ?? m.task_id;
      } else if (m.subtype === 'task_notification') {
        sub.status = m.status === 'completed' ? 'completed' : 'failed';
        sub.summary = m.summary;
        sub.endedAt = new Date().toISOString();
        const finalEvent: SubagentProgressEvent = {
          description: m.summary ?? sub.description,
          totalTokens: m.usage?.total_tokens,
          toolUses: m.usage?.tool_uses,
          durationMs: m.usage?.duration_ms,
        };
        sub.events.push(finalEvent);
        sub.latest = finalEvent;
        notificationFinalized.add(id);
      }
    }
  }

  return Array.from(byToolUseId.values());
}

export function clearCompleted(subs: Subagent[]): Subagent[] {
  return subs.filter((s) => s.status === 'running');
}
