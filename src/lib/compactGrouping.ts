import type { ClaudeStreamMessage } from '@/components/AgentExecution';
import { detectSkillInjection } from './skillDetection';

/**
 * True when the message should render fully on every view — it's either
 * a user-typed prompt, a final assistant response that ends a turn, an
 * Execution Complete card (real or synthesized), or a permission request
 * that needs user action.
 *
 * Everything else (mid-turn tool_use, tool_result replies, thinking,
 * system init, skill-injected user bodies) is part of the "between-prompts"
 * interior of a turn and can be collapsed behind a summary in Compact mode.
 *
 * Pass `allMessages` so skill-injected user messages (which look like user
 * text but were produced by the Skill tool) can be recognized via the
 * preceding tool_use. Without context they can't be distinguished from a
 * real typed prompt.
 */
export function isBoundaryMessage(
  msg: ClaudeStreamMessage,
  allMessages?: ClaudeStreamMessage[],
): boolean {
  if (msg.type === 'permission_request') return true;
  if (msg.type === 'result') return true;

  if (msg.type === 'user') {
    const content: unknown = msg.message?.content;
    if (typeof content === 'string') {
      if (content.length === 0) return false;
    } else if (!Array.isArray(content)) {
      return false;
    } else if (!content.some((c: any) => c?.type === 'text')) {
      return false;
    }
    if (allMessages && detectSkillInjection(msg, allMessages)) return false;
    return true;
  }

  if (msg.type === 'assistant') {
    const stop = (msg.message as any)?.stop_reason;
    if (stop === 'end_turn') return true;
    const content = msg.message?.content;
    if (!Array.isArray(content) || content.length === 0) return false;
    const hasText = content.some((c: any) => c?.type === 'text');
    const hasNonText = content.some((c: any) => c?.type !== 'text');
    return hasText && !hasNonText;
  }

  return false;
}

function hasTodoWriteToolUse(msg: ClaudeStreamMessage): boolean {
  const content = msg.message?.content;
  if (!Array.isArray(content)) return false;
  return content.some(
    (c: any) => c?.type === 'tool_use' && typeof c?.name === 'string' && c.name.toLowerCase() === 'todowrite',
  );
}

function findLastTodoWriteIndex(messages: ClaudeStreamMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (hasTodoWriteToolUse(messages[i])) return i;
  }
  return -1;
}

export type CompactItem =
  | { kind: 'single'; message: ClaudeStreamMessage; key: string }
  | { kind: 'group'; messages: ClaudeStreamMessage[]; key: string };

/**
 * Build the compact-mode item list: boundary messages render as singles,
 * consecutive non-boundary messages collapse into groups. The most recent
 * TodoWrite tool_use is additionally promoted to a top-level single so the
 * live todo list stays visible instead of hiding behind a group summary.
 */
export function buildCompactItems(messages: ClaudeStreamMessage[]): CompactItem[] {
  const latestTodoIdx = findLastTodoWriteIndex(messages);
  const items: CompactItem[] = [];

  messages.forEach((message, idx) => {
    const isPromoted = idx === latestTodoIdx;
    if (isBoundaryMessage(message, messages) || isPromoted) {
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
