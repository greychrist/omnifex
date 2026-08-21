// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';

// The panel only reads/writes one app_settings key, unlike the summary panel
// next door which juggles three.
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

async function waitForLoaded() {
  await screen.findByRole('heading', { name: 'Compactions' });
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
    vi.mocked(api.getSetting).mockImplementation(async () => 'my directive');
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
    vi.mocked(api.getSetting).mockImplementation(async () => 'custom');
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

  // Blanking the box is the documented way to turn the directive off —
  // `queuePostCompactDirective` skips an empty prompt rather than sending an
  // empty turn. The panel must therefore persist an empty string rather than
  // treating it as "nothing changed".
  it('persists an empty template, which is how the directive is turned off', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.mocked(api.getSetting).mockImplementation(async () => 'something');
    render(<CompactionPromptSettings />);
    await waitForLoaded();

    fireEvent.change(textarea(), { target: { value: '' } });
    await vi.advanceTimersByTimeAsync(600);

    await waitFor(() => {
      expect(vi.mocked(api.saveSetting)).toHaveBeenCalledWith(
        POST_COMPACT_PROMPT_SETTING_KEY,
        '',
      );
    });
  });

  it('tells the user that clearing the box disables the directive', async () => {
    render(<CompactionPromptSettings />);
    await waitForLoaded();
    expect(document.body.textContent).toMatch(/clear/i);
  });
});
