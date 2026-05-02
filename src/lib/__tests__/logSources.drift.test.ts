// Drift detector — keeps the main-process and renderer-mirror log
// taxonomies in sync. The two files exist because the renderer Vite
// bundle can't import from the electron tree at runtime; this test
// holds them to a single shared truth at build time.

import { describe, it, expect } from 'vitest';
import {
  LOG_SOURCES as RENDERER_SOURCES,
  LOG_LEVELS as RENDERER_LEVELS,
  LOG_SOURCE_DISPLAY,
} from '../logSources';
import {
  LOG_SOURCES as MAIN_SOURCES,
  LOG_LEVELS as MAIN_LEVELS,
} from '../../../electron/services/log-sources';

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
