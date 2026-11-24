import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runCliOnce } from '../services/sessions/summary-query';

// argv cannot carry a NUL byte and Node refuses the spawn, so this spawns a
// real stand-in.
describe('runCliOnce with a NUL in the prompt', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'omnifex-runcli-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  /** Replies with how many bytes its prompt (`-p <prompt>`) had. */
  function fakeClaude(): string {
    const bin = join(dir, 'claude');
    writeFileSync(bin, '#!/bin/sh\nn=$(printf %s "$2" | wc -c | tr -d " ")\nprintf \'{"result":"%s"}\' "$n"\n', { mode: 0o755 });
    return bin;
  }

  it('drops the NUL bytes instead of failing the spawn', async () => {
    const out = await runCliOnce({ claudeBinary: fakeClaude(), prompt: 'ab\0cd\0', configDir: dir, cwd: dir });
    expect(out.result).toBe('4');
  });
});
