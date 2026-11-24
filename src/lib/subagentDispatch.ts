import type { JsonlNode } from '@/types/jsonl';
import { transcriptIndex } from './transcriptIndex';

/** Case-sensitive: the CLI's wire names, matching `asToolInputOneOf`'s narrowing. */
export function isSubagentDispatch(name: unknown): boolean {
  if (typeof name !== 'string') return false;
  return name === 'Task' || name === 'Agent';
}

/** Main-chain lines carry null (live stream) or omit it (persisted JSONL). */
export function forwardedParentToolUseId(raw: unknown): string | null {
  const id = (raw as { parent_tool_use_id?: unknown } | null)?.parent_tool_use_id;
  return typeof id === 'string' && id.length > 0 ? id : null;
}

/** Separate from isSubagentDispatch: Skill as a dispatch at render sites makes every skill call a subagent card. */
function isForwardedPromptParent(name: unknown): boolean {
  return isSubagentDispatch(name) || name === 'Skill';
}

/** The parent must resolve to a real Task/Agent/Skill tool_use; a user message naming e.g. a Read must still render. */
export function isSubagentPrompt(
  msg: JsonlNode,
  allMessages: readonly JsonlNode[],
): boolean {
  if (msg.kind !== 'user') return false;
  const parentId = (msg.raw as { parent_tool_use_id?: string | null }).parent_tool_use_id;
  if (typeof parentId !== 'string' || parentId.length === 0) return false;

  const parent = transcriptIndex(allMessages).toolUses.get(parentId);
  return parent !== undefined && isForwardedPromptParent(parent.name);
}
