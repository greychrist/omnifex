// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, screen, fireEvent, waitFor, act } from '@testing-library/react';

import { DaemonStatusItem } from '@/components/DaemonStatusItem';
import type { LinkState } from '@/components/ChatStatusBar';

const HEALTH = {
  ok: true, version: '0.4.156', protocolVersion: 1, uptimeSec: 4 * 3600 + 12 * 60, host: '100.64.0.1', port: 47700, clients: 2,
  sessions: { live: 3, known: 9, inFlight: 1 },
};

const w = window as unknown as {
  __omnifexRemote?: unknown;
  electronAPI?: unknown;
};

let fetchMock: ReturnType<typeof vi.fn>;
let invokeMock: ReturnType<typeof vi.fn>;
let appVersion: string;

function remote(welcomeVersion = '0.4.156', mode = 'desktop') {
  w.__omnifexRemote = {
    mode,
    url: 'ws://100.64.0.1:47700/ws',
    client: { state: 'connected', welcome: { protocolVersion: 1, daemonVersion: welcomeVersion } },
  };
  w.electronAPI = { invoke: invokeMock, onEvent: () => () => {} };
}

const LIVE: LinkState = { connection: 'connected', delivering: true };

const trigger = () => screen.getByRole('button', { name: /daemon/i });
const restartButton = () => document.querySelector<HTMLButtonElement>('[data-daemon-restart]')!;

beforeEach(() => {
  appVersion = '0.4.156';
  invokeMock = vi.fn(async (channel: string) => {
    if (channel === 'get_app_version') return appVersion;
    return { url: 'ws://100.64.0.1:47700/ws' };
  });
  fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => HEALTH }));
  vi.stubGlobal('fetch', fetchMock);
  delete w.__omnifexRemote;
  delete w.electronAPI;
});
afterEach(() => {
  vi.unstubAllGlobals();
  cleanup();
});

