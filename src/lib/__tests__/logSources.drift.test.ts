// The renderer bundle cannot import the daemon's tree at runtime, so its
// mirror is held to it here.

import { describe, it, expect } from 'vitest';
import {
  LOG_SOURCES as RENDERER_SOURCES,
  LOG_LEVELS as RENDERER_LEVELS,
  LOG_SOURCE_DISPLAY,
} from '../logSources';
import {
  LOG_SOURCES as MAIN_SOURCES,
  LOG_LEVELS as MAIN_LEVELS,
} from '../../../daemon/services/log-sources';

describe('log taxonomy drift', () => {
  it('LOG_SOURCES is identical in main and renderer', () => {
    expect([...RENDERER_SOURCES]).toEqual([...MAIN_SOURCES]);
  });

  it('LOG_LEVELS is identical in main and renderer', () => {
    expect([...RENDERER_LEVELS]).toEqual([...MAIN_LEVELS]);
  });

  it('LOG_SOURCE_DISPLAY has an entry for every source', () => {
    for (const source of RENDERER_SOURCES) {
      expect(LOG_SOURCE_DISPLAY[source]).toBeDefined();
      expect(LOG_SOURCE_DISPLAY[source].label).toBeTruthy();
      expect(LOG_SOURCE_DISPLAY[source].chipClass).toBeTruthy();
    }
  });
});
