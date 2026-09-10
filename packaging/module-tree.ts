/**
 * Which `node_modules` directories a set of externalised packages needs at
 * runtime, resolved the way Node will resolve them: nearest `node_modules`
 * walking up from the requiring package, so a nested (non-hoisted) copy is
 * found before a hoisted one and the packaged layout mirrors the repo's.
 *
 * The Forge Vite plugin ships nothing from `node_modules` — Vite bundles the
 * main process — so every package left `external` in vite.main.config.ts
 * must be copied into the app by hand, dependencies included. This used to
 * be a hard-coded list per module (better-sqlite3, bindings, …), which is
 * fine for two packages with three deps and wrong the first time a pure-JS
 * dependency tree (web-push: fifteen packages) had to ship. The daemon died
 * at launch in the first packaged build with `Cannot find module 'ws'`.
 *
 * Pure: file access is injected so the walk is testable on a fake tree.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

export interface PackageManifest {
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
}

export interface ModuleTreeFs {
  /** Whether `<dir>/package.json` exists. */
  hasPackage(dir: string): boolean;
  readPackage(dir: string): PackageManifest;
}

const realFs: ModuleTreeFs = {
  hasPackage: (dir) => existsSync(join(dir, 'package.json')),
  readPackage: (dir) => JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as PackageManifest,
};

/** Node's lookup: `<from>/node_modules/<name>`, then the parent's, up to `root`. */
function locate(name: string, from: string, root: string, fs: ModuleTreeFs): string | null {
  let dir = from;
  for (;;) {
    const candidate = join(dir, 'node_modules', name);
    if (fs.hasPackage(candidate)) return candidate;
    if (dir === root) return null;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * Every package directory reachable from `roots` through `dependencies`,
 * as paths relative to `root` (e.g. `node_modules/ws`,
 * `node_modules/web-push/node_modules/minimist`). Missing optional
 * dependencies are skipped — `ws` lists `bufferutil` that way and it is not
 * installed. A missing required dependency throws: shipping it would fail at
 * runtime, and the packaging step is where that belongs.
 */
export function collectModuleTree(roots: string[], root: string, fs: ModuleTreeFs = realFs): string[] {
  const absRoot = resolve(root);
  const seen = new Set<string>();

  function walk(name: string, from: string, requiredBy: string): void {
    const dir = locate(name, from, absRoot, fs);
    if (!dir) throw new Error(`packaging: cannot resolve '${name}' required by ${requiredBy}`);
    if (seen.has(dir)) return;
    seen.add(dir);
    const manifest = fs.readPackage(dir);
    const optional = new Set(Object.keys(manifest.optionalDependencies ?? {}));
    for (const dep of Object.keys(manifest.dependencies ?? {})) {
      if (optional.has(dep) && !locate(dep, dir, absRoot, fs)) continue;
      walk(dep, dir, relative(absRoot, dir) || name);
    }
    for (const dep of optional) {
      if (locate(dep, dir, absRoot, fs)) walk(dep, dir, relative(absRoot, dir) || name);
    }
  }

  for (const name of roots) walk(name, absRoot, 'package.json');
  return [...seen].map((d) => relative(absRoot, d)).sort();
}
