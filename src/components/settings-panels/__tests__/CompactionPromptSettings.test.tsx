// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';

// The panel reads/writes two app_settings keys: the template and the switch.
vi.mock('@/lib/api', async () => {
  return {
    api: {
      getSetting: vi.fn(async (_key: string) => null),
      saveSetting: vi.fn(async () => {}),
    },
  };
});

import { api } from '@/lib/api';
import {
  DEFAULT_POST_COMPACT_PROMPT,
  POST_COMPACT_ENABLED_SETTING_KEY,
  POST_COMPACT_PROMPT_SETTING_KEY,
} from '@/lib/postCompactPrompt';
import { CompactionPromptSettings } from '../CompactionPromptSettings';

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.getSetting).mockImplementation(async () => null);
  vi.mocked(api.saveSetting).mockResolvedValue();
});

afterEach(() => {
  vi.useRealTimers();
  cleanup();
});

// The heading renders while the template is still loading; the editor only
// once it has. Waiting on the heading raced the load under full-suite load.
async function waitForLoaded() {
  await screen.findByRole('textbox');
}

function textarea(): HTMLTextAreaElement {
  return screen.getByRole('textbox') as HTMLTextAreaElement;
}

describe('CompactionPromptSettings', () => {
  it('renders the heading "Compactions"', async () => {
    render(<CompactionPromptSettings />);
    await waitForLoaded();
    expect(screen.getByRole('heading', { name: 'Compactions' })).toBeTruthy();
  });

  it('reads the post-compact template key on mount', async () => {
    render(<CompactionPromptSettings />);
    await waitForLoaded();
    expect(vi.mocked(api.getSetting)).toHaveBeenCalledWith(
      POST_COMPACT_PROMPT_SETTING_KEY,
    );
  });

  it('falls back to the shipped default when no override is stored', async () => {
    render(<CompactionPromptSettings />);
    await waitForLoaded();
    expect(textarea().value).toBe(DEFAULT_POST_COMPACT_PROMPT);
  });

  it('loads a stored override instead of the default', async () => {
    vi.mocked(api.getSetting).mockImplementation(async (key: string) => (key === POST_COMPACT_PROMPT_SETTING_KEY ? 'my directive' : null));
    render(<CompactionPromptSettings />);
    await waitForLoaded();
    expect(textarea().value).toBe('my directive');
  });

  it('does not render Save or Cancel buttons (auto-save replaces them)', async () => {
    render(<CompactionPromptSettings />);
    await waitForLoaded();
    expect(screen.queryByRole('button', { name: /^save$/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /^cancel$/i })).toBeNull();
  });

  it('auto-saves edits after the debounce', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    render(<CompactionPromptSettings />);
    await waitForLoaded();

    fireEvent.change(textarea(), { target: { value: 'edited directive' } });
    expect(vi.mocked(api.saveSetting)).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(600);
    await waitFor(() => {
      expect(vi.mocked(api.saveSetting)).toHaveBeenCalledWith(
        POST_COMPACT_PROMPT_SETTING_KEY,
        'edited directive',
      );
    });
  });

  it('coalesces rapid edits into a single save', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    render(<CompactionPromptSettings />);
    await waitForLoaded();

    fireEvent.change(textarea(), { target: { value: 'a' } });
    await vi.advanceTimersByTimeAsync(100);
    fireEvent.change(textarea(), { target: { value: 'ab' } });
    await vi.advanceTimersByTimeAsync(100);
    fireEvent.change(textarea(), { target: { value: 'abc' } });
    await vi.advanceTimersByTimeAsync(600);

    await waitFor(() => {
      expect(vi.mocked(api.saveSetting)).toHaveBeenCalledTimes(1);
    });
    expect(vi.mocked(api.saveSetting)).toHaveBeenCalledWith(
      POST_COMPACT_PROMPT_SETTING_KEY,
      'abc',
    );
  });

  it('Reset to default restores the shipped directive and saves it', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.mocked(api.getSetting).mockImplementation(async (key: string) => (key === POST_COMPACT_PROMPT_SETTING_KEY ? 'custom' : null));
    render(<CompactionPromptSettings />);
    await waitForLoaded();

    fireEvent.click(screen.getByRole('button', { name: /reset to default/i }));
    expect(textarea().value).toBe(DEFAULT_POST_COMPACT_PROMPT);

    await vi.advanceTimersByTimeAsync(600);
    await waitFor(() => {
      expect(vi.mocked(api.saveSetting)).toHaveBeenCalledWith(
        POST_COMPACT_PROMPT_SETTING_KEY,
        DEFAULT_POST_COMPACT_PROMPT,
      );
    });
  });

  it('disables Reset when the editor already holds the default', async () => {
    render(<CompactionPromptSettings />);
    await waitForLoaded();
    const reset = screen.getByRole('button', { name: /reset to default/i });
    expect((reset as HTMLButtonElement).disabled).toBe(true);
  });

  // The switch turns the directive off and keeps the edited text, which the
  // old "clear the box" did not — and clearing never worked anyway: a blank
  // template resolved to the shipped default.
  const toggle = () => screen.getByRole('switch', { name: /send a prompt after compaction/i });

  it('is on when nothing is stored', async () => {
    render(<CompactionPromptSettings />);
    await waitForLoaded();
    expect(toggle().getAttribute('aria-checked')).toBe('true');
  });

  it('reads a stored off', async () => {
    vi.mocked(api.getSetting).mockImplementation(async (key: string) => (key === POST_COMPACT_ENABLED_SETTING_KEY ? 'false' : null));
    render(<CompactionPromptSettings />);
    await waitForLoaded();
    expect(toggle().getAttribute('aria-checked')).toBe('false');
  });

  it('saves the switch when flipped, leaving the template alone', async () => {
    render(<CompactionPromptSettings />);
    await waitForLoaded();
    fireEvent.click(toggle());
    await waitFor(() => {
      expect(vi.mocked(api.saveSetting)).toHaveBeenCalledWith(POST_COMPACT_ENABLED_SETTING_KEY, 'false');
    });
    expect(vi.mocked(api.saveSetting)).not.toHaveBeenCalledWith(POST_COMPACT_PROMPT_SETTING_KEY, expect.anything());
    expect(textarea().value).toBe(DEFAULT_POST_COMPACT_PROMPT);
  });

  it('flips back if the save fails', async () => {
    vi.mocked(api.saveSetting).mockRejectedValue(new Error('x'));
    render(<CompactionPromptSettings />);
    await waitForLoaded();
    fireEvent.click(toggle());
    await waitFor(() => { expect(toggle().getAttribute('aria-checked')).toBe('true'); });
  });

  it('no longer tells the user to clear the box', async () => {
    render(<CompactionPromptSettings />);
    await waitForLoaded();
    expect(document.body.textContent).not.toMatch(/clear the box/i);
  });
});
