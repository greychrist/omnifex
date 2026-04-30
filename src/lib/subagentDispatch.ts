import type { ClaudeStreamMessage } from '@/types/claudeStream';

/**
 * The Claude Agent SDK and Claude Code CLI emit subagent-dispatch tool_use
 * blocks under different names ("Task" vs "Agent") depending on which
 * runtime produced the stream. Match both case-insensitively so widgets,
 * filters, and timeline markers all light up regardless of source.
 */
export function isSubagentDispatch(name: unknown): boolean {
  if (typeof name !== 'string') return false;
  const lower = name.toLowerCase();
  return lower === 'task' || lower === 'agent';
}

/**
 * True when a user-role message is a synthesized subagent prompt — i.e.
 * its `parent_tool_use_id` matches a Task/Agent tool_use somewhere in the
 * stream. The bare presence of `parent_tool_use_id` is NOT enough: the
 * Claude CLI persists *every* user message with a parent tool reference
 * for conversation-tree chaining, so a presence check would also drop
 * real user prompts on reload.
 */
export function isSubagentPrompt(
  msg: ClaudeStreamMessage,
  allMessages: readonly ClaudeStreamMessage[],
): boolean {
  if (msg.type !== 'user') return false;
  const parentId = (msg as { parent_tool_use_id?: string | null }).parent_tool_use_id;
  if (typeof parentId !== 'string' || parentId.length === 0) return false;

  for (const m of allMessages) {
    if (m.type !== 'assistant') continue;
    const content = m.message?.content;
    if (!Array.isArray(content)) continue;
    for (const b of content) {
      if (b?.type === 'tool_use' && b.id === parentId && isSubagentDispatch(b.name)) {
        return true;
      }
    }
  }
  return false;
}
