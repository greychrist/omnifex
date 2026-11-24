// An explicit `webRoot` always wins, even if missing: a typo should surface as 404s, not a silent fallback.
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

export function candidateWebRoots(bundleDir: string): string[] {
  return [
    resolve(bundleDir, '..', '..', 'dist-web'),
    resolve(bundleDir, '..', '..', '..', 'dist-web'),
  ];
}

export function resolveWebRoot(
  configured: string | null,
  bundleDir: string,
  exists: (p: string) => boolean = existsSync,
): string | null {
  if (configured) return configured;
  for (const c of candidateWebRoots(bundleDir)) {
    if (exists(join(c, 'index.html'))) return c;
  }
  return null;
}
