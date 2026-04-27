// Auto-installer for GreyChrist updates. Validates a ZIP, stages it to
// $TMPDIR, waits for in-flight sessions, then spawns a detached
// helper script that swaps GreyChrist.app and relaunches.
//
// Spec: docs/superpowers/specs/2026-04-25-auto-install-update-design.md

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import type { ChildProcess } from 'node:child_process';
import { buildHelperScript } from './installer/helper-script';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface InstallStatus {
  phase: 'waiting' | 'installing';
  activeSessions?: number;
  /**
   * Diagnostic snapshot of every session main knows about (in-flight or not).
   * Surfaced on `phase: 'waiting'` events so the renderer / DevTools can
   * see exactly what the gate sees when the wait ends or skips.
   */
  tabs?: Array<{ tabId: string; status: string }>;
}

export interface InstallerService {
  stage(zipPath: string, expectedVersion: string): Promise<{ stagedAppPath: string }>;
  resolveTargetApp(): { targetAppPath: string };
  ensureTargetWritable(targetAppPath: string): Promise<void>;
  waitForIdle(opts: { force: boolean }): Promise<void>;
  cancelWait(): void;
  executeInstall(stagedAppPath: string, targetAppPath: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// Injectable deps
// ---------------------------------------------------------------------------

export interface InstallerDeps {
  sessionsService: {
    /** Tabs whose SDK turn is in flight — `'starting'`, `'running'`, or
     *  `'waiting_permission'`. Idle/open sessions are excluded so the
     *  installer doesn't block on tabs sitting at a prompt. */
    listInFlightTabIds: () => string[];
    /** Diagnostic: every session main knows about, with its current status,
     *  whether or not it counts as "in-flight". Used by the gate to log a
     *  full snapshot when it polls / clears. Optional so existing callers
     *  (and tests) keep working. */
    listSessionStatuses?: () => Array<{ tabId: string; status: string }>;
    stopAll: () => void;
  };
  appQuit: () => void;
  spawn: (
    command: string,
    args: string[],
    options: { detached: boolean; stdio: 'ignore' },
  ) => ChildProcess;
  sendToRenderer: (channel: string, payload: unknown) => void;
  /** process.execPath of the running app. Injectable so tests can simulate
   *  packaged vs dev builds without monkey-patching. */
  execPath: string;
  /** Injectable extractor — defaults to `ditto -xk <zip> <dir>`. */
  extractZip?: (zipPath: string, destDir: string) => Promise<void>;
  /** Injectable Info.plist version reader — defaults to plutil. */
  readBundleVersion?: (appPath: string) => Promise<string | null>;
  /** Injectable writability check — defaults to `fs.access(path, W_OK)`. */
  isWritable?: (p: string) => Promise<boolean>;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class UpdateFileNotFound extends Error {
  constructor(p: string) { super(`UpdateFileNotFound: ${p}`); this.name = 'UpdateFileNotFound'; }
}
export class InvalidUpdatePackage extends Error {
  constructor(reason: string) { super(`InvalidUpdatePackage: ${reason}`); this.name = 'InvalidUpdatePackage'; }
}
export class VersionMismatch extends Error {
  constructor(expected: string, actual: string) {
    super(`VersionMismatch: expected ${expected}, got ${actual}`);
    this.name = 'VersionMismatch';
  }
}
export class NotPackaged extends Error {
  constructor() { super('NotPackaged'); this.name = 'NotPackaged'; }
}
export class TargetNotWritable extends Error {
  constructor(p: string) { super(`TargetNotWritable: ${p}`); this.name = 'TargetNotWritable'; }
}
export class WaitCancelled extends Error {
  constructor() { super('WaitCancelled'); this.name = 'WaitCancelled'; }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createInstallerService(deps: InstallerDeps): InstallerService {
  let cancelToken: { cancelled: boolean } | null = null;

  const extractZip =
    deps.extractZip ??
    (async (zipPath, destDir) => {
      const { spawn } = await import('node:child_process');
      await new Promise<void>((resolve, reject) => {
        const proc = spawn('ditto', ['-xk', zipPath, destDir], { stdio: 'ignore' });
        proc.on('exit', (code) => {
          if (code === 0) resolve();
          else reject(new Error(`ditto exited ${code}`));
        });
        proc.on('error', reject);
      });
    });

  const readBundleVersion =
    deps.readBundleVersion ??
    (async (appPath) => {
      const plistPath = path.join(appPath, 'Contents', 'Info.plist');
      try {
        const { spawn } = await import('node:child_process');
        return await new Promise<string | null>((resolve) => {
          const out: Buffer[] = [];
          const proc = spawn('/usr/bin/plutil', [
            '-extract', 'CFBundleShortVersionString', 'raw', plistPath,
          ], { stdio: ['ignore', 'pipe', 'ignore'] });
          proc.stdout?.on('data', (b) => out.push(b));
          proc.on('exit', (code) => {
            if (code !== 0) return resolve(null);
            resolve(Buffer.concat(out).toString('utf8').trim());
          });
          proc.on('error', () => resolve(null));
        });
      } catch {
        return null;
      }
    });

  const isWritable =
    deps.isWritable ??
    (async (p) => {
      try {
        await fs.access(p, fs.constants.W_OK);
        return true;
      } catch {
        return false;
      }
    });

  async function stage(
    zipPath: string,
    expectedVersion: string,
  ): Promise<{ stagedAppPath: string }> {
    try {
      await fs.access(zipPath);
    } catch {
      throw new UpdateFileNotFound(zipPath);
    }

    const destDir = await fs.mkdtemp(path.join(os.tmpdir(), 'greychrist-stage-'));
    try {
      await extractZip(zipPath, destDir);
    } catch (err) {
      await fs.rm(destDir, { recursive: true, force: true }).catch(() => {});
      throw new InvalidUpdatePackage(`extraction failed: ${(err as Error).message}`);
    }

    const stagedAppPath = path.join(destDir, 'GreyChrist.app');
    const execPath = path.join(stagedAppPath, 'Contents', 'MacOS', 'GreyChrist');
    try {
      await fs.access(execPath);
    } catch {
      await fs.rm(destDir, { recursive: true, force: true }).catch(() => {});
      throw new InvalidUpdatePackage('GreyChrist.app/Contents/MacOS/GreyChrist not found in archive');
    }

    const actualVersion = await readBundleVersion(stagedAppPath);
    if (actualVersion !== expectedVersion) {
      await fs.rm(destDir, { recursive: true, force: true }).catch(() => {});
      throw new VersionMismatch(expectedVersion, actualVersion ?? '<unreadable>');
    }

    return { stagedAppPath };
  }

  function resolveTargetApp(): { targetAppPath: string } {
    // Walk up from execPath to find the .app bundle. Path looks like:
    //   /Applications/GreyChrist.app/Contents/MacOS/GreyChrist
    // We want /Applications/GreyChrist.app.
    let cur = deps.execPath;
    while (cur !== '/' && cur !== '') {
      if (cur.endsWith('.app')) {
        return { targetAppPath: cur };
      }
      cur = path.dirname(cur);
    }
    throw new NotPackaged();
  }

  function cancelWait(): void {
    if (cancelToken) cancelToken.cancelled = true;
  }

  async function waitForIdle(opts: { force: boolean }): Promise<void> {
    if (opts.force) {
      deps.sessionsService.stopAll();
    }
    const token = { cancelled: false };
    cancelToken = token;

    while (true) {
      if (token.cancelled) {
        cancelToken = null;
        throw new WaitCancelled();
      }
      const inFlightIds = deps.sessionsService.listInFlightTabIds();
      const sessions = inFlightIds.length;
      const allTabs = deps.sessionsService.listSessionStatuses?.() ?? [];
      // Diagnostic: print every gate poll with the full per-tab status list
      // so we can tell *why* the gate cleared (no sessions, all idle, force,
      // etc.) when something looks wrong from the renderer's perspective.
      // eslint-disable-next-line no-console
      console.log('[installer] waitForIdle poll', {
        inFlight: sessions,
        inFlightIds,
        all: allTabs,
      });
      if (sessions === 0) {
        // eslint-disable-next-line no-console
        console.log('[installer] gate clear → proceeding to install', { all: allTabs });
        deps.sendToRenderer('updater:install-status', { phase: 'installing' });
        cancelToken = null;
        return;
      }
      deps.sendToRenderer('updater:install-status', {
        phase: 'waiting',
        activeSessions: sessions,
        tabs: allTabs,
      });
      await new Promise((r) => setTimeout(r, 1000));
    }
  }

  async function executeInstall(
    stagedAppPath: string,
    targetAppPath: string,
  ): Promise<void> {
    const helperPath = path.join(
      os.tmpdir(),
      `greychrist-installer-${Date.now()}.sh`,
    );
    const script = buildHelperScript({
      parentPid: process.pid,
      targetAppPath,
      stagedAppPath,
    });
    await fs.writeFile(helperPath, script, { mode: 0o755 });
    const child = deps.spawn('/bin/sh', [helperPath], { detached: true, stdio: 'ignore' });
    if (child && typeof child.unref === 'function') child.unref();
    deps.appQuit();
  }

  // Pre-quit writability check. resolveTargetApp() does the structural check;
  // this one ensures we can actually replace the bundle. Called by the IPC
  // handler before kicking off the install pipeline.
  async function ensureTargetWritable(targetAppPath: string): Promise<void> {
    const parent = path.dirname(targetAppPath);
    if (!(await isWritable(parent))) {
      throw new TargetNotWritable(parent);
    }
  }

  return {
    stage,
    resolveTargetApp,
    ensureTargetWritable,
    waitForIdle,
    cancelWait,
    executeInstall,
  };
}
