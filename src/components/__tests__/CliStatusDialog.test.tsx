// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';

const { apiMock } = vi.hoisted(() => ({ apiMock: { sessionCliStatus: vi.fn() } }));
vi.mock('@/lib/api', () => ({ api: apiMock }));

import { CliStatusDialog } from '../CliStatusDialog';

const REPORT = {
  sections: [
    { title: 'Session', rows: [{ label: 'Version', value: '2.1.280' }, { label: 'Email', value: 'a@b.c' }] },
    { title: 'Environment', rows: [{ label: 'Model', value: 'claude-opus-5-5[1m]' }, { value: 'Sandbox is off' }] },
  ],
};

beforeEach(() => { apiMock.sessionCliStatus.mockResolvedValue(REPORT); });
afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe('CliStatusDialog', () => {
  it('asks the live session for its status and renders every section and row', async () => {
    render(<CliStatusDialog open tabId="tab-1" onOpenChange={() => {}} />);
    expect(await screen.findByText('claude-opus-5-5[1m]')).toBeTruthy();
    expect(apiMock.sessionCliStatus).toHaveBeenCalledWith('tab-1');
    for (const t of ['Session', 'Environment', 'Version', '2.1.280', 'Email', 'a@b.c', 'Sandbox is off']) {
      expect(screen.getByText(t)).toBeTruthy();
    }
  });

  it('does not fetch while closed', () => {
    render(<CliStatusDialog open={false} tabId="tab-1" onOpenChange={() => {}} />);
    expect(apiMock.sessionCliStatus).not.toHaveBeenCalled();
  });

  it('says why when the CLI cannot answer', async () => {
    apiMock.sessionCliStatus.mockResolvedValue(null);
    render(<CliStatusDialog open tabId="tab-1" onOpenChange={() => {}} />);
    expect(await screen.findByText(/needs a running session on Claude Code 2\.1\.280 or newer/i)).toBeTruthy();
  });

  it('shows the error when the call fails', async () => {
    apiMock.sessionCliStatus.mockRejectedValue(new Error('boom'));
    render(<CliStatusDialog open tabId="tab-1" onOpenChange={() => {}} />);
    expect(await screen.findByText(/boom/)).toBeTruthy();
  });

  it('refetches on Refresh', async () => {
    render(<CliStatusDialog open tabId="tab-1" onOpenChange={() => {}} />);
    await screen.findByText('2.1.280');
    fireEvent.click(screen.getByRole('button', { name: /refresh/i }));
    await waitFor(() => expect(apiMock.sessionCliStatus).toHaveBeenCalledTimes(2));
  });
});
