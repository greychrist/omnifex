// @vitest-environment jsdom
import { render, screen, fireEvent, act, cleanup } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const api = vi.hoisted(() => ({
  sessionMcpAuthenticate: vi.fn(),
  sessionMcpReauthenticate: vi.fn(),
  sessionMcpSetEnabled: vi.fn(),
  sessionMcpReconnect: vi.fn(),
  sessionMcpSubmitCallbackUrl: vi.fn(),
  getSetting: vi.fn(),
}));
const platform = vi.hoisted(() => ({ isDesktop: true, openExternal: vi.fn(async () => {}) }));
vi.mock('@/lib/api', () => ({ api }));
vi.mock('@/lib/platform', () => ({ platform }));

import { useMcpRowActions, McpRowNotice } from '@/components/sessionContext/McpServerActionsMenu';
import type { McpServerAction } from '@/lib/mcpServerActions';

function Harness({ action, watch }: { action: McpServerAction; watch: () => Promise<boolean> }) {
  const rows = useMcpRowActions('tab1', watch, '/Users/me/.claude-work');
  return (
    <div>
      <button type="button" onClick={() => { void rows.run('atlassian', action); }}>go</button>
      <McpRowNotice
        state={rows.stateFor('atlassian')}
        onSubmitCallback={(url) => { void rows.submitCallback('atlassian', url); }}
      />
    </div>
  );
}

beforeEach(() => {
  for (const f of Object.values(api)) f.mockReset();
  platform.isDesktop = true;
  platform.openExternal.mockClear();
});
afterEach(() => { cleanup(); });

describe('Reconnect', () => {
  it('sends mcp_reconnect and waits for the server to come back', async () => {
    api.sessionMcpReconnect.mockResolvedValue(undefined);
    const watch = vi.fn(async () => true);
    render(<Harness action="reconnect" watch={watch} />);
    await act(async () => { fireEvent.click(screen.getByText('go')); });
    expect(api.sessionMcpReconnect).toHaveBeenCalledWith('tab1', 'atlassian');
    expect(watch).toHaveBeenCalled();
  });

  it("shows the CLI's refusal", async () => {
    api.sessionMcpReconnect.mockRejectedValue(new Error('Server is disabled'));
    render(<Harness action="reconnect" watch={vi.fn(async () => true)} />);
    await act(async () => { fireEvent.click(screen.getByText('go')); });
    expect(screen.getByRole('alert').textContent).toContain('Server is disabled');
  });
});

describe('sign-in from a client away from the daemon', () => {
  it("on the desktop, opens the URL in the account's browser and waits — no paste box", async () => {
    api.getSetting.mockResolvedValue('com.google.Chrome');
    api.sessionMcpAuthenticate.mockResolvedValue({ authUrl: 'https://auth', requiresUserAction: true, callbackExpected: true });
    render(<Harness action="authenticate" watch={vi.fn(async () => true)} />);
    await act(async () => { fireEvent.click(screen.getByText('go')); });
    expect(api.getSetting).toHaveBeenCalledWith('signInBrowser:/Users/me/.claude-work');
    expect(platform.openExternal).toHaveBeenCalledWith('https://auth', { browser: 'com.google.Chrome' });
    expect(screen.queryByLabelText('Redirect URL')).toBeNull();
  });

  it('elsewhere, opens the URL and asks for the address the browser ended on', async () => {
    platform.isDesktop = false;
    api.sessionMcpAuthenticate.mockResolvedValue({ authUrl: 'https://auth', requiresUserAction: true, callbackExpected: true });
    api.sessionMcpSubmitCallbackUrl.mockResolvedValue(undefined);
    const watch = vi.fn(async () => true);
    render(<Harness action="authenticate" watch={watch} />);
    await act(async () => { fireEvent.click(screen.getByText('go')); });
    expect(platform.openExternal).toHaveBeenCalledWith('https://auth', undefined);
    expect(watch).not.toHaveBeenCalled();

    const box = screen.getByLabelText('Redirect URL');
    fireEvent.change(box, { target: { value: 'http://localhost:5555/callback?code=c&state=s' } });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Finish sign-in' })); });
    expect(api.sessionMcpSubmitCallbackUrl).toHaveBeenCalledWith(
      'tab1', 'atlassian', 'http://localhost:5555/callback?code=c&state=s',
    );
    expect(watch).toHaveBeenCalled();
    expect(screen.queryByLabelText('Redirect URL')).toBeNull();
  });

  it('elsewhere, a connector that finishes on claude.ai needs no paste', async () => {
    platform.isDesktop = false;
    api.sessionMcpAuthenticate.mockResolvedValue({ authUrl: 'https://claude.ai/x', requiresUserAction: true, callbackExpected: false });
    render(<Harness action="authenticate" watch={vi.fn(async () => true)} />);
    await act(async () => { fireEvent.click(screen.getByText('go')); });
    expect(screen.queryByLabelText('Redirect URL')).toBeNull();
  });

  it('keeps the box open with the error when the CLI rejects the URL', async () => {
    platform.isDesktop = false;
    api.sessionMcpAuthenticate.mockResolvedValue({ authUrl: 'https://auth', requiresUserAction: true, callbackExpected: true });
    api.sessionMcpSubmitCallbackUrl.mockRejectedValue(new Error('Invalid callback URL: missing code'));
    render(<Harness action="authenticate" watch={vi.fn(async () => true)} />);
    await act(async () => { fireEvent.click(screen.getByText('go')); });
    fireEvent.change(screen.getByLabelText('Redirect URL'), { target: { value: 'http://localhost/x' } });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Finish sign-in' })); });
    expect(screen.getByRole('alert').textContent).toContain('Invalid callback URL');
    expect(screen.getByLabelText('Redirect URL')).toBeTruthy();
  });
});
