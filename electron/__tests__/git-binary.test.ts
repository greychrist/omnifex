import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { resolveGitBinary } from '../services/git-binary';

// A bare 'git' makes libuv on macOS posix_spawn once per PATH entry until one
// succeeds, and XNU creates a process for every miss — measured at 11 pids per
// `git status` with the daemon's PATH, against 1 for an absolute path.

describe('resolveGitBinary', () => {
  const dirs: string[] = [];
  afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });

  function dir(): string {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-gitbin-'));
    dirs.push(d);
    return d;
  }

  it('returns the first executable git on PATH, skipping missing dirs, non-executables and directories', () => {
    const missing = path.join(os.tmpdir(), 'gc-gitbin-does-not-exist');
    const notExec = dir();
    fs.writeFileSync(path.join(notExec, 'git'), '#!/bin/sh\n', { mode: 0o644 });
    const isDir = dir();
    fs.mkdirSync(path.join(isDir, 'git'));
    const good = dir();
    fs.writeFileSync(path.join(good, 'git'), '#!/bin/sh\n', { mode: 0o755 });
    const later = dir();
    fs.writeFileSync(path.join(later, 'git'), '#!/bin/sh\n', { mode: 0o755 });

    const PATH = [missing, '', notExec, isDir, good, later].join(path.delimiter);
    expect(resolveGitBinary(PATH)).toBe(path.join(good, 'git'));
  });

  it("falls back to a bare 'git' when nothing on PATH has one", () => {
    expect(resolveGitBinary(dir())).toBe('git');
    expect(resolveGitBinary(undefined)).toBe('git');
  });
});
