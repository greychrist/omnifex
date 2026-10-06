// @vitest-environment jsdom
/**
 * General tab save behaviour: every control persists on change and reports
 * through the Settings save indicator — there is no Save button to wait for.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return {
    ...actual,
    api: {
      getSetting: vi.fn(async () => null),
      saveSetting: vi.fn(async () => {}),
      logWriteBatch: vi.fn(async () => {}),
      getClaudeBinaryPath: vi.fn(async () => '/usr/local/bin/claude'),
      setClaudeBinaryPath: vi.fn(async () => {}),
      previewNotificationSound: vi.fn(async () => {}),
    },
  };
});

// The real selector lists installations over IPC; the test only needs its
// `onSelect` contract.
vi.mock('@/components/ClaudeVersionSelector', () => ({
  ClaudeVersionSelector: ({ onSelect, autoSelect }: { onSelect: (i: { path: string }) => void; autoSelect?: boolean }) => (
    <button
      type="button"
      data-auto-select={String(autoSelect ?? true)}
      onClick={() => onSelect({ path: '/opt/homebrew/bin/claude' })}
    >
      pick installation
    </button>
  ),
}));

import { api, CLI_AUTO_UPDATE_SETTING_KEY } from '@/lib/api';
import { GeneralSettings } from '../GeneralSettings';
import { SaveStatusProvider, SaveStatusBanner } from '../saveStatus';
import { ThemeProvider } from '@/contexts/ThemeContext';
import { AppFontProvider } from '@/contexts/AppFontContext';
import { AutoScrollProvider } from '@/contexts/AutoScrollContext';
import { SessionGaugesProvider } from '@/contexts/SessionGaugesContext';
import { MessageRenderingProvider } from '@/contexts/MessageRenderingContext';

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.getSetting).mockResolvedValue(null);
  vi.mocked(api.saveSetting).mockResolvedValue();
});
afterEach(cleanup);

async function renderGeneral() {
  render(
    <ThemeProvider>
      <AppFontProvider>
        <AutoScrollProvider>
          <SessionGaugesProvider>
            <MessageRenderingProvider>
              <SaveStatusProvider>
                <SaveStatusBanner />
                <GeneralSettings />
              </SaveStatusProvider>
            </MessageRenderingProvider>
          </SessionGaugesProvider>
        </AutoScrollProvider>
      </AppFontProvider>
    </ThemeProvider>,
  );
  await screen.findByText('pick installation');
  // Let the providers' first loads settle before counting writes.
  await new Promise((r) => setTimeout(r, 0));
  vi.mocked(api.saveSetting).mockClear();
}

const status = () => screen.getByRole('status');

describe('GeneralSettings saving', () => {
  // Every pick saves, so the selector must not pick on its own: that showed
  // "Saved" the moment Settings opened. See ClaudeVersionSelector.test.tsx.
  it('does not let the installation selector pick on the user\'s behalf', async () => {
    await renderGeneral();
    expect(screen.getByText('pick installation').getAttribute('data-auto-select')).toBe('false');
    expect(api.setClaudeBinaryPath).not.toHaveBeenCalled();
  });

  it('saves a picked Claude installation at once', async () => {
    await renderGeneral();
    fireEvent.click(screen.getByText('pick installation'));
    await waitFor(() => {
      expect(api.setClaudeBinaryPath).toHaveBeenCalledWith('/opt/homebrew/bin/claude');
    });
    await waitFor(() => { expect(status().textContent).toMatch(/Saved/); });
    expect(screen.queryByText(/when you save settings/i)).toBeNull();
  });

  it('shows a failed installation save in the indicator', async () => {
    vi.mocked(api.setClaudeBinaryPath).mockRejectedValueOnce(new Error('not executable'));
    await renderGeneral();
    fireEvent.click(screen.getByText('pick installation'));
    await waitFor(() => { expect(status().textContent).toMatch(/not executable/); });
  });

  it('shows a failed switch save in the indicator', async () => {
    await renderGeneral();
    vi.mocked(api.saveSetting).mockRejectedValue(new Error('database is locked'));
    fireEvent.click(screen.getByRole('switch', { name: /Auto-update Claude Code on launch/ }));
    await waitFor(() => {
      expect(api.saveSetting).toHaveBeenCalledWith(CLI_AUTO_UPDATE_SETTING_KEY, 'true');
    });
    await waitFor(() => { expect(status().textContent).toMatch(/Couldn.t save: database is locked/); });
  });

  it('reports a context-setter failure too, which used to be swallowed', async () => {
    await renderGeneral();
    vi.mocked(api.saveSetting).mockRejectedValue(new Error('database is locked'));
    fireEvent.click(screen.getByRole('switch', { name: /Prompt cache countdown/i }));
    await waitFor(() => { expect(status().textContent).toMatch(/database is locked/); });
  });

  it('does not save a typed field that was left unchanged', async () => {
    await renderGeneral();
    const field = screen.getByLabelText(/Follow new messages within/);
    fireEvent.focus(field);
    fireEvent.blur(field);
    await new Promise((r) => setTimeout(r, 0));
    expect(api.saveSetting).not.toHaveBeenCalled();
    expect(status().textContent).toBe('');
  });

  it('saves a changed typed field on blur', async () => {
    await renderGeneral();
    const field = screen.getByLabelText(/Follow new messages within/);
    fireEvent.change(field, { target: { value: '600' } });
    fireEvent.blur(field);
    await waitFor(() => { expect(api.saveSetting).toHaveBeenCalledWith('autoscroll_follow_px', '600'); });
    await waitFor(() => { expect(status().textContent).toMatch(/Saved/); });
  });
});
