/**
 * Where the web client's static files are, when the config does not say.
 *
 * `npm run build:web` writes `dist-web/` at the repo root; the packaged app
 * carries it as an extra resource beside app.asar. Both are found relative to
 * the daemon bundle (`.vite/build/omnifex-server.js`):
 *
 *   repo:      <repo>/.vite/build/omnifex-server.js         → <repo>/dist-web
 *   packaged:  Contents/Resources/app.asar/.vite/build/…     → Contents/Resources/dist-web
 *
 * An explicit `webRoot` in server.json always wins, even if it does not
 * exist — a typo should surface as 404s, not as a silent fallback to a build
 * the user was not expecting to serve.
 */
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
