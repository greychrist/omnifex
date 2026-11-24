import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runCliOnce, stopInternalRuns } from '../services/sessions/summary-query';

describe('stopInternalRuns', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'omnifex-runstop-')); });
  afterEach(() => {
    stopInternalRuns();
    rmSync(dir, { recursive: true, force: true });
  });

  function sleepyClaude(): string {
    const bin = join(dir, 'claude');
    writeFileSync(bin, '#!/bin/sh\nexec sleep 30\n', { mode: 0o755 });
    return bin;
  }

  it('stops a run in flight, which then fails rather than hanging', async () => {
    const run = runCliOnce({ claudeBinary: sleepyClaude(), prompt: 'p', configDir: dir, cwd: dir });
    await new Promise((r) => setTimeout(r, 200));
    const started = Date.now();
    expect(stopInternalRuns()).toBe(1);
    await expect(run).rejects.toThrow(/SIGTERM/);
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it('forgets a run once it has finished', async () => {
    const bin = join(dir, 'claude');
    writeFileSync(bin, '#!/bin/sh\nprintf \'{"result":"ok"}\'\n', { mode: 0o755 });
    await runCliOnce({ claudeBinary: bin, prompt: 'p', configDir: dir, cwd: dir });
    expect(stopInternalRuns()).toBe(0);
  });
});
