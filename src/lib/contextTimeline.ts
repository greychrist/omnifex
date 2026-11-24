import type { JsonlNode } from '@/types/jsonl';
import { turnContextTotal } from '@/lib/turnDelta';
import type { ViewMode } from '@/lib/messageRenderingConfig';
import {
  contextPressureLevel,
  type ContextPressureLevel,
  type ContextPressureSetting,
} from '@/lib/contextPressure';

export const CONTEXT_TIMELINE_ENABLED_SETTING_KEY = 'context_timeline_enabled';
export const DEFAULT_CONTEXT_TIMELINE_ENABLED = true;

export interface ContextTimelinePoint {
  tokens: number;
  delta: number | null;
  /** Previous sample's total, kept even where `delta` must stay null (a reset is not a jump). */
  prevTokens: number | null;
  isSample: boolean;
  isJump: boolean;
  isReset: boolean;
  fraction: number;
  level: ContextPressureLevel;
}

/** Keyed by node identity over the full array: the transcript renders a filtered subset, so indices misalign. */
export function buildContextTimeline(
  messages: JsonlNode[],
  opts: {
    limit: number;
    jumpThresholdTokens: number;
    /** Only its thresholds are used; `enabled` gates the banner, not the rail. */
    pressure: ContextPressureSetting;
  },
): Map<JsonlNode, ContextTimelinePoint> {
  const { limit, jumpThresholdTokens, pressure } = opts;
  const points = new Map<JsonlNode, ContextTimelinePoint>();
  const levelAt = (tokens: number) =>
    contextPressureLevel({ tokens, limit, setting: pressure });

  // lastReading drives the line; lastShown is the total at the previous badge.
  // Badges sit only on replies to the user, or each +Nk lands on the row after a big tool result.
  let lastReading: number | null = null;
  let lastShown: number | null = null;
  let pendingReset = false;

  for (const node of messages) {
    if (node.kind === 'system' && node.subtype === 'compact_boundary') {
      pendingReset = true;
    }

    const reading = turnContextTotal(node);
    if (reading !== null) lastReading = reading;

    if (reading === null || !isReplyToUser(node)) {
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

function windowFraction(tokens: number, limit: number): number {
  if (!Number.isFinite(limit) || limit <= 0) return 0;
  return Math.min(1, Math.max(0, tokens / limit));
}

export const COMPACT_MODE_MIN_DELTA_TOKENS = 2_000;

export function showsGutterDelta(
  delta: number | null,
  viewMode: ViewMode,
): boolean {
  if (delta === null || delta === 0) return false;
  if (viewMode !== 'standard') return true;
  return Math.abs(delta) >= COMPACT_MODE_MIN_DELTA_TOKENS;
}
