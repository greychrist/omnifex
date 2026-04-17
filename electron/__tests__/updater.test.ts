import { describe, it, expect } from 'vitest';
import { createUpdaterService } from '../services/updater';

// ---------------------------------------------------------------------------
// Helpers for the local-folder updater
// ---------------------------------------------------------------------------

/**
 * Build a fake readdir that returns the given filenames for one directory.
 * Real fs operations are never performed in tests.
 */
function makeReaddir(files: string[]): (dir: string) => Promise<string[]> {
  return async () => files;
}

/**
 * Build a fake readdir that throws ENOENT (directory does not exist).
 */
function makeMissingReaddir(): (dir: string) => Promise<string[]> {
  return async () => {
    const err = new Error('ENOENT: no such file or directory');
    (err as any).code = 'ENOENT';
    throw err;
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('updater service (local folder source)', () => {
  describe('checkForUpdate()', () => {
    it('returns null when no local update directory is configured', async () => {
      const svc = createUpdaterService('0.3.12', {
        getLocalUpdateDir: () => null,
        readdir: makeReaddir(['GreyChrist-0.4.0-arm64.dmg']), // should never be read
      });

      const result = await svc.checkForUpdate();

      expect(result).toBeNull();
    });

    it('returns null when local update directory is empty string', async () => {
      const svc = createUpdaterService('0.3.12', {
        getLocalUpdateDir: () => '',
        readdir: makeReaddir(['GreyChrist-0.4.0-arm64.dmg']),
      });

      const result = await svc.checkForUpdate();

      expect(result).toBeNull();
    });

    it('returns null when the local directory does not exist (ENOENT)', async () => {
      const svc = createUpdaterService('0.3.12', {
        getLocalUpdateDir: () => '/nonexistent/path',
        readdir: makeMissingReaddir(),
      });

      const result = await svc.checkForUpdate();

      expect(result).toBeNull();
    });

    it('writes a debug log entry when the configured update dir is unreadable', async () => {
      const collected: any[] = [];
      const fakeLogger: any = {
        writeBatch: (entries: any[]) => collected.push(...entries),
        query: () => { throw new Error('not used'); },
        count: () => { throw new Error('not used'); },
        prune: () => { throw new Error('not used'); },
      };

      const svc = createUpdaterService('0.3.12', {
        getLocalUpdateDir: () => '/nonexistent/path',
        readdir: makeMissingReaddir(),
        logging: fakeLogger,
      });

      await svc.checkForUpdate();

      const match = collected.find(
        (e) => String(e.source) === 'updater' && /local_update_dir|readdir|scan/i.test(String(e.message)),
      );
      expect(match).toBeDefined();
      expect(match.level).toBe('debug');
    });

    it('does NOT log when local_update_dir is disabled (null/empty)', async () => {
      const collected: any[] = [];
      const fakeLogger: any = {
        writeBatch: (entries: any[]) => collected.push(...entries),
        query: () => { throw new Error('not used'); },
        count: () => { throw new Error('not used'); },
        prune: () => { throw new Error('not used'); },
      };

      const svc = createUpdaterService('0.3.12', {
        getLocalUpdateDir: () => '',
        readdir: makeReaddir([]),
        logging: fakeLogger,
      });

      await svc.checkForUpdate();

      // Empty = deliberately disabled; don't spam the log panel on every check.
      expect(collected.length).toBe(0);
    });

    it('returns null when the directory contains no matching DMG files', async () => {
      const svc = createUpdaterService('0.3.12', {
        getLocalUpdateDir: () => '/tmp/updates',
        readdir: makeReaddir(['README.txt', 'random.dmg', 'GreyChrist.dmg']),
      });

      const result = await svc.checkForUpdate();

      expect(result).toBeNull();
    });

    it('returns null when all local DMGs are the same as or older than current version', async () => {
      const svc = createUpdaterService('0.3.12', {
        getLocalUpdateDir: () => '/tmp/updates',
        readdir: makeReaddir([
          'GreyChrist-0.3.10-arm64.dmg',
          'GreyChrist-0.3.11-arm64.dmg',
          'GreyChrist-0.3.12-arm64.dmg', // exact match to current
        ]),
      });

      const result = await svc.checkForUpdate();

      expect(result).toBeNull();
    });

    it('returns UpdateInfo for the newest DMG when one exists that is newer than current', async () => {
      const svc = createUpdaterService('0.3.12', {
        getLocalUpdateDir: () => '/tmp/updates',
        readdir: makeReaddir([
          'GreyChrist-0.3.10-arm64.dmg',
          'GreyChrist-0.3.12-arm64.dmg',
          'GreyChrist-0.4.0-arm64.dmg',
          'GreyChrist-0.3.15-arm64.dmg',
        ]),
      });

      const result = await svc.checkForUpdate();

      expect(result).not.toBeNull();
      expect(result!.available).toBe(true);
      expect(result!.version).toBe('0.4.0');
      expect(result!.assetName).toBe('GreyChrist-0.4.0-arm64.dmg');
      // downloadUrl is an absolute path to the local file (or a file:// URL)
      expect(result!.downloadUrl).toContain('GreyChrist-0.4.0-arm64.dmg');
      expect(result!.downloadUrl).toContain('/tmp/updates');
    });

    it('ignores files that do not match the GreyChrist-<semver>-arm64.dmg pattern', async () => {
      const svc = createUpdaterService('0.3.12', {
        getLocalUpdateDir: () => '/tmp/updates',
        readdir: makeReaddir([
          'GreyChrist-0.4.0-arm64.dmg',   // matches
          'GreyChrist-0.4.0.dmg',          // no -arm64 suffix
          'GreyChrist-foo-arm64.dmg',      // not semver
          'greychrist-0.4.0-arm64.dmg',    // lowercase
          'OtherApp-0.4.0-arm64.dmg',      // wrong name
          'GreyChrist-0.4.0-arm64.dmg.txt', // extra extension
        ]),
      });

      const result = await svc.checkForUpdate();

      expect(result).not.toBeNull();
      expect(result!.version).toBe('0.4.0');
    });

    it('supports version suffixes like 0.3.6a in filename parsing', async () => {
      // Filenames like `GreyChrist-0.3.6a-arm64.dmg` have shown up in the out/
      // folder historically; the updater should either parse them as 0.3.6 (ignoring
      // the suffix, like isNewer already does) or reject them — but not crash.
      const svc = createUpdaterService('0.3.12', {
        getLocalUpdateDir: () => '/tmp/updates',
        readdir: makeReaddir(['GreyChrist-0.3.6a-arm64.dmg']), // 0.3.6 < 0.3.12
      });

      const result = await svc.checkForUpdate();

      // Strict semver + older version → no update
      expect(result).toBeNull();
    });
  });

  describe('downloadUpdate()', () => {
    it('returns the local file path immediately (no network fetch)', async () => {
      const svc = createUpdaterService('0.3.12', {
        getLocalUpdateDir: () => '/tmp/updates',
        readdir: makeReaddir([]),
      });

      const progressCalls: Array<{ percent: number }> = [];
      const result = await svc.downloadUpdate(
        '/tmp/updates/GreyChrist-0.4.0-arm64.dmg',
        (data) => progressCalls.push(data),
      );

      expect(result).toBe('/tmp/updates/GreyChrist-0.4.0-arm64.dmg');
    });

    it('fires a single onProgress({ percent: 100 }) call for UI parity', async () => {
      const svc = createUpdaterService('0.3.12', {
        getLocalUpdateDir: () => '/tmp/updates',
        readdir: makeReaddir([]),
      });

      const progressCalls: Array<{ percent: number; bytesDownloaded: number; totalBytes: number }> = [];
      await svc.downloadUpdate(
        '/tmp/updates/GreyChrist-0.4.0-arm64.dmg',
        (data) => progressCalls.push(data),
      );

      expect(progressCalls).toHaveLength(1);
      expect(progressCalls[0].percent).toBe(100);
    });
  });
});
