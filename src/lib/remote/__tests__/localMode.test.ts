// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';

import {
  clearLocalMode,
  forceLocalMode,
  forcedDaemonUrl,
  localModeForced,
} from '@/lib/remote/localMode';

/**
 * "Work locally" — the escape hatch from a daemon that is not coming back.
 *
 * Kept in `sessionStorage` rather than `localStorage` on purpose, and that is
 * the whole of the one-shot semantics: a reload keeps the choice, closing the
 * app forgets it. A single bad night must not leave the app quietly off the
 * daemon forever, with nothing on screen saying why.
 */
describe('local mode override', () => {
  beforeEach(() => {
    sessionStorage.clear();
    localStorage.clear();
  });

  it('is off until something asks for it', () => {
    expect(localModeForced()).toBe(false);
    expect(forcedDaemonUrl()).toBeNull();
  });

  it('survives a reload and remembers where the daemon was', () => {
    const reload = vi.fn();
    forceLocalMode('ws://127.0.0.1:47700/ws', reload);

    expect(reload).toHaveBeenCalledOnce();
    expect(localModeForced()).toBe(true);
    expect(forcedDaemonUrl()).toBe('ws://127.0.0.1:47700/ws');
  });

  /**
   * The switch-back probe needs an address, and it cannot ask `remote:url` for
   * one: that handler STARTS a daemon when none is running, which would
   * resurrect the process the user just walked away from. The URL is stashed
   * at switch time instead.
   */
  it('keeps the URL out of localStorage so it cannot outlive the session', () => {
    forceLocalMode('ws://127.0.0.1:47700/ws', vi.fn());
    expect(localStorage.getItem('omnifex.remote.forceLocal')).toBeNull();
    expect(sessionStorage.getItem('omnifex.remote.forceLocal')).toBe('1');
  });

  it('forgets the override and reloads on the way back', () => {
    const reload = vi.fn();
    forceLocalMode('ws://127.0.0.1:47700/ws', vi.fn());
    clearLocalMode(reload);

    expect(reload).toHaveBeenCalledOnce();
    expect(localModeForced()).toBe(false);
    expect(forcedDaemonUrl()).toBeNull();
  });

  /** No daemon URL was ever known — the flag still has to work. */
  it('can be forced with no URL to go back to', () => {
    forceLocalMode(null, vi.fn());
    expect(localModeForced()).toBe(true);
    expect(forcedDaemonUrl()).toBeNull();
  });

  /**
   * Storage throws in more places than people expect — a locked-down web view,
   * a full quota. The app must still boot; it just cannot remember.
   */
  it('degrades to "not forced" when storage is unavailable', () => {
    const spy = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('denied');
    });
    expect(localModeForced()).toBe(false);
    spy.mockRestore();
  });

  it('does not reload when storage refuses the write', () => {
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota');
    });
    const reload = vi.fn();
    forceLocalMode('ws://x/ws', reload);

    // Reloading into a mode the flag could not record would just reconnect to
    // the daemon again, and the button would look broken rather than blocked.
    expect(reload).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});
