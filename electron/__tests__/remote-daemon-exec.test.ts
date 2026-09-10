import { describe, it, expect } from 'vitest';

import { APP_EXECUTABLE, DAEMON_EXECUTABLE, appExecPath, daemonExecPath } from '../remote/daemon-exec';

const APP = '/Applications/OmniFex.app/Contents/MacOS/omnifex';
const DAEMON = '/Applications/OmniFex.app/Contents/MacOS/omnifexd';
const DEV = '/repo/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron';

describe('daemon executable', () => {
  it('is the app executable with a d on the end, the Unix way', () => {
    expect(APP_EXECUTABLE).toBe('omnifex');
    expect(DAEMON_EXECUTABLE).toBe('omnifexd');
  });

  describe('daemonExecPath', () => {
    it('picks the omnifexd stub beside the app executable when the bundle ships one', () => {
      expect(daemonExecPath(APP, (p) => p === DAEMON)).toBe(DAEMON);
    });

    it('falls back to the executable it was given when there is no stub (dev Electron)', () => {
      expect(daemonExecPath(DEV, () => false)).toBe(DEV);
      expect(daemonExecPath(APP, () => false)).toBe(APP);
    });
  });

  describe('appExecPath', () => {
    it('maps the daemon stub back to the app executable', () => {
      expect(appExecPath(DAEMON)).toBe(APP);
    });

    it('leaves any other executable alone', () => {
      expect(appExecPath(APP)).toBe(APP);
      expect(appExecPath(DEV)).toBe(DEV);
    });
  });
});
