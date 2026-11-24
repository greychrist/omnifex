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
