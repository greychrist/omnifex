import type { JsonlNode } from '@/types/jsonl';
import type { MessageContentBlock } from '@/types/claudeStream';
import type { MessageRenderingConfig } from './messageRenderingConfig';
import { classifyStandaloneKind } from './messageKind';
import { classifyBlockKind } from './blockKind';

/**
 * Resolve the whole-message kind ID for compact-grouping purposes.
 *
 * Uses `classifyStandaloneKind` for the context-aware kind derivation.
 *
 * Returns `null` for mixed-content messages (regular assistant / user
 * prompt) that need per-block analysis instead of a whole-message kind.
 */
function resolveWholeMessageKind(
  msg: JsonlNode,
  allMessages: JsonlNode[],
): string | null {
  return classifyStandaloneKind(msg, allMessages);
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
 * Under SDK 0.3.x the live task list is surfaced by `TaskList` at the
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
  if (b.type === 'text') return b.text.trim().length > 0;
  if (b.type === 'thinking') return b.thinking.trim().length > 0;
  return false;
}

/**
 * True iff every renderable thing in `msg` is marked hidden by `config`.
 * A message with no renderable content is considered "not hidden" so it
 * doesn't get swept into a group (the renderer will drop it on its own).
 */
export function isMessageFullyHidden(
  msg: JsonlNode,
  allMessages: JsonlNode[],
  config: MessageRenderingConfig,
): boolean {
  const wholeKind = resolveWholeMessageKind(msg, allMessages);
  if (wholeKind) {
    const k = config.kinds[wholeKind];
    if (!k) return false;
    if (k.compactBoundaryLocked) return false;
    return k.hiddenInCompact;
  }

  // Boundary normalization (lib/normalizeMessage) wraps the CLI's persisted
  // bare-string user prompts into single-text-block arrays at ingress, so
  // every message reaches this point with array-shaped content.
  // No content / empty content = nothing to render. Treat as hidden so the
  // message joins any neighboring hidden run instead of breaking it.
  // (Emitting it as a visible "single" would inject an empty card that
  // fragments runs visually for no reason.)
  const content = (msg as unknown as { raw?: { message?: { content?: unknown } } }).raw?.message?.content;
  if (!Array.isArray(content) || content.length === 0) return true;

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
    const k = config.kinds[blockKind];
    if (!k) continue;
    if (k.compactBoundaryLocked) continue;
    if (k.hiddenInCompact) hidden += 1;
  }

  // Same reasoning as the empty-content case: if there's no renderable
  // content (e.g. signature-only thinking blocks), let it merge into a
  // neighboring hidden run.
  if (renderable === 0) return true;

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

  return items;
}
