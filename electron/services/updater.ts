// Updater service — scans a local folder for newer GreyChrist ZIP builds and
// returns update info pointing at the file on disk.
//
// GreyChrist is a solo project with local-only releases (`npm run make`). The
// old GitHub-release-polling updater was retired in v0.3.12 in favor of this
// folder-scanning approach, which needs no network and no Actions budget. See
// CHANGELOG.md v0.3.12 and the `local_update_dir` app setting for how the
// folder is configured.

import path from 'node:path';
import type { LoggingService } from './logging';

// ---------------------------------------------------------------------------
// Public types — stable; the renderer (src/lib/api.ts, CustomTitlebar.tsx)
// consumes these unchanged across the GitHub → local migration.
// ---------------------------------------------------------------------------

export interface UpdateInfo {
  available: boolean;
  version: string;
  /** Absolute local file path. Kept named `downloadUrl` for renderer compatibility. */
  downloadUrl: string;
  assetName: string;           // e.g. "GreyChrist-darwin-arm64-0.4.0.zip"
  releaseUrl: string;          // Empty for local source; kept for renderer compatibility.
  releaseNotes?: string;
}

export interface ProgressData {
  percent: number;
  bytesDownloaded: number;
  totalBytes: number;
}

export interface UpdaterService {
  checkForUpdate(): Promise<UpdateInfo | null>;
  downloadUpdate(
    url: string,
    onProgress: (data: ProgressData) => void,
    assetName?: string,
  ): Promise<string>;
}

// ---------------------------------------------------------------------------
// Deps (injectable for testing)
// ---------------------------------------------------------------------------

interface UpdaterDeps {
  /** Reads the configured local-update directory (from the `local_update_dir`
   *  app setting). Called on every checkForUpdate so the user's setting change
   *  takes effect without restarting the app. Return null or '' to disable. */
  getLocalUpdateDir: () => string | null;
  /** Injectable readdir for tests. Defaults to node:fs/promises.readdir. */
  readdir?: (dir: string) => Promise<string[]>;
  /** Optional logger. When provided, readdir failures (misconfigured path,
   *  missing folder, permission error) are recorded at `debug` level so the
   *  user can diagnose "why isn't it finding my update?" without seeing log
   *  noise when the feature is simply off (empty `local_update_dir`). */
  logging?: LoggingService | null;
}

// ---------------------------------------------------------------------------
// Version comparison (simple semver: major.minor.patch — matches the previous
// implementation's behavior and the install pattern in filenames.)
// ---------------------------------------------------------------------------

function parseVersion(v: string): [number, number, number] | null {
  const m = v.match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

function isNewer(remote: string, local: string): boolean {
  const r = parseVersion(remote);
  const l = parseVersion(local);
  if (!r || !l) return false;
  if (r[0] !== l[0]) return r[0] > l[0];
  if (r[1] !== l[1]) return r[1] > l[1];
  return r[2] > l[2];
}

function compareVersion(a: string, b: string): number {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) return 0;
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] - pb[i];
  }
  return 0;
}

// ---------------------------------------------------------------------------
// Filename pattern — `GreyChrist-darwin-arm64-<major>.<minor>.<patch>.zip`,
// matching the artifact produced by Electron Forge's zip maker.
// The auto-installer service unpacks this ZIP in place of the manual
// DMG-drag flow that predated v0.4.0.
// ---------------------------------------------------------------------------

const ZIP_RE = /^GreyChrist-darwin-arm64-(\d+\.\d+\.\d+)\.zip$/;

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createUpdaterService(
  currentVersion: string,
  deps: UpdaterDeps,
): UpdaterService {
  const getLocalUpdateDir = deps.getLocalUpdateDir;
  const logging = deps.logging ?? null;
  const readdir =
    deps.readdir ??
    (async (dir: string) => {
      const fs = await import('node:fs/promises');
      return fs.readdir(dir);
    });

  function logDebug(message: string, metadata?: Record<string, unknown>): void {
    if (!logging) return;
    try {
      logging.writeBatch([
        {
          timestamp: new Date().toISOString(),
          level: 'debug',
          source: 'updater',
          message,
          metadata: metadata ? JSON.stringify(metadata) : undefined,
        },
      ]);
    } catch {
      // Never let a logging failure escape an update check.
    }
  }

  async function checkForUpdate(): Promise<UpdateInfo | null> {
    const dir = getLocalUpdateDir();
    if (!dir) return null;

    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch (err) {
      // Directory missing, unreadable, or any other IO error — treat as
      // "no update available" rather than a hard failure. The user will
      // see the app as up-to-date; if the dir is misconfigured, the
      // Settings UI is where they fix it. Log at debug so "why isn't it
      // picking up my build?" is answerable without spamming the log panel.
      logDebug(`local_update_dir readdir failed: ${dir}`, {
        dir,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }

    const candidates: Array<{ version: string; filename: string }> = [];
    for (const name of entries) {
      const m = ZIP_RE.exec(name);
      if (!m) continue;
      candidates.push({ version: m[1], filename: name });
    }

    if (candidates.length === 0) return null;

    // Highest version wins.
    candidates.sort((a, b) => compareVersion(b.version, a.version));
    const best = candidates[0];

    if (!isNewer(best.version, currentVersion)) return null;

    return {
      available: true,
      version: best.version,
      downloadUrl: path.join(dir, best.filename),
      assetName: best.filename,
      releaseUrl: '',
    };
  }

  async function downloadUpdate(
    url: string,
    onProgress: (data: ProgressData) => void,
    _assetName?: string,
  ): Promise<string> {
    // The file is already on disk — nothing to fetch. Fire a single
    // 100%-complete progress tick so the renderer's download UI (progress bar
    // etc.) completes naturally instead of hanging at 0%.
    onProgress({ percent: 100, bytesDownloaded: 0, totalBytes: 0 });
    return url;
  }

  return { checkForUpdate, downloadUpdate };
}
