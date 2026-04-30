import type { ClaudeStreamMessage } from '@/types/claudeStream';

export type SubagentStatus = 'running' | 'completed' | 'failed' | 'abandoned';

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
  // True when dispatched with run_in_background:true. The SDK fires an
  // immediate ACK tool_result for these (a dispatch confirmation, not the
  // actual return value), so the tool_result-completion path in step 2
  // must not flip these to "completed" — only task_notification can.
  isBackground?: boolean;
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
  // Index of the assistant message that dispatched each subagent. Used after
  // the main loop to detect orphaned background dispatches (parent moved on
  // past the awaiting result without ever receiving task_notification).
  const dispatchIndex = new Map<string, number>();

  for (let i = 0; i < messages.length; i++) {
    const m = messages[i] as any;

    // 1. Parent tool_use block — surfaces a subagent as soon as it's
    //    dispatched. Two ways a tool_use becomes a subagent:
    //    a) name is Agent or Task (the explicit subagent-dispatch tools)
    //    b) any tool_use with input.run_in_background === true (e.g. Bash with
    //       a long-running build) — the SDK treats those as background tasks
    //       too and fires the same task_started/task_notification lifecycle.
    //    Without (b), Bash backgrounds wouldn't show up in the bar until the
    //    SDK got around to firing task_started, and the synchronous ACK
    //    tool_result would have no isBackground flag to gate against.
    if (m?.type === 'assistant' && Array.isArray(m.message?.content)) {
      for (const block of m.message.content) {
        if (block?.type !== 'tool_use' || !block.id) continue;
        const isAgentTool = block.name === 'Agent' || block.name === 'Task';
        const isBackgroundDispatch = block.input?.run_in_background === true;
        if (!isAgentTool && !isBackgroundDispatch) continue;

        const sub = ensureSubagent(byToolUseId, block.id, block.input?.description ?? '');
        if (!sub.description) sub.description = block.input?.description ?? '';
        if (isAgentTool) sub.agentType = sub.agentType ?? block.input?.subagent_type;
        if (isBackgroundDispatch) sub.isBackground = true;
        if (!dispatchIndex.has(block.id)) dispatchIndex.set(block.id, i);
      }
      continue;
    }

    // 2. Tool results for a subagent tool_use — the parent session received the
    //    subagent's return value, so the subagent has finished. Only used as a
    //    fallback when task_notification never arrives (some streams emit the
    //    tool_result but not the richer lifecycle marker).
    //
    //    Exception: background dispatches (run_in_background:true) get an
    //    immediate ACK tool_result that says "Async agent launched..." — that
    //    is NOT a completion signal. For those, only an is_error=true ACK
    //    counts (the dispatch itself failed); a success ACK is ignored and
    //    we wait for task_notification.
    if (m?.type === 'user' && Array.isArray(m.message?.content)) {
      for (const block of m.message.content) {
        if (block?.type !== 'tool_result') continue;
        const id: string | undefined = block.tool_use_id;
        if (!id) continue;
        const sub = byToolUseId.get(id);
        if (!sub) continue;
        if (notificationFinalized.has(id)) continue;
        if (sub.isBackground && !block.is_error) continue;
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

  // Orphan detection: a background dispatch is "abandoned" if the parent
  // session moved on past its awaiting result without ever receiving a
  // task_notification. Symptom: zombie "running" bars and ghost amber result
  // cards on a session reloaded from disk.
  //
  // Heuristic: for each background subagent still in `running` after the main
  // loop, find the first `result` event after its dispatch. If any message
  // exists after that result (proving the parent advanced — new turn, user
  // input, anything), mark the subagent abandoned. If the result is the
  // latest message, the session may be live and awaiting; leave it running.
  for (const sub of byToolUseId.values()) {
    if (sub.status !== 'running' || !sub.isBackground) continue;
    const dispatchedAt = dispatchIndex.get(sub.toolUseId);
    if (dispatchedAt === undefined) continue;
    let resultIdx = -1;
    for (let i = dispatchedAt + 1; i < messages.length; i++) {
      if ((messages[i] as any)?.type === 'result') {
        resultIdx = i;
        break;
      }
    }
    if (resultIdx === -1) continue;
    if (resultIdx < messages.length - 1) {
      sub.status = 'abandoned';
      sub.endedAt = sub.endedAt ?? new Date().toISOString();
    }
  }

  return Array.from(byToolUseId.values());
}

export function clearCompleted(subs: Subagent[]): Subagent[] {
  return subs.filter((s) => s.status === 'running');
}
