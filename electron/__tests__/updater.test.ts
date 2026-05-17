import { describe, it, expect } from 'vitest';
import { createUpdaterService } from '../services/updater';

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const goodRelease = {
  tag_name: 'v0.4.42',
  name: 'v0.4.42',
  body: '## Fixed\n- stop killing text selection inside Prism code cards',
  html_url: 'https://github.com/greychrist/omnifex/releases/tag/v0.4.42',
  assets: [
    {
      name: 'OmniFex-0.4.42-arm64.dmg',
      browser_download_url: 'https://github.com/greychrist/omnifex/releases/download/v0.4.42/OmniFex-0.4.42-arm64.dmg',
      size: 100,
    },
    {
      name: 'OmniFex-darwin-arm64-0.4.42.zip',
      browser_download_url: 'https://github.com/greychrist/omnifex/releases/download/v0.4.42/OmniFex-darwin-arm64-0.4.42.zip',
      size: 200,
    },
  ],
};

function makeFetchOk(data: unknown): typeof fetch {
  return (async () => ({
    ok: true,
    status: 200,
    json: async () => data,
  })) as unknown as typeof fetch;
}

function makeFetchStatus(status: number): typeof fetch {
  return (async () => ({
    ok: false,
    status,
    json: async () => ({}),
  })) as unknown as typeof fetch;
}

