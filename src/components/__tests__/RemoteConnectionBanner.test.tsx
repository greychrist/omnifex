// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { render, screen, cleanup, act } from '@testing-library/react';

import { RemoteConnectionBanner } from '../RemoteConnectionBanner';

/**
 * What the socket to the daemon is doing. The app has one transport since
 * Electron went (2026-10-23): there is no local mode to offer as a way out,
 * so the banner reports and the client keeps reconnecting. Restarting the
 * daemon is the title bar's Daemon popover's job.
 */

type Listener = (p: unknown) => void;
const listeners = new Set<Listener>();

function setRemote(info: Record<string, unknown> | undefined) {
  (window as unknown as { __omnifexRemote?: unknown }).__omnifexRemote = info;
}

beforeEach(() => {
  listeners.clear();
  sessionStorage.clear();
  vi.useFakeTimers();
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    onEvent: (_channel: string, cb: Listener) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
  };
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  setRemote(undefined);
});

/** The daemon's state changes arrive as `remote-connection` events. */
const emit = (state: string) => {
  act(() => { for (const l of listeners) l({ state }); });
};

describe('RemoteConnectionBanner', () => {
  const connected = { mode: 'desktop', url: 'ws://127.0.0.1:47700/ws', client: { state: 'connected' } };

  it('says nothing while the socket is healthy', () => {
    setRemote(connected);
    render(<RemoteConnectionBanner />);
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('shows reconnecting while the client is between sockets', () => {
    setRemote(connected);
    render(<RemoteConnectionBanner />);
    emit('reconnecting');
    expect(screen.getByRole('status')).toHaveTextContent(/reconnecting/i);
  });

  it('goes quiet again the moment the socket comes back', () => {
    setRemote(connected);
    render(<RemoteConnectionBanner />);
    emit('reconnecting');
    emit('connected');
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('says disconnected when the first connect has not happened yet and the socket drops', () => {
    setRemote({ ...connected, client: { state: 'connecting' } });
    render(<RemoteConnectionBanner />);
    emit('disconnected');
    expect(screen.getByRole('status')).toHaveTextContent(/disconnected/i);
  });

  it('renders nothing before bootstrap has installed a client', () => {
    setRemote(undefined);
    render(<RemoteConnectionBanner />);
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });
});
