import type { JsonlNode } from '@/types/jsonl';
import { transcriptIndex } from './transcriptIndex';

export interface SkillInjection {
  skillName: string;
}

function getContent(m: JsonlNode): unknown[] | null {
  const content = (m as unknown as { raw?: { message?: { content?: unknown } } }).raw?.message?.content;
  return Array.isArray(content) ? content : null;
}

/**
 * Position-independent: CLI 2.1.270 emits a re-invocation preamble before the body.
 * `sourceToolUseID` exists only in persisted JSONL, where committed rows come from.
 */
export function detectSkillInjection(
  message: JsonlNode,
  allMessages: readonly JsonlNode[],
): SkillInjection | null {
  if (message.kind !== 'user') return null;

  const sourceToolUseID = (message.raw as { sourceToolUseID?: unknown }).sourceToolUseID;
  if (typeof sourceToolUseID !== 'string' || sourceToolUseID.length === 0) return null;

  const content = getContent(message);
  if (!content) return null;
  const hasToolResult = content.some((c) => (c as { type?: unknown } | null)?.type === 'tool_result');
  if (hasToolResult) return null;
  const hasText = content.some((c) => (c as { type?: unknown } | null)?.type === 'text');
  if (!hasText) return null;

  const tu = transcriptIndex(allMessages).toolUses.get(sourceToolUseID);
  if (tu?.name !== 'Skill') return null;
  const input = tu.input;
  const skillName =
    (typeof input.skill === 'string' && input.skill) ||
    (typeof input.name === 'string' && input.name) ||
    'unknown';
  return { skillName };
}
