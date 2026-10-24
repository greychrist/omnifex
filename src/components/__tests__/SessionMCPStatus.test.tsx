// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import React from 'react';
import { render, cleanup, screen, fireEvent, waitFor } from '@testing-library/react';
import type { SessionMcpServerStatus } from '@/lib/api';

const { sessionMcpAuthenticate, sessionMcpReauthenticate, sessionMcpSetEnabled, mockPlatform } = vi.hoisted(() => ({
  sessionMcpAuthenticate: vi.fn(),
  sessionMcpReauthenticate: vi.fn(),
  sessionMcpSetEnabled: vi.fn(),
  mockPlatform: { isDesktop: true, openExternal: vi.fn() },
}));
vi.mock('@/lib/api', () => ({
  api: { sessionMcpAuthenticate, sessionMcpReauthenticate, sessionMcpSetEnabled },
}));
vi.mock('@/lib/platform', () => ({ platform: mockPlatform }));

import { SessionMCPStatus } from '@/components/SessionMCPStatus';

type WatchUntil = React.ComponentProps<typeof SessionMCPStatus>['watchUntil'];
const neverWatch: WatchUntil = () => new Promise<boolean>(() => {});

const renderStatus = (list: SessionMcpServerStatus[] | null, watchUntil: WatchUntil = neverWatch) =>
  render(<SessionMCPStatus servers={list} tabId="tab1" watchUntil={watchUntil} />);

const server = (name: string, extra: Partial<SessionMcpServerStatus> = {}): SessionMcpServerStatus =>
  ({ name, status: 'connected', scope: 'user', ...extra }) as SessionMcpServerStatus;

const servers = [
  server('brain', { tools: [{ name: 'brain_search' }] } as Partial<SessionMcpServerStatus>),
  server('github', { status: 'failed', error: 'bad auth' }),
];

afterEach(() => { cleanup(); });

describe('SessionMCPStatus', () => {
  it('shows loading while the list is unknown, not "none"', () => {
    renderStatus(null);
    expect(screen.queryByText(/no MCP servers/i)).toBeNull();
  });

  it('says when no servers are active', () => {
    renderStatus([]);
    expect(screen.getByText(/no MCP servers active/i)).toBeTruthy();
  });

  it('lists servers under their scope with a count', () => {
    renderStatus(servers);
    expect(screen.getByRole('button', { name: /^User\s*2$/ })).toBeTruthy();
    expect(screen.getByText('brain')).toBeTruthy();
  });

  it('says what state each server is in', () => {
    renderStatus(servers);
    expect(screen.getByLabelText('failed')).toBeTruthy();
    expect(screen.getByLabelText('connected')).toBeTruthy();
  });

  it('opens a server to show its tools and its error', () => {
    renderStatus(servers);
    // By its label text: the row's ⋯ trigger ("Actions for brain") is a button too.
    fireEvent.click(screen.getByText('brain').closest('button') as HTMLElement);
    expect(screen.getByText('brain_search')).toBeTruthy();
    fireEvent.click(screen.getByText('github').closest('button') as HTMLElement);
    expect(screen.getByText('bad auth')).toBeTruthy();
  });

  it('collapses a scope group', () => {
    renderStatus(servers);
    fireEvent.click(screen.getByRole('button', { name: /^User\s*2$/ }));
    expect(screen.queryByText('brain')).toBeNull();
  });
});

const atlassian = server('atlassian', { status: 'needs-auth', config: { type: 'http', url: 'https://mcp.example' } });

const openMenu = (name: string) => {
  fireEvent.pointerDown(screen.getByRole('button', { name: `Actions for ${name}` }), { button: 0, ctrlKey: false });
};

