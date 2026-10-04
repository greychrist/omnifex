/**
 * The two-zone surface from TabStatusCard and the Lima page: a muted header
 * band over a body tinted between background and muted, split by a hairline
 * in muted-foreground. Shared so the Lima cards and the session side panels
 * cannot drift apart.
 */

/** The body tint: 40% background into muted. */
export const SURFACE_BODY_BG = 'bg-[color-mix(in_oklch,var(--color-background)_40%,var(--color-muted))]';

/** The header band, with the hairline beneath it drawn as an inset shadow. */
export const SURFACE_HEADER =
  'bg-muted shadow-[inset_0_-1px_0_0_color-mix(in_oklch,var(--color-muted-foreground)_45%,transparent)]';

/** A 1px ring in the hairline colour, as a shadow so it takes no layout. */
export const SURFACE_RING = 'shadow-[0_0_0_1px_color-mix(in_oklch,var(--color-muted-foreground)_45%,transparent),2px_2px_4px_rgb(0_0_0/0.08)]';
