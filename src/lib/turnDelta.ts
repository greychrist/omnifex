/**
 * Per-turn context growth.
 *
 * A turn-count heuristic ("compact every ~40 turns") structurally cannot see a
 * skill or file load that adds hundreds of thousands of tokens in one turn.
 * Only a delta can. This module computes them from the same usage numbers the
 * context gauge already sums.
 *
 * `lastTurnDelta` / `evaluateContextJump` used to live here and answered "should
 * we interrupt the user right now?" for a banner that no longer exists. The
 * question the app asks now is "what has each turn done?", which `turnDeltaSeries`
 * answers for the whole transcript at once — the threshold that used to gate the
 * banner survives as the `isJump` flag on a `context.delta` signal.
 *
 * See docs/superpowers/specs/2026-09-11-session-signals-design.md
 */

import type { JsonlNode } from '@/types/jsonl';
import { isMainAssistant } from '@/lib/sessionDerivedState';
import { forwardedParentToolUseId } from '@/lib/subagentDispatch';

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
   * turn and different on the next one, which is what makes a derived
   * `context.delta` event de-dupe across renders instead of piling up.
   */
  anchorId: string;
}

/**
 * What this turn had in context: the same sum the gauge uses.
 *
 * Null for anything that isn't a MAIN-THREAD assistant turn carrying usage.
 * Subagent messages carry usage describing their own context window, so
 * counting them fabricates jumps the main thread never took.
 */
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
  return (
    (usage.input_tokens || 0) +
    (usage.cache_read_input_tokens || 0) +
    (usage.cache_creation_input_tokens || 0) +
    (usage.output_tokens || 0)
  );
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

/** One prompt-anchored turn, as the session-widget popover logs it. */
export interface TurnDeltaEntry extends TurnDelta {
  /** Epoch ms of the reading that closed the turn. */
  at: number;
  /** A `/compact` landed inside this turn, so the delta is a reset. */
  compacted: boolean;
}

/**
 * Every turn's delta, oldest first — the history behind `lastTurnDelta`.
 *
 * The two differ in what they suppress, and deliberately so. `lastTurnDelta`
 * answers "should we interrupt the user right now?", so it returns null across
 * a compaction and on any shrink: both mean the opposite of a problem. This
 * answers "what has this session done?", where a compaction dropping 420k is
 * the single most interesting row in the log. Same anchoring rule, opposite
 * treatment of the quiet cases.
 */
export function turnDeltaSeries(messages: JsonlNode[]): TurnDeltaEntry[] {
  const anchors = promptAnchors(messages);
  const entries: TurnDeltaEntry[] = [];

  for (let n = 0; n < anchors.length; n += 1) {
    const anchorIdx = anchors[n].index;
    const until = n + 1 < anchors.length ? anchors[n + 1].index - 1 : messages.length - 1;

    const next = lastTotalInRange(messages, anchorIdx + 1, until);
    if (next === null) continue;
    const base = lastTotalInRange(messages, 0, anchorIdx - 1);
    // The opening turn of a session has nothing to be measured against. A
    // delta equal to the whole context would read as a jump it never took.
    if (base === null) continue;

    entries.push({
      deltaTokens: next.total - base.total,
      prevTotal: base.total,
      newTotal: next.total,
      anchorId: promptAnchorId(anchors[n].node, anchorIdx),
      at: readingTime(messages[next.index]),
      compacted: hasCompactBoundaryBetween(messages, base.index, next.index),
    });
  }

  return entries;
}

/** Every human prompt, in order. Same discriminator as `lastPrompt`. */
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

/** Bounded form of `hasCompactBoundaryAfter` — a series needs per-turn answers. */
function hasCompactBoundaryBetween(messages: JsonlNode[], fromIdx: number, toIdx: number): boolean {
  for (let i = fromIdx + 1; i <= toIdx; i += 1) {
    const node = messages[i];
    if (node.kind === 'system' && node.subtype === 'compact_boundary') return true;
  }
  return false;
}

/**
 * Epoch ms, or 0 when there is no usable timestamp — never NaN, this sorts.
 *
 * `receivedAt` is absent from a couple of JsonlNode variants entirely (notably
 * `last-prompt`), so the read is guarded rather than asserted.
 */
function readingTime(node: JsonlNode): number {
  const receivedAt = 'receivedAt' in node ? node.receivedAt : null;
  const parsed = typeof receivedAt === 'string' ? Date.parse(receivedAt) : NaN;
  return Number.isFinite(parsed) ? parsed : 0;
}
