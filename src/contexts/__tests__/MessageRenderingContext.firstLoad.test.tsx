// @vitest-environment jsdom
// v6 has its own key: the dev build and the installed app share one database,
// and a pre-v6 app resets anything under its key that is not v5. The v5 key is
// only read, to migrate from.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import React from 'react';
import { MessageRenderingProvider, useMessageRenderingConfig } from '@/contexts/MessageRenderingContext';
import { api } from '@/lib/api';

vi.mock('@/lib/api', () => ({
  api: {
    getSetting: vi.fn(),
    saveSetting: vi.fn(),
    logWriteBatch: vi.fn(),
  },
}));

const V6_KEY = 'message_rendering_config_v6';
const V5_KEY = 'message_rendering_config';

const wrapper = ({ children }: { children: React.ReactNode }) => (
  <MessageRenderingProvider>{children}</MessageRenderingProvider>
);

function stored(values: Record<string, unknown>) {
  vi.mocked(api.getSetting).mockImplementation(async (key: string) =>
    key in values ? JSON.stringify(values[key]) : null);
}

const writes = () => vi.mocked(api.saveSetting).mock.calls;
const logged = () => vi.mocked(api.logWriteBatch).mock.calls[0]?.[0]?.[0]?.message;

describe('MessageRenderingContext — first load', () => {
  beforeEach(() => {
    vi.mocked(api.getSetting).mockReset();
    vi.mocked(api.saveSetting).mockReset().mockResolvedValue(undefined);
    vi.mocked(api.logWriteBatch).mockReset().mockResolvedValue(undefined);
  });

  it('loads a v6 config as-is and writes nothing', async () => {
    stored({ [V6_KEY]: { version: 6, defaultViewMode: 'expanded' } });
    const { result } = renderHook(() => useMessageRenderingConfig(), { wrapper });
    await waitFor(() => expect(result.current.loaded).toBe(true));
    expect(result.current.config.defaultViewMode).toBe('expanded');
    expect(api.saveSetting).not.toHaveBeenCalled();
    expect(api.logWriteBatch).not.toHaveBeenCalled();
  });

  it('migrates a v5 config into the v6 key, leaving the v5 key alone', async () => {
    stored({ [V5_KEY]: { version: 5, categories: { system: { visibility: 'always' } } } });
    const { result } = renderHook(() => useMessageRenderingConfig(), { wrapper });
    await waitFor(() => expect(result.current.config.version).toBe(6));
    await waitFor(() => expect(writes()).toHaveLength(1));
    const [key, value] = writes()[0];
    expect(key).toBe(V6_KEY);
    expect(JSON.parse(String(value)).categories.system.standard).toBe(true);
    expect(logged()).toMatch(/migrated/);
  });

  it('resets an unreadable or unknown config to defaults, in the v6 key only', async () => {
    for (const legacy of [{ version: 1, kinds: {} }, { version: 2 }]) {
      vi.mocked(api.saveSetting).mockClear();
      vi.mocked(api.logWriteBatch).mockClear();
      stored({ [V5_KEY]: legacy });
      const { result, unmount } = renderHook(() => useMessageRenderingConfig(), { wrapper });
      await waitFor(() => expect(result.current.loaded).toBe(true));
      await waitFor(() => expect(writes()).toHaveLength(1));
      expect(writes()[0][0]).toBe(V6_KEY);
      expect(JSON.parse(String(writes()[0][1])).version).toBe(6);
      expect(logged()).toMatch(/reset/);
      unmount();
    }
  });

  it('saves edits to the v6 key', async () => {
    stored({ [V6_KEY]: { version: 6 } });
    const { result } = renderHook(() => useMessageRenderingConfig(), { wrapper });
    await waitFor(() => expect(result.current.loaded).toBe(true));
    await result.current.setConfig({ ...result.current.config, defaultViewMode: 'expanded' });
    expect(writes().map(([k]) => k)).toEqual([V6_KEY]);
  });
});
