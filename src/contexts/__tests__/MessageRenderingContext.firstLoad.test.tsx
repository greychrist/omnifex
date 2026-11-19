// @vitest-environment jsdom
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

const wrapper = ({ children }: { children: React.ReactNode }) => (
  <MessageRenderingProvider>{children}</MessageRenderingProvider>
);

describe('MessageRenderingContext — first-load reset', () => {
  beforeEach(() => {
    vi.mocked(api.getSetting).mockReset();
    vi.mocked(api.saveSetting).mockReset();
    vi.mocked(api.logWriteBatch).mockReset();
    document.documentElement.style.removeProperty('--chat-content-font');
    document.documentElement.style.removeProperty('--font-terminal');
  });

  it('resets a v1 config to defaults and writes an app_logs entry', async () => {
    // Simulate a v1 persisted config (version field is 1)
    vi.mocked(api.getSetting).mockResolvedValueOnce(
      JSON.stringify({ version: 1, kinds: { 'user.prompt': {} } }),
    );
    vi.mocked(api.saveSetting).mockResolvedValue(undefined);
    vi.mocked(api.logWriteBatch).mockResolvedValue(undefined);

    const { result } = renderHook(() => useMessageRenderingConfig(), { wrapper });

    await waitFor(() => expect(result.current.config.version).toBe(6));
    expect(api.saveSetting).toHaveBeenCalledWith(
      'message_rendering_config',
      expect.stringContaining('"version":6'),
    );
    expect(api.logWriteBatch).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({
          level: 'info',
          source: 'frontend',
          category: 'settings:message-rendering',
          message: expect.stringContaining('reset'),
        }),
      ]),
    );
  });

  it('resets a v2 config to defaults (only v5 and v6 load)', async () => {
    // Simulate a persisted v2 config — parseConfig resets any non-v5 to fresh defaults
    vi.mocked(api.getSetting).mockResolvedValueOnce(
      JSON.stringify({
        version: 2,
        kinds: {},
        defaultViewMode: 'compact',
        hardFilters: {},
        palette: {},
        typography: {},
        terminal: {},
      }),
    );
    vi.mocked(api.saveSetting).mockResolvedValue(undefined);
    vi.mocked(api.logWriteBatch).mockResolvedValue(undefined);

    const { result } = renderHook(() => useMessageRenderingConfig(), { wrapper });
    await waitFor(() => expect(result.current.config.version).toBe(6));

    expect(api.saveSetting).toHaveBeenCalledWith(
      'message_rendering_config',
      expect.stringContaining('"version":6'),
    );
    expect(api.logWriteBatch).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({
          message: expect.stringContaining('reset'),
        }),
      ]),
    );
  });

  // A v6 config is the current shape: nothing to write.
  it('leaves a v6 config untouched', async () => {
    vi.mocked(api.getSetting).mockResolvedValueOnce(JSON.stringify({ version: 6 }));

    renderHook(() => useMessageRenderingConfig(), { wrapper });
    await waitFor(() => expect(api.getSetting).toHaveBeenCalled());

    expect(api.saveSetting).not.toHaveBeenCalled();
    expect(api.logWriteBatch).not.toHaveBeenCalled();
  });

  // A v5 config is migrated on load (Standard shows what Modern showed) and
  // written back as v6, so the migration runs once.
  it('writes a v5 config back as v6, logging the migration', async () => {
    vi.mocked(api.getSetting).mockResolvedValueOnce(
      JSON.stringify({ version: 5, categories: { system: { visibility: 'always' } } }),
    );

    const { result } = renderHook(() => useMessageRenderingConfig(), { wrapper });
    await waitFor(() => expect(result.current.config.version).toBe(6));

    const written = JSON.parse(String(vi.mocked(api.saveSetting).mock.calls[0]?.[1]));
    expect(written.version).toBe(6);
    expect(written.categories.system.standard).toBe(true);
    expect(vi.mocked(api.logWriteBatch).mock.calls[0]?.[0]?.[0]?.message).toMatch(/migrated/);
  });
});
