/**
 * Event-sourced derivation of subagent state from the Claude Agent SDK
 * stream. Two layers:
 *
 *   1. `messagesToEvents(messages)` — pure translation from SDK / JSONL
 *      messages into a typed `SubagentEvent` log. This is the only place
 *      that knows about SDK message shapes; the rest of the derivation
 *      operates on events.
 *   2. `applyEvents(events)` — pure reducer that builds per-`tool_use_id`
 *      `SubagentState` from the event log. Terminal status is intrinsic:
 *      once a state hits a terminal kind the reducer ignores further
 *      events for that id (no late `task_progress` can un-complete a row).
 *
 * Closure signals carry a `source` so consumers can render differently
 * for "real" completions vs `completed_inferred` (parent emitted `result`
 * but we never saw a direct closure carrier — usually because the SDK
 * iterator doesn't yield the `queue-operation` / `attachment` envelopes
 * that the CLI uses for background-Bash completion).
 *
 * The renderer's `subagentStreams.ts` wraps these two functions plus the
 * post-pass inference rule to produce the legacy `Subagent[]` shape.
 */

import type { ClaudeStreamMessage } from '@/types/claudeStream';

// ---------------------------------------------------------------------------
// Public state types
// ---------------------------------------------------------------------------

export type SubagentStatus =
  | 'running'
  | 'completed'
  | 'failed'
  | 'completed_inferred'
  | 'abandoned';

export interface SubagentProgressEntry {
  description: string;
  lastToolName?: string;
  totalTokens?: number;
  toolUses?: number;
  durationMs?: number;
}

export interface SubagentState {
  toolUseId: string;
  taskId?: string;
  agentType?: string;
  description: string;
  status: SubagentStatus;
  startedAt?: string;
  endedAt?: string;
  latest: SubagentProgressEntry | null;
  events: SubagentProgressEntry[];
  summary?: string;
  /** Dispatched with run_in_background:true. Background dispatches receive
   *  an immediate ACK `tool_result` that is not a completion signal; the
   *  reducer suppresses it. */
  isBackground?: boolean;
  /** Set from `SDKTaskUpdatedMessage.patch.error` when the SDK reports a
   *  subagent failure. `task_notification` summaries don't carry an
   *  error string per se; this is the only carrier for it. */
  error?: string;
  /** Inverse: which closure carrier actually finalised this row. `null` for
   *  the inferred branch (`ClosedByParentResult`) and for rows still in
   *  `running`. Useful for tests and for tooltips on the inferred-icon
   *  variant in `SubagentBar`. */
  closureSource?: 'tool_result' | 'task_notification' | 'task_notification_xml' | 'task_updated' | 'parent_result';
}

// ---------------------------------------------------------------------------
// Internal event log
// ---------------------------------------------------------------------------

export type SubagentEvent =
  | { kind: 'Dispatched'; toolUseId: string; messageIdx: number; description: string; agentType?: string; isBackground: boolean }
  | { kind: 'Started'; toolUseId: string; taskId: string; description: string }
  | { kind: 'Progress'; toolUseId: string; description: string; lastToolName?: string; totalTokens?: number; toolUses?: number; durationMs?: number; taskId?: string }
  | {
      kind: 'ToolResult';
      toolUseId: string;
      isError: boolean;
      /** Raw textual content from the tool_result block. Used as a heuristic
       *  to detect the "Async agent launched" / "Command running in
       *  background" ACK shape for safety, even though we already gate on
       *  `isBackground` in the reducer. */
      content?: string;
    }
  | { kind: 'TaskNotification'; toolUseId: string; status: 'completed' | 'failed' | 'stopped'; summary?: string; taskId?: string; totalTokens?: number; toolUses?: number; durationMs?: number }
  | { kind: 'TaskNotificationXml'; toolUseId: string; status: 'completed' | 'failed'; summary?: string; taskId?: string }
  | {
      // SDKTaskUpdatedMessage patch — wire-safe TaskState changes
      // (status, description, end_time, error, is_backgrounded, …).
      // Keyed by `taskId` (NOT `toolUseId`) because the SDK message
      // only carries `task_id`; the reducer maps it back to a
      // dispatched row via `SubagentState.taskId` set by Started /
      // Progress / Notification.
      kind: 'TaskUpdated';
      taskId: string;
      patch: {
        status?: 'pending' | 'running' | 'completed' | 'failed' | 'killed';
        description?: string;
        endTimeMs?: number;
        totalPausedMs?: number;
        error?: string;
        isBackgrounded?: boolean;
      };
    }
  | { kind: 'ClosedByParentResult'; toolUseId: string };

