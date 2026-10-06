// @vitest-environment jsdom
/**
 * The context setters Settings calls must let a failed write reach the caller.
 * They used to catch and `console.error`, so Settings could not tell a saved
 * value from a lost one. The new value still applies either way — only the
 * persistence failed.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { render, cleanup, waitFor } from '@testing-library/react';

vi.mock('@/lib/api', () => ({
  api: {
    getSetting: vi.fn(async () => null),
    saveSetting: vi.fn(async () => {}),
    logWriteBatch: vi.fn(async () => {}),
  },
}));

import { api } from '@/lib/api';
import { ThemeProvider, useThemeContext } from '../ThemeContext';
import { AppFontProvider, useAppFont } from '../AppFontContext';
import { AutoScrollProvider, useAutoScroll } from '../AutoScrollContext';
import { SessionGaugesProvider, useSessionGauges } from '../SessionGaugesContext';
import { MessageRenderingProvider, useMessageRenderingConfig } from '../MessageRenderingContext';
import { createDefaultConfig } from '@/lib/messageRenderingConfig';

const failure = new Error('database is locked');

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.getSetting).mockResolvedValue(null);
});
afterEach(cleanup);

/** Renders `useValue` inside `Provider` and hands back its latest result. */
async function mount<T>(Provider: React.FC<{ children: React.ReactNode }>, useValue: () => T) {
  const ref: { current: T | null } = { current: null };
  function Probe() { ref.current = useValue(); return null; }
  render(<Provider><Probe /></Provider>);
  await waitFor(() => { expect(ref.current).not.toBeNull(); });
  // Let each provider's initial load settle, so its first-load writes are not
  // the ones the failure mock answers.
  await new Promise((r) => setTimeout(r, 0));
  vi.mocked(api.saveSetting).mockRejectedValue(failure);
  return () => ref.current as T;
}

describe('context setters report a failed save', () => {
  it('setTheme', async () => {
    const get = await mount(ThemeProvider, useThemeContext);
    await expect(get().setTheme('light')).rejects.toBe(failure);
    await waitFor(() => { expect(get().theme).toBe('light'); });
  });

  it('setAppFont', async () => {
    const get = await mount(AppFontProvider, useAppFont);
    await expect(get().setAppFont('geist')).rejects.toBe(failure);
  });

  it('setFollowPx', async () => {
    const get = await mount(AutoScrollProvider, useAutoScroll);
    await expect(get().setFollowPx(300)).rejects.toBe(failure);
  });

  it('the session-gauge setters', async () => {
    const get = await mount(SessionGaugesProvider, useSessionGauges);
    await expect(get().setContextPressure({ ...get().contextPressure, value: 50 })).rejects.toBe(failure);
    await expect(get().setCacheTimerEnabled(false)).rejects.toBe(failure);
    await expect(get().setContextJump({ ...get().contextJump, enabled: false })).rejects.toBe(failure);
    await expect(get().setContextTimelineEnabled(false)).rejects.toBe(failure);
  });

  it('setConfig, which also resolves once the write lands', async () => {
    const get = await mount(MessageRenderingProvider, useMessageRenderingConfig);
    const next = createDefaultConfig();
    await expect(get().setConfig(next)).rejects.toBe(failure);
    await waitFor(() => { expect(get().config).toBe(next); });
    vi.mocked(api.saveSetting).mockResolvedValue();
    await expect(get().setConfig(createDefaultConfig())).resolves.toBeUndefined();
  });
});
