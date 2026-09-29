// @vitest-environment jsdom
/**
 * The Settings shell has no Save button: every tab saves as it changes, and
 * the header's save indicator reports the outcome for all of them.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';

vi.mock('@/lib/api', () => ({ api: {} }));
// Proxy used to be the one tab that showed a Save button; open on it.
vi.mock('@/lib/settingsInitialTab', () => ({
  readInitialSettingsTab: () => 'proxy',
  clearInitialSettingsTab: () => {},
}));
vi.mock('@/components/AccountSettings', () => ({ AccountSettings: () => null }));
vi.mock('@/components/ModelPricingEditor', () => ({ ModelPricingEditor: () => null }));
vi.mock('../StorageTab', () => ({ StorageTab: () => null }));
vi.mock('../LogTab', () => ({ LogTab: () => null }));
vi.mock('../settings-panels/SystemPromptSettings', () => ({ SystemPromptSettings: () => null }));
vi.mock('../settings-panels', async () => {
  const { useSaveStatus } = await import('../settings-panels/saveStatus');
  // A panel that saves, to prove the shell's indicator hears every tab.
  const ProxySettingsPanel = () => {
    const { track } = useSaveStatus();
    return (
      <button type="button" onClick={() => { void track(Promise.reject(new Error('proxy refused'))); }}>
        change proxy
      </button>
    );
  };
  return {
    GeneralSettings: () => null,
    AppearanceSettings: () => null,
    RateLimitsSettings: () => null,
    ProxySettingsPanel,
  };
});

import { Settings } from '../Settings';

afterEach(cleanup);

describe('Settings shell', () => {
  it('has no Save button', () => {
    render(<Settings onBack={() => {}} />);
    expect(screen.queryByRole('button', { name: /save/i })).toBeNull();
  });

  it("reports a panel's save in the header indicator", async () => {
    render(<Settings onBack={() => {}} />);
    fireEvent.click(screen.getByText('change proxy'));
    await waitFor(() => {
      expect(screen.getByRole('status').textContent).toMatch(/Couldn.t save: proxy refused/);
    });
  });
});
