/**
 * When the chat transcript follows new messages.
 *
 * One distance: the transcript follows while the view is within `followPx`
 * of the bottom, and stops once the user scrolls further up. Scrolling back
 * within it resumes following.
 *
 * Only the USER can turn following off (`nextFollowing`). The state used to be
 * re-decided from distance alone on every scroll event, on the belief that
 * the follow logic's own scroll-to-bottom always lands at distance 0. It does
 * not: the scroll event that write queues is delivered a frame later, and a
 * tall row landing in that frame — the live bubble swapping for the final
 * message, a batch of tool cards — makes it measure the view as far from the
 * bottom, so following silently stopped mid-turn. A scroll event now counts
 * as the user's only within `USER_SCROLL_INTENT_MS` of their own input
 * (wheel, touch, key, pointer) or while a pointer is held.
 *
 * (This also used to be two distances with a dead zone between them; one
 * distance is enough, since nothing but a scroll event re-decides it.)
 *
 * User-tunable from Settings → General, persisted in `app_settings`.
 */

export const DEFAULT_AUTOSCROLL_FOLLOW_PX = 300;

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

/**
 * How long after the user's own input a scroll event still counts as theirs.
 * Covers a smooth step/jump scroll (~400ms) and the gap between a keypress or
 * flick and the scroll it causes; trackpad momentum keeps emitting wheel
 * events, so it renews itself.
 */
export const USER_SCROLL_INTENT_MS = 1000;

/**
 * The follow state after a scroll event. Within `followPx` it always follows,
 * whoever scrolled; outside it, only a user-caused scroll can stop following.
 */
export function nextFollowing(opts: {
  following: boolean;
  distanceFromBottom: number;
  followPx: number;
  userScrolling: boolean;
}): boolean {
  if (isFollowing(opts.distanceFromBottom, opts.followPx)) return true;
  return opts.userScrolling ? false : opts.following;
}
