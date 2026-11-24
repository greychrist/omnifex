import type { JsonlNode } from '@/types/jsonl';
import type { MessageContentBlock } from '@/types/claudeStream';

/** Cached per array identity: the store replaces the array on change and never mutates it in place. */
export interface TranscriptIndex {
  readonly toolUses: ReadonlyMap<string, ToolUseRef>;
  readonly toolResults: ReadonlyMap<string, MessageContentBlock>;
}

export interface ToolUseRef {
  name: string;
  input: Record<string, unknown>;
}

export function transcriptIndex(messages: readonly JsonlNode[]): TranscriptIndex {
  let index = cache.get(messages);
  if (!index) {
    index = build(messages);
    cache.set(messages, index);
  }
  return index;
}

const cache = new WeakMap<readonly JsonlNode[], TranscriptIndex>();

/** One ref per block for its lifetime: rows compare by identity, and a fresh ref per append re-renders every row. */
function toolUseRef(block: { name?: unknown; input?: unknown }): ToolUseRef {
  let ref = refs.get(block);
  if (!ref) {
    const input = block.input && typeof block.input === 'object' ? (block.input as Record<string, unknown>) : {};
    ref = { name: typeof block.name === 'string' ? block.name : 'tool', input };
    refs.set(block, ref);
  }
  return ref;
}

const refs = new WeakMap<object, ToolUseRef>();

function build(messages: readonly JsonlNode[]): TranscriptIndex {
  const toolUses = new Map<string, ToolUseRef>();
  const toolResults = new Map<string, MessageContentBlock>();

  for (const node of messages) {
    if (node.kind !== 'assistant' && node.kind !== 'user') continue;
    const content = (node.raw as { message?: { content?: unknown } }).message?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content as { type?: string; id?: unknown; name?: unknown; input?: unknown; tool_use_id?: unknown }[]) {
      if (node.kind === 'assistant' && block?.type === 'tool_use' && typeof block.id === 'string') {
        toolUses.set(block.id, toolUseRef(block));
      } else if (node.kind === 'user' && block?.type === 'tool_result' && typeof block.tool_use_id === 'string') {
        toolResults.set(block.tool_use_id, block as unknown as MessageContentBlock);
      }
    }
  }

  return { toolUses, toolResults };
}
