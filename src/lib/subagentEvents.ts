import type { JsonlNode } from '@/types/jsonl';
import type { MessageContentBlock } from '@/types/claudeStream';

interface CliTaskStartedMessage {
  type: 'system';
  subtype: 'task_started';
  task_id?: string;
  tool_use_id?: string;
  description?: string;
  /** Not activity (skip_transcript tasks, watchers): hosts exclude it from activity indicators. */
  ambient?: boolean;
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
  /** The agent's progress label; only on some frames, and only with agentProgressSummaries. */
  summary?: string;
  [k: string]: unknown;
}
interface CliTaskNotificationMessage {
  type: 'system';
  subtype: 'task_notification';
  task_id?: string;
  tool_use_id?: string;
  status?: 'completed' | 'failed' | 'stopped' | (string & {});
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

type TaskLifecycleMessage =
  | CliTaskStartedMessage
  | CliTaskProgressMessage
  | CliTaskNotificationMessage
  | CliTaskUpdatedMessage;

export type SubagentStatus =
  | 'running'
  | 'completed'
  | 'failed'
  | 'completed_inferred'
  | 'abandoned';

export interface SubagentProgressEntry {
  description: string;
  summary?: string;
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
  prompt?: string;
  status: SubagentStatus;
  startedAt?: string;
  endedAt?: string;
  latest: SubagentProgressEntry | null;
  events: SubagentProgressEntry[];
  summary?: string;
  progressSummary?: string;
  /** run_in_background: its immediate ACK tool_result is not a completion. */
  isBackground?: boolean;
  error?: string;
  parentToolUseId?: string;
  closureSource?: 'tool_result' | 'task_notification' | 'task_notification_xml' | 'task_updated' | 'parent_result';
  /** Hidden from countActiveSubagents, but still listed. */
  ambient?: boolean;
  /** Live-frame model; the disk meta's model, once read, takes precedence. */
  model?: string;
}

export type SubagentEvent =
  | { kind: 'Dispatched'; toolUseId: string; messageIdx: number; description: string; agentType?: string; isBackground: boolean; prompt?: string }
  | {
      kind: 'Started';
      toolUseId: string;
      taskId: string;
      description: string;
      ownerToolUseId?: string;
      ambient?: boolean;
    }
  | { kind: 'Progress'; toolUseId: string; description: string; summary?: string; lastToolName?: string; totalTokens?: number; toolUses?: number; durationMs?: number; taskId?: string }
  | {
      kind: 'ToolResult';
      toolUseId: string;
      isError: boolean;
      /** Launch ACK, not a return. CLI ≥2.1.232 backgrounds spawns by default, so only the result side says so. */
      isBackgroundAck?: boolean;
    }
  | { kind: 'TaskNotification'; toolUseId: string; status: 'completed' | 'failed' | 'stopped'; summary?: string; taskId?: string; totalTokens?: number; toolUses?: number; durationMs?: number }
  | { kind: 'TaskNotificationXml'; toolUseId: string; status: 'completed' | 'failed'; summary?: string; taskId?: string; totalTokens?: number; toolUses?: number; durationMs?: number }
  | {
      // Keyed by taskId: task_updated carries no tool_use_id.
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
      // SendMessage reopened a finished agent. messageIdx re-anchors the inferred-closure guard.
      kind: 'AgentResumed';
      taskId: string;
      messageIdx: number;
    }
  | { kind: 'ClosedByParentResult'; toolUseId: string }
  | {
      kind: 'Forwarded';
      toolUseId: string;
      text: string;
      /** CLI >= 2.1.292; unchanged across a SendMessage resume. */
      agentId?: string;
      model?: string;
    };

// Only JSONL replay / the JSONL tail carry these envelopes; the live stream does not.
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

// Broader than extractTaskNotificationXml (which takes only `enqueue`, else the `remove` twin
// double-closes). Must not match queued prompts: those enqueues carry the user's text.
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
  /** Since CLI 2.1.232, the only carrier of a subagent's run stats that reaches the JSONL. */
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
    // The XML spells it subagent_tokens, not total_tokens.
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

const FORWARDED_TEXT_MAX_LENGTH = 500;

export function forwardedAgentId(raw: Record<string, unknown>): string | undefined {
  const id = raw.agent_id;
  return typeof id === 'string' && id.length > 0 ? id : undefined;
}

/** `<synthetic>` marks a CLI-made message (an API error), not a model. */
export function forwardedModel(raw: Record<string, unknown>): string | undefined {
  const model = (raw as { message?: { model?: unknown } }).message?.model;
  return typeof model === 'string' && model.length > 0 && model !== '<synthetic>' ? model : undefined;
}

export function forwardedNarration(raw: Record<string, unknown>): string {
  const content = (raw as { message?: { content?: unknown } }).message?.content;
  if (!Array.isArray(content)) return '';
  let text = '';
  let thinking = '';
  for (const block of content as { type?: string; text?: unknown; thinking?: unknown }[]) {
    if (block.type === 'text' && typeof block.text === 'string') text += block.text;
    else if (block.type === 'thinking' && typeof block.thinking === 'string') thinking += block.thinking;
  }
  const chosen = (text.trim() || thinking.trim());
  return chosen.length > FORWARDED_TEXT_MAX_LENGTH
    ? `${chosen.slice(0, FORWARDED_TEXT_MAX_LENGTH)}…`
    : chosen;
}

// Prefix only: the rest of the ACK's wording has changed before.
const ASYNC_LAUNCH_ACK_PREFIX = 'Async agent launched';

// Reads only the on-disk spelling (toolUseResult); live stream-json spells it tool_use_result.
function isAsyncLaunchEnrichment(raw: unknown): boolean {
  const tur = (raw as { toolUseResult?: unknown } | null)?.toolUseResult;
  if (!tur || typeof tur !== 'object') return false;
  const o = tur as { status?: unknown; isAsync?: unknown };
  return o.status === 'async_launched' || o.isAsync === true;
}

function toolResultText(content: unknown): string | undefined {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return undefined;
  const first: unknown = content.find((b) => (b as { type?: unknown })?.type === 'text');
  const text = (first as { text?: unknown } | undefined)?.text;
  return typeof text === 'string' ? text : undefined;
}

// The text fallback covers the live stream, which spells the structured payload tool_use_result.
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

function isAsyncLaunchText(content: unknown): boolean {
  if (typeof content === 'string') return content.startsWith(ASYNC_LAUNCH_ACK_PREFIX);
  if (!Array.isArray(content)) return false;
  const first: unknown = content.find((b) => (b as { type?: unknown })?.type === 'text');
  const text = (first as { text?: unknown } | undefined)?.text;
  return typeof text === 'string' && text.startsWith(ASYNC_LAUNCH_ACK_PREFIX);
}

// task_started with owned_by_subagent never names the owner; only forwarded frames' parent_tool_use_id does.
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

// The kickoff prompt is the only evidence a Skill forked. A row for an inline skill would stay running forever.
function collectForkedSkillDispatches(
  messages: JsonlNode[],
): Map<string, { agentType?: string; description?: string }> {
  const out = new Map<string, { agentType?: string; description?: string }>();
  for (const m of messages) {
    if (m.kind !== 'user') continue;
    const raw = (m as unknown as { raw?: Record<string, unknown> }).raw ?? {};
    const parentId = (raw as { parent_tool_use_id?: unknown }).parent_tool_use_id;
    if (typeof parentId !== 'string' || parentId.length === 0) continue;
    const agentType = (raw as { subagent_type?: unknown }).subagent_type;
    const description = (raw as { task_description?: unknown }).task_description;
    out.set(parentId, {
      agentType: typeof agentType === 'string' ? agentType : undefined,
      description: typeof description === 'string' ? description : undefined,
    });
  }
  return out;
}

export function messagesToEvents(messages: JsonlNode[]): SubagentEvent[] {
  const events: SubagentEvent[] = [];
  // Pre-pass: a subagent's task_started routinely arrives before the forwarded frame naming its owner.
  const subagentOwnedToolUses = collectSubagentOwnedToolUses(messages);
  const subagentStepShells = new Set<string>();
  // Pre-pass: the kickoff prompt arrives after the dispatching tool_use.
  const forkedSkillDispatches = collectForkedSkillDispatches(messages);

  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    const raw = (m as unknown as { raw?: Record<string, unknown> }).raw ?? {};

    // Forwarded subagent frames, handled before the dispatch scan so nested tool_uses can't create phantom rows.
    if (m.kind === 'assistant') {
      const parentId = (raw as { parent_tool_use_id?: unknown }).parent_tool_use_id;
      if (typeof parentId === 'string' && parentId.length > 0) {
        const text = forwardedNarration(raw);
        const agentId = forwardedAgentId(raw);
        const model = forwardedModel(raw);
        if (text || model) {
          events.push({
            kind: 'Forwarded',
            toolUseId: parentId,
            text,
            ...(agentId ? { agentId } : {}),
            ...(model ? { model } : {}),
          });
        }
        continue;
      }
    }

    if (m.kind === 'assistant') {
      const content = (raw as { message?: { content?: unknown } }).message?.content;
      if (Array.isArray(content)) {
        for (const block of content as MessageContentBlock[]) {
          if (block.type !== 'tool_use' || !block.id) continue;
          const isAgentTool = block.name === 'Agent' || block.name === 'Task';
          const input = block.input;
          const isBackgroundDispatch = input.run_in_background === true;
          // Gated on the tool name so a Task's own kickoff prompt can't rewrite its row.
          const forkedSkill =
            block.name === 'Skill' ? forkedSkillDispatches.get(block.id) : undefined;
          if (!isAgentTool && !isBackgroundDispatch && !forkedSkill) continue;
          const forkedDescription =
            typeof input.skill === 'string' ? input.skill : forkedSkill?.description ?? '';
          events.push({
            kind: 'Dispatched',
            toolUseId: block.id,
            messageIdx: i,
            description: forkedSkill
              ? forkedDescription
              : typeof input.description === 'string'
                ? input.description
                : '',
            agentType: forkedSkill
              ? forkedSkill.agentType
              : isAgentTool && typeof input.subagent_type === 'string'
                ? input.subagent_type
                : undefined,
            isBackground: isBackgroundDispatch,
            prompt: isAgentTool && typeof input.prompt === 'string' ? input.prompt : undefined,
          });
        }
        continue;
      }
    }

    if (m.kind === 'user') {
      const content = (raw as { message?: { content?: unknown } }).message?.content;
      if (Array.isArray(content)) {
        const enrichedAck = isAsyncLaunchEnrichment(raw);
        for (const block of content as MessageContentBlock[]) {
          if (block.type !== 'tool_result') continue;
          const id = block.tool_use_id;
          if (!id) continue;
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

    if (isTaskLifecycleMarker(raw)) {
      const tlm = raw;
      if (tlm.subtype === 'task_updated') {
        if (typeof tlm.task_id === 'string' && tlm.patch && typeof tlm.patch === 'object') {
          const p = tlm.patch;
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

      const id = tlm.tool_use_id;
      if (!id) continue;
      if (subagentStepShells.has(id)) continue;
      if (tlm.subtype === 'task_started') {
        const ownedBySubagent = (tlm as { owned_by_subagent?: unknown }).owned_by_subagent === true;
        // A subagent's foreground shell is one of its steps, not an agent.
        const t = tlm as { task_type?: unknown; is_backgrounded?: unknown };
        if (ownedBySubagent && t.task_type === 'local_bash' && t.is_backgrounded === false) {
          subagentStepShells.add(id);
          continue;
        }
        events.push({
          kind: 'Started',
          toolUseId: id,
          taskId: tlm.task_id ?? '',
          description: tlm.description ?? '',
          ownerToolUseId: ownedBySubagent ? subagentOwnedToolUses.get(id) : undefined,
          ambient: (tlm as { ambient?: unknown }).ambient === true,
        });
      } else if (tlm.subtype === 'task_progress') {
        const tlmProg = tlm;
        events.push({
          kind: 'Progress',
          toolUseId: id,
          description: tlmProg.description ?? '',
          ...(typeof tlmProg.summary === 'string' && tlmProg.summary.trim() ? { summary: tlmProg.summary.trim() } : {}),
          lastToolName: tlmProg.last_tool_name,
          totalTokens: tlmProg.usage.total_tokens,
          toolUses: tlmProg.usage.tool_uses,
          durationMs: tlmProg.usage.duration_ms,
          taskId: tlmProg.task_id,
        });
      } else {
        const tlmNotif = tlm;
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
    if (init.description && !s.description) s.description = init.description;
    if (init.agentType && !s.agentType) s.agentType = init.agentType;
    if (init.isBackground !== undefined && s.isBackground === undefined) s.isBackground = init.isBackground;
  }
  return s;
}

/** Terminal states lock, except a structured TaskNotification overwrites: structured > XML > tool_result. */
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
        if (ev.prompt && !s.prompt) s.prompt = ev.prompt;
        break;
      }
      case 'Started': {
        const s = ensureState(byId, ev.toolUseId, { description: ev.description });
        if (!s.description) s.description = ev.description;
        if (ev.ownerToolUseId && !s.parentToolUseId) s.parentToolUseId = ev.ownerToolUseId;
        if (ev.taskId) s.taskId = ev.taskId;
        if (ev.ambient) s.ambient = true;
        if (!s.startedAt) s.startedAt = new Date().toISOString();
        break;
      }
      case 'Progress': {
        const s = ensureState(byId, ev.toolUseId);
        if (isTerminal(s.status)) break;
        const entry: SubagentProgressEntry = {
          description: ev.description,
          ...(ev.summary ? { summary: ev.summary } : {}),
          lastToolName: ev.lastToolName,
          totalTokens: ev.totalTokens,
          toolUses: ev.toolUses,
          durationMs: ev.durationMs,
        };
        s.events.push(entry);
        s.latest = entry;
        if (ev.summary) s.progressSummary = ev.summary;
        if (ev.taskId && !s.taskId) s.taskId = ev.taskId;
        break;
      }
      case 'Forwarded': {
        // byId.get, not ensureState: an orphan parent id must not create a row. agent_id finds a resumed agent.
        let s = byId.get(ev.toolUseId);
        if (!s && ev.agentId) {
          for (const candidate of byId.values()) {
            if (candidate.taskId === ev.agentId) { s = candidate; break; }
          }
        }
        if (!s) break;
        if (ev.model) s.model = ev.model;
        if (isTerminal(s.status) || !ev.text) break;
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
        // A background dispatch's success ACK is not a completion. Since CLI 2.1.232 only isBackgroundAck
        // flags it (spawns default to background, so the input has no run_in_background).
        if (ev.isBackgroundAck && !ev.isError) s.isBackground = true;
        if (s.isBackground && !ev.isError) break;
        s.status = ev.isError ? 'failed' : 'completed';
        s.closureSource = 'tool_result';
        s.endedAt = s.endedAt ?? new Date().toISOString();
        break;
      }
      case 'TaskNotification': {
        const s = ensureState(byId, ev.toolUseId);
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
        // A resumed agent's notification is keyed to the SendMessage; its <task-id> is the original agent's.
        let s = byId.get(ev.toolUseId);
        if (!s && ev.taskId) {
          for (const candidate of byId.values()) {
            if (candidate.taskId === ev.taskId) { s = candidate; break; }
          }
        }
        // Never invent rows from XML alone: it routinely refers to tool_uses not in scope.
        if (!s) break;
        if (s.closureSource === 'task_notification') break;
        s.status = ev.status === 'completed' ? 'completed' : 'failed';
        s.closureSource = 'task_notification_xml';
        s.summary = ev.summary ?? s.summary;
        if (ev.taskId && !s.taskId) s.taskId = ev.taskId;
        s.endedAt = new Date().toISOString();
        const finalEntry: SubagentProgressEntry = {
          description: ev.summary ?? s.description ?? '',
          totalTokens: ev.totalTokens ?? s.latest?.totalTokens,
          toolUses: ev.toolUses ?? s.latest?.toolUses,
          durationMs: ev.durationMs ?? s.latest?.durationMs,
        };
        s.events.push(finalEntry);
        s.latest = finalEntry;
        break;
      }
      case 'TaskUpdated': {
        let s: SubagentState | undefined;
        for (const candidate of byId.values()) {
          if (candidate.taskId === ev.taskId) {
            s = candidate;
            break;
          }
        }
        if (!s) break;

        const { patch } = ev;
        if (patch.isBackgrounded !== undefined) {
          s.isBackground = patch.isBackgrounded;
        }
        if (patch.description) {
          s.description = patch.description;
        }
        if (patch.error) {
          s.error = patch.error;
        }

        if (s.closureSource !== 'task_notification' && patch.status) {
          if (patch.status === 'completed') {
            s.status = 'completed';
            s.closureSource = 'task_updated';
          } else if (patch.status === 'failed' || patch.status === 'killed') {
            s.status = 'failed';
            s.closureSource = 'task_updated';
          }
        }

        if (patch.endTimeMs !== undefined && isTerminal(s.status)) {
          s.endedAt = new Date(patch.endTimeMs).toISOString();
        }
        break;
      }
      case 'AgentResumed': {
        let s: SubagentState | undefined;
        for (const candidate of byId.values()) {
          if (candidate.taskId === ev.taskId) { s = candidate; break; }
        }
        if (!s) break;
        // The one place a terminal row reopens.
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

/** A trailing `result` (the latest message) may still be awaiting a legitimate background. */
export function inferredClosureEvents(
  messages: JsonlNode[],
  states: Map<string, SubagentState>,
  dispatchIndices: Map<string, number>,
): SubagentEvent[] {
  if (messages.length === 0) return [];
  const out: SubagentEvent[] = [];
  for (const [id, s] of states.entries()) {
    if (s.status !== 'running') continue;
    // A backgrounded dispatch outlives the turn that launched it; inferring closure showed live agents as done.
    if (s.isBackground) continue;
    const dispatchedAt = dispatchIndices.get(id);
    if (dispatchedAt === undefined) continue;
    let resultIdx = -1;
    for (let i = dispatchedAt + 1; i < messages.length; i++) {
      const node = messages[i];
      if (node.kind === 'cli-stream-result') {
        resultIdx = i;
        break;
      }
    }
    if (resultIdx === -1) continue;
    // A result that is the last message may still be awaiting a legitimate background.
    if (resultIdx >= messages.length - 1) continue;
    out.push({ kind: 'ClosedByParentResult', toolUseId: id });
  }
  return out;
}

export function dispatchIndicesFromEvents(events: SubagentEvent[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const ev of events) {
    if (ev.kind === 'Dispatched' && !out.has(ev.toolUseId)) {
      out.set(ev.toolUseId, ev.messageIdx);
    }
  }
  return out;
}
