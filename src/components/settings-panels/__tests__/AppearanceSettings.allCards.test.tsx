// @vitest-environment jsdom
/**
 * Appearance › Message kinds › All cards: settings that apply to every card
 * (default view mode, card border opacity). They used to
 * live on a separate Global tab, which is gone, as are the retired controls
 * (the live-overlay "Hide …" toggles and the Palette tab).
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

function savedConfigs(): Record<string, unknown>[] {
  return vi.mocked(api.saveSetting).mock.calls.map(([, v]) => JSON.parse(String(v)) as Record<string, unknown>);
}

async function openAllCards() {
  render(
    <MessageRenderingProvider>
      <SaveStatusProvider>
        <AppearanceSettings setToast={vi.fn()} />
      </SaveStatusProvider>
    </MessageRenderingProvider>,
  );
  await screen.findAllByText('User');
  fireEvent.click(screen.getByRole('button', { name: /All cards/ }));
  return screen.getByTestId('all-cards-editor');
}

describe('AppearanceSettings — All cards', () => {
  // A generic card, modelled on the User category, so these settings have
  // something to show their effect on.
  it('previews a generic card titled All cards', async () => {
    await openAllCards();
    const sample = screen.getByRole('region', { name: 'Sample' });
    expect(within(sample).getByText('All cards')).toBeInTheDocument();
  });

  it('sets card border opacity, defaulting to 20%', async () => {
    const editor = await openAllCards();
    const slider = within(editor).getByLabelText<HTMLInputElement>('Card border opacity');
    expect(slider.value).toBe('20');
    fireEvent.change(slider, { target: { value: '35' } });
    await waitFor(() => { expect(savedConfigs().some((c) => c.cardBorderOpacity === 35)).toBe(true); });
  });

  it('sets the card corner radius, defaulting to 12px', async () => {
    const editor = await openAllCards();
    const slider = within(editor).getByLabelText<HTMLInputElement>('Card corner radius');
    expect(slider.value).toBe('12');
    fireEvent.change(slider, { target: { value: '4' } });
    await waitFor(() => { expect(savedConfigs().some((c) => c.cardBorderRadius === 4)).toBe(true); });
  });

  it('sets the default view mode', async () => {
    const editor = await openAllCards();
    const group = within(editor).getByRole('radiogroup', { name: 'Default view mode' });
    expect(within(group).getByRole('radio', { name: 'Verbose' })).toHaveAttribute('aria-checked', 'true');
    fireEvent.click(within(group).getByRole('radio', { name: 'Compact' }));
    await waitFor(() => { expect(savedConfigs().some((c) => c.defaultViewMode === 'compact')).toBe(true); });
  });

  // The "Show message kind label" debug toggle was read by nothing — the
  // card footer always shows the kind label — so it is gone.
  it('offers no kind-label toggle', async () => {
    const editor = await openAllCards();
    expect(within(editor).queryByRole('checkbox', { name: /kind label/i })).toBeNull();
  });

  it('has no Global or Palette tab, and none of the retired filters', async () => {
    await openAllCards();
    expect(screen.queryByRole('tab', { name: 'Global' })).toBeNull();
    expect(screen.queryByRole('tab', { name: 'Palette' })).toBeNull();
    expect(screen.queryByText(/Hide partial token streaming/)).toBeNull();
  });

  it('falls back to Message kinds when the remembered tab was Global', async () => {
    sessionStorage.setItem('omnifex:appearance-tab', 'global');
    render(
      <MessageRenderingProvider>
        <SaveStatusProvider>
          <AppearanceSettings setToast={vi.fn()} />
        </SaveStatusProvider>
      </MessageRenderingProvider>,
    );
    expect(await screen.findByRole('tab', { name: 'Message kinds', selected: true })).toBeInTheDocument();
  });
});
