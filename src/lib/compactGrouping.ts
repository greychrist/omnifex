import type { JsonlNode } from '@/types/jsonl';
import type { MessageContentBlock } from '@/types/claudeStream';
import type { MessageRenderingConfig } from './messageRenderingConfig';
import { isHiddenInCompact, isNeverShown, resolveKind, type KindStyle } from './messageRenderingConfig';
import { classifyStandaloneKind } from './messageKind';
import { classifyBlockKind } from './blockKind';
import { countHiddenEvents } from './hiddenEventsSummary';

/**
 * Resolve the whole-message kind ID for compact-grouping purposes.
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
  // Sentinel IDs for the answered AskUserQuestion pair are internal dispatch
  // signals (StreamMessage short-circuits to AnsweredAskUserQuestionCard /
  // null before the registry lookup runs). Map them to the registry entry
  // that carries the correct compact-grouping style so they are never folded
  // into a HiddenEventsGroup.
  if (
    raw === 'tool.askUserQuestion.answered' ||
    raw === 'tool.askUserQuestion.answered.result'
  ) {
    return 'assistant.askUserQuestion';
  }
  return raw;
}

/**
 * Compact-mode grouping: walk the timeline and decide, per message, whether
 * to render it normally (visible) or fold it into a `HiddenEventsGroup`
 * with neighboring hidden messages.
 *
 * The rule is intentionally simple: a message is "fully hidden" iff every
 * renderable thing in it is hidden by the user's per-kind config. A
 * partially-hidden message (e.g. visible text + hidden tool_use blocks)
 * still renders normally — its hidden blocks get a per-message
 * `HiddenBlocksExpander` inside `StreamMessage`.
 *
 * Under the current CLI the live task list is surfaced by `TaskList` at the
 * bottom of the chat (driven by the per-task `TaskCreate` / `TaskUpdate`
 * stream), so there's no longer a single snapshot tool_use to carve out
 * and promote here.
 */

export type CompactItem =
  | { kind: 'single'; message: JsonlNode; key: string }
  | { kind: 'group'; messages: JsonlNode[]; key: string };

function isRenderableBlock(b: MessageContentBlock | null | undefined): boolean {
  if (!b || typeof b !== 'object') return false;
  if (b.type === 'tool_use' || b.type === 'tool_result' || b.type === 'image') return true;
  if (b.type === 'text') return (b.text ?? '').trim().length > 0;
  if (b.type === 'thinking') return (b.thinking ?? '').trim().length > 0;
  return false;
}

/**
 * True iff every renderable thing in `msg` is folded away in compact mode.
 * A message with no renderable content counts as hidden, so it joins any
 * neighbouring hidden run instead of injecting an empty card that fragments
 * runs visually for no reason.
 */
export function isMessageFullyHidden(
  msg: JsonlNode,
  allMessages: JsonlNode[],
  config: MessageRenderingConfig,
): boolean {
  return everyRenderableKind(msg, allMessages, config, isHiddenInCompact) ?? true;
}

/**
 * True iff every renderable thing in `msg` is set to never be shown. Unlike
 * the compact rule, a message with nothing classifiable stays: dropping
 * content is this predicate's whole effect, so it only acts on evidence.
 */
export function isMessageNeverShown(
  msg: JsonlNode,
  allMessages: JsonlNode[],
  config: MessageRenderingConfig,
): boolean {
  return everyRenderableKind(msg, allMessages, config, isNeverShown) ?? false;
}

/**
 * `messages` without the ones the user set to never be shown. Runs before
 * either view mode, so a never-shown message is neither drawn in verbose mode
 * nor folded into a compact-mode expander.
 */
export function withoutNeverShown(
  messages: JsonlNode[],
  config: MessageRenderingConfig,
): JsonlNode[] {
  const kept = messages.filter((m) => !isMessageNeverShown(m, messages, config));
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

export function buildCompactItems(
  messages: JsonlNode[],
  config: MessageRenderingConfig,
): CompactItem[] {
  const items: CompactItem[] = [];

  messages.forEach((message, idx) => {
    const fullyHidden = isMessageFullyHidden(message, messages, config);

    if (!fullyHidden) {
      items.push({ kind: 'single', message, key: `m-${idx}` });
      return;
    }

    const last = items[items.length - 1];
    if (last?.kind === 'group') {
      last.messages.push(message);
    } else {
      items.push({ kind: 'group', messages: [message], key: `g-${idx}` });
    }
  });

  // A hidden run with nothing countable renders no expander; emitting it
  // anyway left an empty, padded row — a blank gap — in the transcript.
  return items.filter((item) => item.kind === 'single' || countHiddenEvents(item.messages) > 0);
}