// ---------------------------------------------------------------------------
// XML extraction (queue-operation / attachment.queued_command carriers)
// ---------------------------------------------------------------------------

// XML <task-notification>...</task-notification> payloads ride two envelopes:
//   - { type: 'queue-operation', operation: 'enqueue', content: '<task-notification>...' }
//   - { type: 'attachment', attachment: { type: 'queued_command', prompt: '<task-notification>...' } }
// Both surface the completion of a run_in_background dispatch in lieu of a
// structured SDKTaskNotificationMessage. The live SDK iterator does NOT yield
// these envelopes (they're not in the SDKMessage union); they only land in the
// renderer via JSONL replay or the new `claude-output-extra:<tabId>` IPC
// channel surfaced by the main-process JSONL tail.
function extractTaskNotificationXml(m: unknown): string | null {
  if (!m || typeof m !== 'object') return null;
  const any = m as Record<string, unknown>;
  if (any.type === 'queue-operation' && (any.operation === 'enqueue' || any.operation === undefined)) {
    const content = any.content;
    if (typeof content === 'string' && content.includes('<task-notification>')) return content;
  }
  if (any.type === 'attachment') {
    const att = any.attachment as { type?: string; prompt?: unknown } | undefined;
    if (att?.type === 'queued_command' && typeof att.prompt === 'string' && att.prompt.includes('<task-notification>')) {
      return att.prompt;
    }
  }
  return null;
}

interface ParsedTaskNotification {
  taskId?: string;
  toolUseId: string;
  status: 'completed' | 'failed';
  summary?: string;
}

