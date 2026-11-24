import type { JsonlNode } from '@/types/jsonl';
import { isMainAssistant } from '@/lib/sessionDerivedState';
import { forwardedParentToolUseId } from '@/lib/subagentDispatch';

export const CONTEXT_JUMP_ENABLED_SETTING_KEY = 'context_jump_enabled';
export const CONTEXT_JUMP_TOKENS_SETTING_KEY = 'context_jump_tokens';

export const DEFAULT_CONTEXT_JUMP_TOKENS = 50_000;
export const DEFAULT_CONTEXT_JUMP_ENABLED = true;

const MIN_JUMP_TOKENS = 1_000;

export interface ContextJumpSetting {
  enabled: boolean;
  thresholdTokens: number;
}

export const DEFAULT_CONTEXT_JUMP: ContextJumpSetting = {
  enabled: DEFAULT_CONTEXT_JUMP_ENABLED,
  thresholdTokens: DEFAULT_CONTEXT_JUMP_TOKENS,
};

export interface TurnDelta {
  deltaTokens: number;
  prevTotal: number;
  newTotal: number;
  /** Stable per turn, so a derived `context.delta` event de-dupes across renders. */
  anchorId: string;
}

/** Main-thread only: subagent usage describes its own context window. */
export function turnContextTotal(node: JsonlNode): number | null {
  if (!isMainAssistant(node)) return null;
  const usage = node.raw.message?.usage as
    | {
        input_tokens?: number;
        output_tokens?: number;
        cache_read_input_tokens?: number;
        cache_creation_input_tokens?: number;
      }
    | undefined;
  if (!usage) return null;
  const total =
    (usage.input_tokens || 0) +
    (usage.cache_read_input_tokens || 0) +
    (usage.cache_creation_input_tokens || 0) +
    (usage.output_tokens || 0);
  // After /compact the CLI rewrites the last reply with all-zero usage: that is no reading, not 0.
  return total > 0 ? total : null;
}

function lastTotalInRange(
  messages: JsonlNode[],
  from: number,
  to: number,
): { total: number; index: number } | null {
  for (let i = Math.min(to, messages.length - 1); i >= Math.max(from, 0); i -= 1) {
    const total = turnContextTotal(messages[i]);
    if (total !== null) return { total, index: i };
  }
  return null;
}

/** Index fallback keeps the id stable within a render when the CLI omits uuid. */
function promptAnchorId(node: Extract<JsonlNode, { kind: 'user' }>, index: number): string {
  const raw = node.raw as { uuid?: string; promptId?: string };
  return raw.uuid ?? raw.promptId ?? `${node.receivedAt}#${index}`;
}

export function clampJumpTokens(value: number): number {
  const n = Math.floor(value);
  if (!Number.isFinite(n)) return DEFAULT_CONTEXT_JUMP_TOKENS;
  return Math.max(MIN_JUMP_TOKENS, n);
}

export function parseJumpTokens(raw: string | null): number {
  if (raw === null) return DEFAULT_CONTEXT_JUMP_TOKENS;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) return DEFAULT_CONTEXT_JUMP_TOKENS;
  return clampJumpTokens(n);
}

export interface TurnDeltaEntry extends TurnDelta {
  at: number;
  compacted: boolean;
  promptUuid: string | null;
}

export function turnDeltaSeries(messages: JsonlNode[]): TurnDeltaEntry[] {
  const anchors = promptAnchors(messages);
  const entries: TurnDeltaEntry[] = [];

  for (let n = 0; n < anchors.length; n += 1) {
    const anchorIdx = anchors[n].index;
    const until = n + 1 < anchors.length ? anchors[n + 1].index - 1 : messages.length - 1;

    const next = lastTotalInRange(messages, anchorIdx + 1, until);
    if (next === null) continue;
    const base = lastTotalInRange(messages, 0, anchorIdx - 1);
    // The opening turn has no baseline; its whole context would read as a jump.
    if (base === null) continue;

    entries.push({
      deltaTokens: next.total - base.total,
      prevTotal: base.total,
      newTotal: next.total,
      anchorId: promptAnchorId(anchors[n].node, anchorIdx),
      at: readingTime(messages[next.index]),
      compacted: hasCompactBoundaryBetween(messages, base.index, next.index),
      promptUuid: (anchors[n].node.raw as { uuid?: string }).uuid ?? null,
    });
  }

  return entries;
}

function promptAnchors(
  messages: JsonlNode[],
): { node: Extract<JsonlNode, { kind: 'user' }>; index: number }[] {
  const out: { node: Extract<JsonlNode, { kind: 'user' }>; index: number }[] = [];
  for (let i = 0; i < messages.length; i += 1) {
    const node = messages[i];
    if (node.kind !== 'user' || node.userKind !== 'prompt') continue;
    if (forwardedParentToolUseId(node.raw) !== null) continue;
    out.push({ node, index: i });
  }
  return out;
}

function hasCompactBoundaryBetween(messages: JsonlNode[], fromIdx: number, toIdx: number): boolean {
  for (let i = fromIdx + 1; i <= toIdx; i += 1) {
    const node = messages[i];
    if (node.kind === 'system' && node.subtype === 'compact_boundary') return true;
  }
  return false;
}

/** Epoch ms, or 0 — never NaN, this sorts. */
function readingTime(node: JsonlNode): number {
  const receivedAt = 'receivedAt' in node ? node.receivedAt : null;
  const parsed = typeof receivedAt === 'string' ? Date.parse(receivedAt) : NaN;
  return Number.isFinite(parsed) ? parsed : 0;
}
