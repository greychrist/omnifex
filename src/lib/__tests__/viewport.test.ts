import { describe, it, expect } from 'vitest';

import { APP_ROOT_HEIGHT } from '@/lib/viewport';

// Never `100vh`: on iPad Safari it is the toolbar-retracted height, which hides
// the composer under the toolbar. `100dvh` tracks the visible viewport.
describe('app root height', () => {
  it('uses the dynamic viewport, not 100vh', () => {
    expect(APP_ROOT_HEIGHT).toBe('h-dvh');
    expect(APP_ROOT_HEIGHT).not.toContain('h-screen');
  });
});
