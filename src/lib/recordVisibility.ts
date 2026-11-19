/**
 * Which records Standard leaves out, by each record's kind settings
 * (Settings › Chats). Expanded reads none of this: it draws every record.
 * What survives of the classic Compact grouping (2026-11-18).
 */
import type { JsonlNode } from '@/types/jsonl';
import type { MessageContentBlock } from '@/types/claudeStream';
import type { MessageRenderingConfig } from './messageRenderingConfig';
import { isHiddenInStandard, resolveKind, type KindStyle } from './messageRenderingConfig';
import { classifyStandaloneKind } from './messageKind';
import { classifyBlockKind } from './blockKind';

/**
 * Resolve the whole-message kind ID a visibility rule reads.
 *
 * Uses `classifyStandaloneKind` for the context-aware kind derivation.
 *
 * Returns `null` for mixed-content messages (regular assistant / user
 * prompt) that need per-block analysis instead of a whole-message kind.
 *
 * Internal sentinel IDs that the classifier emits but that intentionally
 * have no registry entries (tool.askUserQuestion.answered and .result) are
 * mapped to their effective registry kind so resolveKind can resolve them
 * correctly instead of falling through to the system-category default.
 */
function resolveWholeMessageKind(
  msg: JsonlNode,
  allMessages: JsonlNode[],
): string | null {
  const raw = classifyStandaloneKind(msg, allMessages);
  // Sentinel IDs for the answered AskUserQuestion pair have no registry
  // entry. Map them to the one that carries their visibility.
  if (
    raw === 'tool.askUserQuestion.answered' ||
    raw === 'tool.askUserQuestion.answered.result'
  ) {
    return 'assistant.askUserQuestion';
  }
  // A record type OmniFex does not recognize: the Unknown kind decides it.
  if (raw === null && msg.kind === 'unknown') return 'unknown';
  return raw;
}

function isRenderableBlock(b: MessageContentBlock | null | undefined): boolean {
  if (!b || typeof b !== 'object') return false;
  if (b.type === 'tool_use' || b.type === 'tool_result' || b.type === 'image') return true;
  if (b.type === 'text') return (b.text ?? '').trim().length > 0;
  if (b.type === 'thinking') return (b.thinking ?? '').trim().length > 0;
  return false;
}

/**
 * True iff every renderable thing in `msg` is hidden in Standard. A message
 * with no renderable content counts as hidden.
 */
export function isMessageFullyHidden(
  msg: JsonlNode,
  allMessages: JsonlNode[],
  config: MessageRenderingConfig,
): boolean {
  return everyRenderableKind(msg, allMessages, config, isHiddenInStandard) ?? true;
}

/**
 * `messages` without the records Standard hides: every renderable thing in
 * them is a kind hidden in Standard. A record with nothing classifiable
 * stays — dropping it is this filter's whole effect, so it acts only on
 * evidence. Records that reach grouping as a line meet the stricter
 * `isMessageFullyHidden` there, as Compact's did.
 */
export function withoutHiddenInStandard(
  messages: JsonlNode[],
  config: MessageRenderingConfig,
): JsonlNode[] {
  const kept = messages.filter((m) => !everyRenderableKind(m, messages, config, isHiddenInStandard));
  return kept.length === messages.length ? messages : kept;
}

/**
 * Whether `test` holds for the message's kind — or, for mixed-content
 * messages, for every renderable block's kind. Null when the message has no
 * renderable content, which each caller resolves its own way.
 */
function everyRenderableKind(
  msg: JsonlNode,
  allMessages: JsonlNode[],
  config: MessageRenderingConfig,
  test: (style: KindStyle) => boolean,
): boolean | null {
  const wholeKind = resolveWholeMessageKind(msg, allMessages);
  if (wholeKind) return test(resolveKind(config, wholeKind));

  // Boundary normalization (lib/normalizeMessage) wraps the CLI's persisted
  // bare-string user prompts into single-text-block arrays at ingress, so
  // every message reaches this point with array-shaped content.
  const content = (msg as unknown as { raw?: { message?: { content?: unknown } } }).raw?.message?.content;
  if (!Array.isArray(content) || content.length === 0) return null;

  let renderable = 0;
  let hidden = 0;
  for (const b of content as MessageContentBlock[]) {
    if (!isRenderableBlock(b)) continue;
    renderable += 1;
    const blockKind = classifyBlockKind(b, msg);
    if (!blockKind) {
      // Unclassified renderable block (e.g. a plain user typed text block).
      // Treat as visible — its kind is either implicit user.prompt (locked
      // visible) or genuinely something we have no toggle for.
      continue;
    }
    if (test(resolveKind(config, blockKind))) hidden += 1;
  }

  // Nothing renderable (e.g. signature-only thinking blocks).
  if (renderable === 0) return null;

  return hidden === renderable;
}
