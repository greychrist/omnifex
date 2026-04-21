import { describe, it, expect, vi } from 'vitest';
import { createSdkVersionService, type SdkVersionDeps } from '../services/sdk-version';

function makeDeps(overrides: Partial<SdkVersionDeps> = {}): SdkVersionDeps {
  return {
    readSdkPackageJson: vi.fn(async () => ({ version: '0.2.116' })),
    fetchLatestVersion: vi.fn(async () => '0.2.116'),
    ...overrides,
  };
}

describe('sdk-version service', () => {
  describe('getReferenced', () => {
    it('returns the version from the SDK package.json', async () => {
      const svc = createSdkVersionService(makeDeps());
      expect(await svc.getReferenced()).toBe('0.2.116');
    });

    it('returns null when the package.json has no version field', async () => {
      const svc = createSdkVersionService(
        makeDeps({ readSdkPackageJson: vi.fn(async () => ({})) }),
      );
      expect(await svc.getReferenced()).toBeNull();
    });

    it('returns null when the package.json cannot be read', async () => {
      const svc = createSdkVersionService(
        makeDeps({ readSdkPackageJson: vi.fn(async () => null) }),
      );
      expect(await svc.getReferenced()).toBeNull();
    });

    it('returns null when read throws', async () => {
      const svc = createSdkVersionService(
        makeDeps({
          readSdkPackageJson: vi.fn(async () => {
            throw new Error('nope');
          }),
        }),
      );
      expect(await svc.getReferenced()).toBeNull();
    });
  });

  describe('getLatest', () => {
    it('returns the latest version from npm', async () => {
      const svc = createSdkVersionService(
        makeDeps({ fetchLatestVersion: vi.fn(async () => '0.2.200') }),
      );
      expect(await svc.getLatest()).toBe('0.2.200');
    });

    it('returns null when fetch rejects', async () => {
      const svc = createSdkVersionService(
        makeDeps({
          fetchLatestVersion: vi.fn(async () => {
            throw new Error('network down');
          }),
        }),
      );
      expect(await svc.getLatest()).toBeNull();
    });

    it('returns null when fetch returns an empty string', async () => {
      const svc = createSdkVersionService(
        makeDeps({ fetchLatestVersion: vi.fn(async () => '') }),
      );
      expect(await svc.getLatest()).toBeNull();
    });
  });
});