function parseTaskNotificationXml(text: string): ParsedTaskNotification | null {
  const tag = (name: string): string | undefined => {
    const re = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`);
    const m = text.match(re);
    return m ? m[1].trim() : undefined;
  };
  const toolUseId = tag('tool-use-id');
  if (!toolUseId) return null;
  const statusRaw = tag('status');
  return {
    taskId: tag('task-id'),
    toolUseId,
    status: statusRaw === 'completed' ? 'completed' : 'failed',
    summary: tag('summary'),
  };
}

export function isTaskLifecycleMarker(m: unknown): boolean {
  const msg = m as { type?: string; subtype?: string } | null;
  return !!msg && msg.type === 'system' && typeof msg.subtype === 'string' && msg.subtype.startsWith('task_');
}

// ---------------------------------------------------------------------------
// Translation: messages → events
// ---------------------------------------------------------------------------

/**
 * Translate the raw message stream into an ordered event log. Pure; only the
 * supplied messages drive output. The reducer in `applyEvents` then folds
 * these into `SubagentState`.
 *
 * The post-pass inference rule (`appendClosureFromParentResult`) is *not*
 * applied here — it needs to inspect the final state map and the message
 * array together, so it runs after this function.
 */
export function messagesToEvents(messages: ClaudeStreamMessage[]): SubagentEvent[] {
  const events: SubagentEvent[] = [];

  for (let i = 0; i < messages.length; i++) {
    const m = messages[i] as any;

    // 1. Dispatch — assistant tool_use blocks where the tool either is
    //    Agent/Task explicitly OR rides run_in_background:true (background
    //    Bash etc.). Without the background branch, long-running shell
    //    dispatches wouldn't surface until task_started fires.
    if (m?.type === 'assistant' && Array.isArray(m.message?.content)) {
      for (const block of m.message.content) {
        if (block?.type !== 'tool_use' || !block.id) continue;
        const isAgentTool = block.name === 'Agent' || block.name === 'Task';
        const isBackgroundDispatch = block.input?.run_in_background === true;
        if (!isAgentTool && !isBackgroundDispatch) continue;
        events.push({
          kind: 'Dispatched',
          toolUseId: block.id,
          messageIdx: i,
          description: block.input?.description ?? '',
          agentType: isAgentTool ? block.input?.subagent_type : undefined,
          isBackground: isBackgroundDispatch,
        });
      }
      continue;
    }

    // 2. Tool result blocks — surface as `ToolResult`. The reducer decides
    //    whether to interpret them as completion or as a background ACK
    //    based on the dispatch's `isBackground` flag, which was captured at
    //    Dispatched-event time.
    if (m?.type === 'user' && Array.isArray(m.message?.content)) {
      for (const block of m.message.content) {
        if (block?.type !== 'tool_result') continue;
        const id: string | undefined = block.tool_use_id;
        if (!id) continue;
        events.push({
          kind: 'ToolResult',
          toolUseId: id,
          isError: block.is_error === true,
          content: typeof block.content === 'string' ? block.content : undefined,
        });
      }
      continue;
    }

    // 3. Structured SDK task_* SystemMessages.
    if (isTaskLifecycleMarker(m)) {
      // task_updated rides a different shape from task_started /
      // task_progress / task_notification: keyed by `task_id` only
      // (no tool_use_id) and carries a `patch` object. Handle it
      // BEFORE the `if (!id) continue;` guard below, which would
      // otherwise drop it.
      if (m.subtype === 'task_updated' && typeof m.task_id === 'string' && m.patch && typeof m.patch === 'object') {
        const p = m.patch as Record<string, unknown>;
        events.push({
          kind: 'TaskUpdated',
          taskId: m.task_id,
          patch: {
            status: typeof p.status === 'string' ? (p.status as 'pending' | 'running' | 'completed' | 'failed' | 'killed') : undefined,
            description: typeof p.description === 'string' ? p.description : undefined,
            endTimeMs: typeof p.end_time === 'number' ? p.end_time : undefined,
            totalPausedMs: typeof p.total_paused_ms === 'number' ? p.total_paused_ms : undefined,
            error: typeof p.error === 'string' ? p.error : undefined,
            isBackgrounded: typeof p.is_backgrounded === 'boolean' ? p.is_backgrounded : undefined,
          },
        });
        continue;
      }

      const id: string | undefined = m.tool_use_id;
      if (!id) continue;
      if (m.subtype === 'task_started') {
        events.push({ kind: 'Started', toolUseId: id, taskId: m.task_id, description: m.description ?? '' });
      } else if (m.subtype === 'task_progress') {
        events.push({
          kind: 'Progress',
          toolUseId: id,
          description: m.description ?? '',
          lastToolName: m.last_tool_name,
          totalTokens: m.usage?.total_tokens,
          toolUses: m.usage?.tool_uses,
          durationMs: m.usage?.duration_ms,
          taskId: m.task_id,
        });
      } else if (m.subtype === 'task_notification') {
        events.push({
          kind: 'TaskNotification',
          toolUseId: id,
          status: m.status === 'completed' ? 'completed' : m.status === 'stopped' ? 'stopped' : 'failed',
          summary: m.summary,
          taskId: m.task_id,
          totalTokens: m.usage?.total_tokens,
          toolUses: m.usage?.tool_uses,
          durationMs: m.usage?.duration_ms,
        });
      }
      continue;
    }

    // 4. XML <task-notification> carriers — only present on JSONL replay or
    //    via the live JSONL tail.
    const xml = extractTaskNotificationXml(m);
    if (xml) {
      const parsed = parseTaskNotificationXml(xml);
      if (parsed) {
        events.push({
          kind: 'TaskNotificationXml',
          toolUseId: parsed.toolUseId,
          status: parsed.status,
          summary: parsed.summary,
          taskId: parsed.taskId,
        });
      }
    }
  }

  return events;
}

// ---------------------------------------------------------------------------
// Reducer: events → state map
// ---------------------------------------------------------------------------

const TERMINAL_STATUSES: ReadonlySet<SubagentStatus> = new Set<SubagentStatus>([
  'completed',
  'failed',
  'completed_inferred',
  'abandoned',
]);

function isTerminal(status: SubagentStatus): boolean {
  return TERMINAL_STATUSES.has(status);
}

function ensureState(map: Map<string, SubagentState>, id: string, init?: Partial<SubagentState>): SubagentState {
  let s = map.get(id);
  if (!s) {
    s = {
      toolUseId: id,
      description: '',
      status: 'running',
      latest: null,
      events: [],
      ...init,
    };
    map.set(id, s);
  } else if (init) {
    // Merge any newly-known metadata (description from Started when the
    // Dispatched event lacked one, agentType from a late Dispatched, etc.)
    if (init.description && !s.description) s.description = init.description;
    if (init.agentType && !s.agentType) s.agentType = init.agentType;
    if (init.isBackground !== undefined && s.isBackground === undefined) s.isBackground = init.isBackground;
  }
  return s;
}

/**
 * Apply the event log to a fresh state map. Terminal lock is intrinsic:
 * once a state reaches a terminal kind, subsequent events for that id are
 * mostly ignored — with two pragmatic exceptions:
 *
 *   - A later `TaskNotification` (structured SDK message) overwrites status
 *     and summary. This preserves the legacy precedence ("structured wins")
 *     so a richer carrier — which usually arrives slightly after a bare
 *     `tool_result` — can correct an earlier interpretation. The XML
 *     carrier does NOT do this; structured > XML > tool_result.
 *   - `Dispatched` after `Started` (lifecycle-only path) just enriches
 *     metadata; the reducer never re-enters from terminal.
 */
export function applyEvents(events: SubagentEvent[]): Map<string, SubagentState> {
  const byId = new Map<string, SubagentState>();

  for (const ev of events) {
    switch (ev.kind) {
      case 'Dispatched': {
        const s = ensureState(byId, ev.toolUseId, {
          description: ev.description,
          agentType: ev.agentType,
          isBackground: ev.isBackground,
        });
        if (ev.description && !s.description) s.description = ev.description;
        if (ev.agentType && !s.agentType) s.agentType = ev.agentType;
        if (ev.isBackground && s.isBackground === undefined) s.isBackground = true;
        break;
      }
      case 'Started': {
        const s = ensureState(byId, ev.toolUseId, { description: ev.description });
        if (!s.description) s.description = ev.description;
        if (ev.taskId) s.taskId = ev.taskId;
        if (!s.startedAt) s.startedAt = new Date().toISOString();
        break;
      }
      case 'Progress': {
        const s = ensureState(byId, ev.toolUseId);
        if (isTerminal(s.status)) break;
        const entry: SubagentProgressEntry = {
          description: ev.description,
          lastToolName: ev.lastToolName,
          totalTokens: ev.totalTokens,
          toolUses: ev.toolUses,
          durationMs: ev.durationMs,
        };
        s.events.push(entry);
        s.latest = entry;
        if (ev.taskId && !s.taskId) s.taskId = ev.taskId;
        break;
      }
      case 'ToolResult': {
        const s = byId.get(ev.toolUseId);
        if (!s) break;
        if (isTerminal(s.status)) break;
        // Background dispatches receive an immediate ACK `tool_result` —
        // "Async agent launched" / "Command running in background". That's
        // a dispatch confirmation, not a completion signal. Only an
        // is_error=true ACK counts (the dispatch itself failed); a success
        // ACK is ignored, and we wait for TaskNotification(Xml) or the
        // inferred-closure post-pass.
        if (s.isBackground && !ev.isError) break;
        s.status = ev.isError ? 'failed' : 'completed';
        s.closureSource = 'tool_result';
        s.endedAt = s.endedAt ?? new Date().toISOString();
        break;
      }
      case 'TaskNotification': {
        const s = ensureState(byId, ev.toolUseId);
        // Structured task_notification is the most authoritative carrier
        // (carries usage + a canonical summary). It overwrites any prior
        // terminal status set by ToolResult or XML.
        s.status = ev.status === 'completed' ? 'completed' : 'failed';
        s.closureSource = 'task_notification';
        s.summary = ev.summary ?? s.summary;
        if (ev.taskId && !s.taskId) s.taskId = ev.taskId;
        s.endedAt = new Date().toISOString();
        const finalEntry: SubagentProgressEntry = {
          description: ev.summary ?? s.description ?? '',
          totalTokens: ev.totalTokens,
          toolUses: ev.toolUses,
          durationMs: ev.durationMs,
        };
        s.events.push(finalEntry);
        s.latest = finalEntry;
        break;
      }
      case 'TaskNotificationXml': {
        const s = byId.get(ev.toolUseId);
        // Only act when we know the dispatch — never invent orphan subs
        // from a notification XML alone, since they routinely refer to
        // tool_uses from earlier turns we may not have in scope.
        if (!s) break;
        // XML carrier outranks ToolResult but loses to structured
        // TaskNotification. Skip if the row already finalised via the
        // structured path.
        if (s.closureSource === 'task_notification') break;
        s.status = ev.status === 'completed' ? 'completed' : 'failed';
        s.closureSource = 'task_notification_xml';
        s.summary = ev.summary ?? s.summary;
        if (ev.taskId && !s.taskId) s.taskId = ev.taskId;
        s.endedAt = new Date().toISOString();
        const finalEntry: SubagentProgressEntry = {
          description: ev.summary ?? s.description ?? '',
        };
        s.events.push(finalEntry);
        s.latest = finalEntry;
        break;
      }
      case 'TaskUpdated': {
        // Reverse-lookup state by taskId. SubagentState.taskId is set by
        // Started / Progress / Notification — task_updated for an
        // unknown taskId is silently dropped (no orphan creation).
        let s: SubagentState | undefined;
        for (const candidate of byId.values()) {
          if (candidate.taskId === ev.taskId) {
            s = candidate;
            break;
          }
        }
        if (!s) break;

        const { patch } = ev;
        // Mid-flight metadata: applied unconditionally (does not conflict
        // with terminal lock, since these don't change closure semantics).
        if (patch.isBackgrounded !== undefined) {
          s.isBackground = patch.isBackgrounded;
        }
        if (patch.description) {
          s.description = patch.description;
        }
        if (patch.error) {
          s.error = patch.error;
        }

        // Status / endedAt: TaskNotification is the canonical closure
        // carrier. If a TaskNotification has already finalized this row,
        // task_updated must NOT contradict it. Otherwise apply.
        if (s.closureSource !== 'task_notification' && patch.status) {
          if (patch.status === 'completed') {
            s.status = 'completed';
            s.closureSource = 'task_updated';
          } else if (patch.status === 'failed' || patch.status === 'killed') {
            s.status = 'failed';
            s.closureSource = 'task_updated';
          }
          // 'pending' / 'running' patches do not lift terminal status —
          // once a row is terminal, we don't un-finish it.
        }

        if (patch.endTimeMs !== undefined && isTerminal(s.status)) {
          s.endedAt = new Date(patch.endTimeMs).toISOString();
        }
        break;
      }
      case 'ClosedByParentResult': {
        const s = byId.get(ev.toolUseId);
        if (!s) break;
        if (isTerminal(s.status)) break;
        s.status = 'completed_inferred';
        s.closureSource = 'parent_result';
        s.endedAt = s.endedAt ?? new Date().toISOString();
        break;
      }
    }
  }

  return byId;
}

// ---------------------------------------------------------------------------
// Post-pass: inferred closure from parent `result`
// ---------------------------------------------------------------------------

/**
 * For each subagent still in `running`, if a `type: 'result'` exists in the
 * message array at or after its dispatch index AND the result is not the
 * most recent message in the array, emit `ClosedByParentResult`. The
 * "result is not the latest" condition is intentional: when the result is
 * the latest message, the session is awaiting input and a long-running
 * background may still legitimately be in flight — the JSONL tail (or a
 * future watchdog) should resolve those, not this rule.
 *
 * Pass `dispatchIndices` so we don't re-scan messages for each subagent.
 * The caller already has them from translation.
 */
export function inferredClosureEvents(
  messages: ClaudeStreamMessage[],
  states: Map<string, SubagentState>,
  dispatchIndices: Map<string, number>,
): SubagentEvent[] {
  if (messages.length === 0) return [];
  const out: SubagentEvent[] = [];
  for (const [id, s] of states.entries()) {
    if (s.status !== 'running') continue;
    const dispatchedAt = dispatchIndices.get(id);
    if (dispatchedAt === undefined) continue;
    let resultIdx = -1;
    for (let i = dispatchedAt + 1; i < messages.length; i++) {
      if ((messages[i] as any)?.type === 'result') {
        resultIdx = i;
        break;
      }
    }
    if (resultIdx === -1) continue;
    // Same conservative guard as the legacy orphan heuristic: only infer
    // closure when the parent has clearly advanced past the result. If
    // result is the last message the session may still be awaiting a
    // legitimate background — leave it as `running`.
    if (resultIdx >= messages.length - 1) continue;
    out.push({ kind: 'ClosedByParentResult', toolUseId: id });
  }
  return out;
}

/**
 * Extract `Dispatched` events' message indices for use by
 * `inferredClosureEvents`. Pulled out so callers don't reach into event
 * shapes.
 */
export function dispatchIndicesFromEvents(events: SubagentEvent[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const ev of events) {
    if (ev.kind === 'Dispatched' && !out.has(ev.toolUseId)) {
      out.set(ev.toolUseId, ev.messageIdx);
    }
  }
  return out;
}
