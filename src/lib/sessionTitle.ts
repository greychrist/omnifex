// A session's name, resolved the way the CLI resolves it.
//
// The CLI keeps two title records in the transcript: `ai-title`, which it
// generates itself from the first prompt of a fresh conversation, and
// `custom-title`, which a rename writes (`/rename`, a claude.ai rename
// relayed down, or our own `rename_session` control request). It reads them
// independently — `findLast` per type — and lets a rename win regardless of
// which record landed last. It has to be independent: the CLI goes on
// re-emitting `ai-title` every turn after a rename, so "last record in the
// file wins" would flip the name back to the generated one on the next turn.
//
// Everything in the app that shows a session's name resolves it here, so the
// status bar, the session list and the CLI can never disagree about what a
// session is called.

import type { JsonlNode } from '@/types/jsonl';
import { parseCommandEnvelope } from './commandEnvelope';

export interface SessionTitleParts {
  /** The CLI's own generated title, from its `ai-title` records. */
  aiTitle?: string | null;
  /** A rename, from its `custom-title` records. */
  customTitle?: string | null;
}

/** The name to show for a session, or null when it has no name yet. */
export function pickSessionTitle({ aiTitle, customTitle }: SessionTitleParts): string | null {
  // A rename to empty string is how the CLI CLEARS a custom title, so blank
  // means "no rename" rather than "named the empty string".
  const custom = customTitle?.trim();
  if (custom) return custom;
  const ai = aiTitle?.trim();
  return ai ? ai : null;
}

/** The same rule, applied to the transcript records a live session delivers. */
export function deriveSessionTitle(messages: readonly JsonlNode[]): string | null {
  let aiTitle: string | undefined;
  let customTitle: string | undefined;
  for (const node of messages) {
    if (node.kind === 'ai-title') aiTitle = node.raw.aiTitle;
    else if (node.kind === 'custom-title') customTitle = node.raw.customTitle;
  }
  return pickSessionTitle({ aiTitle, customTitle });
}

/**
 * Indices of the title records worth a transcript row: those where the
 * effective title changes. The CLI re-appends an unchanged `ai-title` after
 * nearly every turn, and keeps appending it after a rename, so the raw
 * records repeat and alternate; only a change is news. The record kept is the
 * one that caused the change, so its kind says what changed.
 */
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

/**
 * The text of the session's first real prompt — what a name should be
 * suggested from. Tool results and forwarded subagent prompts are not the
 * user asking anything; image blocks contribute nothing. Null when the
 * transcript has no prompt yet.
 */
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
