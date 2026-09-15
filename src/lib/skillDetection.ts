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
 * A user-role message is "skill-injected" when the CLI names the `Skill`
 * tool_use that produced it in `sourceToolUseID`. The CLI injects the skill's
 * SKILL.md body as a user-role text message after the tool runs, and we
 * render it distinctly from a real user-typed prompt.
 *
 * Detection is position-independent, and that is the point. This used to
 * require the record to sit IMMEDIATELY after the Skill tool_result, which
 * held only while the CLI emitted exactly one companion per invocation. CLI
 * 2.1.270 emits two on a re-invocation — a "(Re-invocation of …)" preamble,
 * then the body — so adjacency matched the preamble and the body fell
 * through to `user.prompt`, rendering a skill's instructions as if the user
 * had typed them.
 *
 * `sourceToolUseID` is only present on the CLI's persisted JSONL; stream-json
 * strips it along with `isMeta` and `turnCompanion`. That is safe to depend
 * on because committed transcript rows now come from the JSONL exclusively
 * (see electron/services/sessions/stream-forward.ts).
 */
export function detectSkillInjection(
  message: JsonlNode,
  allMessages: JsonlNode[],
): SkillInjection | null {
  if (message.kind !== 'user') return null;

  const sourceToolUseID = (message.raw as { sourceToolUseID?: unknown }).sourceToolUseID;
  if (typeof sourceToolUseID !== 'string' || sourceToolUseID.length === 0) return null;

  // Boundary normalization (lib/normalizeMessage) wraps the CLI's bare-string
  // user prompts into single-text-block arrays at ingress, so by the time
  // this runs `content` is always an array (or the message has no content).
  const content = getContent(message);
  if (!content) return null;
  const hasToolResult = content.some((c: any) => c?.type === 'tool_result');
  if (hasToolResult) return null;
  const hasText = content.some((c: any) => c?.type === 'text');
  if (!hasText) return null;

  for (const candidate of allMessages) {
    if (candidate.kind !== 'assistant') continue;
    const candContent = getContent(candidate);
    if (!candContent) continue;
    // BetaContentBlock narrows to BetaToolUseBlock when type === 'tool_use'.
    const tu = candContent.find(
      (c): c is Extract<typeof c, { type: 'tool_use' }> =>
        (c as any)?.type === 'tool_use' && (c as { id?: string }).id === sourceToolUseID,
    );
    if (!tu) continue;
    // A companion from some other tool (Task, Bash) is not a skill body.
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
