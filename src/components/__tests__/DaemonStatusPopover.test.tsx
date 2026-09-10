// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, screen, fireEvent, waitFor, act } from '@testing-library/react';

// Animation wrappers render as plain DOM so assertions are synchronous.
vi.mock('framer-motion', () => ({
  motion: new Proxy(
    {},
    {
      get: (_, key) => {
        const Tag = key as string;
        // eslint-disable-next-line @typescript-eslint/no-require-imports -- vi.mock factory hoisted before module imports settle.
        const React = require('react');
        return React.forwardRef(({ children, ...rest }: any, ref: unknown) => {
          const { initial, animate, exit, transition, layout, whileTap, ...domProps } = rest;
          void initial; void animate; void exit; void transition; void layout; void whileTap;
          return React.createElement(Tag, { ...domProps, ref }, children);
        });
      },
    },
  ),
  AnimatePresence: ({ children }: any) => children,
}));

import { DaemonStatusPopover } from '@/components/DaemonStatusPopover';

const HEALTH = {
  ok: true, version: '0.4.156', protocolVersion: 1, uptimeSec: 4 * 3600 + 12 * 60, host: '100.64.0.1', port: 47700, clients: 2,
  sessions: { live: 3, known: 9, inFlight: 1 },
};

const w = window as unknown as {
  __omnifexRemote?: unknown;
  electronAPI?: unknown;
};

let listeners: Array<(p: unknown) => void>;
let fetchMock: ReturnType<typeof vi.fn>;
let invokeMock: ReturnType<typeof vi.fn>;

function remote(state: string, welcomeVersion = '0.4.156') {
  w.__omnifexRemote = {
    mode: 'electron-remote',
    url: 'ws://100.64.0.1:47700/ws',
    client: { state, welcome: { protocolVersion: 1, daemonVersion: welcomeVersion } },
  };
  w.electronAPI = {
    invoke: invokeMock,
    onEvent: (channel: string, cb: (p: unknown) => void) => {
      if (channel === 'remote-connection') listeners.push(cb);
      return () => {};
    },
  };
}

const trigger = () => document.querySelector<HTMLButtonElement>('[data-daemon-trigger]')!;
const restartButton = () => document.querySelector<HTMLButtonElement>('[data-daemon-restart]')!;

beforeEach(() => {
  listeners = [];
  invokeMock = vi.fn(async () => ({ url: 'ws://100.64.0.1:47700/ws' }));
  fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => HEALTH }));
  vi.stubGlobal('fetch', fetchMock);
  delete w.__omnifexRemote;
  delete w.electronAPI;
});
afterEach(() => {
  vi.unstubAllGlobals();
  cleanup();
});

describe('DaemonStatusPopover', () => {
  it('shows red and explains built-in IPC when there is no daemon', () => {
    render(<DaemonStatusPopover appVersion="0.4.156" />);
    expect(trigger().dataset.daemonState).toBe('none');
    fireEvent.click(trigger());
    expect(screen.getByText('Not connected')).toBeTruthy();
    expect(screen.getByText(/built-in IPC/)).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('shows green when connected and reads /healthz while open', async () => {
    remote('connected');
    render(<DaemonStatusPopover appVersion="0.4.156" />);
    expect(trigger().dataset.daemonState).toBe('connected');
    expect(fetchMock).not.toHaveBeenCalled();

    fireEvent.click(trigger());
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('http://100.64.0.1:47700/healthz', { cache: 'no-store' }));
    await waitFor(() => expect(screen.getByText('2')).toBeTruthy());
    expect(screen.getByText('Connected')).toBeTruthy();
    expect(screen.getByText('0.4.156')).toBeTruthy();
    expect(screen.getByText('100.64.0.1:47700')).toBeTruthy();
    expect(screen.getByText('3 live · 1 running')).toBeTruthy();
    expect(screen.getByText('4h 12m')).toBeTruthy();
    expect(document.querySelector('[data-daemon-version-mismatch]')).toBeNull();
  });

  it('calls out a daemon of another build', async () => {
    remote('connected');
    render(<DaemonStatusPopover appVersion="0.5.0" />);
    fireEvent.click(trigger());
    await waitFor(() => expect(screen.getByText('0.4.156 (app 0.5.0)')).toBeTruthy());
    expect(document.querySelector('[data-daemon-version-mismatch]')).toBeTruthy();
  });

  it('follows the connection state pushed by the shim', () => {
    remote('connected');
    render(<DaemonStatusPopover />);
    act(() => { for (const l of listeners) l({ state: 'reconnecting' }); });
    expect(trigger().dataset.daemonState).toBe('reconnecting');
    act(() => { for (const l of listeners) l({ state: 'disconnected' }); });
    expect(trigger().dataset.daemonState).toBe('disconnected');
    act(() => { for (const l of listeners) l({ state: 'connected' }); });
    expect(trigger().dataset.daemonState).toBe('connected');
  });

  it('surfaces a failed /healthz read without hiding the panel', async () => {
    remote('connected');
    fetchMock.mockResolvedValue({ ok: false, status: 503, json: async () => ({}) });
    render(<DaemonStatusPopover />);
    fireEvent.click(trigger());
    await waitFor(() => expect(document.querySelector('[data-daemon-error]')).toBeTruthy());
    expect(screen.getByText(/503/)).toBeTruthy();
  });

  it('refreshes on demand', async () => {
    remote('connected');
    render(<DaemonStatusPopover />);
    fireEvent.click(trigger());
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    fireEvent.click(document.querySelector<HTMLButtonElement>('[data-daemon-refresh]')!);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  });

  describe('restart', () => {
    it('restarts at once when no turn is running, then re-reads /healthz', async () => {
      remote('connected');
      fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({ ...HEALTH, sessions: { live: 3, known: 9, inFlight: 0 } }) });
      render(<DaemonStatusPopover />);
      fireEvent.click(trigger());
      await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

      fireEvent.click(restartButton());
      expect(document.querySelector('[data-daemon-restart-confirm]')).toBeNull();
      await waitFor(() => expect(invokeMock).toHaveBeenCalledWith('remote:restart', {}));
      await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
      expect(document.querySelector('[data-daemon-restart-error]')).toBeNull();
    });

    it('asks first when a turn is running, and restarts on confirm', async () => {
      remote('connected');
      render(<DaemonStatusPopover />);
      fireEvent.click(trigger());
      await waitFor(() => expect(screen.getByText('3 live · 1 running')).toBeTruthy());

      fireEvent.click(restartButton());
      expect(invokeMock).not.toHaveBeenCalled();
      const confirm = document.querySelector<HTMLButtonElement>('[data-daemon-restart-confirm]')!;
      expect(confirm).toBeTruthy();
      expect(screen.getByText(/1 running turn will be stopped/)).toBeTruthy();

      fireEvent.click(confirm);
      await waitFor(() => expect(invokeMock).toHaveBeenCalledWith('remote:restart', {}));
    });

    it('is disabled while restarting and reports a failed restart', async () => {
      remote('connected');
      fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({ ...HEALTH, sessions: { live: 0, known: 0, inFlight: 0 } }) });
      let finish!: (v: unknown) => void;
      invokeMock.mockImplementation(() => new Promise((r) => { finish = r; }));
      render(<DaemonStatusPopover />);
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
