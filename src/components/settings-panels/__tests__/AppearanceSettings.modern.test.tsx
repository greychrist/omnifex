// @vitest-environment jsdom
/**
 * Appearance › Modern: the Modern chat format's own settings, beside a live
 * sample drawn by the real Modern components. It took the Terminal tab's place.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { render, screen, fireEvent, cleanup, waitFor, within } from '@testing-library/react';

vi.mock('@/lib/api', () => ({
  api: {
    getSetting: vi.fn(async () => null),
    saveSetting: vi.fn(async () => {}),
    logWriteBatch: vi.fn(async () => {}),
  },
}));
vi.mock('@/hooks/useLayoutMode', () => ({ useLayoutMode: () => ({ touch: false }) }));
vi.mock('@/hooks', async (orig) => ({
  ...(await orig<typeof import('@/hooks')>()),
  useTheme: () => ({ theme: 'gray', setTheme: () => {}, isLoading: false }),
}));

import { api } from '@/lib/api';
import { AppearanceSettings } from '../AppearanceSettings';
import { SaveStatusProvider } from '../saveStatus';
import { MessageRenderingProvider } from '@/contexts/MessageRenderingContext';

beforeEach(() => {
  vi.clearAllMocks();
  sessionStorage.clear();
  vi.mocked(api.getSetting).mockResolvedValue(null);
  vi.mocked(api.saveSetting).mockResolvedValue();
});
afterEach(cleanup);

function savedModern(): Record<string, unknown>[] {
  return vi.mocked(api.saveSetting).mock.calls
    .map(([, v]) => (JSON.parse(String(v)) as { modern?: Record<string, unknown> }).modern)
    .filter((m): m is Record<string, unknown> => !!m);
}

async function openModern() {
  sessionStorage.setItem('omnifex:appearance-tab', 'modern');
  render(
    <MessageRenderingProvider>
      <SaveStatusProvider>
        <AppearanceSettings setToast={vi.fn()} />
      </SaveStatusProvider>
    </MessageRenderingProvider>,
  );
  return screen.findByTestId('modern-editor');
}

describe('AppearanceSettings — Modern', () => {
  it('has a Modern tab and no Terminal tab', async () => {
    await openModern();
    expect(screen.getByRole('tab', { name: 'Modern' })).toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: 'Terminal' })).toBeNull();
  });

  it('shows a sample drawn by the Modern format', async () => {
    await openModern();
    const sample = screen.getByRole('region', { name: 'Modern sample' });
    expect(sample).toHaveClass('modern-format');
    expect(sample.querySelector('.modern-prompt')).not.toBeNull();
    expect(sample.querySelector('[data-slot="trace"]')).not.toBeNull();
  });

  it('saves the timeline setting', async () => {
    const editor = await openModern();
    fireEvent.click(within(editor).getByRole('radio', { name: 'Always open' }));
    await waitFor(() => { expect(savedModern().some((m) => m.timelineOpen === 'always')).toBe(true); });
  });

  it('saves hiding thoughts', async () => {
    const editor = await openModern();
    fireEvent.click(within(editor).getByRole('switch', { name: 'Show thoughts' }));
    await waitFor(() => { expect(savedModern().some((m) => m.showThoughts === false)).toBe(true); });
  });

  it('saves the font and the answer size', async () => {
    const editor = await openModern();
    fireEvent.click(within(editor).getByRole('radio', { name: 'Typography font' }));
    fireEvent.click(within(editor).getByRole('radio', { name: '16px' }));
    await waitFor(() => {
      expect(savedModern().some((m) => m.font === 'content' && m.answerSize === 16)).toBe(true);
    });
  });

  it('hands the live chats its font, answer size and tint through :root', async () => {
    const editor = await openModern();
    fireEvent.click(within(editor).getByRole('radio', { name: '16px' }));
    fireEvent.change(within(editor).getByLabelText('Prompt bubble colour hex'), { target: { value: '#22c55e' } });
    const root = document.documentElement.style;
    await waitFor(() => {
      expect(root.getPropertyValue('--modern-answer-size')).toBe('16px');
      expect(root.getPropertyValue('--modern-prompt-tint')).toBe('#22c55e');
    });
  });

  it('saves a prompt tint and a failed-step colour', async () => {
    const editor = await openModern();
    fireEvent.change(within(editor).getByLabelText('Prompt bubble colour hex'), { target: { value: '#22c55e' } });
    fireEvent.change(within(editor).getByLabelText('Failed step colour hex'), { target: { value: '#f97316' } });
    await waitFor(() => {
      expect(savedModern().some((m) => m.promptTint === '#22c55e' && m.failedColor === '#f97316')).toBe(true);
    });
  });

  it('lists an icon for every kind of step', async () => {
    const editor = await openModern();
    for (const label of ['Thought', 'Command', 'Commit', 'Read', 'Edit', 'Web', 'Agent', 'MCP tool', 'Other tool']) {
      expect(within(editor).getByRole('group', { name: `${label} step icon` })).toBeInTheDocument();
    }
  });
});
