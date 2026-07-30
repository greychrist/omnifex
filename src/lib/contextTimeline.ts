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
import {
  contextPressureLevel,
  type ContextPressureLevel,
  type ContextPressureSetting,
} from '@/lib/contextPressure';

export const CONTEXT_TIMELINE_ENABLED_SETTING_KEY = 'context_timeline_enabled';
export const DEFAULT_CONTEXT_TIMELINE_ENABLED = false;

export interface ContextTimelinePoint {
  /** Context size at this row; carried forward between samples. */
  tokens: number;
  /** Growth vs the previous sample. Null at carried-forward rows and resets. */
  delta: number | null;
  /** True only where a real usage reading exists. */
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

  let lastTotal: number | null = null;
  let pendingReset = false;

  for (const node of messages) {
    if (node.kind === 'system' && node.subtype === 'compact_boundary') {
      // The next reading is a fresh baseline, not a drop worth differencing.
      pendingReset = true;
    }

    const total = turnContextTotal(node);

    if (total === null) {
      // No reading here. Carry the curve forward so the rail stays continuous,
      // but only once there is something to carry.
      if (lastTotal !== null) {
        points.set(node, {
          tokens: lastTotal,
          delta: null,
          isSample: false,
          isJump: false,
          isReset: false,
          fraction: windowFraction(lastTotal, limit),
          level: levelAt(lastTotal),
        });
      }
      continue;
    }

    const isReset = pendingReset;
    const delta = isReset || lastTotal === null ? null : total - lastTotal;
    pendingReset = false;
    lastTotal = total;

    points.set(node, {
      tokens: total,
      delta,
      isSample: true,
      isJump: delta !== null && delta >= jumpThresholdTokens,
      isReset,
      fraction: windowFraction(total, limit),
      level: levelAt(total),
    });
  }

  return points;
}

/** 0 rather than NaN/Infinity when the window is unknown — this drives a width. */
function windowFraction(tokens: number, limit: number): number {
  if (!Number.isFinite(limit) || limit <= 0) return 0;
  return Math.min(1, Math.max(0, tokens / limit));
}
