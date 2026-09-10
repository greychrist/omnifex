import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, it, expect } from 'vitest';

/**
 * `contextBridge.exposeInMainWorld` defines the property ReadOnly | DontDelete
 * on the main-world `window`. The OmniFex Remote bootstrap replaces
 * `window.electronAPI` with a WebSocket shim when a daemon is reachable, so
 * the preload must NOT be the one to define `electronAPI` — it publishes the
 * IPC bridge under `__omnifexNative` only, and `src/lib/remote/bootstrap.ts`
 * decides what `electronAPI` is. Verified 2026-09-10: exposing both made the
 * shim assignment throw and every launch fell back to legacy IPC.
 */
describe('preload exposure', () => {
  const source = readFileSync(resolve(__dirname, '../preload.ts'), 'utf8');
  const exposed = [...source.matchAll(/exposeInMainWorld\(\s*'([^']+)'/g)].map((m) => m[1]);

  it('publishes the bridge as __omnifexNative', () => {
    expect(exposed).toContain('__omnifexNative');
  });

  it('does not define electronAPI (read-only once contextBridge sets it)', () => {
    expect(exposed).not.toContain('electronAPI');
  });
});
