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
import { ProgressModSettings } from '../ProgressModSettings';
import { PROGRESS_MOD_ENABLED_KEY } from '@/lib/progressModSettings';

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.getSetting).mockImplementation(async () => null);
  vi.mocked(api.saveSetting).mockResolvedValue();
});
afterEach(cleanup);

describe('ProgressModSettings', () => {
  it('defaults to on', async () => {
    render(<ProgressModSettings />);
    const toggle = await screen.findByRole('switch', { name: /Agent step progress/ });
    expect(toggle.getAttribute('aria-checked')).toBe('true');
  });

  it('shows a stored off', async () => {
    vi.mocked(api.getSetting).mockImplementation(async (key: string) => (key === PROGRESS_MOD_ENABLED_KEY ? 'false' : null));
    render(<ProgressModSettings />);
    const toggle = await screen.findByRole('switch', { name: /Agent step progress/ });
    await waitFor(() => expect(toggle.getAttribute('aria-checked')).toBe('false'));
  });

  it('saves the switch both ways', async () => {
    render(<ProgressModSettings />);
    const toggle = await screen.findByRole('switch', { name: /Agent step progress/ });
    fireEvent.click(toggle);
    await waitFor(() => expect(api.saveSetting).toHaveBeenCalledWith(PROGRESS_MOD_ENABLED_KEY, 'false'));
    fireEvent.click(toggle);
    await waitFor(() => expect(api.saveSetting).toHaveBeenCalledWith(PROGRESS_MOD_ENABLED_KEY, 'true'));
  });
});
