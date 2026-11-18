import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Installed version of a package, from the lockfile the build installs. */
function locked(name: string): string {
  const lock = JSON.parse(readFileSync(join(__dirname, '..', '..', 'package-lock.json'), 'utf8')) as {
    packages: Record<string, { version?: string }>;
  };
  const v = lock.packages[`node_modules/${name}`]?.version;
  if (!v) throw new Error(`${name} is not in package-lock.json`);
  return v;
}

function atLeast(version: string, floor: string): boolean {
  const a = version.split('.').map(Number);
  const b = floor.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  }
  return true;
}

// Security floors for transitive dependencies, so a lockfile regeneration
// cannot quietly reinstall a vulnerable release.
describe('dependency security floors', () => {
  // GHSA-cg2g-xh64-v4q7 (critical): SAFE_FOR_TEMPLATES bypass in DOM output
  // modes, 3.4.4–3.4.16. Reached through mermaid. Mermaid does not use those
  // options, but the floor costs nothing (2026-11-18).
  it('keeps dompurify at 3.4.17 or later', () => {
    expect(atLeast(locked('dompurify'), '3.4.17')).toBe(true);
  });
});
