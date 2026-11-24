import type { JsonlNode } from '@/types/jsonl';
import type { MessageContentBlock } from '@/types/claudeStream';

export type TaskStatus = 'pending' | 'in_progress' | 'completed';

export interface TaskListEntry {
  id: string;
  subject: string;
  status: TaskStatus;
  activeForm?: string;
  messages: JsonlNode[];
  messageIndices: number[];
}

export interface TaskListSummary {
  total: number;
  done: number;
  inProgress: number;
  pending: number;
  running: boolean;
}

interface InternalTask {
  toolUseId: string;
  taskId?: string;
  subject: string;
  status: TaskStatus;
  activeForm?: string;
  order: number;
  messages: JsonlNode[];
  messageIndices: number[];
}

const TASK_CREATE_CONTENT_REGEX = /^Task #(\S+) created successfully/;

function extractTaskIdFromContent(content: unknown): string | null {
  const tryMatch = (s: string): string | null => {
    const m = TASK_CREATE_CONTENT_REGEX.exec(s);
    return m ? m[1] : null;
  };
  if (typeof content === 'string') return tryMatch(content);
  if (Array.isArray(content)) {
    for (const b of content) {
      if (b && typeof b === 'object' && (b as { type?: unknown }).type === 'text') {
        const text = (b as { text?: unknown }).text;
        if (typeof text === 'string') {
          const id = tryMatch(text);
          if (id) return id;
        }
      }
    }
  }
  return null;
}

function extractTaskIdFromEnvelope(message: unknown): string | null {
  if (!message || typeof message !== 'object') return null;
  const env = message as { tool_use_result?: unknown; toolUseResult?: unknown };
  for (const payload of [env.tool_use_result, env.toolUseResult]) {
    if (!payload || typeof payload !== 'object') continue;
    const task = (payload as { task?: { id?: unknown } }).task;
    if (!task || typeof task !== 'object') continue;
    const id = task.id;
    if (typeof id === 'string' && id.length > 0) return id;
  }
  return null;
}

function coerceSdkStatus(s: unknown): TaskStatus | 'deleted' | null {
  if (s === 'pending' || s === 'in_progress' || s === 'completed') return s;
  if (s === 'deleted') return 'deleted';
  return null;
}

/** Explicit in_progress wins, else the earliest non-terminal task: many agents never mark in_progress. */
function pickAttributionTarget(
  byToolUseId: Map<string, InternalTask>,
  byTaskId: Map<string, InternalTask>,
  currentTaskId: string | null,
): InternalTask | null {
  if (currentTaskId !== null) {
    const explicit = byTaskId.get(currentTaskId);
    if (explicit && explicit.status !== 'completed') return explicit;
  }
  let earliest: InternalTask | null = null;
  for (const t of byToolUseId.values()) {
    if (t.status === 'completed') continue;
    if (earliest === null || t.order < earliest.order) earliest = t;
  }
  return earliest;
}

function getContent(m: JsonlNode): unknown[] | null {
  const raw = (m as unknown as { raw?: { message?: { content?: unknown } } }).raw;
  const content = raw?.message?.content;
  return Array.isArray(content) ? content : null;
}

function isAttributable(m: JsonlNode): boolean {
  if (m.kind !== 'assistant' && m.kind !== 'user') return false;
  const content = getContent(m);
  if (!Array.isArray(content)) return false;
  const blocks = content as MessageContentBlock[];
  if (blocks.length === 0) return false;
  // All-structural (Task* calls/results) messages are skipped; text beside a Task* call is real work.
  let renderable = 0;
  let structural = 0;
  for (const b of blocks) {
    if (!b || typeof b !== 'object') continue;
    if (b.type === 'tool_use') {
      renderable += 1;
      const name = typeof b.name === 'string' ? b.name.toLowerCase() : '';
      if (
        name === 'taskcreate' ||
        name === 'taskupdate' ||
        name === 'taskget' ||
        name === 'tasklist'
      ) {
        structural += 1;
      }
      continue;
    }
    if (b.type === 'tool_result') {
      renderable += 1;
      const c = typeof b.content === 'string' ? b.content : '';
      if (
        /^Task #\S+ created successfully/.test(c) ||
        /^Updated task #\S+/.test(c)
      ) {
        structural += 1;
      }
      continue;
    }
    if (b.type === 'text' || b.type === 'thinking' || b.type === 'image') {
      renderable += 1;
    }
  }
  if (renderable === 0) return false;
  return structural < renderable;
}

/** CLI 2.1.328 task-ticker frame: with the ticker on Claude doesn't call TaskUpdate, so this is the only status carrier. Sets only the tasks it names. */
function taskTickerStatuses(m: JsonlNode): { id: string; status: TaskStatus }[] | null {
  const raw = (m as unknown as { raw?: { type?: unknown; subtype?: unknown; statuses?: unknown } }).raw;
  if (raw?.type !== 'system' || raw.subtype !== 'task_list_statuses') return null;
  if (!Array.isArray(raw.statuses)) return [];
  return raw.statuses.flatMap((entry: unknown) => {
    const { id, status } = (entry ?? {}) as { id?: unknown; status?: unknown };
    const coerced = coerceSdkStatus(status);
    return typeof id === 'string' && coerced !== null && coerced !== 'deleted'
      ? [{ id, status: coerced }]
      : [];
  });
}

