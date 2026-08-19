/**
 * Event-sourced derivation of subagent state from the Claude CLI
 * stream. Two layers:
 *
 *   1. `messagesToEvents(messages)` — pure translation from CLI / JSONL
 *      messages into a typed `SubagentEvent` log. This is the only place
 *      that knows about CLI message shapes; the rest of the derivation
 *      operates on events.
 *   2. `applyEvents(events)` — pure reducer that builds per-`tool_use_id`
 *      `SubagentState` from the event log. Terminal status is intrinsic:
 *      once a state hits a terminal kind the reducer ignores further
 *      events for that id (no late `task_progress` can un-complete a row).
 *
 * Closure signals carry a `source` so consumers can render differently
 * for "real" completions vs `completed_inferred` (parent emitted `result`
 * but we never saw a direct closure carrier — usually because the CLI
 * stream doesn't yield the `queue-operation` / `attachment` envelopes
 * that the CLI uses for background-Bash completion).
 *
 * The renderer's `subagentStreams.ts` wraps these two functions plus the
 * post-pass inference rule to produce the legacy `Subagent[]` shape.
 */

import type { JsonlNode } from '@/types/jsonl';
import type { MessageContentBlock } from '@/types/claudeStream';

/**
 * Per-variant shapes for CLI task messages. The wire payloads come from
 * the CLI directly (via `system+task_*` messages on the claude-output
 * channel); the field sets here mirror what the CLI emits.
 */
interface CliTaskStartedMessage {
  type: 'system';
  subtype: 'task_started';
  task_id?: string;
  tool_use_id?: string;
  description?: string;
  [k: string]: unknown;
}
interface CliTaskProgressMessage {
  type: 'system';
  subtype: 'task_progress';
  task_id?: string;
  tool_use_id?: string;
  description?: string;
  last_tool_name?: string;
  usage: { total_tokens?: number; tool_uses?: number; duration_ms?: number };
  [k: string]: unknown;
}
interface CliTaskNotificationMessage {
  type: 'system';
  subtype: 'task_notification';
  task_id?: string;
  tool_use_id?: string;
  status?: 'completed' | 'failed' | 'stopped' | string;
  summary?: string;
  usage?: { total_tokens?: number; tool_uses?: number; duration_ms?: number };
  [k: string]: unknown;
}
interface CliTaskUpdatedMessage {
  type: 'system';
  subtype: 'task_updated';
  task_id?: string;
  patch?: Record<string, unknown>;
  [k: string]: unknown;
}

