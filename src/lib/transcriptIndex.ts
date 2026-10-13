import type { JsonlNode } from '@/types/jsonl';
import type { MessageContentBlock } from '@/types/claudeStream';
import { collectStructuredResults } from './bashToolResult';

/**
 * One pass over a transcript, keyed by tool_use id, so that "find the record
 * that goes with this one" is a map lookup instead of a walk.
 *
 * Rows used to answer those questions by scanning the whole message array —
 * each row, on every render. Under an unvirtualised transcript that is
 * quadratic: a 4,000-record tab took ~5.6s of main thread per appended record
 * (traced 2026-10-13), freezing the window from a tab that was not even on
 * screen. The helpers that did the scanning (`findToolUse`, `hasLiveDenial`,
 * `isSubagentPrompt`, `detectSkillInjection`, `classifyStandaloneKind`) now
 * read this instead, so every caller got cheaper at once.
 *
 * Cached per array identity, the same contract as `queueWaitMs`: the store
 * replaces the message array on every change and never mutates one in place.
 * An array that is mutated after it has been indexed would read stale.
 *
 * Duplicate ids keep the LAST occurrence. A tool_use id is unique per call, so
 * a duplicate is the same block recorded twice and the two are identical.
 */
export interface TranscriptIndex {
  /** Each tool call's name and input. */
  readonly toolUses: ReadonlyMap<string, ToolUseRef>;
  /** Each tool call's `tool_result` content block. */
  readonly toolResults: ReadonlyMap<string, MessageContentBlock>;
  /** The structured half of each result — see `collectStructuredResults`. */
  readonly structuredResults: ReadonlyMap<string, Record<string, unknown>>;
  /** Calls a live `permission_denied` event was emitted for. */
  readonly liveDenials: ReadonlySet<string>;
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

/**
 * One ref per tool_use block for the block's lifetime, not per index build: a
 * row's lookups are compared by identity, and a ref minted afresh by each
 * append would read as "changed" and re-render every row that holds one.
 */
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
  const liveDenials = new Set<string>();

  for (const node of messages) {
    if (node.kind === 'system') {
      const id = (node.raw as { tool_use_id?: unknown }).tool_use_id;
      if (node.subtype === 'permission_denied' && typeof id === 'string') liveDenials.add(id);
      continue;
    }
    if (node.kind !== 'assistant' && node.kind !== 'user') continue;
    const content = (node.raw as { message?: { content?: unknown } }).message?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content as Array<{ type?: string; id?: unknown; name?: unknown; input?: unknown; tool_use_id?: unknown }>) {
      if (node.kind === 'assistant' && block?.type === 'tool_use' && typeof block.id === 'string') {
        toolUses.set(block.id, toolUseRef(block));
      } else if (node.kind === 'user' && block?.type === 'tool_result' && typeof block.tool_use_id === 'string') {
        toolResults.set(block.tool_use_id, block as unknown as MessageContentBlock);
      }
    }
  }

  return {
    toolUses,
    toolResults,
    structuredResults: collectStructuredResults(messages as unknown as { kind: string; raw: unknown }[]),
    liveDenials,
  };
}