function makeFetchThrows(message: string): typeof fetch {
  return (async () => {
    throw new Error(message);
  }) as unknown as typeof fetch;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('updater service', () => {
  describe('checkForUpdate()', () => {
    it('returns UpdateInfo from GitHub for a newer release', async () => {
      const svc = createUpdaterService('0.4.0', {
        getGitHubRepo: () => 'greychrist/omnifex',
        fetch: makeFetchOk(goodRelease),
      });

      const result = await svc.checkForUpdate();

      expect(result).not.toBeNull();
      expect(result!.available).toBe(true);
      expect(result!.version).toBe('0.4.42');
      expect(result!.assetName).toBe('OmniFex-darwin-arm64-0.4.42.zip');
      expect(result!.downloadUrl).toBe(
        'https://github.com/greychrist/omnifex/releases/download/v0.4.42/OmniFex-darwin-arm64-0.4.42.zip',
      );
      expect(result!.releaseUrl).toBe('https://github.com/greychrist/omnifex/releases/tag/v0.4.42');
      expect(result!.releaseNotes).toContain('Fixed');
    });

    it('hits releases/latest for the configured repo', async () => {
      const calls: string[] = [];
      const fakeFetch: typeof fetch = (async (url: any) => {
        calls.push(String(url));
        return {
          ok: true,
          status: 200,
          json: async () => goodRelease,
        };
      }) as any;

      const svc = createUpdaterService('0.4.0', {
        getGitHubRepo: () => 'greychrist/omnifex',
        fetch: fakeFetch,
      });

      await svc.checkForUpdate();

      expect(calls).toEqual(['https://api.github.com/repos/greychrist/omnifex/releases/latest']);
    });

    it('sends a User-Agent header (GitHub API requires one)', async () => {
      const recordedInit: RequestInit[] = [];
      const fakeFetch: typeof fetch = (async (_url: any, init?: RequestInit) => {
        recordedInit.push(init ?? {});
        return { ok: true, status: 200, json: async () => goodRelease };
      }) as any;

      const svc = createUpdaterService('0.4.0', {
        getGitHubRepo: () => 'greychrist/omnifex',
        fetch: fakeFetch,
      });

      await svc.checkForUpdate();

      const headers = recordedInit[0]?.headers as Record<string, string> | undefined;
      const ua = headers?.['User-Agent'] ?? headers?.['user-agent'];
      expect(ua).toBeTruthy();
    });

    it('returns null when the release is not newer than current', async () => {
      const svc = createUpdaterService('0.4.42', {
        getGitHubRepo: () => 'greychrist/omnifex',
        fetch: makeFetchOk(goodRelease),
      });

      expect(await svc.checkForUpdate()).toBeNull();
    });

    it('returns null when GitHub returns 404', async () => {
      const svc = createUpdaterService('0.4.0', {
        getGitHubRepo: () => 'greychrist/omnifex',
        fetch: makeFetchStatus(404),
      });

      expect(await svc.checkForUpdate()).toBeNull();
    });

    it('returns null when GitHub returns 403 (rate limit)', async () => {
      const svc = createUpdaterService('0.4.0', {
        getGitHubRepo: () => 'greychrist/omnifex',
        fetch: makeFetchStatus(403),
      });

      expect(await svc.checkForUpdate()).toBeNull();
    });

    it('returns null when fetch throws (network error)', async () => {
      const svc = createUpdaterService('0.4.0', {
        getGitHubRepo: () => 'greychrist/omnifex',
        fetch: makeFetchThrows('ENOTFOUND'),
      });

      expect(await svc.checkForUpdate()).toBeNull();
    });

    it('returns null when the release has no matching darwin-arm64 ZIP asset', async () => {
      const dmgOnly = { ...goodRelease, assets: [goodRelease.assets[0]] };
      const svc = createUpdaterService('0.4.0', {
        getGitHubRepo: () => 'greychrist/omnifex',
        fetch: makeFetchOk(dmgOnly),
      });

      expect(await svc.checkForUpdate()).toBeNull();
    });

    it('does NOT call GitHub when getGitHubRepo returns null', async () => {
      let called = false;
      const fakeFetch: typeof fetch = (async () => {
        called = true;
        return { ok: true, status: 200, json: async () => goodRelease };
      }) as any;

      const svc = createUpdaterService('0.4.0', {
        getGitHubRepo: () => null,
        fetch: fakeFetch,
      });

      const result = await svc.checkForUpdate();

      expect(called).toBe(false);
      expect(result).toBeNull();
    });

    it('does NOT call GitHub when getGitHubRepo returns empty string', async () => {
      let called = false;
      const fakeFetch: typeof fetch = (async () => {
        called = true;
        return { ok: true, status: 200, json: async () => goodRelease };
      }) as any;

      const svc = createUpdaterService('0.4.0', {
        getGitHubRepo: () => '',
        fetch: fakeFetch,
      });

      await svc.checkForUpdate();

      expect(called).toBe(false);
    });

    it('writes a debug log entry when the GitHub fetch fails', async () => {
      const collected: any[] = [];
      const fakeLogger: any = {
        writeBatch: (entries: any[]) => collected.push(...entries),
        query: () => { throw new Error('not used'); },
        count: () => { throw new Error('not used'); },
        prune: () => { throw new Error('not used'); },
      };
      const svc = createUpdaterService('0.4.0', {
        getGitHubRepo: () => 'greychrist/omnifex',
        fetch: makeFetchThrows('ENOTFOUND'),
        logging: fakeLogger,
      });

      await svc.checkForUpdate();

      const match = collected.find(
        (e) => String(e.source) === 'updater' && /github|fetch/i.test(String(e.message)),
      );
      expect(match).toBeDefined();
      expect(match.level).toBe('debug');
    });
  });

  describe('downloadUpdate()', () => {
    it('streams the URL via downloadFile and reports progress', async () => {
      const progressEvents: { percent: number; bytesDownloaded: number; totalBytes: number }[] = [];
      const downloadCalls: { url: string; destPath: string }[] = [];

      const svc = createUpdaterService('0.4.0', {
        getGitHubRepo: () => 'greychrist/omnifex',
        tmpdir: () => '/tmp/fake',
        downloadFile: async ({ url, destPath, onProgress }) => {
          downloadCalls.push({ url, destPath });
          onProgress(50, 100);
          onProgress(100, 100);
        },
      });

      const result = await svc.downloadUpdate(
        'https://github.com/greychrist/omnifex/releases/download/v0.4.42/OmniFex-darwin-arm64-0.4.42.zip',
        (data) => progressEvents.push(data),
        'OmniFex-darwin-arm64-0.4.42.zip',
      );

      expect(downloadCalls).toHaveLength(1);
      expect(downloadCalls[0].url).toContain('OmniFex-darwin-arm64-0.4.42.zip');
      expect(downloadCalls[0].destPath).toBe('/tmp/fake/OmniFex-darwin-arm64-0.4.42.zip');
      expect(result).toBe(downloadCalls[0].destPath);
      expect(progressEvents.length).toBeGreaterThanOrEqual(2);
      expect(progressEvents[progressEvents.length - 1].percent).toBe(100);
    });

    it('derives the destination filename from the URL when assetName is omitted', async () => {
      const downloadCalls: { destPath: string }[] = [];
      const svc = createUpdaterService('0.4.0', {
        getGitHubRepo: () => 'greychrist/omnifex',
        tmpdir: () => '/tmp/fake',
        downloadFile: async ({ destPath, onProgress }) => {
          downloadCalls.push({ destPath });
          onProgress(100, 100);
        },
      });

      await svc.downloadUpdate(
        'https://github.com/greychrist/omnifex/releases/download/v0.4.42/OmniFex-darwin-arm64-0.4.42.zip',
        () => {},
      );

      expect(downloadCalls[0].destPath).toMatch(/OmniFex-darwin-arm64-0\.4\.42\.zip$/);
    });
  });
});
