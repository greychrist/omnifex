import type { ClaudeStreamMessage } from '@/components/AgentExecution';

export interface SkillInjection {
  skillName: string;
}

/**
 * A user-role message is "skill-injected" when it immediately follows a
 * tool_result whose matching tool_use was the `Skill` tool. The SDK injects
 * the skill's SKILL.md body as a user-role text message after the tool runs,
 * and we want to render it distinctly from a real user-typed prompt.
 */
export function detectSkillInjection(
  message: ClaudeStreamMessage,
  allMessages: ClaudeStreamMessage[],
): SkillInjection | null {
  if (message.type !== 'user') return null;

  const content: unknown = message.message?.content;
  if (typeof content === 'string') {
    if (!content.trim()) return null;
  } else if (Array.isArray(content)) {
    const hasToolResult = content.some((c: any) => c?.type === 'tool_result');
    if (hasToolResult) return null;
    const hasText = content.some((c: any) => c?.type === 'text');
    if (!hasText) return null;
  } else {
    return null;
  }

  const idx = allMessages.indexOf(message);
  if (idx <= 0) return null;

  const prev = allMessages[idx - 1];
  if (prev.type !== 'user') return null;
  const prevContent = prev.message?.content;
  if (!Array.isArray(prevContent)) return null;
  const toolResult = prevContent.find((c: any) => c?.type === 'tool_result');
  if (!toolResult) return null;
  const toolUseId: string | undefined = toolResult.tool_use_id;
  if (!toolUseId) return null;

  for (let i = idx - 2; i >= 0; i--) {
    const candidate = allMessages[i];
    if (candidate.type !== 'assistant') continue;
    const candContent = candidate.message?.content;
    if (!Array.isArray(candContent)) continue;
    const tu = candContent.find(
      (c: any) => c?.type === 'tool_use' && c?.id === toolUseId,
    );
    if (!tu) continue;
    if (tu.name !== 'Skill') return null;
    const skillName =
      (typeof tu.input?.skill === 'string' && tu.input.skill) ||
      (typeof tu.input?.name === 'string' && tu.input.name) ||
      'unknown';
    return { skillName };
  }

  return null;
}
