/**
 * When the chat transcript follows new messages.
 *
 * One distance: the transcript follows while the view is within `followPx`
 * of the bottom, and stops once the user scrolls further up. Scrolling back
 * within it resumes following.
 *
 * This used to be two distances with a dead zone between them, meant to keep
 * content-height jitter (code blocks finishing layout, images loading) from
 * flapping the state. Jitter cannot reach it: the state is only re-decided
 * on a scroll event, content growing below the fold does not fire one, and
 * the follow logic's own scroll-to-bottom lands at distance 0.
 *
 * User-tunable from Settings → General, persisted in `app_settings`.
 */

export const DEFAULT_AUTOSCROLL_FOLLOW_PX = 200;

export const AUTOSCROLL_FOLLOW_SETTING_KEY = "autoscroll_follow_px";

/** A stored setting string as a non-negative integer, or the default. */
export function parseFollowPx(raw: string | null): number {
  if (raw === null) return DEFAULT_AUTOSCROLL_FOLLOW_PX;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 0) return DEFAULT_AUTOSCROLL_FOLLOW_PX;
  return n;
}

/** A non-negative integer pixel distance. */
export function clampFollowPx(px: number): number {
  return Math.max(0, Math.floor(px));
}

/** Whether the transcript should follow, given its distance from the bottom. */
export function isFollowing(distanceFromBottom: number, followPx: number): boolean {
  return distanceFromBottom <= followPx;
}
