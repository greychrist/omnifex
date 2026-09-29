// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';

vi.mock('@/lib/api', async () => ({
  api: {
    getSetting: vi.fn(async (_key: string) => null),
    saveSetting: vi.fn(async () => {}),
  },
}));

import { api } from '@/lib/api';
import { AutoRecapSettings } from '../AutoRecapSettings';
import { SaveStatusProvider, SaveStatusBanner } from '../saveStatus';
import { AUTO_RECAP_ENABLED_KEY, AUTO_RECAP_DELAY_KEY } from '@/lib/autoRecapSettings';

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.getSetting).mockImplementation(async () => null);
  vi.mocked(api.saveSetting).mockResolvedValue();
});
afterEach(cleanup);

describe('AutoRecapSettings', () => {
  it('defaults to on, after 10 minutes', async () => {
    render(<AutoRecapSettings />);
    const toggle = await screen.findByRole('switch', { name: /Recap idle sessions/ });
    expect(toggle.getAttribute('aria-checked')).toBe('true');
    expect((screen.getByLabelText(/Minutes before the recap/) as HTMLInputElement).value).toBe('10');
  });

  it('shows the stored values', async () => {
    vi.mocked(api.getSetting).mockImplementation(async (key: string) =>
      key === AUTO_RECAP_ENABLED_KEY ? 'false' : key === AUTO_RECAP_DELAY_KEY ? '15' : null);
    render(<AutoRecapSettings />);
    const toggle = await screen.findByRole('switch', { name: /Recap idle sessions/ });
    await waitFor(() => expect(toggle.getAttribute('aria-checked')).toBe('false'));
    expect((screen.getByLabelText(/Minutes before the recap/) as HTMLInputElement).value).toBe('15');
  });

  it('saves the switch', async () => {
    render(<AutoRecapSettings />);
    fireEvent.click(await screen.findByRole('switch', { name: /Recap idle sessions/ }));
    await waitFor(() => expect(api.saveSetting).toHaveBeenCalledWith(AUTO_RECAP_ENABLED_KEY, 'false'));
  });

  it('saves a new delay on blur, and refuses one that is not a positive number', async () => {
    render(<AutoRecapSettings />);
    const field = await screen.findByLabelText(/Minutes before the recap/) as HTMLInputElement;
    fireEvent.change(field, { target: { value: '15' } });
    fireEvent.blur(field);
    await waitFor(() => expect(api.saveSetting).toHaveBeenCalledWith(AUTO_RECAP_DELAY_KEY, '15'));

    vi.mocked(api.saveSetting).mockClear();
    fireEvent.change(field, { target: { value: '0' } });
    fireEvent.blur(field);
    await waitFor(() => expect(field.value).toBe('15'));
    expect(api.saveSetting).not.toHaveBeenCalled();
  });

  it('reports a failed save in the save indicator', async () => {
    vi.mocked(api.saveSetting).mockRejectedValue(new Error('database is locked'));
    render(
      <SaveStatusProvider>
        <SaveStatusBanner />
        <AutoRecapSettings />
      </SaveStatusProvider>,
    );
    fireEvent.click(await screen.findByRole('switch', { name: /Recap idle sessions/ }));
    await waitFor(() => {
      expect(screen.getByRole('status').textContent).toMatch(/Couldn.t save: database is locked/);
    });
  });
});
