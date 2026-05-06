// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';

// Mock the api module before importing the component. The panel reads
// three app_settings keys on mount and writes back on every change.
vi.mock('@/lib/api', async () => {
  return {
    api: {
      getSetting: vi.fn(async (_key: string) => null),
      saveSetting: vi.fn(async () => {}),
    },
    PROMPT_TEMPLATE_SETTING_KEY: 'sessionsSummary.promptTemplate',
    AUTO_ON_CLOSE_SETTING_KEY: 'sessionsSummary.autoOnClose',
    ENABLED_SETTING_KEY: 'sessionsSummary.enabled',
  };
});

import { api } from '@/lib/api';
import { SummaryPromptSettings } from '../SummaryPromptSettings';

beforeEach(() => {
  vi.clearAllMocks();
  // Default load: every key absent → defaults apply (enabled+auto both
  // true, prompt = built-in default). Individual tests can override
  // mockImplementation before render.
  vi.mocked(api.getSetting).mockImplementation(async () => null);
  vi.mocked(api.saveSetting).mockResolvedValue();
});

afterEach(() => {
  vi.useRealTimers();
  cleanup();
});

// Helper: wait for the panel to finish loading (heading is rendered once
// the initial getSetting Promise.all resolves and `loading` flips false).
async function waitForLoaded() {
  await screen.findByRole('heading', { name: 'Session Summaries' });
}

describe('SummaryPromptSettings', () => {
  it('renders the heading "Session Summaries"', async () => {
    render(<SummaryPromptSettings />);
    await waitForLoaded();
    expect(screen.getByRole('heading', { name: 'Session Summaries' })).toBeTruthy();
  });

  it('does not render Save or Cancel buttons (auto-save replaces them)', async () => {
    render(<SummaryPromptSettings />);
    await waitForLoaded();
    expect(screen.queryByRole('button', { name: /^save$/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /^cancel$/i })).toBeNull();
  });

  it('renders the master "Enable session summaries" switch', async () => {
    render(<SummaryPromptSettings />);
    await waitForLoaded();
    expect(
      screen.getByRole('switch', { name: /enable session summaries/i }),
    ).toBeTruthy();
  });

  it('renders the auto-on-close switch', async () => {
    render(<SummaryPromptSettings />);
    await waitForLoaded();
    expect(
      screen.getByRole('switch', {
        name: /generate summaries automatically on session close/i,
      }),
    ).toBeTruthy();
  });

  it('persists the master toggle immediately on flip', async () => {
    render(<SummaryPromptSettings />);
    await waitForLoaded();
    fireEvent.click(
      screen.getByRole('switch', { name: /enable session summaries/i }),
    );
    await waitFor(() =>
      expect(api.saveSetting).toHaveBeenCalledWith(
        'sessionsSummary.enabled',
        'false',
      ),
    );
  });

  it('persists the auto-on-close toggle immediately on flip', async () => {
    render(<SummaryPromptSettings />);
    await waitForLoaded();
    fireEvent.click(
      screen.getByRole('switch', {
        name: /generate summaries automatically on session close/i,
      }),
    );
    await waitFor(() =>
      expect(api.saveSetting).toHaveBeenCalledWith(
        'sessionsSummary.autoOnClose',
        'false',
      ),
    );
  });

  it('auto-saves prompt edits (debounced) without a Save button', async () => {
    render(<SummaryPromptSettings />);
    await waitForLoaded();
    // Switch to fake timers AFTER the load resolves so we can drive the
    // debounce window deterministically.
    vi.useFakeTimers();
    try {
      const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;
      fireEvent.change(textarea, { target: { value: 'edited prompt body' } });
      // Inside debounce — no save yet.
      expect(
        vi.mocked(api.saveSetting).mock.calls.filter(
          (c) => c[0] === 'sessionsSummary.promptTemplate',
        ),
      ).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(600);
    } finally {
      vi.useRealTimers();
    }
    await waitFor(() =>
      expect(api.saveSetting).toHaveBeenCalledWith(
        'sessionsSummary.promptTemplate',
        'edited prompt body',
      ),
    );
  });

  it('coalesces rapid edits into a single save call', async () => {
    render(<SummaryPromptSettings />);
    await waitForLoaded();
    vi.useFakeTimers();
    try {
      const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;
      fireEvent.change(textarea, { target: { value: 'a' } });
      await vi.advanceTimersByTimeAsync(100);
      fireEvent.change(textarea, { target: { value: 'ab' } });
      await vi.advanceTimersByTimeAsync(100);
      fireEvent.change(textarea, { target: { value: 'abc' } });
      expect(
        vi.mocked(api.saveSetting).mock.calls.filter(
          (c) => c[0] === 'sessionsSummary.promptTemplate',
        ),
      ).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(600);
    } finally {
      vi.useRealTimers();
    }
    await waitFor(() => {
      const promptCalls = vi
        .mocked(api.saveSetting)
        .mock.calls.filter((c) => c[0] === 'sessionsSummary.promptTemplate');
      expect(promptCalls).toHaveLength(1);
      expect(promptCalls[0][1]).toBe('abc');
    });
  });

  it('Reset to default replaces the textarea AND auto-saves', async () => {
    vi.mocked(api.getSetting).mockImplementation(async (key: string) => {
      if (key === 'sessionsSummary.promptTemplate') return 'CUSTOM';
      return null;
    });
    render(<SummaryPromptSettings />);
    await waitForLoaded();
    const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;
    expect(textarea.value).toBe('CUSTOM');
    vi.useFakeTimers();
    try {
      fireEvent.click(
        screen.getByRole('button', { name: /reset to default/i }),
      );
      await vi.advanceTimersByTimeAsync(600);
    } finally {
      vi.useRealTimers();
    }
    await waitFor(() => {
      const promptCalls = vi
        .mocked(api.saveSetting)
        .mock.calls.filter((c) => c[0] === 'sessionsSummary.promptTemplate');
      expect(promptCalls.length).toBeGreaterThan(0);
      const lastSaved = promptCalls[promptCalls.length - 1][1] as string;
      expect(lastSaved).not.toBe('CUSTOM');
      expect(textarea.value).toBe(lastSaved);
    });
  });

  it('loads existing settings on mount (enabled=false stays unchecked)', async () => {
    vi.mocked(api.getSetting).mockImplementation(async (key: string) => {
      if (key === 'sessionsSummary.enabled') return 'false';
      return null;
    });
    render(<SummaryPromptSettings />);
    await waitForLoaded();
    const sw = screen.getByRole('switch', {
      name: /enable session summaries/i,
    }) as HTMLButtonElement;
    expect(sw.getAttribute('aria-checked')).toBe('false');
  });
});
