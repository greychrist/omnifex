import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import {
  PROTOCOL_VERSION,
  decodeClientMessage,
  ServerMessageSchema,
} from '../../src/protocol';

const PROTOCOL_DIR = join(__dirname, '..', '..', 'src', 'protocol');

/**
 * The protocol is the ONE module the daemon and both clients share, so it has
 * to load under all three runtimes: Electron main, the renderer, and a plain
 * Node test process.
 *
 * This file is that claim under test from the main-process side. The import
 * above is the point of it — `tsconfig.electron.json` typechecks whatever
 * `electron/**` reaches into, so a DOM or React dependency added to the
 * protocol fails here and in `npm run check`, rather than in Phase 2 when the
 * daemon first tries to start.
 */
describe('protocol is shared, not renderer-only', () => {
  it('imports and runs from the main-process side', () => {
    expect(PROTOCOL_VERSION).toBe(1);

    const decoded = decodeClientMessage({ type: 'session.list', requestId: 'r1' });
    expect(decoded.ok).toBe(true);
  });

  it('round-trips a daemon push built here', () => {
    const push = {
      type: 'event' as const,
      sessionId: 's1',
      seq: 1,
      kind: 'transcript' as const,
      payload: { kind: 'assistant', raw: { type: 'assistant' } },
    };
    expect(ServerMessageSchema.parse(JSON.parse(JSON.stringify(push)))).toEqual(push);
  });

  it('imports nothing that ties it to a browser, React or Electron', () => {
    // Checked as source text rather than by loading, because a bad import can
    // resolve fine under vitest's aliases and still break a packaged daemon.
    const offenders = [
      /from ['"]react/,
      /from ['"]electron['"]/,
      /from ['"]@\/(?!protocol)/,
      /\bdocument\./,
      /\bwindow\./,
    ];

    const files = readdirSync(PROTOCOL_DIR).filter((f) => f.endsWith('.ts'));
    expect(files.length).toBeGreaterThan(0);

    for (const file of files) {
      const source = readFileSync(join(PROTOCOL_DIR, file), 'utf8');
      for (const pattern of offenders) {
        expect(pattern.test(source), `${file} matches ${String(pattern)}`).toBe(false);
      }
    }
  });
});
