/**
 * Reconciling the optimistic prompt echo with the CLI's own record of it.
 *
 * In rich mode the renderer appends a synthetic `user` node the instant you
 * press Enter (`useSendPrompt`), so the bubble does not wait on the CLI. That
 * echo used to be the only copy of your prompt in `messages[]`: stream-json
 * echoes `user` records for tool results, never for the prompt you typed.
 *
 * The transcript inversion made the CLI's JSONL the source of committed rows,
 * and the JSONL *does* record the prompt. The stream's copy is denied
 * (`JSONL_CARRIED_TYPES` includes `user`), which correctly de-duplicates tool
 * results — but the prompt's collision is not stream-vs-file, it is
 * file-vs-echo, so nothing caught it and every prompt rendered twice.
 *
 * The fix is to reconcile rather than to drop the echo. Dropping it would put
 * the JSONL tail's 100ms poll — and, on the first prompt of a session, the
 * whole session-start latency — between Enter and seeing your own text. So the
 * echo stays as a placeholder and the CLI's record replaces it. That also
 * upgrades the row to the real record, which matters downstream: `turnDelta`
 * anchors on prompt nodes and `transcriptStepper` walks them by uuid.
 *
 * A placeholder is identified by the absence of `uuid` — the renderer cannot
 * mint one the CLI would agree with, and every persisted record has one.
 *
 * When matching fails the caller appends, so an unrecognised shape shows up
 * twice rather than vanishing. Same direction as the deny-list in
 * electron/services/sessions/stream-forward.ts: fail toward the visible bug.
 */

import type { JsonlNode } from '@/types/jsonl';

type UserNode = Extract<JsonlNode, { kind: 'user' }>;

function isPromptNode(node: JsonlNode): node is UserNode {
  return node.kind === 'user' && node.userKind === 'prompt';
}

/** The node's raw JSONL line. Overlay kinds (stream-event, …) carry none. */
function rawOf(node: JsonlNode): Record<string, unknown> | null {
  return 'raw' in node ? (node.raw as Record<string, unknown>) : null;
}

function uuidOf(node: JsonlNode): string | null {
  const uuid = rawOf(node)?.uuid;
  return typeof uuid === 'string' && uuid.length > 0 ? uuid : null;
}

/**
 * True for the renderer's own optimistic echo: a user prompt with no uuid,
 * still waiting for the CLI to write its copy.
 */
export function isPendingPromptPlaceholder(node: JsonlNode): boolean {
  return isPromptNode(node) && uuidOf(node) === null;
}

/** True for the CLI's persisted record of a user prompt. */
export function isCliPromptRecord(node: JsonlNode): boolean {
  return isPromptNode(node) && uuidOf(node) !== null;
}

/**
 * The prompt's text, with image and other non-text blocks dropped — the CLI
 * persists images as their own blocks and we only compare what was typed.
 */
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

/**
 * The command a CLI record describes, when the record is a slash-command
 * envelope. The CLI rewrites a typed `/foo bar` into
 * `<command-name>/foo</command-name>` plus `<command-message>` /
 * `<command-args>` siblings before persisting it, so the persisted text never
 * equals what the user typed. Both orderings occur in real transcripts.
 */
function commandNameOf(text: string): string | null {
  const match = /<command-name>\s*\/?([^<\s]+)\s*<\/command-name>/.exec(text);
  return match ? match[1] : null;
}

/** The command a typed prompt invokes, or null when it is ordinary prose. */
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

/**
 * Index of the placeholder `incoming` is the CLI's copy of, or -1.
 *
 * Scans oldest-first so two identical prompts in flight reconcile in the order
 * they were sent.
 */
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

/**
 * `messages` with the matching placeholder replaced by `incoming`, or null
 * when there is nothing to reconcile — in which case the caller appends as
 * normal. Never mutates the input.
 */
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
