import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import { createInstallerService, type InstallerDeps } from '../services/installer';

function makeDeps(overrides: Partial<InstallerDeps> = {}): InstallerDeps {
  return {
    sessionsService: {
      listActiveTabIds: () => [],
      stopAll: () => {},
    },
    agentRunRegistry: {
      listActiveRunIds: () => [],
      killAll: () => {},
    },
    appQuit: vi.fn(),
    spawn: vi.fn(),
    sendToRenderer: vi.fn(),
    execPath: '/Applications/GreyChrist.app/Contents/MacOS/GreyChrist',
    ...overrides,
  };
}

describe('InstallerService.stage', () => {
  let stageDir: string;

  beforeEach(async () => {
    stageDir = await fs.mkdtemp(path.join(os.tmpdir(), 'installer-test-'));
  });

  afterEach(async () => {
    await fs.rm(stageDir, { recursive: true, force: true });
  });

  it('throws UpdateFileNotFound when the ZIP is missing', async () => {
    const installer = createInstallerService(makeDeps());
    await expect(
      installer.stage(path.join(stageDir, 'does-not-exist.zip'), '0.4.0'),
    ).rejects.toThrow(/UpdateFileNotFound/);
  });

  it('throws InvalidUpdatePackage when the ZIP does not contain GreyChrist.app', async () => {
    const zipPath = path.join(stageDir, 'fake.zip');
    await fs.writeFile(zipPath, 'not a real zip');
    const installer = createInstallerService(makeDeps({
      extractZip: async (_zip, dest) => {
        // Simulate extraction producing no .app
        await fs.writeFile(path.join(dest, 'README.txt'), 'oops');
      },
    }));
    await expect(installer.stage(zipPath, '0.4.0')).rejects.toThrow(/InvalidUpdatePackage/);
  });

  it('throws VersionMismatch when bundle version disagrees with expected', async () => {
    const zipPath = path.join(stageDir, 'pkg.zip');
    await fs.writeFile(zipPath, 'placeholder');
    const installer = createInstallerService(makeDeps({
      extractZip: async (_zip, dest) => {
        const appDir = path.join(dest, 'GreyChrist.app', 'Contents', 'MacOS');
        await fs.mkdir(appDir, { recursive: true });
        await fs.writeFile(path.join(appDir, 'GreyChrist'), 'binary');
      },
      readBundleVersion: async () => '0.3.99',
    }));
    await expect(installer.stage(zipPath, '0.4.0')).rejects.toThrow(/VersionMismatch/);
  });

  it('returns stagedAppPath when ZIP is valid and version matches', async () => {
    const zipPath = path.join(stageDir, 'good.zip');
    await fs.writeFile(zipPath, 'placeholder');
    const installer = createInstallerService(makeDeps({
      extractZip: async (_zip, dest) => {
        const appDir = path.join(dest, 'GreyChrist.app', 'Contents', 'MacOS');
        await fs.mkdir(appDir, { recursive: true });
        await fs.writeFile(path.join(appDir, 'GreyChrist'), 'binary');
      },
      readBundleVersion: async () => '0.4.0',
    }));
    const { stagedAppPath } = await installer.stage(zipPath, '0.4.0');
    expect(stagedAppPath).toMatch(/GreyChrist\.app$/);
    await fs.access(stagedAppPath); // exists
  });
});

describe('InstallerService.resolveTargetApp', () => {
  it('returns the .app bundle ancestor of execPath', () => {
    const installer = createInstallerService(makeDeps({
      execPath: '/Applications/GreyChrist.app/Contents/MacOS/GreyChrist',
    }));
    expect(installer.resolveTargetApp()).toEqual({
      targetAppPath: '/Applications/GreyChrist.app',
    });
  });

  it('returns .app when execPath is under Electron.app (dev build case)', () => {
    const installer = createInstallerService(makeDeps({
      execPath: '/Users/dev/repo/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron',
    }));
    expect(installer.resolveTargetApp()).toEqual({
      targetAppPath: '/Users/dev/repo/node_modules/electron/dist/Electron.app',
    });
  });

  it('throws NotPackaged for execPath without any .app ancestor', () => {
    const installer = createInstallerService(makeDeps({
      execPath: '/usr/local/bin/some-binary',
    }));
    expect(() => installer.resolveTargetApp()).toThrow(/NotPackaged/);
  });
});

describe('InstallerService.ensureTargetWritable', () => {
  it('throws TargetNotWritable when parent dir is read-only', async () => {
    const installer = createInstallerService(makeDeps({
      isWritable: async () => false,
    })) as ReturnType<typeof createInstallerService> & {
      ensureTargetWritable(p: string): Promise<void>;
    };
    await expect(installer.ensureTargetWritable('/Applications/GreyChrist.app'))
      .rejects.toThrow(/TargetNotWritable/);
  });

  it('resolves silently when parent dir is writable', async () => {
    const installer = createInstallerService(makeDeps({
      isWritable: async () => true,
    })) as ReturnType<typeof createInstallerService> & {
      ensureTargetWritable(p: string): Promise<void>;
    };
    await expect(installer.ensureTargetWritable('/Applications/GreyChrist.app')).resolves.toBeUndefined();
  });
});

describe('InstallerService.waitForIdle', () => {
  it('emits installing immediately when nothing is in flight', async () => {
    const sendToRenderer = vi.fn();
    const installer = createInstallerService(makeDeps({ sendToRenderer }));
    await installer.waitForIdle({ force: false });
    expect(sendToRenderer).toHaveBeenCalledWith('updater:install-status', { phase: 'installing' });
  });

  it('emits waiting until counts reach zero, then installing', async () => {
    let activeSessions = 2;
    const sendToRenderer = vi.fn();
    const installer = createInstallerService(makeDeps({
      sendToRenderer,
      sessionsService: {
        listActiveTabIds: () => activeSessions > 0 ? new Array(activeSessions).fill('t').map((_, i) => `t-${i}`) : [],
        stopAll: () => {},
      },
    }));
    // Start the wait, then drain sessions over time
    const p = installer.waitForIdle({ force: false });
    setTimeout(() => { activeSessions = 1; }, 1100);
    setTimeout(() => { activeSessions = 0; }, 2100);
    await p;
    const phases = sendToRenderer.mock.calls.map((c) => c[1].phase);
    expect(phases).toContain('waiting');
    expect(phases[phases.length - 1]).toBe('installing');
  });

  it('with force=true calls stopAll and killAll once, then resolves', async () => {
    const stopAll = vi.fn();
    const killAll = vi.fn();
    let activeSessions = 1;
    const installer = createInstallerService(makeDeps({
      sessionsService: {
        listActiveTabIds: () => activeSessions > 0 ? ['t'] : [],
        stopAll: () => { stopAll(); activeSessions = 0; },
      },
      agentRunRegistry: {
        listActiveRunIds: () => [],
        killAll: () => { killAll(); },
      },
    }));
    await installer.waitForIdle({ force: true });
    expect(stopAll).toHaveBeenCalledTimes(1);
    expect(killAll).toHaveBeenCalledTimes(1);
  });

  it('cancelWait rejects the in-flight wait with WaitCancelled', async () => {
    const installer = createInstallerService(makeDeps({
      sessionsService: {
        listActiveTabIds: () => ['t'],
        stopAll: () => {},
      },
    }));
    const p = installer.waitForIdle({ force: false });
    setTimeout(() => installer.cancelWait(), 100);
    await expect(p).rejects.toThrow(/WaitCancelled/);
  });
});
