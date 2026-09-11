/**
 * "Work locally" — running the app against main's own services while the
 * daemon is unreachable.
 *
 * There is no way to swap transports in place. `bootstrap.ts` assigns
 * `window.electronAPI` once, before React mounts, and every module that
 * imported `api.ts` is holding whatever it got. Switching modes is therefore a
 * flag plus a reload, and this module is the flag.
 *
 * `sessionStorage`, deliberately. A reload keeps the choice — that is what
 * makes the switch work at all — and closing the app forgets it, so one bad
 * night cannot leave the app quietly off the daemon forever with nothing on
 * screen saying why. `localStorage` would have made it permanent.
 */

const FORCED_KEY = 'omnifex.remote.forceLocal';
const URL_KEY = 'omnifex.remote.lastDaemonUrl';

/** Every read is guarded: a locked-down web view throws on the property itself. */
function read(key: string): string | null {
  try {
    return sessionStorage.getItem(key);
  } catch {
    return null;
  }
}

/** True when this page load must skip the daemon. */
export function localModeForced(): boolean {
  return read(FORCED_KEY) === '1';
}

/**
 * Where the daemon was when we walked away, so the switch-back watcher has
 * something to probe.
 *
 * It cannot ask `remote:url` for one: that handler STARTS a daemon when none
 * is running, which would resurrect the process the user just stepped away
 * from, every few seconds, forever.
 */
export function forcedDaemonUrl(): string | null {
  return read(URL_KEY);
}

/**
 * Switch to local mode: record the choice, then reload into it.
 *
 * The reload only happens if the flag was actually written. Reloading without
 * it would reconnect straight back to the daemon, and the button would look
 * broken rather than blocked.
 */
export function forceLocalMode(daemonUrl: string | null, reload: () => void): void {
  try {
    sessionStorage.setItem(FORCED_KEY, '1');
    if (daemonUrl) sessionStorage.setItem(URL_KEY, daemonUrl);
    else sessionStorage.removeItem(URL_KEY);
  } catch {
    return;
  }
  reload();
}

/** Switch back: drop the override and reload into whatever bootstrap decides. */
export function clearLocalMode(reload: () => void): void {
  try {
    sessionStorage.removeItem(FORCED_KEY);
    sessionStorage.removeItem(URL_KEY);
  } catch {
    return;
  }
  reload();
}
