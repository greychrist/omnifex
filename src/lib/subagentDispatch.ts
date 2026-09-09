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
 * The `parent_tool_use_id` a live-forwarded subagent line carries, or null.
 * Under `--forward-subagent-text` (CLI ≥2.1.211) subagent text/thinking
 * arrives as regular user/assistant envelopes whose top-level
 * `parent_tool_use_id` names the dispatching Task/Agent tool_use. Main-chain
 * lines carry null (live stream) or omit the field entirely (persisted
 * JSONL — verified: no persisted user/assistant line carries a non-null
 * value; subagent transcripts live in separate agent-*.jsonl files).
 */
export function forwardedParentToolUseId(raw: unknown): string | null {
  const id = (raw as { parent_tool_use_id?: unknown } | null)?.parent_tool_use_id;
  return typeof id === 'string' && id.length > 0 ? id : null;
}

/**
 * Tools that can dispatch work whose prompt is then forwarded back to us.
 *
 * A superset of `isSubagentDispatch`, and deliberately a SEPARATE predicate:
 * `Skill` belongs here but must not be treated as a subagent dispatch at the
 * render sites (`StreamMessage`), where it would turn every ordinary skill
 * call into a subagent card.
 *
 * `Skill` earns its place because CLI 2.1.265 made forked skills
 * (`context: fork`) stream their kickoff prompt, parented to the `Skill`
 * tool_use that dispatched them.
 */
function isForwardedPromptParent(name: unknown): boolean {
  return isSubagentDispatch(name) || name === 'Skill';
}

/**
 * True when a user-role message is a synthesized subagent prompt — i.e. its
 * `parent_tool_use_id` matches a Task/Agent/Skill tool_use somewhere in the
 * stream.
 *
 * Both halves of that are load-bearing:
 *
 *  - The parent must RESOLVE to a real tool_use. Presence of the field alone
 *    is not enough to act on here.
 *  - The parent must be a tool that actually dispatches forwarded work. A
 *    user message pointing at, say, a `Read` tool_use is not a forwarded
 *    prompt and must still render.
 *
 * Before CLI 2.1.265 this accepted Task/Agent only, so a forked skill's
 * kickoff prompt fell through and rendered as a prompt the human never typed
 * — live only, since the persisted transcript carries no such line, which
 * made the same session look different after a reload.
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
      if ((b as any)?.type === 'tool_use' && (b as any).id === parentId && isForwardedPromptParent((b as any).name)) {
        return true;
      }
    }
  }
  return false;
}
