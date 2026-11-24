/**
 * Resolved the way Node will: nearest `node_modules` walking up, so a nested (non-hoisted) copy wins
 * and the packaged layout mirrors the repo's.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

export interface PackageManifest {
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
}

export interface ModuleTreeFs {
  hasPackage(dir: string): boolean;
  readPackage(dir: string): PackageManifest;
}

const realFs: ModuleTreeFs = {
  hasPackage: (dir) => existsSync(join(dir, 'package.json')),
  readPackage: (dir) => JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as PackageManifest,
};

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
 * Missing optional dependencies are skipped (`ws` lists `bufferutil` that way). A missing required one
 * throws here, at packaging, rather than at runtime.
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
