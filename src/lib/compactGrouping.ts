import type { ClaudeStreamMessage } from '@/types/claudeStream';
import type { MessageRenderingConfig } from './messageRenderingConfig';
import { classifyStandaloneKind } from './messageKind';
import { classifyBlockKind } from './blockKind';

/**
 * Compact-mode grouping: walk the timeline and decide, per message, whether
 * to render it normally (visible) or fold it into a `HiddenEventsGroup`
 * with neighboring hidden messages.
 *
 * The rule is intentionally simple: a message is "fully hidden" iff every
 * renderable thing in it is hidden by the user's per-kind config. A
 * partially-hidden message (e.g. visible text + hidden tool_use blocks)
 * still renders normally — its hidden blocks get a per-message
 * `HiddenBlocksExpander` inside `StreamMessage`.
 *
 * Special carve-out: the most recent `TodoWrite` tool_use is always
 * promoted to a top-level visible card so the live todo list stays
 * inspectable even when `assistant.toolUse` is hidden.
 */

export type CompactItem =
  | { kind: 'single'; message: ClaudeStreamMessage; key: string }
  | { kind: 'group'; messages: ClaudeStreamMessage[]; key: string };

function hasTodoWriteToolUse(msg: ClaudeStreamMessage): boolean {
  const content = msg.message?.content;
  if (!Array.isArray(content)) return false;
  return content.some(
    (c: any) =>
      c?.type === 'tool_use' && typeof c?.name === 'string' && c.name.toLowerCase() === 'todowrite',
  );
}

function findLastTodoWriteIndex(messages: ClaudeStreamMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (hasTodoWriteToolUse(messages[i])) return i;
  }
  return -1;
}

function isRenderableBlock(b: any): boolean {
  if (!b || typeof b !== 'object') return false;
  if (b.type === 'tool_use' || b.type === 'tool_result' || b.type === 'image') return true;
  if (b.type === 'text') {
    const t = typeof b.text === 'string' ? b.text.trim() : '';
    return t.length > 0;
  }
  if (b.type === 'thinking') {
    const t = typeof b.thinking === 'string' ? b.thinking.trim() : '';
    return t.length > 0;
  }
  return false;
}

/**
 * True iff every renderable thing in `msg` is marked hidden by `config`.
 * A message with no renderable content is considered "not hidden" so it
 * doesn't get swept into a group (the renderer will drop it on its own).
 */
export function isMessageFullyHidden(
  msg: ClaudeStreamMessage,
  allMessages: ClaudeStreamMessage[],
  config: MessageRenderingConfig,
): boolean {
  const wholeKind = classifyStandaloneKind(msg, allMessages);
  if (wholeKind) {
    const k = config.kinds[wholeKind];
    if (!k) return false;
    if (k.compactBoundaryLocked) return false;
    return k.hiddenInCompact === true;
  }

  // The declared shape says content is `any[]`, but the CLI's persisted
  // user prompts are bare strings (live SDK uses an array of text blocks).
  // Widen here so the string-form check below isn't narrowed away.
  const content: unknown = msg.message?.content;
  // Treat any non-empty string as a visible user prompt — early-returning
  // "fully hidden" here was sweeping reloaded prompts into hidden groups.
  if (typeof content === 'string') return content.trim().length === 0;
  // No content / empty content = nothing to render. Treat as hidden so the
  // message joins any neighboring hidden run instead of breaking it.
  // (Emitting it as a visible "single" would inject an empty card that
  // fragments runs visually for no reason.)
  if (!Array.isArray(content) || content.length === 0) return true;

  let renderable = 0;
  let hidden = 0;
  for (const b of content) {
    if (!isRenderableBlock(b)) continue;
    renderable += 1;
    const blockKind = classifyBlockKind(b, msg);
    if (!blockKind) {
      // Unclassified renderable block (e.g. a plain user typed text block).
      // Treat as visible — its kind is either implicit user.prompt (locked
      // visible) or genuinely something we have no toggle for.
      continue;
    }
    const k = config.kinds[blockKind];
    if (!k) continue;
    if (k.compactBoundaryLocked) continue;
    if (k.hiddenInCompact) hidden += 1;
  }

  // Same reasoning as the empty-content case: if there's no renderable
  // content (e.g. signature-only thinking blocks), let it merge into a
  // neighboring hidden run.
  if (renderable === 0) return true;

  return hidden === renderable;
}

export function buildCompactItems(
  messages: ClaudeStreamMessage[],
  config: MessageRenderingConfig,
): CompactItem[] {
  const latestTodoIdx = findLastTodoWriteIndex(messages);
  const items: CompactItem[] = [];

  messages.forEach((message, idx) => {
    const isLatestTodo = idx === latestTodoIdx;
    const fullyHidden = !isLatestTodo && isMessageFullyHidden(message, messages, config);

    if (!fullyHidden) {
      items.push({ kind: 'single', message, key: `m-${idx}` });
      return;
    }

    const last = items[items.length - 1];
    if (last && last.kind === 'group') {
      last.messages.push(message);
    } else {
      items.push({ kind: 'group', messages: [message], key: `g-${idx}` });
    }
  });

  return items;
}
