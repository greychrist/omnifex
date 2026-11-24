/** Safari shrinks visualViewport, not innerHeight, for the keyboard; differences under this are not a keyboard. */
export const KEYBOARD_DEAD_BAND_PX = 40;

export function keyboardInset(innerHeight: number, vvHeight: number, vvOffsetTop: number): number {
  const covered = innerHeight - (vvHeight + vvOffsetTop);
  if (!Number.isFinite(covered) || covered < KEYBOARD_DEAD_BAND_PX) return 0;
  return Math.round(covered);
}

export const KEYBOARD_INSET_VAR = '--omnifex-keyboard-inset';
