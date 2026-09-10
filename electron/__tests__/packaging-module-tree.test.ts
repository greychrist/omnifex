import { describe, it, expect } from 'vitest';
import { join } from 'node:path';

import { collectModuleTree, type ModuleTreeFs, type PackageManifest } from '../../packaging/module-tree';

const ROOT = '/repo';

/** A fake node_modules: path relative to the repo → package.json. */
function tree(packages: Record<string, PackageManifest>): ModuleTreeFs {
  const dirs = new Map(Object.entries(packages).map(([rel, m]) => [join(ROOT, rel), m]));
  return {
    hasPackage: (dir) => dirs.has(dir),
    readPackage: (dir) => {
      const m = dirs.get(dir);
      if (!m) throw new Error(`no package at ${dir}`);
      return m;
    },
  };
}

describe('collectModuleTree', () => {
  it('walks transitive dependencies from the hoisted node_modules', () => {
    const fs = tree({
      'node_modules/web-push': { dependencies: { jws: '^4', minimist: '^1' } },
      'node_modules/jws': { dependencies: { jwa: '^2' } },
      'node_modules/jwa': {},
      'node_modules/minimist': {},
      'node_modules/unrelated': {},
    });
    expect(collectModuleTree(['web-push'], ROOT, fs)).toEqual([
      'node_modules/jwa',
      'node_modules/jws',
      'node_modules/minimist',
      'node_modules/web-push',
    ]);
  });

  it('prefers a nested copy over a hoisted one, like Node does', () => {
    const fs = tree({
      'node_modules/web-push': { dependencies: { debug: '^4' } },
      'node_modules/web-push/node_modules/debug': { dependencies: { ms: '^2' } },
      'node_modules/debug': { dependencies: { ms: '^2' } },
      'node_modules/ms': {},
    });
    expect(collectModuleTree(['web-push'], ROOT, fs)).toEqual([
      'node_modules/ms',
      'node_modules/web-push',
      'node_modules/web-push/node_modules/debug',
    ]);
  });

  it('skips optional dependencies that are not installed', () => {
    const fs = tree({
      'node_modules/ws': { optionalDependencies: { bufferutil: '^4', 'utf-8-validate': '^6' } },
    });
    expect(collectModuleTree(['ws'], ROOT, fs)).toEqual(['node_modules/ws']);
  });

  it('includes optional dependencies that are installed', () => {
    const fs = tree({
      'node_modules/ws': { optionalDependencies: { bufferutil: '^4' } },
      'node_modules/bufferutil': {},
    });
    expect(collectModuleTree(['ws'], ROOT, fs)).toEqual(['node_modules/bufferutil', 'node_modules/ws']);
  });

  it('throws on a missing required dependency rather than shipping a broken package', () => {
    const fs = tree({
      'node_modules/web-push': { dependencies: { jws: '^4' } },
    });
    expect(() => collectModuleTree(['web-push'], ROOT, fs)).toThrow(/cannot resolve 'jws' required by node_modules\/web-push/);
  });

  it('throws when a root itself is missing', () => {
    expect(() => collectModuleTree(['ws'], ROOT, tree({}))).toThrow(/cannot resolve 'ws' required by package.json/);
  });

  it('visits a shared dependency once', () => {
    const fs = tree({
      'node_modules/a': { dependencies: { shared: '^1' } },
      'node_modules/b': { dependencies: { shared: '^1' } },
      'node_modules/shared': {},
    });
    expect(collectModuleTree(['a', 'b'], ROOT, fs)).toEqual(['node_modules/a', 'node_modules/b', 'node_modules/shared']);
  });

  it('resolves the real ws and web-push trees from this repo', () => {
    const dirs = collectModuleTree(['ws', 'web-push'], join(__dirname, '..', '..'));
    expect(dirs).toContain('node_modules/ws');
    expect(dirs).toContain('node_modules/web-push');
    expect(dirs.length).toBeGreaterThan(2);
  });
});
