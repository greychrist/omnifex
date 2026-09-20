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
    const trimmed = text.trim();
    if (trimmed) return trimmed;
  }
  return null;
}
