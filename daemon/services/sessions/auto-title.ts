/**
 * Session auto-naming: when OmniFex asks the CLI to name a session.
 *
 * The CLI used to do this itself — a Haiku call fired on the first turn,
 * written to the transcript as an `ai-title` record, which is where
 * `Session.ai_title` and the tab subtitle come from. It stopped at CLI
 * 2.1.277 and 2.1.278 has not brought it back: across 534 transcripts, every
 * version through 2.1.276 titled ~all of its sessions and 2.1.277+ titled
 * none. Reproduced against a bare `--input-format stream-json` session, so it
 * is the CLI, not OmniFex's argv.
 *
 * What still works is the `generate_session_title` control request, and with
 * `persist: true` the CLI writes the same `ai-title` record it always did —
 * so nothing downstream of the transcript has to change. This module decides
 * when to send it.
 *
 * Deliberately NOT `custom-title`: the CLI resolves a session's name as
 * `agentName || customTitle || aiTitle || summary || firstPrompt`, so a name
 * generated here can never overwrite one the user typed.
 */

/** Pure: what `sendMessage` knows at the moment the prompt is handed over. */
export interface AutoTitleDecision {
  /** The per-session latch. Set for resumes at handle construction. */
  attempted: boolean;
  /** The prompt text about to reach the CLI. */
  prompt: string;
}

export function shouldAutoTitle({ attempted, prompt }: AutoTitleDecision): boolean {
  if (attempted) return false;
  const trimmed = prompt.trim();
  if (!trimmed) return false;
  // A slash command names the session after the command rather than the work
  // — "/resume", "/compact". The CLI's own gate excluded these too. A leading
  // absolute path is not one: `/Users/...` has a slash and a dot but no
  // command shape, and pasting a path is a perfectly good first prompt.
  if (/^\/[a-z][\w-]*(\s|$)/i.test(trimmed)) return false;
  return true;
}

/**
 * The description to name from, pulled out of a structured message's content
 * blocks. A first message that is an image plus a caption should still name
 * the session; one that is an image alone has nothing to name from.
 */
export function autoTitleDescription(content: Record<string, unknown>[]): string {
  return content
    .filter((b) => b.type === 'text' && typeof b.text === 'string')
    .map((b) => (b.text as string).trim())
    .filter(Boolean)
    .join('\n')
    .trim();
}
