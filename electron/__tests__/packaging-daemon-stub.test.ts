import { describe, it, expect, vi } from 'vitest';

import { appBundleFromResourcesApp, daemonStubPaths, installDaemonStub } from '../../packaging/daemon-stub';

const APP = '/tmp/staging/Electron.app';

describe('daemon stub packaging', () => {
  it('derives the .app bundle from the Resources/app dir the afterCopy hook is handed', () => {
    expect(appBundleFromResourcesApp('/tmp/staging/Electron.app/Contents/Resources/app')).toBe(APP);
  });

  it('copies the Electron stub beside itself as omnifexd', () => {
    expect(daemonStubPaths(APP, 'Electron')).toEqual({
      from: '/tmp/staging/Electron.app/Contents/MacOS/Electron',
      to: '/tmp/staging/Electron.app/Contents/MacOS/omnifexd',
    });
  });

  it('installs the stub with the source executable bits', () => {
    const copyFileSync = vi.fn();
    const chmodSync = vi.fn();
    const statSync = vi.fn(() => ({ mode: 0o100755 }));
    const to = installDaemonStub(APP, 'Electron', { copyFileSync, chmodSync, statSync });
    expect(to).toBe('/tmp/staging/Electron.app/Contents/MacOS/omnifexd');
    expect(copyFileSync).toHaveBeenCalledWith('/tmp/staging/Electron.app/Contents/MacOS/Electron', to);
    expect(chmodSync).toHaveBeenCalledWith(to, 0o100755);
  });
});
