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
 * Growth between the two most recent assistant turns, or null when there is no
 * meaningful delta to report.
 *
 * Null cases, each of which would otherwise produce a misleading number:
 *  - fewer than two turns with usage — nothing to difference
 *  - a compact_boundary between them — compaction drops context by design, so
 *    the delta is hugely negative and means the opposite of a problem
 *  - any shrink — same reasoning, without the explicit marker
 */
export function lastTurnDelta(messages: JsonlNode[]): TurnDelta | null {
  let newTotal: number | null = null;
  let sawCompactBoundary = false;

  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const node = messages[i];

    if (node.kind === 'system' && node.subtype === 'compact_boundary') {
      // Only matters once we're between the two turns being differenced.
      if (newTotal !== null) sawCompactBoundary = true;
      continue;
    }

    const total = turnContextTotal(node);
    if (total === null) continue;

    if (newTotal === null) {
      newTotal = total;
      continue;
    }
    if (sawCompactBoundary) return null;
    const deltaTokens = newTotal - total;
    if (deltaTokens <= 0) return null;
    return { deltaTokens, prevTotal: total, newTotal };
  }
  return null;
}

/**
 * The jump worth telling the user about, or null.
 *
 * Only ever reports the most recent delta, which is what makes the notice
 * self-clearing: the big turn stops being "most recent" as soon as an ordinary
 * one lands, and the notice disappears without any dismissal state.
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
