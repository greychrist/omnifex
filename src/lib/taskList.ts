import type { JsonlNode } from '@/types/jsonl';
import type { MessageContentBlock } from '@/types/claudeStream';

/**
 * Reduce the live message stream into a per-task TaskList under SDK 0.3.x.
 *
 * The new SDK exposes a Task primitive via four tools:
 *   - `TaskCreate(subject, description, activeForm?)` mints a row.
 *   - `TaskUpdate(taskId, status?, subject?, activeForm?)` mutates it.
 *   - `TaskGet` / `TaskList` are read-only and don't drive state.
 *
 * Replaces the old snapshot-shaped `TodoWrite` flow. Each task row gets:
 *   - the SDK-assigned id (parsed off the tool_result content string —
 *     the live stream's only carrier; see the comment on
 *     `extractTaskIdFromContent`)
 *   - subject / activeForm (initial + renames via TaskUpdate)
 *   - status: 'pending' | 'in_progress' | 'completed'
 *     ('deleted' status drops the row entirely)
 *   - `messages`: the stream messages attributed to this task. Attribution
 *     is an in-progress window: any message emitted between
 *     `TaskUpdate(taskId, status='in_progress')` and the same task's next
 *     terminal `TaskUpdate` ('completed' / 'deleted') belongs to that task.
 *     Messages emitted while NO task is in_progress aren't attributed at
 *     all (no orphan bucket). The Task* tool_uses themselves are excluded
 *     from attribution so the panel doesn't render meta-noise about the
 *     system managing itself.
 *
 * The pattern mirrors `src/lib/subagentEvents.ts`'s reducer style:
 * walk-once, state map keyed by id, terminal status overrides only via
 * the SDK's canonical TaskUpdate carrier.
 */

export type TaskStatus = 'pending' | 'in_progress' | 'completed';

export interface TaskListEntry {
  id: string;
  subject: string;
  status: TaskStatus;
  activeForm?: string;
  /** Messages emitted while this task was in_progress, in arrival order. */
  messages: JsonlNode[];
  /** Parallel array of indices into the original `messages` argument so
   *  callers that want to scroll the chat to the originating row can. */
  messageIndices: number[];
}

export interface TaskListSummary {
  total: number;
  done: number;
  inProgress: number;
  pending: number;
  /** True iff there is at least one task that isn't completed. */
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
    const m = s.match(TASK_CREATE_CONTENT_REGEX);
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

/**
 * Pick the task an incoming work-message belongs to. Used by getTaskList's
 * attribution pass.
 *
 *   1. Explicit in_progress wins — if the agent took the trouble to mark
 *      a task in_progress, we trust that signal even when the queue
 *      order would suggest otherwise.
 *   2. Otherwise fall back to the EARLIEST non-terminal task in creation
 *      order — the "next up" item in the queue. This catches the common
 *      batched-up-front workflow where the agent creates A, B, C all at
 *      once and never bothers with in_progress updates.
 *   3. If every task is terminal, return null so nothing is attributed.
 */
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

/**
 * Inspect the message's top-level content blocks and decide whether the
 * message should be attributed to the currently-in_progress task. Returns
 * false when the message is "structural" (TaskCreate / TaskUpdate
 * tool_uses, TaskCreate tool_results, system messages, ...) so the panel
 * never renders meta-rows about itself.
 */
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
  // If EVERY renderable block in the message is a Task* tool_use or a
  // tool_result for a Task* tool_use, the message is structural and we
  // skip it. A mixed message (e.g. text + TaskUpdate) stays attributable
  // because the text is real work commentary.
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
      // We can't cheaply tell whether this is a Task* tool_result without
      // the parent context, so check the content prose against the same
      // sentinel the CLI emits for TaskCreate / TaskUpdate.
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

export function getTaskList(messages: JsonlNode[]): TaskListEntry[] | null {
  const byToolUseId = new Map<string, InternalTask>();
  const byTaskId = new Map<string, InternalTask>();
  let order = 0;
  let sawCreate = false;
  let currentTaskId: string | null = null;

  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];

    // Per-turn boundary. Detach the currently in-progress attribution
    // (so messages emitted between turns aren't attributed). DO NOT
    // force-complete remaining tasks: `result` fires once per turn,
    // not once per session, so subagents that span multiple turns
    // need their pending tasks to stay pending. The renderer's
    // task-list summarizer treats real-state pending tasks correctly.
    if (m.kind === 'unknown' && (m.raw as { type?: string }).type === 'result') {
      currentTaskId = null;
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
          // Epoch-boundary reset — when the agent finishes a batch of
          // tasks and starts a new one, the new list should replace the
          // old, matching the legacy TodoBar's "new list empties the
          // old" UX. Detection: a TaskCreate that arrives when EVERY
          // existing task is already `completed`. If any task is still
          // pending or in_progress, this is an additive TaskCreate on
          // the same in-flight batch and we don't reset.
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

    // Attribution rule:
    //   1. If a task is explicitly in_progress, the message belongs to it.
    //   2. Otherwise, the message belongs to the EARLIEST non-terminal
    //      task in the current epoch — the "next up" task in the queue.
    //      This is necessary because the Task* primitive doesn't ship
    //      per-task progress events, and many agents skip the in_progress
    //      step entirely (TaskCreate batch → work → TaskUpdate completed),
    //      which would otherwise leave every message unattributed.
    //   3. If every task is terminal, nothing gets attributed.
    //
    // Structural messages (Task* tool_use / their tool_results) are
    // filtered out by `isAttributable` so the panel never renders
    // meta-rows about itself.
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

/** Stable cache-key string for the visible task list — useful for
 *  diffing between renders to know if anything actually changed. */
export function taskListKey(entries: TaskListEntry[] | null): string {
  if (entries === null) return '__null__';
  return JSON.stringify(entries.map((e) => [e.id, e.subject, e.status, e.messageIndices.length]));
}
