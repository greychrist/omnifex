// Only the user can stop following: the follow logic's own scroll event lands a frame late,
// after a tall row may have grown, and would measure the view as far from the bottom.

export const DEFAULT_AUTOSCROLL_FOLLOW_PX = 300;

export const AUTOSCROLL_FOLLOW_SETTING_KEY = "autoscroll_follow_px";

export function parseFollowPx(raw: string | null): number {
  if (raw === null) return DEFAULT_AUTOSCROLL_FOLLOW_PX;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 0) return DEFAULT_AUTOSCROLL_FOLLOW_PX;
  return n;
}

export function clampFollowPx(px: number): number {
  return Math.max(0, Math.floor(px));
}

export function isFollowing(distanceFromBottom: number, followPx: number): boolean {
  return distanceFromBottom <= followPx;
}

export const USER_SCROLL_INTENT_MS = 1000;

export function nextFollowing(opts: {
  following: boolean;
  distanceFromBottom: number;
  followPx: number;
  userScrolling: boolean;
}): boolean {
  if (isFollowing(opts.distanceFromBottom, opts.followPx)) return true;
  return opts.userScrolling ? false : opts.following;
}

/** A user-caused height change never scrolls: pinning would carry the opened row out from under them. */
export function afterContentResize(opts: {
  following: boolean;
  distanceFromBottom: number;
  followPx: number;
  mustSee: boolean;
  userToggled: boolean;
}): { scroll: boolean; following: boolean } {
  if (opts.userToggled) {
    return {
      scroll: false,
      following: nextFollowing({ ...opts, userScrolling: true }),
    };
  }
  return { scroll: opts.following || opts.mustSee, following: opts.following };
}
