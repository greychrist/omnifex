// The optimistic echo is a uuid-less placeholder that the CLI's JSONL record replaces: stream-json never echoes the
// typed prompt, and file-vs-echo is invisible to stream-forward's deny-list. Unmatched records append (fail visible).

import type { JsonlNode } from '@/types/jsonl';

type UserNode = Extract<JsonlNode, { kind: 'user' }>;

function isPromptNode(node: JsonlNode): node is UserNode {
  return node.kind === 'user' && node.userKind === 'prompt';
}

function rawOf(node: JsonlNode): Record<string, unknown> | null {
  return 'raw' in node ? (node.raw as Record<string, unknown>) : null;
}

export function uuidOf(node: JsonlNode): string | null {
  const uuid = rawOf(node)?.uuid;
  return typeof uuid === 'string' && uuid.length > 0 ? uuid : null;
}

export function isPendingPromptPlaceholder(node: JsonlNode): boolean {
  return isPromptNode(node) && uuidOf(node) === null;
}

/** A built-in slash command's echo is 'local-command'; its stdout is too, but carries no `<command-name>`. */
export function isCliPromptRecord(node: JsonlNode): boolean {
  if (node.kind !== 'user') return false;
  if (node.userKind !== 'prompt' && node.userKind !== 'local-command') return false;
  return uuidOf(node) !== null;
}

function promptText(node: JsonlNode): string {
  const message = rawOf(node)?.message as { content?: unknown } | undefined;
  const content = message?.content;
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return '';
  return content
    .filter(
      (b): b is { type: 'text'; text: string } =>
        typeof b === 'object' &&
        b !== null &&
        (b as { type?: unknown }).type === 'text' &&
        typeof (b as { text?: unknown }).text === 'string',
    )
    .map((b) => b.text)
    .join('\n')
    .trim();
}

/** The CLI persists a typed `/foo bar` as `<command-name>` envelopes, in either order, so its text never equals what was typed. */
function commandNameOf(text: string): string | null {
  const match = /<command-name>\s*\/?([^<\s]+)\s*<\/command-name>/.exec(text);
  return match ? match[1] : null;
}

function typedCommandOf(text: string): string | null {
  if (!text.startsWith('/')) return null;
  const word = text.slice(1).split(/\s/, 1)[0];
  return word.length > 0 ? word : null;
}

function isSamePrompt(placeholderText: string, recordText: string): boolean {
  if (placeholderText === recordText) return true;
  const typed = typedCommandOf(placeholderText);
  if (typed === null) return false;
  return commandNameOf(recordText) === typed;
}

/** Oldest-first, so two identical prompts in flight reconcile in send order. */
export function findPendingPromptMatch(messages: JsonlNode[], incoming: JsonlNode): number {
  if (!isCliPromptRecord(incoming)) return -1;
  const text = promptText(incoming);
  for (let i = 0; i < messages.length; i += 1) {
    const candidate = messages[i];
    if (!isPendingPromptPlaceholder(candidate)) continue;
    if (isSamePrompt(promptText(candidate), text)) return i;
  }
  return -1;
}

export function reconcilePendingPrompt(
  messages: JsonlNode[],
  incoming: JsonlNode,
): JsonlNode[] | null {
  const idx = findPendingPromptMatch(messages, incoming);
  if (idx === -1) return null;
  const next = messages.slice();
  next[idx] = incoming;
  return next;
}

function timeOf(node: JsonlNode): number {
  const at = (node as { receivedAt?: unknown }).receivedAt;
  return typeof at === 'string' ? Date.parse(at) : NaN;
}

/**
 * The answer reaches the JSONL before `result`, which drains the queue, so the next echo can be appended first. A
 * persisted record written before an echo's stamp goes above it; only records with a uuid move.
 */
export function appendCliRecord(messages: JsonlNode[], incoming: JsonlNode): JsonlNode[] {
  const writtenAt = timeOf(incoming);
  if (uuidOf(incoming) !== null && !Number.isNaN(writtenAt)) {
    const idx = messages.findIndex(
      (m) => isPendingPromptPlaceholder(m) && timeOf(m) > writtenAt,
    );
    if (idx !== -1) {
      return [...messages.slice(0, idx), incoming, ...messages.slice(idx)];
    }
  }
  return [...messages, incoming];
}
