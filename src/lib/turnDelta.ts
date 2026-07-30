/**
 * Single-turn context growth.
 *
 * A turn-count heuristic ("compact every ~40 turns") structurally cannot see a
 * skill or file load that adds hundreds of thousands of tokens in one turn.
 * Only a delta alarm can. This module computes that delta from the same usage
 * numbers the context gauge already sums.
 *
 * See docs/superpowers/specs/2026-07-30-context-pressure-banner-design.md
 */

import type { JsonlNode } from '@/types/jsonl';

export const CONTEXT_JUMP_ENABLED_SETTING_KEY = 'context_jump_enabled';
export const CONTEXT_JUMP_TOKENS_SETTING_KEY = 'context_jump_tokens';

export const DEFAULT_CONTEXT_JUMP_TOKENS = 50_000;
export const DEFAULT_CONTEXT_JUMP_ENABLED = true;

/** Smallest threshold worth configuring. */
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
  /**
   * Identity of the prompt this delta is anchored to. Stable for the whole
   * turn and different on the next one, which is what lets the banner remember
   * a dismissal without suppressing the next jump.
   */
  anchorId: string;
}

/**
 * What this turn had in context: the same sum the gauge uses.
 * Null for anything that isn't an assistant turn carrying usage.
 */
export function turnContextTotal(node: JsonlNode): number | null {
  if (node.kind !== 'assistant') return null;
  const usage = node.raw.message?.usage as
    | {
        input_tokens?: number;
        output_tokens?: number;
        cache_read_input_tokens?: number;
        cache_creation_input_tokens?: number;
      }
    | undefined;
  if (!usage) return null;
  return (
    (usage.input_tokens || 0) +
    (usage.cache_read_input_tokens || 0) +
    (usage.cache_creation_input_tokens || 0) +
    (usage.output_tokens || 0)
  );
}

/**
 * How much context has grown since the human last hit enter, or null when
 * there is no meaningful delta to report.
 *
 * The anchor is the last `userKind === 'prompt'` node, NOT the previous
 * assistant message. That distinction is the whole point: one prompt produces
 * a whole tool loop of assistant messages, so an assistant-to-assistant
 * difference measures one step of a loop rather than the turn. It also made
 * the notice useless in practice — a skill load would register on exactly one
 * message and be wiped by the next step of the same turn, seconds later.
 *
 * Null cases, each of which would otherwise produce a misleading number:
 *  - no prompt to anchor to, or no assistant usage on either side of it
 *  - a compact_boundary between the baseline and now — compaction drops
 *    context by design, so the delta means the opposite of a problem
 *  - any shrink — same reasoning, without the explicit marker
 */
export function lastTurnDelta(messages: JsonlNode[]): TurnDelta | null {
  const anchor = lastPrompt(messages);
  if (anchor === null) return null;
  const anchorIdx = anchor.index;

  // Newest usage in the current turn, and the last usage before it started.
  const next = lastTotalInRange(messages, anchorIdx + 1, messages.length - 1);
  if (next === null) return null;
  const base = lastTotalInRange(messages, 0, anchorIdx - 1);
  if (base === null) return null;

  if (hasCompactBoundaryAfter(messages, base.index)) return null;

  const deltaTokens = next.total - base.total;
  if (deltaTokens <= 0) return null;
  return {
    deltaTokens,
    prevTotal: base.total,
    newTotal: next.total,
    anchorId: promptAnchorId(anchor.node, anchorIdx),
  };
}

function lastPrompt(
  messages: JsonlNode[],
): { node: Extract<JsonlNode, { kind: 'user' }>; index: number } | null {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const node = messages[i];
    if (node.kind === 'user' && node.userKind === 'prompt') return { node, index: i };
  }
  return null;
}

/** Newest assistant context total in [from, to], or null if there is none. */
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

/**
 * A compaction after the baseline invalidates it: the pre-compaction total is
 * not comparable to the current one. Scanned from the baseline rather than
 * from the prompt, because `/compact` lands between the two.
 */
function hasCompactBoundaryAfter(messages: JsonlNode[], baseIdx: number): boolean {
  for (let i = baseIdx + 1; i < messages.length; i += 1) {
    const node = messages[i];
    if (node.kind === 'system' && node.subtype === 'compact_boundary') return true;
  }
  return false;
}

/** Index fallback keeps the id stable within a render when the CLI omits uuid. */
function promptAnchorId(node: Extract<JsonlNode, { kind: 'user' }>, index: number): string {
  const raw = node.raw as { uuid?: string; promptId?: string };
  return raw.uuid ?? raw.promptId ?? `${node.receivedAt}#${index}`;
}

/**
 * The jump worth telling the user about, or null.
 *
 * Reports only the current turn, so the notice lives exactly as long as the
 * prompt that caused it: it holds while that turn runs, and clears when the
 * next prompt re-anchors the delta. `SessionNotices` layers a dismissal on top
 * of that, keyed to `anchorId`.
 */
export function evaluateContextJump(opts: {
  messages: JsonlNode[];
  setting: ContextJumpSetting;
}): TurnDelta | null {
  const { messages, setting } = opts;
  if (!setting.enabled) return null;
  const delta = lastTurnDelta(messages);
  if (!delta) return null;
  return delta.deltaTokens >= clampJumpTokens(setting.thresholdTokens) ? delta : null;
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
