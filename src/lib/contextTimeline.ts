/**
 * Per-message context series for the transcript rail.
 *
 * Answers the retrospective question the live gauges cannot: *which message
 * made this session expensive?* Every main-thread assistant message carries a
 * cumulative context reading, so the series needs no new capture — only
 * derivation. See docs/superpowers/specs/2026-07-30-context-timeline-design.md
 */

import type { JsonlNode } from '@/types/jsonl';
import { turnContextTotal } from '@/lib/turnDelta';
import type { ViewMode } from '@/components/SessionViewToggle';
import {
  contextPressureLevel,
  type ContextPressureLevel,
  type ContextPressureSetting,
} from '@/lib/contextPressure';

export const CONTEXT_TIMELINE_ENABLED_SETTING_KEY = 'context_timeline_enabled';
/**
 * On by default since the session-signals refactor.
 *
 * It shipped off, as an opt-in retrospective view, while the banner stack
 * carried context growth for everyone else. With the banners gone the rail is
 * the only inline place a delta appears, so leaving it off would have meant the
 * default user silently lost the "this prompt added 325k" signal entirely.
 */
export const DEFAULT_CONTEXT_TIMELINE_ENABLED = true;

export interface ContextTimelinePoint {
  /** Context size at this row; carried forward between samples. */
  tokens: number;
  /** Growth since the previous badge (reply). Null at carried-forward rows and resets. */
  delta: number | null;
  /**
   * The previous sample's total, carried even where `delta` is null.
   *
   * The rail needs to print the drop on a compaction row ("−420k"), but `delta`
   * has to stay null there or `isJump` and the level coloring would start
   * treating a reset as a step. Two fields, two meanings.
   */
  prevTokens: number | null;
  /** True only at a badge: Claude's text to the user, with a usage reading. */
  isSample: boolean;
  /** A sample whose delta met the jump threshold. */
  isJump: boolean;
  /** First sample after a compact_boundary. */
  isReset: boolean;
  /** tokens / limit, clamped to 0..1, for bar width. */
  fraction: number;
  /**
   * Where `tokens` sits against the configured budget — drives the rail's
   * green/amber/red. Shared with the context-pressure banner rather than
   * re-derived, so the rail turns amber exactly when the banner would.
   */
  level: ContextPressureLevel;
}

/**
 * Build the series over the FULL message array, keyed by node identity.
 *
 * Identity keying rather than array indices is load-bearing. The transcript
 * renders `displayableMessages` — `messages` after the user's hard filters —
 * so index-keyed points misalign the moment any filter is on. Computing over
 * the full array also keeps deltas honest: differencing the filtered array
 * would attribute a hidden message's growth to its visible neighbour.
 */
export function buildContextTimeline(
  messages: JsonlNode[],
  opts: {
    limit: number;
    jumpThresholdTokens: number;
    /**
     * The banner's budget setting. Only its thresholds are used — `enabled`
     * gates the banner, not the rail, which has its own toggle.
     */
    pressure: ContextPressureSetting;
  },
): Map<JsonlNode, ContextTimelinePoint> {
  const { limit, jumpThresholdTokens, pressure } = opts;
  const points = new Map<JsonlNode, ContextTimelinePoint>();
  const levelAt = (tokens: number) =>
    contextPressureLevel({ tokens, limit, setting: pressure });

  // Two running values. `lastReading` is the newest context size from any
  // main-thread response, tool calls included, so the line and its color
  // follow real context. `lastShown` is the size at the previous badge, which
  // sits only on Claude's text to the user: each badge's delta is the growth
  // since the previous reply, the tool work between them included. A badge on
  // every response put one on each tool row, and its "+Nk" landed on
  // whichever row followed a big tool result (Greg, 2026-11-18).
  let lastReading: number | null = null;
  let lastShown: number | null = null;
  let pendingReset = false;

  for (const node of messages) {
    if (node.kind === 'system' && node.subtype === 'compact_boundary') {
      // The next badge is a fresh baseline, not a drop worth differencing.
      pendingReset = true;
    }

    const reading = turnContextTotal(node);
    if (reading !== null) lastReading = reading;

    if (reading === null || !isReplyToUser(node)) {
      // No badge here. Carry the curve forward so the rail stays continuous,
      // but only once there is something to carry.
      if (lastReading !== null) {
        points.set(node, {
          tokens: lastReading,
          delta: null,
          prevTokens: null,
          isSample: false,
          isJump: false,
          isReset: false,
          fraction: windowFraction(lastReading, limit),
          level: levelAt(lastReading),
        });
      }
      continue;
    }

    const total = reading;
    const isReset = pendingReset;
    const delta = isReset || lastShown === null ? null : total - lastShown;
    const prevTokens = lastShown;
    pendingReset = false;
    lastShown = total;

    points.set(node, {
      tokens: total,
      delta,
      prevTokens,
      isSample: true,
      isJump: delta !== null && delta >= jumpThresholdTokens,
      isReset,
      fraction: windowFraction(total, limit),
      level: levelAt(total),
    });
  }

  return points;
}

/** Claude saying something to the user: a non-blank text block. */
function isReplyToUser(node: JsonlNode): boolean {
  if (node.kind !== 'assistant') return false;
  const content = (node.raw as { message?: { content?: unknown } }).message?.content;
  if (typeof content === 'string') return content.trim() !== '';
  if (!Array.isArray(content)) return false;
  return content.some(
    (block: unknown) =>
      typeof block === 'object' &&
      block !== null &&
      (block as { type?: unknown }).type === 'text' &&
      typeof (block as { text?: unknown }).text === 'string' &&
      ((block as { text: string }).text).trim() !== '',
  );
}

/** 0 rather than NaN/Infinity when the window is unknown — this drives a width. */
function windowFraction(tokens: number, limit: number): number {
  if (!Number.isFinite(limit) || limit <= 0) return 0;
  return Math.min(1, Math.max(0, tokens / limit));
}

/**
 * Smallest gutter delta worth a row in Compact output mode.
 *
 * Most turns move context by a few hundred tokens. Printing all of them turns
 * the rail into a column of noise that hides the one row that matters, which is
 * the same failure the old jump banner existed to avoid. Verbose mode prints
 * every delta, because that is what Verbose means.
 */
export const COMPACT_MODE_MIN_DELTA_TOKENS = 2_000;

/** Does this delta earn a line in the gutter under the current output mode? */
export function showsGutterDelta(
  delta: number | null,
  viewMode: ViewMode,
): boolean {
  if (delta === null || delta === 0) return false;
  // Modern filters as Compact does, so it prints the same deltas.
  if (viewMode !== 'compact' && viewMode !== 'modern') return true;
  return Math.abs(delta) >= COMPACT_MODE_MIN_DELTA_TOKENS;
}
