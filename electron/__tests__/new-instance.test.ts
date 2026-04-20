import { describe, it, expect } from 'vitest';
import { resolveAppBundlePath, launchNewInstance } from '../new-instance';

describe('resolveAppBundlePath', () => {
  it('returns the .app bundle path from a packaged macOS execPath', () => {
    expect(
      resolveAppBundlePath('/Applications/GreyChrist.app/Contents/MacOS/GreyChrist'),
    ).toBe('/Applications/GreyChrist.app');
  });

  it('returns the bundle path even when the user renamed the app', () => {
    expect(
      resolveAppBundlePath('/Applications/GreyChrist 2.app/Contents/MacOS/GreyChrist'),
    ).toBe('/Applications/GreyChrist 2.app');
  });

  it('returns the first .app when nested paths contain multiple', () => {
    expect(
      resolveAppBundlePath('/Users/me/Outer.app/Contents/Inner.app/Contents/MacOS/X'),
    ).toBe('/Users/me/Outer.app');
  });

  it('returns null when execPath has no .app bundle (dev mode)', () => {
    expect(
      resolveAppBundlePath('/Users/me/proj/node_modules/electron/dist/Electron'),
    ).toBeNull();
  });

  it('returns null for empty input', () => {
    expect(resolveAppBundlePath('')).toBeNull();
  });
});

describe('launchNewInstance', () => {
  it('refuses on non-darwin platforms', () => {
    const spawned: Array<[string, string[]]> = [];
    const result = launchNewInstance({
      platform: 'linux',
      isPackaged: true,
      execPath: '/opt/greychrist/greychrist',
      spawn: (cmd, args) => spawned.push([cmd, args]),
    });
    expect(result.ok).toBe(false);
    expect(spawned).toHaveLength(0);
  });

  it('refuses in dev mode (isPackaged false)', () => {
    const spawned: Array<[string, string[]]> = [];
    const result = launchNewInstance({
      platform: 'darwin',
      isPackaged: false,
      execPath: '/Users/me/proj/node_modules/electron/dist/Electron',
      spawn: (cmd, args) => spawned.push([cmd, args]),
    });
    expect(result.ok).toBe(false);
    expect(spawned).toHaveLength(0);
  });

  it('refuses when .app bundle cannot be located', () => {
    const spawned: Array<[string, string[]]> = [];
    const result = launchNewInstance({
      platform: 'darwin',
      isPackaged: true,
      execPath: '/weird/exec/path/without/bundle',
      spawn: (cmd, args) => spawned.push([cmd, args]),
    });
    expect(result.ok).toBe(false);
    expect(spawned).toHaveLength(0);
  });

  it('spawns `open -n <bundle>` on packaged macOS', () => {
    const spawned: Array<[string, string[]]> = [];
    const result = launchNewInstance({
      platform: 'darwin',
      isPackaged: true,
      execPath: '/Applications/GreyChrist.app/Contents/MacOS/GreyChrist',
      spawn: (cmd, args) => spawned.push([cmd, args]),
    });
    expect(result.ok).toBe(true);
    expect(spawned).toEqual([['open', ['-n', '/Applications/GreyChrist.app']]]);
  });
});
