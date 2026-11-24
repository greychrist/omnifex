import { describe, it, expect } from 'vitest';

import { candidateWebRoots, resolveWebRoot } from '../remote/webroot';

describe('web root resolution', () => {
  it('looks beside the repo build and beside a packaged app.asar', () => {
    expect(candidateWebRoots('/repo/.vite/build')).toEqual(['/repo/dist-web', '/dist-web']);
    expect(candidateWebRoots('/Applications/OmniFex.app/Contents/Resources/app.asar/.vite/build')).toEqual([
      '/Applications/OmniFex.app/Contents/Resources/app.asar/dist-web',
      '/Applications/OmniFex.app/Contents/Resources/dist-web',
    ]);
  });

  it('prefers an explicit webRoot even when it does not exist', () => {
    expect(resolveWebRoot('/srv/web', '/repo/.vite/build', () => false)).toBe('/srv/web');
  });

  it('picks the first candidate that has an index.html, else null', () => {
    const only = (p: string) => p === '/Applications/OmniFex.app/Contents/Resources/dist-web/index.html';
    expect(resolveWebRoot(null, '/Applications/OmniFex.app/Contents/Resources/app.asar/.vite/build', only)).toBe(
      '/Applications/OmniFex.app/Contents/Resources/dist-web',
    );
    expect(resolveWebRoot(null, '/repo/.vite/build', () => false)).toBeNull();
  });
});
