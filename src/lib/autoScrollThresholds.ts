/**
 * Auto-scroll stickiness thresholds for the chat transcript.
 *
 * The transcript "sticks" to the bottom while new messages stream in, but
 * disengages once the user scrolls up to read history. A two-threshold
 * hysteresis prevents content-height jitter (code blocks finishing layout,
 * images loading) from flapping the stickiness on and off:
 *
 *  - within `reengagePx` of the bottom  → near bottom, keep/resume auto-scroll
 *  - beyond `disengagePx` from bottom   → user is reading history, stop
 *  - between the two                    → dead zone, no state change
 *
 * The defaults below are user-tunable from Settings → General and persisted
 * in `app_settings`. They were tightened from the original 400/800 to 200/400
 * after testing — the old disengage distance kept the view stuck to the bottom
 * too aggressively while the user tried to read history.
 */

export const DEFAULT_AUTOSCROLL_REENGAGE_PX = 200;
export const DEFAULT_AUTOSCROLL_DISENGAGE_PX = 400;

export const AUTOSCROLL_REENGAGE_SETTING_KEY = "autoscroll_reengage_px";
export const AUTOSCROLL_DISENGAGE_SETTING_KEY = "autoscroll_disengage_px";

export interface AutoScrollThresholds {
  /** Distance from bottom (px) within which auto-scroll re-engages. */
  reengagePx: number;
  /** Distance from bottom (px) beyond which auto-scroll disengages. */
  disengagePx: number;
}

/**
 * Parse a stored setting string into a non-negative integer pixel value,
 * falling back when it is missing, non-numeric, or negative.
 */
export function parseThresholdPx(raw: string | null, fallback: number): number {
  if (raw === null) return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return n;
}

/**
 * Enforce the threshold invariants: both non-negative integers, and
 * `disengagePx >= reengagePx` so the dead zone never inverts.
 */
export function clampThresholds(t: AutoScrollThresholds): AutoScrollThresholds {
  const reengagePx = Math.max(0, Math.floor(t.reengagePx));
  const disengagePx = Math.max(reengagePx, Math.floor(t.disengagePx));
  return { reengagePx, disengagePx };
}

/**
 * Hysteresis decision for whether the transcript should consider itself
 * "near bottom" (and thus keep auto-scrolling) given the current scroll
 * distance from the bottom and the previous state.
 */
export function nextNearBottom(
  distanceFromBottom: number,
  current: boolean,
  { reengagePx, disengagePx }: AutoScrollThresholds,
): boolean {
  if (distanceFromBottom < reengagePx) return true;
  if (distanceFromBottom > disengagePx) return false;
  return current;
}
