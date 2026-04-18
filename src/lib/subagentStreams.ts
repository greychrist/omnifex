import type { ClaudeStreamMessage } from '@/components/AgentExecution';

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

    // 2. Task lifecycle markers (task_started / task_progress / task_notification)
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
      }
    }
  }

  return Array.from(byToolUseId.values());
}

export function clearCompleted(subs: Subagent[]): Subagent[] {
  return subs.filter((s) => s.status === 'running');
}
