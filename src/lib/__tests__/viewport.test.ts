import { describe, it, expect } from 'vitest';

import { APP_ROOT_HEIGHT } from '@/lib/viewport';

/**
 * The app root must never size itself with `100vh` (`h-screen`). On iPad
 * Safari `100vh` is the largest viewport — the height with the toolbar
 * retracted — while the page is shown with the toolbar present and
 * `overflow: hidden` on <html>, so the bottom ~85px (the composer) sits under
 * the toolbar with no way to scroll it into view. `100dvh` tracks the
 * visible viewport; in Electron the two are equal.
 */
describe('app root height', () => {
  it('uses the dynamic viewport, not 100vh', () => {
    expect(APP_ROOT_HEIGHT).toBe('h-dvh');
    expect(APP_ROOT_HEIGHT).not.toContain('h-screen');
  });
});
