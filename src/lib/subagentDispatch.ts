import type { JsonlNode } from '@/types/jsonl';

/**
 * The Claude Code CLI emits subagent-dispatch tool_use blocks under
 * PascalCase 'Task' or 'Agent'. Earlier defense-in-depth accepted
 * lowercase / uppercase variants too, but no production code path
 * actually emits those (verified via the session reducer + JSONL replay)
 * and the case-insensitive contract diverged from the case-sensitive
 * narrowing in `asToolInputOneOf`, forcing a normalization shim at every
 * call site. This helper is now case-sensitive against the CLI's wire
 * contract — both layers agree, no shim needed.
 */
export function isSubagentDispatch(name: unknown): boolean {
  if (typeof name !== 'string') return false;
  return name === 'Task' || name === 'Agent';
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
  msg: JsonlNode,
  allMessages: readonly JsonlNode[],
): boolean {
  if (msg.kind !== 'user') return false;
  const parentId = (msg.raw as { parent_tool_use_id?: string | null }).parent_tool_use_id;
  if (typeof parentId !== 'string' || parentId.length === 0) return false;

  for (const m of allMessages) {
    if (m.kind !== 'assistant') continue;
    const content = (m.raw as { message?: { content?: unknown } }).message?.content;
    if (!Array.isArray(content)) continue;
    for (const b of content) {
      if ((b as any)?.type === 'tool_use' && (b as any).id === parentId && isSubagentDispatch((b as any).name)) {
        return true;
      }
    }
  }
  return false;
}
