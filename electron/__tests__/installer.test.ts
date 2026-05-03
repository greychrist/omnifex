import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import { createInstallerService, type InstallerDeps } from '../services/installer';

function makeDeps(overrides: Partial<InstallerDeps> = {}): InstallerDeps {
  return {
    sessionsService: {
      listInFlightTabIds: () => [],
      stopAll: () => {},
    },
    appQuit: vi.fn(),
    spawn: vi.fn(),
    sendToRenderer: vi.fn(),
    execPath: '/Applications/OmniFex.app/Contents/MacOS/OmniFex',
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

  it('throws InvalidUpdatePackage when the ZIP does not contain OmniFex.app', async () => {
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
        const appDir = path.join(dest, 'OmniFex.app', 'Contents', 'MacOS');
        await fs.mkdir(appDir, { recursive: true });
        await fs.writeFile(path.join(appDir, 'OmniFex'), 'binary');
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
        const appDir = path.join(dest, 'OmniFex.app', 'Contents', 'MacOS');
        await fs.mkdir(appDir, { recursive: true });
        await fs.writeFile(path.join(appDir, 'OmniFex'), 'binary');
      },
      readBundleVersion: async () => '0.4.0',
    }));
    const { stagedAppPath } = await installer.stage(zipPath, '0.4.0');
    expect(stagedAppPath).toMatch(/OmniFex\.app$/);
    await fs.access(stagedAppPath); // exists
  });
});

