import type { EventEmitter } from 'node:events';
import { POWER_STATE_CHANNEL } from '../src/lib/powerState';

/**
 * Forward Electron's `powerMonitor` lock/suspend events to the renderer.
 *
 * Main only — the daemon never imports `electron`. The renderer turns this,
 * its document's visibility and the active tab into the per-watch visibility
 * the git watcher polls on; a locked screen does not reliably hide the
 * document, so it cannot be left to `visibilitychange` alone.
 */
export function forwardPowerState(
  monitor: Pick<EventEmitter, 'on'>,
  send: (channel: string, payload: { awake: boolean }) => void,
): void {
  const report = (awake: boolean) => () => { send(POWER_STATE_CHANNEL, { awake }); };
  monitor.on('lock-screen', report(false));
  monitor.on('suspend', report(false));
  monitor.on('unlock-screen', report(true));
  monitor.on('resume', report(true));
}
