// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';

vi.mock('@/lib/api', () => ({
  api: {
    getSetting: vi.fn(async () => null),
    saveSetting: vi.fn(async () => {}),
    logQuery: vi.fn(async () => ({ entries: [], total: 0 })),
    logCount: vi.fn(async () => 0),
    logPrune: vi.fn(async () => 0),
  },
}));

vi.mock('@/contexts/TabContext', () => ({ useTabContext: () => ({ tabs: [] }) }));

import { api } from '@/lib/api';
import { LogTab } from '../LogTab';
import { SaveStatusProvider, SaveStatusBanner } from '../settings-panels/saveStatus';

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.saveSetting).mockResolvedValue();
});
afterEach(cleanup);

function renderLog() {
  render(
    <SaveStatusProvider>
      <SaveStatusBanner />
      <LogTab />
    </SaveStatusProvider>,
  );
}

describe('LogTab settings switches', () => {
  it('report a save in the save indicator', async () => {
    renderLog();
    fireEvent.click(await screen.findByRole('switch', { name: /Toast on errors/ }));
    await waitFor(() => {
      expect(api.saveSetting).toHaveBeenCalledWith('log_error_toast_enabled', expect.any(String));
    });
    await waitFor(() => { expect(screen.getByRole('status').textContent).toMatch(/Saved/); });
  });

  it('report a failed save instead of only logging it', async () => {
    vi.mocked(api.saveSetting).mockRejectedValue(new Error('database is locked'));
    renderLog();
    fireEvent.click(await screen.findByRole('switch', { name: /Claude hook events/ }));
    await waitFor(() => {
      expect(screen.getByRole('status').textContent).toMatch(/Couldn.t save: database is locked/);
    });
  });
});
