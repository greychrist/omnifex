// A rename (custom-title) wins regardless of order: the CLI re-emits ai-title every turn after a rename.

import type { JsonlNode } from '@/types/jsonl';
import { parseCommandEnvelope } from './commandEnvelope';

export interface SessionTitleParts {
  aiTitle?: string | null;
  customTitle?: string | null;
}

export function pickSessionTitle({ aiTitle, customTitle }: SessionTitleParts): string | null {
  // An empty rename is how the CLI clears a custom title.
  const custom = customTitle?.trim();
  if (custom) return custom;
  const ai = aiTitle?.trim();
  return ai ? ai : null;
}

export function deriveSessionTitle(messages: readonly JsonlNode[]): string | null {
  let aiTitle: string | undefined;
  let customTitle: string | undefined;
  for (const node of messages) {
    if (node.kind === 'ai-title') aiTitle = node.raw.aiTitle;
    else if (node.kind === 'custom-title') customTitle = node.raw.customTitle;
  }
  return pickSessionTitle({ aiTitle, customTitle });
}

/** Only title changes: the CLI re-appends an unchanged ai-title nearly every turn. */
export function titleChangeIndices(messages: readonly JsonlNode[]): ReadonlySet<number> {
  const keep = new Set<number>();
  let aiTitle: string | undefined;
  let customTitle: string | undefined;
  let shown: string | null = null;
  messages.forEach((node, i) => {
    if (node.kind === 'ai-title') aiTitle = node.raw.aiTitle;
    else if (node.kind === 'custom-title') customTitle = node.raw.customTitle;
    else return;
    const effective = pickSessionTitle({ aiTitle, customTitle });
    if (effective !== null && effective !== shown) {
      keep.add(i);
      shown = effective;
    }
  });
  return keep;
}

export function firstPromptText(messages: readonly JsonlNode[]): string | null {
  for (const node of messages) {
    if (node.kind !== 'user' || node.userKind !== 'prompt') continue;
    const raw = node.raw as { parent_tool_use_id?: unknown; message?: { content?: unknown } };
    if (raw.parent_tool_use_id) continue;
    const content = raw.message?.content;
    const text = typeof content === 'string'
      ? content
      : Array.isArray(content)
        ? content
            .filter((b): b is { type: 'text'; text: string } => !!b && typeof b === 'object' && (b as { type?: unknown }).type === 'text' && typeof (b as { text?: unknown }).text === 'string')
            .map((b) => b.text)
            .join('')
        : '';
    // A skill command's echo is the CLI's envelope; suggest from what was typed.
    const command = parseCommandEnvelope(text);
    const trimmed = command ? [command.name, command.args].filter(Boolean).join(' ') : text.trim();
    if (trimmed) return trimmed;
  }
  return null;
}
