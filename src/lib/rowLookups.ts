import type { JsonlNode } from '@/types/jsonl';
import type { MessageContentBlock } from '@/types/claudeStream';
import { transcriptIndex, type ToolUseRef } from './transcriptIndex';
import { classifyStandaloneKind } from './messageKind';
import { detectSkillInjection, type SkillInjection } from './skillDetection';
import { queueWaitMs } from './queueWait';
import { turnDuration } from './sessionDerivedState';

/**
 * Everything a transcript row needs to know about OTHER records — and nothing
 * else — so a row's props change only when something it shows changes.
 *
 * A row used to take the whole message array. Every appended record made a new
 * array, which defeated `React.memo` on every row in the tab; each row then
 * re-derived these answers by scanning the array and re-parsed its markdown.
 * On a 4,000-record tab that was ~5.6s of frozen window per record (traced
 * 2026-10-13). Now the transcript builds one of these per row and hands back
 * the SAME object while the answers are unchanged, so an append re-renders the
 * new row plus any row whose answers it changed — a tool call whose result just
 * landed — and nothing else.
 *
 * Every map is restricted to the ids the row itself names: the tool calls in
 * an assistant row, the results in a user row, a denial's call.
 */
export interface RowLookups {
  /** `tool_result` block for each tool call in this row that has one. */
  readonly toolResults: ReadonlyMap<string, MessageContentBlock>;
  /** Structured result for each tool call in this row that has one. */
  readonly structuredResults: ReadonlyMap<string, Record<string, unknown>>;
  /** The call behind each `tool_result` in this row, and a denial's call. */
  readonly toolUses: ReadonlyMap<string, ToolUseRef>;
  /** Of this row's results, those a live `permission_denied` already showed. */
  readonly liveDenials: ReadonlySet<string>;
  readonly standaloneKind: string | null;
  readonly skillInjection: SkillInjection | null;
  /** Completion-band duration; assistant rows only. */
  readonly turnDurationMs: number | null;
  /** Time in the CLI's input queue; dequeue rows only. */
  readonly queueWaitMs: number | null;
}

/** Last answers per row, so an unchanged row gets its previous object back. */
export type RowLookupCache = WeakMap<JsonlNode, RowLookups>;

export function createRowLookupCache(): RowLookupCache {
  return new WeakMap();
}

export function rowLookups(
  message: JsonlNode,
  messages: readonly JsonlNode[],
  cache: RowLookupCache,
): RowLookups {
  const next = compute(message, messages);
  const prev = cache.get(message);
  if (prev && sameLookups(prev, next)) return prev;
  cache.set(message, next);
  return next;
}

function compute(message: JsonlNode, messages: readonly JsonlNode[]): RowLookups {
  const index = transcriptIndex(messages);
  const toolResults = new Map<string, MessageContentBlock>();
  const structuredResults = new Map<string, Record<string, unknown>>();
  const toolUses = new Map<string, ToolUseRef>();
  const liveDenials = new Set<string>();

  const useCall = (id: string) => {
    const call = index.toolUses.get(id);
    if (call) toolUses.set(id, call);
  };

  if (message.kind === 'assistant' || message.kind === 'user') {
    const content = (message.raw as { message?: { content?: unknown } }).message?.content;
    if (Array.isArray(content)) {
      for (const block of content as Array<{ type?: string; id?: unknown; tool_use_id?: unknown }>) {
        if (message.kind === 'assistant' && block?.type === 'tool_use' && typeof block.id === 'string') {
          const result = index.toolResults.get(block.id);
          if (result) toolResults.set(block.id, result);
          const structured = index.structuredResults.get(block.id);
          if (structured) structuredResults.set(block.id, structured);
        } else if (message.kind === 'user' && block?.type === 'tool_result' && typeof block.tool_use_id === 'string') {
          useCall(block.tool_use_id);
          if (index.liveDenials.has(block.tool_use_id)) liveDenials.add(block.tool_use_id);
        }
      }
    }
  } else if (message.kind === 'system' && message.subtype === 'permission_denied') {
    const id = (message.raw as { tool_use_id?: unknown }).tool_use_id;
    if (typeof id === 'string') useCall(id);
  }

  return {
    toolResults,
    structuredResults,
    toolUses,
    liveDenials,
    standaloneKind: classifyStandaloneKind(message, messages),
    skillInjection: detectSkillInjection(message, messages),
    turnDurationMs: turnDuration(messages, message),
    queueWaitMs: message.kind === 'queue-operation' ? queueWaitMs(messages, message) : null,
  };
}

function sameLookups(a: RowLookups, b: RowLookups): boolean {
  return a.standaloneKind === b.standaloneKind
    && a.skillInjection?.skillName === b.skillInjection?.skillName
    && a.turnDurationMs === b.turnDurationMs
    && a.queueWaitMs === b.queueWaitMs
    && sameEntries(a.toolResults, b.toolResults)
    && sameEntries(a.structuredResults, b.structuredResults)
    && sameEntries(a.toolUses, b.toolUses)
    && a.liveDenials.size === b.liveDenials.size
    && [...a.liveDenials].every((id) => b.liveDenials.has(id));
}

function sameEntries<V>(a: ReadonlyMap<string, V>, b: ReadonlyMap<string, V>): boolean {
  if (a.size !== b.size) return false;
  for (const [k, v] of a) if (b.get(k) !== v) return false;
  return true;
}
