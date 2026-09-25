import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { forwardPowerState } from '../power-state';
import { POWER_STATE_CHANNEL } from '../../src/lib/powerState';

// Nobody is looking at a locked or sleeping Mac. The renderer cannot always
// tell (a locked screen does not reliably hide the document), so main
// forwards powerMonitor's view and the renderer pauses git polling on it.
describe('forwardPowerState', () => {
  it('reports asleep on lock and suspend, awake on unlock and resume', () => {
    const monitor = new EventEmitter();
    const send = vi.fn();
    forwardPowerState(monitor, send);
    monitor.emit('lock-screen');
    monitor.emit('unlock-screen');
    monitor.emit('suspend');
    monitor.emit('resume');
    expect(send.mock.calls).toEqual([
      [POWER_STATE_CHANNEL, { awake: false }],
      [POWER_STATE_CHANNEL, { awake: true }],
      [POWER_STATE_CHANNEL, { awake: false }],
      [POWER_STATE_CHANNEL, { awake: true }],
    ]);
  });
});
