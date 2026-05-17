// Updater service — polls GitHub Releases for the configured public repo and
// streams matching darwin-arm64 ZIP assets to $TMPDIR with progress.
//
// History:
//   - Pre-v0.3.12: GitHub Releases via a CI-driven workflow.
//   - v0.3.12: Updater retired; releases moved local-only (no Actions budget).
//   - v0.3.13: Local-folder scanner added so dev builds could be picked up.
//   - May 2026: Repo went public; GitHub source restored alongside the local
//     folder, then the local folder was removed entirely (this file). Manual
//     drag-install is the fallback for builds not on a published release.
//
// Anonymous GitHub API gives 60 req/hr/IP — fine for a desktop client that
// checks on launch and on user request. 403/404/network errors all reduce
// to "no update" so the UI shows "up to date" rather than an error spinner.

import path from 'node:path';
import os from 'node:os';
import type { LoggingService } from './logging';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface UpdateInfo {
  available: boolean;
  version: string;
  /** HTTPS URL to the release asset. */
  downloadUrl: string;
  assetName: string;
  releaseUrl: string;
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

export interface DownloadFileParams {
  url: string;
  destPath: string;
  onProgress: (bytesDownloaded: number, totalBytes: number) => void;
}

interface UpdaterDeps {
  /** Returns "owner/repo" for the public GitHub repo, or null/'' to disable. */
  getGitHubRepo: () => string | null;
  /** Injectable for tests. Defaults to global fetch. */
  fetch?: typeof fetch;
  /** Injectable for tests. Defaults to a node:https streaming implementation. */
  downloadFile?: (params: DownloadFileParams) => Promise<void>;
  /** Injectable for tests. Defaults to os.tmpdir(). */
  tmpdir?: () => string;
  /** Optional logger; failures recorded at debug. */
  logging?: LoggingService | null;
}

// ---------------------------------------------------------------------------
// Version helpers
// ---------------------------------------------------------------------------

function parseVersion(v: string): [number, number, number] | null {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(v);
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

// Filename pattern produced by `npm run make` (Electron Forge zip maker).
// Updater + installer both rely on this exact shape.
const ZIP_RE = /^OmniFex-darwin-arm64-(\d+\.\d+\.\d+)\.zip$/;

// ---------------------------------------------------------------------------
// GitHub release shape (subset we care about)
// ---------------------------------------------------------------------------

interface GitHubAsset {
  name: string;
  browser_download_url: string;
  size?: number;
}

interface GitHubRelease {
  tag_name: string;
  name?: string;
  body?: string;
  html_url: string;
  assets: GitHubAsset[];
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createUpdaterService(
  currentVersion: string,
  deps: UpdaterDeps,
): UpdaterService {
  const getGitHubRepo = deps.getGitHubRepo;
  const logging = deps.logging ?? null;
  const fetchImpl = deps.fetch ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
  const tmpdirFn = deps.tmpdir ?? (() => os.tmpdir());
  const downloadFn = deps.downloadFile ?? defaultDownloadFile;

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
    const repo = getGitHubRepo();
    if (!repo) return null;

    // Cache-bust the URL so GitHub's edge cache (which holds releases/latest
    // for ~60s) can't return stale data right after a publish — observed in
    // v0.4.43→v0.4.44 testing where the manual update check returned the old
    // version for ~minute after the new release went live. Belt-and-suspenders:
    // also send Cache-Control: no-cache so any intermediary revalidates.
    const url = `https://api.github.com/repos/${repo}/releases/latest?_=${Date.now()}`;
    let release: GitHubRelease;
    try {
      const res = await fetchImpl(url, {
        headers: {
          'Accept': 'application/vnd.github+json',
          'User-Agent': 'OmniFex-Updater',
          'Cache-Control': 'no-cache',
        },
      });
      if (!res.ok) {
        logDebug(`github fetch non-ok: ${res.status}`, { url, status: res.status });
        return null;
      }
      release = (await res.json()) as GitHubRelease;
    } catch (err) {
      logDebug(`github fetch threw: ${err instanceof Error ? err.message : String(err)}`, {
        url,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }

    if (!release || !Array.isArray(release.assets)) return null;

    let best: { version: string; asset: GitHubAsset } | null = null;
    for (const asset of release.assets) {
      const m = ZIP_RE.exec(asset.name);
      if (!m) continue;
      if (!best || compareVersion(m[1], best.version) > 0) {
        best = { version: m[1], asset };
      }
    }
    if (!best) return null;
    if (!isNewer(best.version, currentVersion)) return null;

    return {
      available: true,
      version: best.version,
      downloadUrl: best.asset.browser_download_url,
      assetName: best.asset.name,
      releaseUrl: release.html_url,
      releaseNotes: release.body,
    };
  }

  async function downloadUpdate(
    url: string,
    onProgress: (data: ProgressData) => void,
    assetName?: string,
  ): Promise<string> {
    const filename = assetName ?? deriveFilenameFromUrl(url);
    const destPath = path.join(tmpdirFn(), filename);

    await downloadFn({
      url,
      destPath,
      onProgress: (bytesDownloaded, totalBytes) => {
        const percent = totalBytes > 0 ? Math.round((bytesDownloaded / totalBytes) * 100) : 0;
        onProgress({ percent, bytesDownloaded, totalBytes });
      },
    });

    return destPath;
  }

  return { checkForUpdate, downloadUpdate };
}

// ---------------------------------------------------------------------------
// Default HTTPS downloader — streams to disk, reports bytes.
// ---------------------------------------------------------------------------

async function defaultDownloadFile(params: DownloadFileParams): Promise<void> {
  const https = await import('node:https');
  const http = await import('node:http');
  const fs = await import('node:fs');

  return new Promise((resolve, reject) => {
    const client = params.url.startsWith('https://') ? https : http;
    const doRequest = (currentUrl: string, redirectsLeft: number) => {
      const req = client.get(currentUrl, { headers: { 'User-Agent': 'OmniFex-Updater' } }, (res) => {
        // Follow GitHub release-asset redirects (302 -> objects CDN).
        if (
          res.statusCode &&
          res.statusCode >= 300 &&
          res.statusCode < 400 &&
          res.headers.location
        ) {
          if (redirectsLeft <= 0) {
            reject(new Error('too many redirects'));
            return;
          }
          res.resume();
          doRequest(res.headers.location, redirectsLeft - 1);
          return;
        }
        if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error(`download failed: HTTP ${res.statusCode}`));
          res.resume();
          return;
        }

        const total = Number(res.headers['content-length'] ?? 0);
        let downloaded = 0;
        const file = fs.createWriteStream(params.destPath);
        res.on('data', (chunk: Buffer) => {
          downloaded += chunk.length;
          params.onProgress(downloaded, total);
        });
        res.pipe(file);
        file.on('finish', () => file.close(() => resolve()));
        file.on('error', (err) => reject(err));
        res.on('error', (err) => reject(err));
      });
      req.on('error', (err) => reject(err));
    };
    doRequest(params.url, 5);
  });
}

function deriveFilenameFromUrl(url: string): string {
  try {
    const u = new URL(url);
    const last = u.pathname.split('/').filter(Boolean).pop();
    return last && last.length > 0 ? last : 'OmniFex-update.zip';
  } catch {
    return 'OmniFex-update.zip';
  }
}