describe('SessionMCPStatus row actions', () => {
  beforeEach(() => {
    sessionMcpAuthenticate.mockReset();
    sessionMcpReauthenticate.mockReset();
    sessionMcpSetEnabled.mockReset().mockResolvedValue(undefined);
    mockPlatform.isDesktop = true;
    mockPlatform.openExternal.mockReset().mockResolvedValue(undefined);
  });

  it('shows a ⋯ menu with the gated actions', () => {
    renderStatus([atlassian]);
    openMenu('atlassian');
    expect(screen.getByRole('menuitem', { name: 'Authenticate' })).toBeTruthy();
    expect(screen.getByRole('menuitem', { name: 'Disable' })).toBeTruthy();
    expect(screen.queryByRole('menuitem', { name: 'Enable' })).toBeNull();
  });

  it('Authenticate opens the auth URL and watches the server', async () => {
    sessionMcpAuthenticate.mockResolvedValue({ authUrl: 'https://x', requiresUserAction: true, callbackExpected: true });
    const watchUntil = vi.fn<WatchUntil>().mockResolvedValue(true);
    renderStatus([atlassian], watchUntil);
    openMenu('atlassian');
    fireEvent.click(screen.getByRole('menuitem', { name: 'Authenticate' }));
    await waitFor(() => { expect(watchUntil).toHaveBeenCalled(); });
    expect(sessionMcpAuthenticate).toHaveBeenCalledWith('tab1', 'atlassian');
    expect(mockPlatform.openExternal).toHaveBeenCalledWith('https://x', undefined);
    expect(watchUntil.mock.calls[0][0]).toBe('atlassian');
    const done = watchUntil.mock.calls[0][1];
    expect(done(server('atlassian', { status: 'connected' }))).toBe(true);
    expect(done(server('atlassian', { status: 'needs-auth' }))).toBe(false);
  });

  it('skips the browser when the CLI needs no user action', async () => {
    sessionMcpAuthenticate.mockResolvedValue({ authUrl: null, requiresUserAction: false, callbackExpected: false });
    const watchUntil = vi.fn<WatchUntil>().mockResolvedValue(true);
    renderStatus([atlassian], watchUntil);
    openMenu('atlassian');
    fireEvent.click(screen.getByRole('menuitem', { name: 'Authenticate' }));
    await waitFor(() => { expect(watchUntil).toHaveBeenCalled(); });
    expect(mockPlatform.openExternal).not.toHaveBeenCalled();
  });

  it('Re-authenticate calls the reauthenticate request', async () => {
    sessionMcpReauthenticate.mockResolvedValue({ authUrl: 'https://y', requiresUserAction: true, callbackExpected: true });
    const watchUntil = vi.fn<WatchUntil>().mockResolvedValue(true);
    renderStatus([server('ctx', { status: 'connected', config: { type: 'http' } })], watchUntil);
    openMenu('ctx');
    fireEvent.click(screen.getByRole('menuitem', { name: 'Re-authenticate' }));
    await waitFor(() => { expect(watchUntil).toHaveBeenCalled(); });
    expect(sessionMcpReauthenticate).toHaveBeenCalledWith('tab1', 'ctx');
    expect(mockPlatform.openExternal).toHaveBeenCalledWith('https://y', undefined);
  });

  it("shows the CLI's error under the row when an action fails", async () => {
    sessionMcpAuthenticate.mockRejectedValue(new Error('Server not found: x'));
    renderStatus([atlassian]);
    openMenu('atlassian');
    fireEvent.click(screen.getByRole('menuitem', { name: 'Authenticate' }));
    expect(await screen.findByText('Server not found: x')).toBeTruthy();
  });

  it('Disable calls set_enabled(false) and refreshes', async () => {
    const watchUntil = vi.fn<WatchUntil>().mockResolvedValue(true);
    renderStatus([atlassian], watchUntil);
    openMenu('atlassian');
    fireEvent.click(screen.getByRole('menuitem', { name: 'Disable' }));
    await waitFor(() => { expect(watchUntil).toHaveBeenCalled(); });
    expect(sessionMcpSetEnabled).toHaveBeenCalledWith('tab1', 'atlassian', false);
    const [name, done] = watchUntil.mock.calls[0];
    expect(name).toBe('atlassian');
    expect(done(server('atlassian', { status: 'disabled' }))).toBe(true);
    expect(done(server('atlassian', { status: 'needs-auth' }))).toBe(false);
  });

  it('Enable calls set_enabled(true) and waits for it to leave disabled', async () => {
    const watchUntil = vi.fn<WatchUntil>().mockResolvedValue(true);
    renderStatus([server('gh', { status: 'disabled' })], watchUntil);
    openMenu('gh');
    fireEvent.click(screen.getByRole('menuitem', { name: 'Enable' }));
    await waitFor(() => { expect(watchUntil).toHaveBeenCalled(); });
    expect(sessionMcpSetEnabled).toHaveBeenCalledWith('tab1', 'gh', true);
    const done = watchUntil.mock.calls[0][1];
    expect(done(server('gh', { status: 'pending' }))).toBe(true);
    expect(done(server('gh', { status: 'disabled' }))).toBe(false);
  });

  it('shows a still-waiting hint when the watch times out', async () => {
    sessionMcpAuthenticate.mockResolvedValue({ authUrl: 'https://x', requiresUserAction: true, callbackExpected: false });
    renderStatus([atlassian], vi.fn<WatchUntil>().mockResolvedValue(false));
    openMenu('atlassian');
    fireEvent.click(screen.getByRole('menuitem', { name: 'Authenticate' }));
    expect(await screen.findByText('Still waiting — reopen the panel after signing in')).toBeTruthy();
    // The row returns to its normal state: the menu works again.
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Actions for atlassian' }).disabled).toBe(false);
  });

  it('disables the ⋯ trigger while an action is in flight', async () => {
    sessionMcpAuthenticate.mockReturnValue(new Promise(() => {}));
    renderStatus([atlassian]);
    openMenu('atlassian');
    fireEvent.click(screen.getByRole('menuitem', { name: 'Authenticate' }));
    await waitFor(() => {
      expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Actions for atlassian' }).disabled).toBe(true);
    });
    openMenu('atlassian');
    expect(screen.queryByRole('menuitem')).toBeNull();
    expect(sessionMcpAuthenticate).toHaveBeenCalledTimes(1);
  });

  // The web client finishes sign-in by pasting the redirect URL
  // (mcp_oauth_callback_url), so it gets the same items as the desktop.
  it('offers auth items in the web client too', () => {
    mockPlatform.isDesktop = false;
    renderStatus([atlassian]);
    openMenu('atlassian');
    expect(screen.getByRole('menuitem', { name: 'Authenticate' })).toBeTruthy();
    expect(screen.getByRole('menuitem', { name: 'Disable' })).toBeTruthy();
  });

  it('does not nest the ⋯ trigger inside the expand button', () => {
    renderStatus([atlassian]);
    const trigger = screen.getByRole('button', { name: 'Actions for atlassian' });
    expect(trigger.parentElement?.closest('button')).toBeNull();
  });

  // Drives the action's predicate through a status sequence, like the real
  // watch: true at the first tick it holds, false (timeout) if it never does.
  const feeding = (statuses: SessionMcpServerStatus['status'][]) => {
    const seen: boolean[] = [];
    const watchUntil = vi.fn<WatchUntil>((name, done) => {
      for (const status of statuses) {
        const ok = done(server(name, { status }));
        seen.push(ok);
        if (ok) return Promise.resolve(true);
      }
      return Promise.resolve(false);
    });
    return { watchUntil, seen };
  };

  it('Re-authenticate waits for the server to leave connected and come back', async () => {
    sessionMcpReauthenticate.mockResolvedValue({ authUrl: 'https://y', requiresUserAction: true, callbackExpected: true });
    const { watchUntil, seen } = feeding(['connected', 'connected', 'needs-auth', 'connected']);
    renderStatus([server('ctx', { status: 'connected', config: { type: 'http' } })], watchUntil);
    openMenu('ctx');
    fireEvent.click(screen.getByRole('menuitem', { name: 'Re-authenticate' }));
    await waitFor(() => { expect(seen).toEqual([false, false, false, true]); });
    expect(screen.queryByText(/Still waiting/)).toBeNull();
  });

  it('Re-authenticate that never leaves connected ends in the timeout hint', async () => {
    sessionMcpReauthenticate.mockResolvedValue({ authUrl: 'https://y', requiresUserAction: true, callbackExpected: true });
    const { watchUntil, seen } = feeding(['connected', 'connected', 'connected']);
    renderStatus([server('ctx', { status: 'connected', config: { type: 'http' } })], watchUntil);
    openMenu('ctx');
    fireEvent.click(screen.getByRole('menuitem', { name: 'Re-authenticate' }));
    expect(await screen.findByText('Still waiting — reopen the panel after signing in')).toBeTruthy();
    expect(seen).toEqual([false, false, false]);
  });

  it('Enable does not count a missing server as enabled', async () => {
    const watchUntil = vi.fn<WatchUntil>().mockResolvedValue(true);
    renderStatus([server('gh', { status: 'disabled' })], watchUntil);
    openMenu('gh');
    fireEvent.click(screen.getByRole('menuitem', { name: 'Enable' }));
    await waitFor(() => { expect(watchUntil).toHaveBeenCalled(); });
    expect(watchUntil.mock.calls[0][1](undefined)).toBe(false);
  });

  it('lets a long server name shrink instead of pushing the ⋯ trigger out', () => {
    renderStatus([atlassian]);
    const expand = screen.getByText('atlassian').closest('button') as HTMLElement;
    expect(expand.className).toMatch(/\bmin-w-0\b/);
  });
});