describe('DaemonStatusItem', () => {
  it('renders nothing when the page has no daemon', () => {
    const { container } = render(<DaemonStatusItem link={{ connection: null, delivering: false }} />);
    expect(container.innerHTML).toBe('');
  });

  // The bar's readout is the trigger: `daemon live` opens the detail.
  it('opens the daemon detail from the readout and reads /healthz while open', async () => {
    remote();
    render(<DaemonStatusItem link={LIVE} />);
    expect(screen.getByText('live')).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();

    fireEvent.click(trigger());
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('http://100.64.0.1:47700/healthz', { cache: 'no-store' }));
    await waitFor(() => expect(screen.getByText('2')).toBeTruthy());
    expect(screen.getByText('0.4.156')).toBeTruthy();
    expect(screen.getByText('100.64.0.1:47700')).toBeTruthy();
    expect(screen.getByText('3 live · 1 running')).toBeTruthy();
    expect(screen.getByText('4h 12m')).toBeTruthy();
    expect(document.querySelector('[data-daemon-version-mismatch]')).toBeNull();
  });

  // The popover lives on a session now, so it answers for this session too —
  // the fact the global titlebar button could never show.
  it('says whether this session is receiving events', async () => {
    remote();
    const { unmount } = render(<DaemonStatusItem link={LIVE} />);
    fireEvent.click(trigger());
    expect(document.querySelector('[data-daemon-session]')?.textContent).toMatch(/Receiving/);
    unmount();

    render(<DaemonStatusItem link={{ connection: 'connected', delivering: false }} />);
    fireEvent.click(trigger());
    expect(document.querySelector('[data-daemon-session]')?.textContent).toMatch(/Not receiving/);
    expect(screen.getByText(/Reloading the window re-subscribes/)).toBeTruthy();
  });

  it('names the connection state in the header', () => {
    remote();
    render(<DaemonStatusItem link={{ connection: 'reconnecting', delivering: false }} />);
    fireEvent.click(trigger());
    expect(document.querySelector('[data-daemon-status]')?.textContent).toBe('Reconnecting…');
  });

  it('calls out a daemon of another build', async () => {
    remote();
    appVersion = '0.5.0';
    render(<DaemonStatusItem link={LIVE} />);
    fireEvent.click(trigger());
    await waitFor(() => expect(screen.getByText('0.4.156 (app 0.5.0)')).toBeTruthy());
    expect(document.querySelector('[data-daemon-version-mismatch]')?.textContent).toMatch(/replaced automatically/);
  });

  // On the web the daemon is what served this page, so nothing swaps it on
  // the tablet's behalf — a mismatch means the page itself is stale.
  it('tells a stale web page to reload instead', async () => {
    remote('0.4.156', 'web');
    appVersion = '0.4.155';
    render(<DaemonStatusItem link={LIVE} />);
    fireEvent.click(trigger());
    await waitFor(() => expect(screen.getByText('0.4.156 (page 0.4.155)')).toBeTruthy());
    const note = document.querySelector('[data-daemon-version-mismatch]');
    expect(note?.textContent).toMatch(/Reload/);
    expect(note?.textContent).not.toMatch(/replaced automatically/);
  });

  it('surfaces a failed /healthz read without hiding the panel', async () => {
    remote();
    fetchMock.mockResolvedValue({ ok: false, status: 503, json: async () => ({}) });
    render(<DaemonStatusItem link={LIVE} />);
    fireEvent.click(trigger());
    await waitFor(() => expect(document.querySelector('[data-daemon-error]')).toBeTruthy());
    expect(screen.getByText(/503/)).toBeTruthy();
  });

  it('refreshes on demand', async () => {
    remote();
    render(<DaemonStatusItem link={LIVE} />);
    fireEvent.click(trigger());
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    fireEvent.click(document.querySelector<HTMLButtonElement>('[data-daemon-refresh]')!);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  });

  describe('restart', () => {
    it('restarts at once when no turn is running, then re-reads /healthz', async () => {
      remote();
      fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({ ...HEALTH, sessions: { live: 3, known: 9, inFlight: 0 } }) });
      render(<DaemonStatusItem link={LIVE} />);
      fireEvent.click(trigger());
      await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

      fireEvent.click(restartButton());
      expect(document.querySelector('[data-daemon-restart-confirm]')).toBeNull();
      await waitFor(() => expect(invokeMock).toHaveBeenCalledWith('remote:restart', {}));
      await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
      expect(document.querySelector('[data-daemon-restart-error]')).toBeNull();
    });

    it('asks first when a turn is running, and restarts on confirm', async () => {
      remote();
      render(<DaemonStatusItem link={LIVE} />);
      fireEvent.click(trigger());
      await waitFor(() => expect(screen.getByText('3 live · 1 running')).toBeTruthy());

      fireEvent.click(restartButton());
      expect(invokeMock).not.toHaveBeenCalledWith('remote:restart', {});
      const confirm = document.querySelector<HTMLButtonElement>('[data-daemon-restart-confirm]')!;
      expect(confirm).toBeTruthy();
      expect(screen.getByText(/1 running turn will be stopped/)).toBeTruthy();

      fireEvent.click(confirm);
      await waitFor(() => expect(invokeMock).toHaveBeenCalledWith('remote:restart', {}));
    });

    it('is disabled while restarting and reports a failed restart', async () => {
      remote();
      fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({ ...HEALTH, sessions: { live: 0, known: 0, inFlight: 0 } }) });
      let finish!: (v: unknown) => void;
      invokeMock.mockImplementation((channel: string) =>
        channel === 'get_app_version' ? Promise.resolve(appVersion) : new Promise((r) => { finish = r; }));
      render(<DaemonStatusItem link={LIVE} />);
      fireEvent.click(trigger());
      await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

      fireEvent.click(restartButton());
      await waitFor(() => expect(restartButton().disabled).toBe(true));
      expect(screen.getByText('Restarting…')).toBeTruthy();

      act(() => { finish({ url: null }); });
      await waitFor(() => expect(document.querySelector('[data-daemon-restart-error]')).toBeTruthy());
      expect(restartButton().disabled).toBe(false);
    });
  });
});
