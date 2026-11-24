import type { JsonlNode } from '@/types/jsonl';
import type { MessageContentBlock } from '@/types/claudeStream';
import type { MessageRenderingConfig } from './messageRenderingConfig';
import { isHiddenInStandard, resolveKind, type KindStyle } from './messageRenderingConfig';
import { classifyStandaloneKind } from './messageKind';
import { classifyBlockKind } from './blockKind';

function resolveWholeMessageKind(
  msg: JsonlNode,
  allMessages: JsonlNode[],
): string | null {
  const raw = classifyStandaloneKind(msg, allMessages);
  // The answered-AskUserQuestion sentinels have no registry entry.
  if (
    raw === 'tool.askUserQuestion.answered' ||
    raw === 'tool.askUserQuestion.answered.result'
  ) {
    return 'assistant.askUserQuestion';
  }
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

export function isMessageFullyHidden(
  msg: JsonlNode,
  allMessages: JsonlNode[],
  config: MessageRenderingConfig,
): boolean {
  return everyRenderableKind(msg, allMessages, config, isHiddenInStandard) ?? true;
}

/** A record with nothing classifiable stays: this filter acts only on evidence. */
export function withoutHiddenInStandard(
  messages: JsonlNode[],
  config: MessageRenderingConfig,
): JsonlNode[] {
  const kept = messages.filter((m) => !everyRenderableKind(m, messages, config, isHiddenInStandard));
  return kept.length === messages.length ? messages : kept;
}

function everyRenderableKind(
  msg: JsonlNode,
  allMessages: JsonlNode[],
  config: MessageRenderingConfig,
  test: (style: KindStyle) => boolean,
): boolean | null {
  const wholeKind = resolveWholeMessageKind(msg, allMessages);
  if (wholeKind) return test(resolveKind(config, wholeKind));

  const content = (msg as unknown as { raw?: { message?: { content?: unknown } } }).raw?.message?.content;
  if (!Array.isArray(content) || content.length === 0) return null;

  let renderable = 0;
  let hidden = 0;
  for (const b of content as MessageContentBlock[]) {
    if (!isRenderableBlock(b)) continue;
    renderable += 1;
    const blockKind = classifyBlockKind(b, msg);
    if (!blockKind) {
      continue;
    }
    if (test(resolveKind(config, blockKind))) hidden += 1;
  }

  if (renderable === 0) return null;

  return hidden === renderable;
}
