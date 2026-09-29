// @vitest-environment jsdom
/**
 * Chats-tab edits report through the Settings save indicator — the real
 * outcome of the write — instead of an "Appearance saved" toast that fired
 * whether or not the write landed.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';

vi.mock('@/lib/api', () => ({
  api: {
    getSetting: vi.fn(async () => null),
    saveSetting: vi.fn(async () => {}),
    logWriteBatch: vi.fn(async () => {}),
  },
}));

import { api } from '@/lib/api';
import { AppearanceSettings } from '../AppearanceSettings';
import { SaveStatusProvider, SaveStatusBanner } from '../saveStatus';
import { MessageRenderingProvider } from '@/contexts/MessageRenderingContext';

const setToast = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.getSetting).mockResolvedValue(null);
  vi.mocked(api.saveSetting).mockResolvedValue();
});
afterEach(cleanup);

async function renderChats() {
  render(
    <MessageRenderingProvider>
      <SaveStatusProvider>
        <SaveStatusBanner />
        <AppearanceSettings setToast={setToast} />
      </SaveStatusProvider>
    </MessageRenderingProvider>,
  );
  await screen.findAllByText('User');
}

const editAccent = () => {
  fireEvent.change(screen.getByLabelText('Accent colour picker'), { target: { value: '#123456' } });
};

describe('AppearanceSettings saving', () => {
  it('reports an edit as Saved once the write lands, with no toast', async () => {
    await renderChats();
    editAccent();
    await waitFor(() => { expect(screen.getByRole('status').textContent).toMatch(/Saved/); });
    await new Promise((r) => setTimeout(r, 900));
    expect(setToast).not.toHaveBeenCalled();
  });

  it('reports a failed write', async () => {
    await renderChats();
    vi.mocked(api.saveSetting).mockRejectedValue(new Error('database is locked'));
    editAccent();
    await waitFor(() => {
      expect(screen.getByRole('status').textContent).toMatch(/Couldn.t save: database is locked/);
    });
  });
});