/** Type predicate covering every task_* lifecycle subtype the renderer cares about. */
type TaskLifecycleMessage =
  | CliTaskStartedMessage
  | CliTaskProgressMessage
  | CliTaskNotificationMessage
  | CliTaskUpdatedMessage;

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
  /** Set from `CliTaskUpdatedMessage.patch.error` when the CLI reports a
   *  subagent failure. `task_notification` summaries don't carry an
   *  error string per se; this is the only carrier for it. */
  error?: string;
  /** For a task a subagent owns rather than the session: the tool_use id of
   *  the agent that started it. Drives the indented rendering in
   *  SubagentBar, matching the nested rows applySubagentMeta synthesises. */
  parentToolUseId?: string;
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
  | {
      kind: 'Started';
      toolUseId: string;
      taskId: string;
      description: string;
      /** Set when the task belongs to a subagent (`owned_by_subagent`):
       *  the tool_use id of the agent that owns it, so the row renders
       *  nested under it instead of as a sibling of the session's own
       *  agents. */
      ownerToolUseId?: string;
    }
  | { kind: 'Progress'; toolUseId: string; description: string; lastToolName?: string; totalTokens?: number; toolUses?: number; durationMs?: number; taskId?: string }
  | {
      kind: 'ToolResult';
      toolUseId: string;
      isError: boolean;
      /** This result is a background-launch ACK, not a return value — so the
       *  reducer must not close the row on it. Set when the result side says
       *  so, which is the only place CLI ≥2.1.232 says it at all: agent
       *  spawns are backgrounded by default there, so the dispatch input
       *  carries no `run_in_background` to gate on. */
      isBackgroundAck?: boolean;
    }
  | { kind: 'TaskNotification'; toolUseId: string; status: 'completed' | 'failed' | 'stopped'; summary?: string; taskId?: string; totalTokens?: number; toolUses?: number; durationMs?: number }
  | { kind: 'TaskNotificationXml'; toolUseId: string; status: 'completed' | 'failed'; summary?: string; taskId?: string; totalTokens?: number; toolUses?: number; durationMs?: number }
  | {
      // CliTaskUpdatedMessage patch — wire-safe TaskState changes
      // (status, description, end_time, error, is_backgrounded, …).
      // Keyed by `taskId` (NOT `toolUseId`) because the CLI message
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
  | {
      // A finished agent was re-opened with SendMessage. Keyed by the agent id
      // the CLI reports, which is the same id its notifications carry as
      // `<task-id>` — so the row is found the same way the task-id fallback
      // finds it. `messageIdx` re-anchors the inferred-closure guard: a
      // `result` from before the resume says nothing about the new run.
      kind: 'AgentResumed';
      taskId: string;
      messageIdx: number;
    }
  | { kind: 'ClosedByParentResult'; toolUseId: string }
  | {
      // Live-forwarded subagent narration (--forward-subagent-text).
      // Text of the subagent's latest assistant message (thinking fallback),
      // shown as the row's progress line between task_progress ticks.
      kind: 'ForwardedText';
      toolUseId: string;
      text: string;
    };

// ---------------------------------------------------------------------------
// XML extraction (queue-operation / attachment.queued_command carriers)
// ---------------------------------------------------------------------------

// XML <task-notification>...</task-notification> payloads ride two envelopes:
//   - { type: 'queue-operation', operation: 'enqueue', content: '<task-notification>...' }
//   - { type: 'attachment', attachment: { type: 'queued_command', prompt: '<task-notification>...' } }
// Both surface the completion of a run_in_background dispatch in lieu of a
// structured CliTaskNotificationMessage. The live CLI stream does NOT yield
// these envelopes (they're not in the CliMessage union); they only land in the
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

/**
 * True when a queue-operation / attachment envelope's whole payload is a
 * `<task-notification>` — i.e. the row carries subagent bookkeeping and
 * nothing a reader wants in the transcript.
 *
 * Deliberately broader than `extractTaskNotificationXml`: that one accepts
 * only `enqueue`, because applying the `remove` twin as a second closure
 * would double-apply the notification. For *display* both twins are equally
 * noise, and the CLI emits both for every backgrounded completion. The
 * queued-prompt case is the one this must not match — those enqueues carry
 * the user's own text and are the only record that a prompt was queued.
 */
export function isTaskNotificationCarrier(m: unknown): boolean {
  if (!m || typeof m !== 'object') return false;
  const any = m as Record<string, unknown>;
  if (any.type === 'queue-operation') {
    const content = any.content;
    return typeof content === 'string' && content.includes('<task-notification>');
  }
  if (any.type === 'attachment') {
    const att = any.attachment as { type?: string; prompt?: unknown } | undefined;
    return (
      att?.type === 'queued_command' &&
      typeof att.prompt === 'string' &&
      att.prompt.includes('<task-notification>')
    );
  }
  return false;
}

interface ParsedTaskNotification {
  taskId?: string;
  toolUseId: string;
  status: 'completed' | 'failed';
  summary?: string;
  /** From the `<usage>` block. Since CLI 2.1.232 backgrounds agent spawns by
   *  default, this is the only carrier of a subagent's run stats that reaches
   *  the JSONL: the async-launch ACK's `toolUseResult` has no totals for
   *  `readSubagentMeta` to read, and no structured `task_notification` line is
   *  written. Absent on older/other carriers, hence all-optional. */
  totalTokens?: number;
  toolUses?: number;
  durationMs?: number;
}

function parseTaskNotificationXml(text: string): ParsedTaskNotification | null {
  const tag = (name: string): string | undefined => {
    const re = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`);
    const m = text.match(re);
    return m ? m[1].trim() : undefined;
  };
  const numTag = (name: string): number | undefined => {
    const raw = tag(name);
    if (raw === undefined) return undefined;
    const n = Number.parseInt(raw, 10);
    return Number.isFinite(n) ? n : undefined;
  };
  const toolUseId = tag('tool-use-id');
  if (!toolUseId) return null;
  const statusRaw = tag('status');
  return {
    taskId: tag('task-id'),
    toolUseId,
    status: statusRaw === 'completed' ? 'completed' : 'failed',
    summary: tag('summary'),
    // `subagent_tokens`, not `total_tokens` — the XML block spells these
    // differently from the structured `task_notification` usage object.
    totalTokens: numTag('subagent_tokens'),
    toolUses: numTag('tool_uses'),
    durationMs: numTag('duration_ms'),
  };
}

export function isTaskLifecycleMarker(m: unknown): m is TaskLifecycleMessage {
  if (!m || typeof m !== 'object') return false;
  const obj = m as { type?: unknown; subtype?: unknown };
  if (obj.type !== 'system') return false;
  return typeof obj.subtype === 'string' && obj.subtype.startsWith('task_');
}

// ---------------------------------------------------------------------------
// Translation: messages → events
// ---------------------------------------------------------------------------

/** Cap forwarded narration entries so a subagent's multi-page final report
 *  doesn't bloat the per-row event log the expanded SubagentBar renders. */
const FORWARDED_TEXT_MAX_LENGTH = 500;

/**
 * Extract the narration line from a forwarded subagent assistant envelope:
 * concatenated `text` blocks first, `thinking` blocks as the fallback
 * (early in a turn only thinking has streamed). Empty string when the
 * message carries neither (e.g. a tool_use-only frame).
 */
function forwardedNarration(raw: Record<string, unknown>): string {
  const content = (raw as { message?: { content?: unknown } }).message?.content;
  if (!Array.isArray(content)) return '';
  let text = '';
  let thinking = '';
  for (const block of content as Array<{ type?: string; text?: unknown; thinking?: unknown }>) {
    if (block.type === 'text' && typeof block.text === 'string') text += block.text;
    else if (block.type === 'thinking' && typeof block.thinking === 'string') thinking += block.thinking;
  }
  const chosen = (text.trim() || thinking.trim());
  return chosen.length > FORWARDED_TEXT_MAX_LENGTH
    ? `${chosen.slice(0, FORWARDED_TEXT_MAX_LENGTH)}…`
    : chosen;
}

// The ACK the CLI returns the instant a backgrounded agent launches. Prefix
// only: the full string continues into an instruction not to quote it and the
// agentId, both of which have already changed wording once.
const ASYNC_LAUNCH_ACK_PREFIX = 'Async agent launched';

/**
 * Does the tool_result line carry the CLI's async-launch enrichment?
 *
 * `toolUseResult` is written onto the on-disk JSONL line (never the live
 * stream-json output), so this is the reliable signal in TUI mode — which
 * tails that file — and absent in chat mode. `status: 'async_launched'` and
 * `isAsync: true` ride together; either alone is enough.
 */
function isAsyncLaunchEnrichment(raw: unknown): boolean {
  const tur = (raw as { toolUseResult?: unknown } | null)?.toolUseResult;
  if (!tur || typeof tur !== 'object') return false;
  const o = tur as { status?: unknown; isAsync?: unknown };
  return o.status === 'async_launched' || o.isAsync === true;
}

/** First text payload of a tool_result block, whichever shape it rides. */
function toolResultText(content: unknown): string | undefined {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return undefined;
  const first = content.find((b) => (b as { type?: unknown })?.type === 'text');
  const text = (first as { text?: unknown } | undefined)?.text;
  return typeof text === 'string' ? text : undefined;
}

/**
 * The agent id a SendMessage result reports having re-opened, or null.
 *
 * Structured first (`toolUseResult.resumedAgentId`, written onto the on-disk
 * JSONL), then the same field out of the JSON blob the tool returns as text,
 * which is all the live stream carries. SendMessage also addresses other
 * Claude sessions — those results carry no `resumedAgentId`, so this stays
 * silent for them.
 */
function resumedAgentId(raw: unknown, blockContent: unknown): string | null {
  const tur = (raw as { toolUseResult?: unknown } | null)?.toolUseResult;
  if (tur && typeof tur === 'object') {
    const id = (tur as { resumedAgentId?: unknown }).resumedAgentId;
    if (typeof id === 'string' && id.length > 0) return id;
  }
  const text = toolResultText(blockContent);
  if (text === undefined) return null;
  const m = /"resumedAgentId"\s*:\s*"([^"]+)"/.exec(text);
  return m ? m[1] : null;
}

/**
 * Fallback for the live stream, where the enrichment above never arrives.
 *
 * `content` rides both shapes: a bare string, or the content-block array
 * (`[{type:'text', text}]`) that a real 2.1.232 transcript persists. Only the
 * first text block matters — the ACK leads with its marker sentence.
 */
function isAsyncLaunchText(content: unknown): boolean {
  if (typeof content === 'string') return content.startsWith(ASYNC_LAUNCH_ACK_PREFIX);
  if (!Array.isArray(content)) return false;
  const first = content.find((b) => (b as { type?: unknown })?.type === 'text');
  const text = (first as { text?: unknown } | undefined)?.text;
  return typeof text === 'string' && text.startsWith(ASYNC_LAUNCH_ACK_PREFIX);
}

/**
 * Translate the raw message stream into an ordered event log. Pure; only the
 * supplied messages drive output. The reducer in `applyEvents` then folds
 * these into `SubagentState`.
 *
 * The post-pass inference rule (`appendClosureFromParentResult`) is *not*
 * applied here — it needs to inspect the final state map and the message
 * array together, so it runs after this function.
 */
/**
 * Map every tool_use a subagent issued to the agent that issued it.
 *
 * When one of those tool_uses is backgrounded the CLI announces it with a
 * `task_started` carrying `owned_by_subagent: true` and the block's own id —
 * but never the owner's. The forwarded frame's `parent_tool_use_id` is the
 * only place that edge exists, so without this the shell surfaced as a
 * top-level row indistinguishable from one of the session's own agents.
 *
 * Every tool_use block is recorded, not just the ones that look
 * backgroundable: the cost is a map entry, and a guess that misses puts the
 * row back at top level.
 */
function collectSubagentOwnedToolUses(messages: JsonlNode[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of messages) {
    if (m.kind !== 'assistant') continue;
    const raw = (m as unknown as { raw?: Record<string, unknown> }).raw ?? {};
    const parentId = (raw as { parent_tool_use_id?: unknown }).parent_tool_use_id;
    if (typeof parentId !== 'string' || parentId.length === 0) continue;
    const blocks = (raw as { message?: { content?: unknown } }).message?.content;
    if (!Array.isArray(blocks)) continue;
    for (const block of blocks as MessageContentBlock[]) {
      if (block.type === 'tool_use' && block.id) out.set(block.id, parentId);
    }
  }
  return out;
}

export function messagesToEvents(messages: JsonlNode[]): SubagentEvent[] {
  const events: SubagentEvent[] = [];
  // tool_use id -> the agent that issued it. Harvested in a pre-pass rather
  // than inline: the engine's assistant resolver buffers each committed
  // frame on its own parent-chain key and flushes it only when that chain
  // emits again, so a subagent's `task_started` routinely reaches the
  // renderer BEFORE the forwarded frame naming its owner. Verified on a
  // recorded 2.1.235 stream — harvesting inline nested nothing.
  const subagentOwnedToolUses = collectSubagentOwnedToolUses(messages);

  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    const raw = (m as unknown as { raw?: Record<string, unknown> }).raw ?? {};

    // 0. Live-forwarded subagent narration (--forward-subagent-text, CLI
    //    ≥2.1.211): assistant envelopes tagged with the dispatching Task's
    //    tool_use_id. Their text (or thinking, when no text block landed)
    //    becomes the row's live progress line. Handled before the dispatch
    //    scan so a subagent's own nested tool_use blocks can't create
    //    phantom rows in the parent's bar.
    if (m.kind === 'assistant') {
      const parentId = (raw as { parent_tool_use_id?: unknown }).parent_tool_use_id;
      if (typeof parentId === 'string' && parentId.length > 0) {
        const text = forwardedNarration(raw);
        if (text) events.push({ kind: 'ForwardedText', toolUseId: parentId, text });
        continue;
      }
    }

    // 1. Dispatch — assistant tool_use blocks where the tool either is
    //    Agent/Task explicitly OR rides run_in_background:true (background
    //    Bash etc.). Without the background branch, long-running shell
    //    dispatches wouldn't surface until task_started fires.
    if (m.kind === 'assistant') {
      const content = (raw as { message?: { content?: unknown } }).message?.content;
      if (Array.isArray(content)) {
        for (const block of content as MessageContentBlock[]) {
          if (block.type !== 'tool_use' || !block.id) continue;
          const isAgentTool = block.name === 'Agent' || block.name === 'Task';
          const input = block.input;
          const isBackgroundDispatch = input.run_in_background === true;
          if (!isAgentTool && !isBackgroundDispatch) continue;
          events.push({
            kind: 'Dispatched',
            toolUseId: block.id,
            messageIdx: i,
            description: typeof input.description === 'string' ? input.description : '',
            agentType: isAgentTool && typeof input.subagent_type === 'string' ? input.subagent_type : undefined,
            isBackground: isBackgroundDispatch,
          });
        }
        continue;
      }
    }

    // 2. Tool result blocks — surface as `ToolResult`. The reducer decides
    //    whether to interpret them as completion or as a background ACK
    //    based on the dispatch's `isBackground` flag, which was captured at
    //    Dispatched-event time.
    if (m.kind === 'user') {
      const content = (raw as { message?: { content?: unknown } }).message?.content;
      if (Array.isArray(content)) {
        const enrichedAck = isAsyncLaunchEnrichment(raw);
        for (const block of content as MessageContentBlock[]) {
          if (block.type !== 'tool_result') continue;
          const id = block.tool_use_id;
          if (!id) continue;
          // A SendMessage result that re-opened an agent: the row it names is
          // working again, whatever its last notification said.
          const resumed = resumedAgentId(raw, block.content);
          if (resumed) {
            events.push({ kind: 'AgentResumed', taskId: resumed, messageIdx: i });
            continue;
          }
          events.push({
            kind: 'ToolResult',
            toolUseId: id,
            isError: block.is_error === true,
            isBackgroundAck: enrichedAck || isAsyncLaunchText(block.content),
          });
        }
        continue;
      }
    }

    // 3. Structured CLI task_* SystemMessages.
    if (isTaskLifecycleMarker(raw)) {
      // `raw` is narrowed to TaskLifecycleMessage here. Access all fields via raw.
      const tlm = raw as TaskLifecycleMessage;
      // task_updated rides a different shape from task_started /
      // task_progress / task_notification: keyed by `task_id` only
      // (no tool_use_id) and carries a `patch` object. Handle it as
      // its own branch so TS can narrow `raw` for the tool_use_id-bearing
      // siblings below.
      if (tlm.subtype === 'task_updated') {
        if (typeof tlm.task_id === 'string' && tlm.patch && typeof tlm.patch === 'object') {
          const p = tlm.patch as Record<string, unknown>;
          events.push({
            kind: 'TaskUpdated',
            taskId: tlm.task_id,
            patch: {
              status: typeof p.status === 'string' ? (p.status as 'pending' | 'running' | 'completed' | 'failed' | 'killed') : undefined,
              description: typeof p.description === 'string' ? p.description : undefined,
              endTimeMs: typeof p.end_time === 'number' ? p.end_time : undefined,
              totalPausedMs: typeof p.total_paused_ms === 'number' ? p.total_paused_ms : undefined,
              error: typeof p.error === 'string' ? p.error : undefined,
              isBackgrounded: typeof p.is_backgrounded === 'boolean' ? p.is_backgrounded : undefined,
            },
          });
        }
        continue;
      }

      // Remaining variants (task_started, task_progress, task_notification) all
      // share the optional `tool_use_id` field. Skip if absent.
      const id = tlm.tool_use_id;
      if (!id) continue;
      if (tlm.subtype === 'task_started') {
        const ownedBySubagent = (tlm as { owned_by_subagent?: unknown }).owned_by_subagent === true;
        events.push({
          kind: 'Started',
          toolUseId: id,
          taskId: tlm.task_id ?? '',
          description: tlm.description ?? '',
          ownerToolUseId: ownedBySubagent ? subagentOwnedToolUses.get(id) : undefined,
        });
      } else if (tlm.subtype === 'task_progress') {
        const tlmProg = tlm as CliTaskProgressMessage;
        events.push({
          kind: 'Progress',
          toolUseId: id,
          description: tlmProg.description ?? '',
          lastToolName: tlmProg.last_tool_name,
          totalTokens: tlmProg.usage.total_tokens,
          toolUses: tlmProg.usage.tool_uses,
          durationMs: tlmProg.usage.duration_ms,
          taskId: tlmProg.task_id,
        });
      } else {
        // task_notification
        const tlmNotif = tlm as CliTaskNotificationMessage;
        events.push({
          kind: 'TaskNotification',
          toolUseId: id,
          status: tlmNotif.status === 'completed' ? 'completed' : tlmNotif.status === 'stopped' ? 'stopped' : 'failed',
          summary: tlmNotif.summary,
          taskId: tlmNotif.task_id,
          totalTokens: tlmNotif.usage?.total_tokens,
          toolUses: tlmNotif.usage?.tool_uses,
          durationMs: tlmNotif.usage?.duration_ms,
        });
      }
      continue;
    }

    // 4. XML <task-notification> carriers — only present on JSONL replay or
    //    via the live JSONL tail.
    const xml = extractTaskNotificationXml(raw);
    if (xml) {
      const parsed = parseTaskNotificationXml(xml);
      if (parsed) {
        events.push({
          kind: 'TaskNotificationXml',
          toolUseId: parsed.toolUseId,
          status: parsed.status,
          summary: parsed.summary,
          taskId: parsed.taskId,
          totalTokens: parsed.totalTokens,
          toolUses: parsed.toolUses,
          durationMs: parsed.durationMs,
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
 *   - A later `TaskNotification` (structured CLI message) overwrites status
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
        if (ev.ownerToolUseId && !s.parentToolUseId) s.parentToolUseId = ev.ownerToolUseId;
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
      case 'ForwardedText': {
        // Narration only ever attaches to an already-dispatched row —
        // byId.get, not ensureState, so an orphan parent id (nested
        // subagent, replay edge) can't create a phantom row.
        const s = byId.get(ev.toolUseId);
        if (!s) break;
        if (isTerminal(s.status)) break;
        // Carry the numeric tally forward from the previous entry so the
        // row's meta bits (tokens/tools/elapsed) don't blank out between
        // task_progress ticks.
        const entry: SubagentProgressEntry = {
          description: ev.text,
          lastToolName: s.latest?.lastToolName,
          totalTokens: s.latest?.totalTokens,
          toolUses: s.latest?.toolUses,
          durationMs: s.latest?.durationMs,
        };
        s.events.push(entry);
        s.latest = entry;
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
        //
        // `isBackgroundAck` is the same rule keyed off the result rather than
        // the dispatch, and since CLI 2.1.232 it is the only one that fires
        // for a plain agent spawn: backgrounding became the default, so the
        // input no longer carries `run_in_background`. Backfilling
        // `isBackground` keeps the row's later events on the background path.
        if (ev.isBackgroundAck && !ev.isError) s.isBackground = true;
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
        // Resuming a finished agent (SendMessage) produces a notification
        // keyed to the SendMessage's tool_use_id, which dispatched no row —
        // but its `<task-id>` is still the original agent's, so fall back to
        // that. Verified against a real resume, where the second run's totals
        // were otherwise dropped on the floor.
        let s = byId.get(ev.toolUseId);
        if (!s && ev.taskId) {
          for (const candidate of byId.values()) {
            if (candidate.taskId === ev.taskId) { s = candidate; break; }
          }
        }
        // Only act when we know the row — never invent orphan subs from a
        // notification XML alone, since they routinely refer to tool_uses
        // from earlier turns we may not have in scope.
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
          // Fall back to the running tallies when the XML omits `<usage>`, so
          // a carrier without stats doesn't blank numbers the row already had.
          totalTokens: ev.totalTokens ?? s.latest?.totalTokens,
          toolUses: ev.toolUses ?? s.latest?.toolUses,
          durationMs: ev.durationMs ?? s.latest?.durationMs,
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
      case 'AgentResumed': {
        // Reverse-lookup by taskId, exactly as TaskUpdated does. No match is
        // the normal case for a cross-session SendMessage — stay quiet.
        let s: SubagentState | undefined;
        for (const candidate of byId.values()) {
          if (candidate.taskId === ev.taskId) { s = candidate; break; }
        }
        if (!s) break;
        // The one place a terminal row legitimately reopens: the agent is
        // demonstrably working again. Clear the closure so the next
        // notification is treated as a fresh one.
        s.status = 'running';
        s.closureSource = undefined;
        s.endedAt = undefined;
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
  messages: JsonlNode[],
  states: Map<string, SubagentState>,
  dispatchIndices: Map<string, number>,
): SubagentEvent[] {
  if (messages.length === 0) return [];
  const out: SubagentEvent[] = [];
  for (const [id, s] of states.entries()) {
    if (s.status !== 'running') continue;
    // A backgrounded dispatch outlives the turn that launched it, so the
    // parent's `result` is not evidence that it finished. Since CLI 2.1.232
    // backgrounds agent spawns by default the parent's turn typically ends
    // seconds after the launch ACK and minutes before the agent returns —
    // inferring closure there showed a live 12-minute agent as done three
    // seconds in, and let "Clear done" delete it. Background rows close on
    // their own carrier instead: `task_notification` in the live stream, or
    // the `queue-operation` / `attachment` XML the JSONL tail forwards. If
    // that carrier is genuinely lost the row stays `running` — honest, and
    // dismissible — rather than lying about work still in flight.
    if (s.isBackground) continue;
    const dispatchedAt = dispatchIndices.get(id);
    if (dispatchedAt === undefined) continue;
    let resultIdx = -1;
    for (let i = dispatchedAt + 1; i < messages.length; i++) {
      // result messages arrive as kind:'cli-stream-result'
      const node = messages[i];
      if (node.kind === 'cli-stream-result') {
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
