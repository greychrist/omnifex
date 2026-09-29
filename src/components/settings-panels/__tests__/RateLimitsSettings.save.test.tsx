// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';

const loaded = {
  notifications_enabled: true,
  five_hour_thresholds_pct: [80, 95],
  seven_day_notifications_enabled: false,
  seven_day_thresholds_pct: [90],
  sound_enabled: true,
};

vi.mock('@/lib/api', () => ({
  api: {
    getRateLimitSettings: vi.fn(),
    updateRateLimitSettings: vi.fn(),
  },
}));

import { api } from '@/lib/api';
import { RateLimitsSettings } from '../RateLimitsSettings';
import { SaveStatusProvider, SaveStatusBanner } from '../saveStatus';

const setToast = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.getRateLimitSettings).mockResolvedValue({ ...loaded });
  vi.mocked(api.updateRateLimitSettings).mockImplementation(async (p) => ({ ...loaded, ...p }));
});
afterEach(cleanup);

async function renderPanel() {
  render(
    <SaveStatusProvider>
      <SaveStatusBanner />
      <RateLimitsSettings setToast={setToast} />
    </SaveStatusProvider>,
  );
  await waitFor(() => { expect(api.getRateLimitSettings).toHaveBeenCalled(); });
}

describe('RateLimitsSettings saving', () => {
  it('reports a saved switch in the save indicator', async () => {
    await renderPanel();
    fireEvent.click(screen.getAllByRole('switch')[0]);
    await waitFor(() => {
      expect(api.updateRateLimitSettings).toHaveBeenCalledWith({ notifications_enabled: false });
    });
    await waitFor(() => { expect(screen.getByRole('status').textContent).toMatch(/Saved/); });
    expect(setToast).not.toHaveBeenCalled();
  });

  it('reports a failed save in the save indicator instead of a toast', async () => {
    vi.mocked(api.updateRateLimitSettings).mockRejectedValue(new Error('database is locked'));
    await renderPanel();
    fireEvent.click(screen.getAllByRole('switch')[0]);
    await waitFor(() => {
      expect(screen.getByRole('status').textContent).toMatch(/Couldn.t save: database is locked/);
    });
    expect(setToast).not.toHaveBeenCalled();
  });
});
