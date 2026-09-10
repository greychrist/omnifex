/**
 * How much of the layout viewport the software keyboard covers.
 *
 * Safari does not shrink `window.innerHeight` when the keyboard comes up; it
 * shrinks `visualViewport.height` and may scroll the layout viewport
 * (`visualViewport.offsetTop`). The composer must sit above the keyboard,
 * which means padding the bottom of the app by exactly the covered amount —
 * and by nothing when a hardware keyboard is attached (the visual viewport
 * then equals the layout viewport).
 *
 * Small differences (the URL bar collapsing, a rounding error) are not a
 * keyboard: anything under the dead band is treated as zero so the composer
 * does not twitch on every scroll.
 */
export const KEYBOARD_DEAD_BAND_PX = 40;

export function keyboardInset(innerHeight: number, vvHeight: number, vvOffsetTop: number): number {
  const covered = innerHeight - (vvHeight + vvOffsetTop);
  if (!Number.isFinite(covered) || covered < KEYBOARD_DEAD_BAND_PX) return 0;
  return Math.round(covered);
}

export const KEYBOARD_INSET_VAR = '--omnifex-keyboard-inset';
