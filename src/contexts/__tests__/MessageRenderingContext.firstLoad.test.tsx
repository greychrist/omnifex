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

  it('resets a v1 config to v2 defaults and writes an app_logs entry', async () => {
    // Simulate a v1 persisted config (version field is 1)
    vi.mocked(api.getSetting).mockResolvedValueOnce(
      JSON.stringify({ version: 1, kinds: { 'user.prompt': {} } }),
    );
    vi.mocked(api.saveSetting).mockResolvedValue(undefined);
    vi.mocked(api.logWriteBatch).mockResolvedValue(undefined);

    const { result } = renderHook(() => useMessageRenderingConfig(), { wrapper });

    await waitFor(() => expect(result.current.config.version).toBe(2));
    expect(api.saveSetting).toHaveBeenCalledWith(
      'message_rendering_config',
      expect.stringContaining('"version":2'),
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

  it('leaves a v2 config untouched', async () => {
    // Simulate a persisted v2 config
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

    renderHook(() => useMessageRenderingConfig(), { wrapper });
    await waitFor(() => expect(api.getSetting).toHaveBeenCalled());

    expect(api.saveSetting).not.toHaveBeenCalled();
    expect(api.logWriteBatch).not.toHaveBeenCalled();
  });
});
