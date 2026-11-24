// The CLI no longer titles sessions itself; `generate_session_title` with `persist: true` writes its `ai-title` record.
// Never `custom-title`: the CLI ranks it above `aiTitle`, so it would overwrite a name the user typed.

export interface AutoTitleDecision {
  attempted: boolean;
  prompt: string;
}

export function shouldAutoTitle({ attempted, prompt }: AutoTitleDecision): boolean {
  if (attempted) return false;
  const trimmed = prompt.trim();
  if (!trimmed) return false;
  // A leading absolute path (`/Users/...`) is a real prompt, not a command.
  if (/^\/[a-z][\w-]*(\s|$)/i.test(trimmed)) return false;
  return true;
}

export function autoTitleDescription(content: Record<string, unknown>[]): string {
  return content
    .filter((b) => b.type === 'text' && typeof b.text === 'string')
    .map((b) => (b.text as string).trim())
    .filter(Boolean)
    .join('\n')
    .trim();
}
