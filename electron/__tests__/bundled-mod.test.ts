// @vitest-environment node
//
// The bundled mod ships in the app (Contents/Resources/omnifex-mod) but the
// CLI writes types and a tsconfig into any mod dir it loads, so sessions load
// an installed copy under the state dir instead. These pin where the source is
// found, how the copy is kept current, and that nothing here can fail a spawn.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import {
  BUNDLED_MOD_FILES,
  candidateBundledModSources,
  createBundledModPluginDirs,
  installBundledMod,
  resolveBundledModSource,
} from '../services/bundled-mod';
import { PROGRESS_MOD_ENABLED_KEY } from '../../src/lib/progressModSettings';

let tmp: string;

function writeSource(root: string, marker = 'v1'): string {
  const src = path.join(root, 'omnifex-mod');
  for (const rel of BUNDLED_MOD_FILES) {
    fs.mkdirSync(path.dirname(path.join(src, rel)), { recursive: true });
    fs.writeFileSync(path.join(src, rel), `${rel} ${marker}`);
  }
  return src;
}

beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'omnifex-bundled-mod-')); });
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

describe('resolveBundledModSource', () => {
  it('looks beside the repo build and beside a packaged app.asar', () => {
    expect(candidateBundledModSources('/repo/.vite/build')).toEqual(['/repo/omnifex-mod', '/omnifex-mod']);
    expect(candidateBundledModSources('/A/OmniFex.app/Contents/Resources/app.asar/.vite/build')).toEqual([
      '/A/OmniFex.app/Contents/Resources/app.asar/omnifex-mod',
      '/A/OmniFex.app/Contents/Resources/omnifex-mod',
    ]);
  });

  it('picks the first candidate with a plugin manifest, else null', () => {
    const only = (p: string) => p === '/A/OmniFex.app/Contents/Resources/omnifex-mod/.claude-plugin/plugin.json';
    expect(resolveBundledModSource('/A/OmniFex.app/Contents/Resources/app.asar/.vite/build', only))
      .toBe('/A/OmniFex.app/Contents/Resources/omnifex-mod');
    expect(resolveBundledModSource('/repo/.vite/build', () => false)).toBeNull();
  });
});

describe('installBundledMod', () => {
  it('copies every mod file into the destination', () => {
    const src = writeSource(tmp);
    const dest = path.join(tmp, 'state', 'mod', 'omnifex');
    installBundledMod(src, dest);
    for (const rel of BUNDLED_MOD_FILES) {
      expect(fs.readFileSync(path.join(dest, rel), 'utf8')).toBe(`${rel} v1`);
    }
  });

  it('leaves an unchanged file alone, so the CLI sees no edit', () => {
    const src = writeSource(tmp);
    const dest = path.join(tmp, 'dest');
    installBundledMod(src, dest);
    const target = path.join(dest, 'hooks', 'register.ts');
    const old = new Date('2020-01-01T00:00:00Z');
    fs.utimesSync(target, old, old);
    installBundledMod(src, dest);
    expect(fs.statSync(target).mtime.getTime()).toBe(old.getTime());
  });

  it('replaces a file whose source changed (an app update)', () => {
    const dest = path.join(tmp, 'dest');
    installBundledMod(writeSource(tmp, 'v1'), dest);
    installBundledMod(writeSource(tmp, 'v2'), dest);
    expect(fs.readFileSync(path.join(dest, 'hooks', 'register.ts'), 'utf8')).toBe('hooks/register.ts v2');
  });

  it('leaves what the CLI wrote beside the mod alone', () => {
    const src = writeSource(tmp);
    const dest = path.join(tmp, 'dest');
    installBundledMod(src, dest);
    fs.writeFileSync(path.join(dest, 'tsconfig.json'), '{}');
    installBundledMod(src, dest);
    expect(fs.existsSync(path.join(dest, 'tsconfig.json'))).toBe(true);
  });
});

describe('createBundledModPluginDirs', () => {
  function setup(stored: string | null = null) {
    writeSource(tmp);
    const getSetting = vi.fn((key: string) => (key === PROGRESS_MOD_ENABLED_KEY ? stored : null));
    const warn = vi.fn();
    const dirs = createBundledModPluginDirs({
      getSetting,
      bundleDir: path.join(tmp, '.vite', 'build'),
      stateDir: path.join(tmp, 'state'),
      warn,
    });
    return { dirs, getSetting, warn, dest: path.join(tmp, 'state', 'mod', 'omnifex') };
  }

  it('installs the mod and names the installed copy', () => {
    const { dirs, dest } = setup();
    expect(dirs()).toEqual([dest]);
    expect(fs.existsSync(path.join(dest, '.claude-plugin', 'plugin.json'))).toBe(true);
  });

  it('names nothing when Agent step progress is switched off, read at each spawn', () => {
    const { dirs, getSetting, dest } = setup('false');
    expect(dirs()).toEqual([]);
    getSetting.mockImplementation(() => 'true');
    expect(dirs()).toEqual([dest]);
  });

  it('names nothing, and says why, when the app carries no mod', () => {
    const warn = vi.fn();
    const dirs = createBundledModPluginDirs({
      getSetting: () => null,
      bundleDir: path.join(tmp, 'nowhere', '.vite', 'build'),
      stateDir: path.join(tmp, 'state'),
      warn,
    });
    expect(dirs()).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('names nothing when the state dir cannot be written', () => {
    writeSource(tmp);
    const blocker = path.join(tmp, 'file-not-dir');
    fs.writeFileSync(blocker, '');
    const warn = vi.fn();
    const dirs = createBundledModPluginDirs({
      getSetting: () => null,
      bundleDir: path.join(tmp, '.vite', 'build'),
      stateDir: blocker,
      warn,
    });
    expect(dirs()).toEqual([]);
    expect(warn).toHaveBeenCalled();
  });

  it('installs once per process, not once per spawn', () => {
    const { dirs, dest } = setup();
    dirs();
    fs.rmSync(path.join(dest, 'hooks', 'register.ts'));
    dirs();
    expect(fs.existsSync(path.join(dest, 'hooks', 'register.ts'))).toBe(false);
  });
});
