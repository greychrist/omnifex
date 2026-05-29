import type { JsonlNode } from '@/types/jsonl';

export interface SkillInjection {
  skillName: string;
}

/** Read message.content from an assistant or user JsonlNode. */
function getContent(m: JsonlNode): unknown[] | null {
  const content = (m as unknown as { raw?: { message?: { content?: unknown } } }).raw?.message?.content;
  return Array.isArray(content) ? content : null;
}

/**
 * A user-role message is "skill-injected" when it immediately follows a
 * tool_result whose matching tool_use was the `Skill` tool. The CLI injects
 * the skill's SKILL.md body as a user-role text message after the tool runs,
 * and we want to render it distinctly from a real user-typed prompt.
 */
export function detectSkillInjection(
  message: JsonlNode,
  allMessages: JsonlNode[],
): SkillInjection | null {
  if (message.kind !== 'user') return null;

  // Boundary normalization (lib/normalizeMessage) wraps the CLI's bare-string
  // user prompts into single-text-block arrays at ingress, so by the time
  // this runs `content` is always an array (or the message has no content).
  const content = getContent(message);
  if (!content) return null;
  const hasToolResult = content.some((c: any) => c?.type === 'tool_result');
  if (hasToolResult) return null;
  const hasText = content.some((c: any) => c?.type === 'text');
  if (!hasText) return null;

  const idx = allMessages.indexOf(message);
  if (idx <= 0) return null;

  const prev = allMessages[idx - 1];
  if (prev.kind !== 'user') return null;
  const prevContent = getContent(prev);
  if (!prevContent) return null;
  // ContentBlockParam → ToolResultBlockParam narrowing.
  const toolResult = prevContent.find(
    (c): c is Extract<typeof c, { type: 'tool_result' }> =>
      (c as any)?.type === 'tool_result',
  );
  if (!toolResult) return null;
  const toolUseId = (toolResult as any).tool_use_id;
  if (!toolUseId) return null;

  for (let i = idx - 2; i >= 0; i--) {
    const candidate = allMessages[i];
    if (candidate.kind !== 'assistant') continue;
    const candContent = getContent(candidate);
    if (!candContent) continue;
    // BetaContentBlock narrows to BetaToolUseBlock when type === 'tool_use'.
    const tu = candContent.find(
      (c): c is Extract<typeof c, { type: 'tool_use' }> =>
        (c as any)?.type === 'tool_use' && (c as { id?: string }).id === toolUseId,
    );
    if (!tu) continue;
    if ((tu as any).name !== 'Skill') return null;
    const input = ((tu as any).input ?? {}) as Record<string, unknown>;
    const skillName =
      (typeof input.skill === 'string' && input.skill) ||
      (typeof input.name === 'string' && input.name) ||
      'unknown';
    return { skillName };
  }

  return null;
}
