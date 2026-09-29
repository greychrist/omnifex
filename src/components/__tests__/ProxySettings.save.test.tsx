// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';

const stored = { http_proxy: null, https_proxy: null, no_proxy: null, all_proxy: null, enabled: false };

vi.mock('@/lib/api', () => ({
  api: {
    getProxySettings: vi.fn(),
    saveProxySettings: vi.fn(async () => {}),
  },
}));

import { api } from '@/lib/api';
import { ProxySettings } from '../ProxySettings';
import { SaveStatusProvider, SaveStatusBanner } from '../settings-panels/saveStatus';

const setToast = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.getProxySettings).mockResolvedValue({ ...stored });
  vi.mocked(api.saveProxySettings).mockResolvedValue();
});
afterEach(cleanup);

async function renderProxy() {
  render(
    <SaveStatusProvider>
      <SaveStatusBanner />
      <ProxySettings setToast={setToast} />
    </SaveStatusProvider>,
  );
  await waitFor(() => { expect(api.getProxySettings).toHaveBeenCalled(); });
}

const status = () => screen.getByRole('status');

describe('ProxySettings saving', () => {
  it('saves the Enable switch at once', async () => {
    await renderProxy();
    fireEvent.click(screen.getByRole('switch', { name: /Enable Proxy/ }));
    await waitFor(() => {
      expect(api.saveProxySettings).toHaveBeenCalledWith({ ...stored, enabled: true });
    });
    await waitFor(() => { expect(status().textContent).toMatch(/Saved/); });
    expect(setToast).not.toHaveBeenCalled();
  });

  it('saves an address when the field is left, not on every keystroke', async () => {
    await renderProxy();
    fireEvent.click(screen.getByRole('switch', { name: /Enable Proxy/ }));
    await waitFor(() => { expect(api.saveProxySettings).toHaveBeenCalledTimes(1); });
    const field = screen.getByLabelText('HTTP Proxy');
    fireEvent.change(field, { target: { value: 'http://proxy:8080' } });
    expect(api.saveProxySettings).toHaveBeenCalledTimes(1);
    fireEvent.blur(field);
    await waitFor(() => {
      expect(api.saveProxySettings).toHaveBeenLastCalledWith({
        ...stored, enabled: true, http_proxy: 'http://proxy:8080',
      });
    });
  });

  it('does not save a field left unchanged', async () => {
    await renderProxy();
    fireEvent.blur(screen.getByLabelText('No Proxy'));
    await new Promise((r) => setTimeout(r, 0));
    expect(api.saveProxySettings).not.toHaveBeenCalled();
  });

  it('shows a failed save in the indicator', async () => {
    vi.mocked(api.saveProxySettings).mockRejectedValue(new Error('invalid proxy URL'));
    await renderProxy();
    fireEvent.click(screen.getByRole('switch', { name: /Enable Proxy/ }));
    await waitFor(() => { expect(status().textContent).toMatch(/invalid proxy URL/); });
  });
});
