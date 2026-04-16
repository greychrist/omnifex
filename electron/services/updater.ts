// Updater service — checks GitHub releases for a newer version, downloads
// the DMG asset, and opens it for the user to install.

import path from 'node:path';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface UpdateInfo {
  available: boolean;
  version: string;
  downloadUrl: string;
  assetName: string;       // e.g. "GreyChrist-0.4.0-arm64.dmg"
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
  downloadUpdate(url: string, onProgress: (data: ProgressData) => void, assetName?: string): Promise<string>;
}

// ---------------------------------------------------------------------------
// Deps (injectable for testing)
// ---------------------------------------------------------------------------

interface UpdaterDeps {
  downloadsPath?: string;
  writeFile?: (filePath: string, data: Buffer) => Promise<void>;
  /** GitHub personal access token for private repo access. */
  getToken?: () => string | null;
}

// ---------------------------------------------------------------------------
// Version comparison (simple semver: major.minor.patch)
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

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

const REPO = 'greychrist/GreyChrist';
const API_URL = `https://api.github.com/repos/${REPO}/releases`;

export function createUpdaterService(
  currentVersion: string,
  deps?: UpdaterDeps,
): UpdaterService {
  const downloadsPath = deps?.downloadsPath ?? '';
  const writeFile = deps?.writeFile;
  const getToken = deps?.getToken;

  async function checkForUpdate(): Promise<UpdateInfo | null> {
    try {
      const headers: Record<string, string> = { Accept: 'application/vnd.github+json' };
      const token = getToken?.();
      if (token) headers.Authorization = `token ${token}`;
      const res = await fetch(API_URL, { headers });
      if (!res.ok) return null;

      const releases: any[] = await res.json();
      if (!Array.isArray(releases) || releases.length === 0) return null;

      // Find the first non-draft, non-prerelease release
      const release = releases.find((r: any) => !r.draft && !r.prerelease);
      if (!release) return null;

      const remoteVersion = (release.tag_name ?? '').replace(/^v/, '');
      const available = isNewer(remoteVersion, currentVersion);

      // Select asset: prefer DMG, fall back to ZIP
      const assets: any[] = release.assets ?? [];
      const dmg = assets.find((a: any) => /\.dmg$/i.test(a.name));
      const zip = assets.find((a: any) => /\.zip$/i.test(a.name));
      const asset = dmg ?? zip;

      // Use the API URL (asset.url) for downloads — browser_download_url
      // fails for private repos because fetch strips the Authorization header
      // on the cross-origin redirect to S3.  The API URL returns a 302 to a
      // pre-signed S3 URL that needs no auth header.
      return {
        available,
        version: remoteVersion,
        downloadUrl: asset?.url ?? '',
        assetName: asset?.name ?? '',
        releaseUrl: release.html_url ?? '',
        releaseNotes: release.body ?? undefined,
      };
    } catch {
      return null;
    }
  }

  async function downloadUpdate(
    url: string,
    onProgress: (data: ProgressData) => void,
    assetName?: string,
  ): Promise<string> {
    const dlHeaders: Record<string, string> = { Accept: 'application/octet-stream' };
    const dlToken = getToken?.();
    if (dlToken) dlHeaders.Authorization = `token ${dlToken}`;
    const res = await fetch(url, { headers: dlHeaders });
    if (!res.ok) {
      throw new Error(`Download failed: ${res.status}`);
    }

    const totalBytes = Number(res.headers.get('content-length') ?? 0);
    const reader = res.body!.getReader();
    const chunks: Uint8Array[] = [];
    let bytesDownloaded = 0;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      bytesDownloaded += value.byteLength;
      const percent = totalBytes > 0 ? Math.round((bytesDownloaded / totalBytes) * 100) : 0;
      onProgress({ percent, bytesDownloaded, totalBytes });
    }

    const buffer = Buffer.concat(chunks);
    const fileName = assetName || path.basename(new URL(url).pathname) || 'GreyChrist-update.dmg';
    const filePath = path.join(downloadsPath, fileName);

    if (writeFile) {
      await writeFile(filePath, buffer);
    } else {
      const fs = await import('node:fs/promises');
      await fs.writeFile(filePath, buffer);
    }

    return filePath;
  }

  return { checkForUpdate, downloadUpdate };
}
