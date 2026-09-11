// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { render, screen, cleanup, fireEvent, act, within } from '@testing-library/react';

import { LocalModeBanner, RemoteConnectionBanner } from '../RemoteConnectionBanner';

/**
 * Losing the daemon, and coming back from it.
 *
 * Before this the app had exactly one behaviour for a dead daemon: reconnect
 * with backoff, forever, behind a "Reconnecting…" banner. There was no way out
 * short of quitting, and nothing said there was a way out. The offer is
 * deliberately late — a daemon restart heals in two or three seconds, and
 * offering to hide the user's live sessions during that window would be worse
 * than saying nothing.
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

const advance = (ms: number) => { act(() => { vi.advanceTimersByTime(ms); }); };

describe('RemoteConnectionBanner', () => {
  const connected = { mode: 'electron-remote', url: 'ws://127.0.0.1:47700/ws', client: { state: 'connected' }, forcedLocal: false };

  it('says nothing while the socket is healthy', () => {
    setRemote(connected);
    render(<RemoteConnectionBanner />);
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('shows reconnecting without offering a way out yet', () => {
    setRemote(connected);
    render(<RemoteConnectionBanner />);
    emit('reconnecting');

    expect(screen.getByRole('status')).toHaveTextContent(/reconnecting/i);
    // A daemon restart lands here and heals in seconds. Offering now would ask
    // the user to abandon the view of live sessions over a blip.
    expect(screen.queryByRole('button', { name: /work locally/i })).not.toBeInTheDocument();
  });

  it('offers to work locally once the outage outlasts a restart', () => {
    setRemote(connected);
    render(<RemoteConnectionBanner />);
    emit('reconnecting');

    advance(19_000);
    expect(screen.queryByRole('button', { name: /work locally/i })).not.toBeInTheDocument();

    advance(2_000);
    expect(screen.getByRole('button', { name: /work locally/i })).toBeInTheDocument();
  });

  it('withdraws the offer the moment the socket comes back', () => {
    setRemote(connected);
    render(<RemoteConnectionBanner />);
    emit('reconnecting');
    advance(21_000);
    expect(screen.getByRole('button', { name: /work locally/i })).toBeInTheDocument();

    emit('connected');
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  /** The clock restarts with the outage, so a flap does not accumulate credit. */
  it('restarts the countdown when the socket reconnects and drops again', () => {
    setRemote(connected);
    render(<RemoteConnectionBanner />);
    emit('reconnecting');
    advance(15_000);
    emit('connected');
    emit('reconnecting');

    advance(15_000);
    expect(screen.queryByRole('button', { name: /work locally/i })).not.toBeInTheDocument();
    advance(6_000);
    expect(screen.getByRole('button', { name: /work locally/i })).toBeInTheDocument();
  });

  /**
   * Consequential and irreversible-looking, so it is confirmed. The copy has
   * to say what actually happens: the sessions keep running in the daemon,
   * this window just stops being able to see them.
   */
  it('confirms before switching, and says what happens to running sessions', () => {
    const reload = vi.fn();
    setRemote(connected);
    render(<RemoteConnectionBanner reload={reload} />);
    emit('reconnecting');
    advance(21_000);

    fireEvent.click(screen.getByRole('button', { name: /work locally/i }));

    expect(screen.getByRole('dialog')).toHaveTextContent(/keep running/i);
    // Opening the dialog changes nothing on its own.
    expect(reload).not.toHaveBeenCalled();
    expect(sessionStorage.getItem('omnifex.remote.forceLocal')).toBeNull();
  });

  it('records the daemon URL and reloads when the switch is confirmed', () => {
    const reload = vi.fn();
    setRemote(connected);
    render(<RemoteConnectionBanner reload={reload} />);
    emit('reconnecting');
    advance(21_000);
    fireEvent.click(screen.getByRole('button', { name: /work locally/i }));

    const dialog = screen.getByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: /work locally/i }));

    expect(reload).toHaveBeenCalledOnce();
    expect(sessionStorage.getItem('omnifex.remote.forceLocal')).toBe('1');
    expect(sessionStorage.getItem('omnifex.remote.lastDaemonUrl')).toBe('ws://127.0.0.1:47700/ws');
  });

  it('renders nothing at all under legacy IPC, where there is no socket', () => {
    setRemote({ mode: 'electron-legacy', url: null, client: null, forcedLocal: false });
    render(<RemoteConnectionBanner />);
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });
});

describe('LocalModeBanner', () => {
  const forced = { mode: 'electron-legacy', url: null, client: null, forcedLocal: true };

  const health = () => Promise.resolve({ ok: true, version: '1', protocolVersion: 1, uptimeSec: 3, host: 'h', port: 1, clients: 0, sessions: { live: 0, known: 0, inFlight: 0 } });

  it('renders nothing unless local mode was forced', () => {
    setRemote({ mode: 'electron-remote', url: 'ws://x/ws', client: {}, forcedLocal: false });
    render(<LocalModeBanner probe={health} />);
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('says it is working locally while the daemon is still down', async () => {
    sessionStorage.setItem('omnifex.remote.lastDaemonUrl', 'ws://127.0.0.1:47700/ws');
    setRemote(forced);
    const probe = vi.fn(() => Promise.reject(new Error('ECONNREFUSED')));
    render(<LocalModeBanner probe={probe} />);

    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(screen.getByRole('status')).toHaveTextContent(/working locally/i);
    expect(screen.queryByRole('button', { name: /reconnect/i })).not.toBeInTheDocument();
  });

  /** The switch back is offered, never taken automatically. */
  it('offers to reconnect once the daemon answers again', async () => {
    sessionStorage.setItem('omnifex.remote.lastDaemonUrl', 'ws://127.0.0.1:47700/ws');
    setRemote(forced);
    const probe = vi.fn(health);
    render(<LocalModeBanner probe={probe} />);

    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(screen.getByRole('button', { name: /reconnect/i })).toBeInTheDocument();
  });

  it('clears the override and reloads when the switch back is confirmed', async () => {
    sessionStorage.setItem('omnifex.remote.forceLocal', '1');
    sessionStorage.setItem('omnifex.remote.lastDaemonUrl', 'ws://127.0.0.1:47700/ws');
    setRemote(forced);
    const reload = vi.fn();
    render(<LocalModeBanner probe={health} reload={reload} />);

    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    fireEvent.click(screen.getByRole('button', { name: /reconnect/i }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: /reconnect/i }));

    expect(reload).toHaveBeenCalledOnce();
    expect(sessionStorage.getItem('omnifex.remote.forceLocal')).toBeNull();
  });

  /**
   * No URL was ever stashed — there is nothing to probe, so the banner states
   * the mode and offers nothing rather than polling a guess.
   */
  it('does not probe when it has no address to probe', async () => {
    setRemote(forced);
    const probe = vi.fn(health);
    render(<LocalModeBanner probe={probe} />);

    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    expect(probe).not.toHaveBeenCalled();
    expect(screen.getByRole('status')).toHaveTextContent(/working locally/i);
  });
});