export function getTaskList(messages: JsonlNode[]): TaskListEntry[] | null {
  const byToolUseId = new Map<string, InternalTask>();
  const byTaskId = new Map<string, InternalTask>();
  let order = 0;
  let sawCreate = false;
  let currentTaskId: string | null = null;

  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];

    // Don't force-complete at result: it fires per turn, and multi-turn tasks must stay pending.
    if (m.kind === 'cli-stream-result') {
      currentTaskId = null;
      continue;
    }

    const tickerStatuses = taskTickerStatuses(m);
    if (tickerStatuses) {
      for (const { id, status } of tickerStatuses) {
        const task = byTaskId.get(id);
        if (!task) continue;
        task.status = status;
        if (status === 'in_progress') currentTaskId = id;
        else if (currentTaskId === id) currentTaskId = null;
      }
      continue;
    }

    const content = getContent(m);
    if (!Array.isArray(content)) continue;
    const blocks = content as MessageContentBlock[];

    for (const block of blocks) {
      if (!block || typeof block !== 'object') continue;

      if (block.type === 'tool_use') {
        const name = typeof block.name === 'string' ? block.name.toLowerCase() : '';
        const input = block.input;

        if (name === 'taskcreate') {
          if (!block.id) continue;
          // A TaskCreate after every task is completed starts a new list.
          if (byToolUseId.size > 0) {
            let anyActive = false;
            for (const t of byToolUseId.values()) {
              if (t.status !== 'completed') {
                anyActive = true;
                break;
              }
            }
            if (!anyActive) {
              byToolUseId.clear();
              byTaskId.clear();
              currentTaskId = null;
            }
          }
          sawCreate = true;
          const subject = typeof input.subject === 'string'
            ? input.subject
            : typeof input.description === 'string'
              ? input.description
              : '';
          const task: InternalTask = {
            toolUseId: block.id,
            subject,
            status: 'pending',
            activeForm: typeof input.activeForm === 'string' ? input.activeForm : undefined,
            order: order++,
            messages: [],
            messageIndices: [],
          };
          byToolUseId.set(block.id, task);
        } else if (name === 'taskupdate') {
          const taskId = typeof input.taskId === 'string' ? input.taskId : undefined;
          if (!taskId) continue;
          const task = byTaskId.get(taskId);
          if (!task) continue;
          const mappedStatus = coerceSdkStatus(input.status);
          if (mappedStatus === 'deleted') {
            byTaskId.delete(taskId);
            byToolUseId.delete(task.toolUseId);
            if (currentTaskId === taskId) currentTaskId = null;
            continue;
          }
          if (mappedStatus) {
            task.status = mappedStatus;
            if (mappedStatus === 'in_progress') {
              currentTaskId = taskId;
            } else if (mappedStatus === 'completed' && currentTaskId === taskId) {
              currentTaskId = null;
            }
          }
          if (typeof input.subject === 'string') task.subject = input.subject;
          if (typeof input.activeForm === 'string') task.activeForm = input.activeForm;
        }
      } else if (block.type === 'tool_result') {
        const id = block.tool_use_id;
        if (!id) continue;
        const task = byToolUseId.get(id);
        if (!task || task.taskId) continue;
        const taskId =
          extractTaskIdFromContent(block.content) ??
          extractTaskIdFromEnvelope((m as unknown as { raw?: Record<string, unknown> }).raw);
        if (taskId) {
          task.taskId = taskId;
          byTaskId.set(taskId, task);
        }
      }
    }

    if (!isAttributable(m)) continue;
    const target = pickAttributionTarget(byToolUseId, byTaskId, currentTaskId);
    if (!target) continue;
    target.messages.push(m);
    target.messageIndices.push(i);
  }

  if (!sawCreate) return null;

  const entries: TaskListEntry[] = [...byToolUseId.values()]
    .sort((a, b) => a.order - b.order)
    .map((t) => {
      const e: TaskListEntry = {
        id: t.taskId ?? t.toolUseId,
        subject: t.subject,
        status: t.status,
        messages: t.messages,
        messageIndices: t.messageIndices,
      };
      if (t.activeForm) e.activeForm = t.activeForm;
      return e;
    });

  return entries.length > 0 ? entries : null;
}

export function summarizeTaskList(entries: TaskListEntry[]): TaskListSummary {
  let done = 0;
  let inProgress = 0;
  let pending = 0;
  for (const e of entries) {
    if (e.status === 'completed') done += 1;
    else if (e.status === 'in_progress') inProgress += 1;
    else pending += 1;
  }
  return {
    total: entries.length,
    done,
    inProgress,
    pending,
    running: inProgress > 0 || pending > 0,
  };
}

export function taskListKey(entries: TaskListEntry[] | null): string {
  if (entries === null) return '__null__';
  return JSON.stringify(entries.map((e) => [e.id, e.subject, e.status, e.messageIndices.length]));
}
