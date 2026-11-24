import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { gitBinary } from '../services/git-binary';

// A bare 'git' makes libuv on macOS posix_spawn once per PATH entry until one
// succeeds, and XNU creates a process for every miss — measured at 11 pids per
// `git status` with the daemon's PATH, against 1 for an absolute path. The
// lookup itself is util/spawn.ts's resolveCommand, tested there.

describe('gitBinary', () => {
  const dirs: string[] = [];
  const savedPath = process.env.PATH;
  afterEach(() => {
    process.env.PATH = savedPath;
    for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  });

  function dir(): string {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-gitbin-'));
    dirs.push(d);
    return d;
  }

  it('returns the absolute git on process.env.PATH', () => {
    const good = dir();
    fs.writeFileSync(path.join(good, 'git'), '#!/bin/sh\n', { mode: 0o755 });
    process.env.PATH = good;
    expect(gitBinary()).toBe(path.join(good, 'git'));
  });

  it('falls back to /usr/bin/git, never a bare name, when nothing on PATH has one', () => {
    process.env.PATH = dir();
    expect(gitBinary()).toBe('/usr/bin/git');
  });
});
