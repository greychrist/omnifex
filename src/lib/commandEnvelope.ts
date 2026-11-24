import { tagText } from './xmlTags';

/** The CLI's tag order varies (built-ins name-first with args, skills message-first without): match each tag independently. */
export interface CommandEnvelope {
  name: string;
  message: string;
  args?: string;
}

export function parseCommandEnvelope(text: string): CommandEnvelope | null {
  const name = tagText(text, 'command-name');
  if (!name) return null;
  const args = tagText(text, 'command-args');
  return {
    name,
    message: tagText(text, 'command-message') ?? '',
    args: args || undefined,
  };
}

export const COMMAND_NAME_TAG = '<command-name>';

/** The tags must open the text: a tag further in is a prompt quoting one. */
export function commandEnvelopeKind(text: string): 'echo' | 'output' | null {
  const head = text.trimStart();
  if (head.startsWith('<local-command-stdout>') || head.startsWith('<local-command-stderr>')) return 'output';
  if ((head.startsWith(COMMAND_NAME_TAG) || head.startsWith('<command-message>')) && head.includes(COMMAND_NAME_TAG)) {
    return 'echo';
  }
  return null;
}

/** Keyed on the CLI's `commandRun` stamp, never the text: the recap is prose. */
export function isRecapCommandRecord(raw: unknown): boolean {
  const run = (raw as { commandRun?: { command?: unknown } } | null)?.commandRun;
  return run?.command === 'recap';
}

/** CLI 2.1.283+ puts this in a `system/local_command` record's content; older transcripts in a user record. */
export function localCommandOutput(text: string): string {
  const parts: string[] = [];
  for (const tag of ['local-command-stdout', 'local-command-stderr']) {
    const m = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(text);
    if (m) parts.push(m[1]);
  }
  return parts.length > 0 ? parts.join('\n') : text;
}

/** Both shapes: the live stream and a re-read transcript differ, and only one normalizes. */
function contentText(content: unknown): string | null {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return null;
  return content
    .map((b) => (b && typeof b === 'object' && (b as { type?: string }).type === 'text'
      ? String((b as { text?: string }).text ?? '')
      : ''))
    .join('');
}

export function isLocalCommandEnvelope(content: unknown): boolean {
  const text = contentText(content);
  return text !== null && commandEnvelopeKind(text) !== null;
}

/** Skill/custom echoes are message-first and newer CLIs stamp `turnOrigin` on them; either signal counts. */
export function isModelCommandEcho(content: unknown, turnOrigin: unknown): boolean {
  const text = contentText(content);
  if (text === null || commandEnvelopeKind(text) !== 'echo') return false;
  return text.trimStart().startsWith('<command-message>') || typeof turnOrigin === 'string';
}