describe('InstallerService.resolveTargetApp', () => {
  it('returns the .app bundle ancestor of execPath', () => {
    const installer = createInstallerService(makeDeps({
      execPath: '/Applications/OmniFex.app/Contents/MacOS/OmniFex',
    }));
    expect(installer.resolveTargetApp()).toEqual({
      targetAppPath: '/Applications/OmniFex.app',
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
    }));
    await expect(installer.ensureTargetWritable('/Applications/OmniFex.app'))
      .rejects.toThrow(/TargetNotWritable/);
  });

  it('resolves silently when parent dir is writable', async () => {
    const installer = createInstallerService(makeDeps({
      isWritable: async () => true,
    }));
    await expect(installer.ensureTargetWritable('/Applications/OmniFex.app')).resolves.toBeUndefined();
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
        listInFlightTabIds: () => activeSessions > 0 ? new Array(activeSessions).fill('t').map((_, i) => `t-${i}`) : [],
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

  it('with force=true calls stopAll once, then resolves', async () => {
    const stopAll = vi.fn();
    let activeSessions = 1;
    const installer = createInstallerService(makeDeps({
      sessionsService: {
        listInFlightTabIds: () => activeSessions > 0 ? ['t'] : [],
        stopAll: () => { stopAll(); activeSessions = 0; },
      },
    }));
    await installer.waitForIdle({ force: true });
    expect(stopAll).toHaveBeenCalledTimes(1);
  });

  it('cancelWait rejects the in-flight wait with WaitCancelled', async () => {
    const installer = createInstallerService(makeDeps({
      sessionsService: {
        listInFlightTabIds: () => ['t'],
        stopAll: () => {},
      },
    }));
    const p = installer.waitForIdle({ force: false });
    setTimeout(() => installer.cancelWait(), 100);
    await expect(p).rejects.toThrow(/WaitCancelled/);
  });
});

describe('InstallerService.stage extractZip failure', () => {
  let stageDir: string;
  beforeEach(async () => {
    stageDir = await fs.mkdtemp(path.join(os.tmpdir(), 'installer-extract-fail-'));
  });
  afterEach(async () => {
    await fs.rm(stageDir, { recursive: true, force: true });
  });

  it('throws InvalidUpdatePackage when extractZip rejects', async () => {
    const zipPath = path.join(stageDir, 'corrupt.zip');
    await fs.writeFile(zipPath, 'garbage');
    const installer = createInstallerService(makeDeps({
      extractZip: async () => {
        throw new Error('ditto exited 1');
      },
    }));
    await expect(installer.stage(zipPath, '0.4.0')).rejects.toThrow(
      /InvalidUpdatePackage.*extraction failed.*ditto exited 1/,
    );
  });

  it('readBundleVersion returning null surfaces "<unreadable>" in VersionMismatch', async () => {
    const zipPath = path.join(stageDir, 'pkg.zip');
    await fs.writeFile(zipPath, 'x');
    const installer = createInstallerService(makeDeps({
      extractZip: async (_zip, dest) => {
        const appDir = path.join(dest, 'OmniFex.app', 'Contents', 'MacOS');
        await fs.mkdir(appDir, { recursive: true });
        await fs.writeFile(path.join(appDir, 'OmniFex'), 'b');
      },
      readBundleVersion: async () => null,
    }));
    await expect(installer.stage(zipPath, '0.4.0')).rejects.toThrow(/<unreadable>/);
  });
});

describe('InstallerService default isWritable', () => {
  it('returns true for a writable tmp dir', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'installer-write-'));
    try {
      const installer = createInstallerService(makeDeps());
      // We can't access the default impl directly — exercise via ensureTargetWritable.
      await expect(installer.ensureTargetWritable(path.join(tmpDir, 'whatever.app')))
        .resolves.toBeUndefined();
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('throws TargetNotWritable for a non-existent parent dir', async () => {
    const installer = createInstallerService(makeDeps());
    await expect(installer.ensureTargetWritable('/this/path/does/not/exist/whatever.app'))
      .rejects.toThrow(/TargetNotWritable/);
  });
});

describe('InstallerService.waitForIdle diagnostic snapshot', () => {
  it('includes tabs from listSessionStatuses in the waiting payload', async () => {
    let active = 1;
    const sendToRenderer = vi.fn();
    const installer = createInstallerService(makeDeps({
      sendToRenderer,
      sessionsService: {
        listInFlightTabIds: () => active > 0 ? ['t-1'] : [],
        listSessionStatuses: () => [
          { tabId: 't-1', status: 'running' },
          { tabId: 't-2', status: 'idle' },
        ],
        stopAll: () => {},
      },
    }));
    const p = installer.waitForIdle({ force: false });
    setTimeout(() => { active = 0; }, 1100);
    await p;
    const waitingCalls = sendToRenderer.mock.calls.filter((c) => c[1].phase === 'waiting');
    expect(waitingCalls.length).toBeGreaterThan(0);
    expect(waitingCalls[0][1].tabs).toEqual([
      { tabId: 't-1', status: 'running' },
      { tabId: 't-2', status: 'idle' },
    ]);
  });
});

describe('InstallerService.stage default extractZip / readBundleVersion (macOS only)', () => {
  let stageDir: string;
  beforeEach(async () => {
    stageDir = await fs.mkdtemp(path.join(os.tmpdir(), 'installer-default-'));
  });
  afterEach(async () => {
    await fs.rm(stageDir, { recursive: true, force: true });
  });

  // Skip on non-darwin since `ditto` is macOS-only.
  const itDarwin = process.platform === 'darwin' ? it : it.skip;

  itDarwin('default extractZip fails as InvalidUpdatePackage on a corrupt zip', async () => {
    const corrupt = path.join(stageDir, 'corrupt.zip');
    await fs.writeFile(corrupt, 'not-a-zip');
    // No extractZip injected — default ditto runs and fails
    const installer = createInstallerService(makeDeps());
    await expect(installer.stage(corrupt, '0.4.0')).rejects.toThrow(/InvalidUpdatePackage/);
  });

  itDarwin('default readBundleVersion returns null when Info.plist is missing → VersionMismatch <unreadable>', async () => {
    // Create a minimal valid zip containing OmniFex.app/Contents/MacOS/OmniFex
    // but no Info.plist so plutil fails.
    const srcDir = path.join(stageDir, 'src');
    const appDir = path.join(srcDir, 'OmniFex.app', 'Contents', 'MacOS');
    await fs.mkdir(appDir, { recursive: true });
    await fs.writeFile(path.join(appDir, 'OmniFex'), '#!/bin/sh\nexit 0\n');

    const zipPath = path.join(stageDir, 'pkg.zip');
    // Use system `ditto -ck` (the create form) to build a real zip
    const { spawnSync } = await import('node:child_process');
    const create = spawnSync('ditto', ['-ck', '--keepParent', path.join(srcDir, 'OmniFex.app'), zipPath]);
    if (create.status !== 0) {
      // Skip cleanly if ditto cannot create the test zip on this host
      return;
    }

    const installer = createInstallerService(makeDeps());
    // No readBundleVersion injected → default plutil tries to read missing
    // Info.plist and returns null, surfacing as VersionMismatch <unreadable>
    await expect(installer.stage(zipPath, '0.4.0')).rejects.toThrow(/<unreadable>/);
  });
});

describe('InstallerService.executeInstall', () => {
  let stageDir: string;
  beforeEach(async () => {
    stageDir = await fs.mkdtemp(path.join(os.tmpdir(), 'installer-exec-test-'));
  });
  afterEach(async () => {
    await fs.rm(stageDir, { recursive: true, force: true });
  });

  it('writes a helper script, spawns it detached, and calls appQuit', async () => {
    const spawn = vi.fn().mockReturnValue({ unref: () => {} });
    const appQuit = vi.fn();
    const installer = createInstallerService(makeDeps({ spawn, appQuit }));
    await installer.executeInstall('/tmp/stage/OmniFex.app', '/Applications/OmniFex.app');

    expect(spawn).toHaveBeenCalledTimes(1);
    const [cmd, args, opts] = spawn.mock.calls[0];
    expect(cmd).toBe('/bin/sh');
    expect(args).toHaveLength(1);
    expect(args[0]).toMatch(/omnifex-installer-\d+\.sh$/);
    expect(opts).toEqual({ detached: true, stdio: 'ignore' });

    // The helper script should exist on disk and be executable
    const stat = await fs.stat(args[0]);
    expect(stat.mode & 0o100).toBeTruthy(); // owner executable bit

    const contents = await fs.readFile(args[0], 'utf8');
    expect(contents).toContain('TARGET_APP="/Applications/OmniFex.app"');
    expect(contents).toContain('STAGED_APP="/tmp/stage/OmniFex.app"');

    expect(appQuit).toHaveBeenCalledTimes(1);

    // Cleanup the script file we just created
    await fs.unlink(args[0]).catch(() => {});
  });
});
