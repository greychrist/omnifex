/**
 * The web bundle has to know its own version.
 *
 * It is served by one specific daemon build, so "which build is this page?"
 * is a real, answerable question — and the answer is what the daemon popover
 * compares against. Before this define existed the shim answered the literal
 * string `web`, which never equals a version number, so the popover's
 * version-mismatch warning was on permanently.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

import webConfig from '../../../../vite.web.config';

const pkg = JSON.parse(readFileSync(new URL('../../../../package.json', import.meta.url), 'utf8')) as { version: string };

describe('web build', () => {
  it('bakes the package version into the bundle', () => {
    const define = (webConfig as { define?: Record<string, unknown> }).define;
    expect(define?.__APP_VERSION__).toBe(JSON.stringify(pkg.version));
  });
});
