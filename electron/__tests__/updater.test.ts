import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createUpdaterService } from '../services/updater';

// ---------------------------------------------------------------------------
// Mock fetch globally
// ---------------------------------------------------------------------------

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRelease(tag: string, opts?: { draft?: boolean; prerelease?: boolean; assets?: Array<{ name: string; url?: string; browser_download_url: string; size: number }> }) {
  const defaultAssets = [
    { name: `GreyChrist-${tag.replace('v', '')}-arm64.dmg`, url: `https://api.github.com/repos/greychrist/GreyChrist/releases/assets/dmg-${tag}`, browser_download_url: `https://github.com/download/${tag}/GreyChrist.dmg`, size: 100_000_000 },
    { name: `GreyChrist-darwin-arm64-${tag.replace('v', '')}.zip`, url: `https://api.github.com/repos/greychrist/GreyChrist/releases/assets/zip-${tag}`, browser_download_url: `https://github.com/download/${tag}/GreyChrist.zip`, size: 110_000_000 },
  ];
  return {
    tag_name: tag,
    draft: opts?.draft ?? false,
    prerelease: opts?.prerelease ?? false,
    html_url: `https://github.com/greychrist/GreyChrist/releases/tag/${tag}`,
    body: `Release notes for ${tag}`,
    assets: opts?.assets ?? defaultAssets,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('updater service', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  describe('checkForUpdate()', () => {
    it('returns available: true when remote version is newer', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => [makeRelease('v0.4.0')],
      });

      const svc = createUpdaterService('0.3.0');
      const result = await svc.checkForUpdate();

      expect(result).not.toBeNull();
      expect(result!.available).toBe(true);
      expect(result!.version).toBe('0.4.0');
      expect(result!.downloadUrl).toContain('api.github.com');
      expect(result!.downloadUrl).toContain('dmg-v0.4.0');
      expect(result!.releaseUrl).toContain('v0.4.0');
    });

    it('returns available: false when versions match', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => [makeRelease('v0.3.0')],
      });

      const svc = createUpdaterService('0.3.0');
      const result = await svc.checkForUpdate();

      expect(result).not.toBeNull();
      expect(result!.available).toBe(false);
    });

    it('returns available: false when local version is newer', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => [makeRelease('v0.2.0')],
      });

      const svc = createUpdaterService('0.3.0');
      const result = await svc.checkForUpdate();

      expect(result).not.toBeNull();
      expect(result!.available).toBe(false);
    });

    it('returns null on network error', async () => {
      mockFetch.mockRejectedValueOnce(new Error('Network error'));

      const svc = createUpdaterService('0.3.0');
      const result = await svc.checkForUpdate();

      expect(result).toBeNull();
    });

    it('returns null on non-OK response', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 404,
      });

      const svc = createUpdaterService('0.3.0');
      const result = await svc.checkForUpdate();

      expect(result).toBeNull();
    });

    it('skips draft and prerelease entries', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => [
          makeRelease('v0.5.0', { draft: true }),
          makeRelease('v0.4.0', { prerelease: true }),
          makeRelease('v0.3.1'),
        ],
      });

      const svc = createUpdaterService('0.3.0');
      const result = await svc.checkForUpdate();

      expect(result!.available).toBe(true);
      expect(result!.version).toBe('0.3.1');
    });

    it('returns null when no non-draft releases exist', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => [
          makeRelease('v0.5.0', { draft: true }),
        ],
      });

      const svc = createUpdaterService('0.3.0');
      const result = await svc.checkForUpdate();

      expect(result).toBeNull();
    });

    it('selects DMG asset over ZIP', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => [makeRelease('v0.4.0')],
      });

      const svc = createUpdaterService('0.3.0');
      const result = await svc.checkForUpdate();

      expect(result!.downloadUrl).toContain('dmg-v0.4.0');
    });

    it('falls back to ZIP when no DMG asset exists', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => [
          makeRelease('v0.4.0', {
            assets: [
              { name: 'GreyChrist-darwin-arm64-0.4.0.zip', url: 'https://api.github.com/repos/greychrist/GreyChrist/releases/assets/zip-only', browser_download_url: 'https://example.com/file.zip', size: 100_000 },
            ],
          }),
        ],
      });

      const svc = createUpdaterService('0.3.0');
      const result = await svc.checkForUpdate();

      expect(result!.downloadUrl).toContain('zip-only');
    });

    it('sets downloadUrl to empty string when no matching assets exist', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => [
          makeRelease('v0.4.0', {
            assets: [
              { name: 'unrelated-file.tar.gz', url: 'https://api.github.com/repos/greychrist/GreyChrist/releases/assets/tar', browser_download_url: 'https://example.com/file.tar.gz', size: 100_000 },
            ],
          }),
        ],
      });

      const svc = createUpdaterService('0.3.0');
      const result = await svc.checkForUpdate();

      expect(result!.available).toBe(true);
      expect(result!.downloadUrl).toBe('');
    });

    it('returns null when releases array is empty', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => [],
      });

      const svc = createUpdaterService('0.3.0');
      const result = await svc.checkForUpdate();

      expect(result).toBeNull();
    });

    it('strips leading v from tag when comparing versions', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => [makeRelease('v0.3.0')],
      });

      const svc = createUpdaterService('0.3.0');
      const result = await svc.checkForUpdate();

      expect(result!.available).toBe(false);
      expect(result!.version).toBe('0.3.0');
    });
  });

  describe('downloadUpdate()', () => {
    it('streams to a file and reports progress', async () => {
      const chunks = [new Uint8Array(40), new Uint8Array(60)];
      let chunkIndex = 0;

      const mockReader = {
        read: vi.fn().mockImplementation(async () => {
          if (chunkIndex < chunks.length) {
            return { done: false, value: chunks[chunkIndex++] };
          }
          return { done: true, value: undefined };
        }),
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        headers: { get: (name: string) => name === 'content-length' ? '100' : null },
        body: { getReader: () => mockReader },
      });

      const writeFileMock = vi.fn().mockResolvedValue(undefined);
      const svc = createUpdaterService('0.3.0', {
        downloadsPath: '/tmp/downloads',
        writeFile: writeFileMock,
      });

      const progress: number[] = [];
      const filePath = await svc.downloadUpdate(
        'https://example.com/GreyChrist-0.4.0-arm64.dmg',
        (data) => progress.push(data.percent),
      );

      expect(filePath).toBe('/tmp/downloads/GreyChrist-0.4.0-arm64.dmg');
      expect(progress.length).toBe(2);
      expect(progress[0]).toBe(40);
      expect(progress[1]).toBe(100);
      expect(writeFileMock).toHaveBeenCalledWith(
        '/tmp/downloads/GreyChrist-0.4.0-arm64.dmg',
        expect.any(Buffer),
      );
    });

    it('throws on network error', async () => {
      mockFetch.mockRejectedValueOnce(new Error('Network error'));

      const svc = createUpdaterService('0.3.0', { downloadsPath: '/tmp/downloads' });

      await expect(
        svc.downloadUpdate('https://example.com/file.dmg', () => {}),
      ).rejects.toThrow('Network error');
    });

    it('throws on non-OK response', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 404,
        statusText: 'Not Found',
      });

      const svc = createUpdaterService('0.3.0', { downloadsPath: '/tmp/downloads' });

      await expect(
        svc.downloadUpdate('https://example.com/file.dmg', () => {}),
      ).rejects.toThrow('Download failed: 404');
    });
  });
});
