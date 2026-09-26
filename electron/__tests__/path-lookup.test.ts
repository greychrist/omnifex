import { describe, it, expect, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const spawned = vi.hoisted(() => [] as string[]);
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  const record = (name: string) => (...a: unknown[]) => { spawned.push(`${name} ${String(a[0])}`); throw new Error('no spawning in a PATH lookup'); };
  return { ...actual, execSync: record('execSync'), execFileSync: record('execFileSync'), spawnSync: record('spawnSync') };
});

import { findOnPath } from '../services/util/path-lookup';
import { discoverClaudeBinary } from '../services/claude-binary';

// `which` through a shell is two processes to answer what a few stat calls
// can. See git-binary.ts for why every process counts on macOS.

describe('findOnPath', () => {
  const dirs: string[] = [];
  const realPath = process.env.PATH;
  afterEach(() => {
    process.env.PATH = realPath;
    spawned.length = 0;
    for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  });

  function dir(): string {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-pathlookup-'));
    dirs.push(d);
    return d;
  }

  it('returns the first executable match, skipping missing dirs, non-executables and directories', () => {
    const notExec = dir();
    fs.writeFileSync(path.join(notExec, 'tool'), '', { mode: 0o644 });
    const isDir = dir();
    fs.mkdirSync(path.join(isDir, 'tool'));
    const good = dir();
    fs.writeFileSync(path.join(good, 'tool'), '', { mode: 0o755 });
    const PATH = ['/nonexistent-gc', '', notExec, isDir, good].join(path.delimiter);
    expect(findOnPath('tool', PATH)).toBe(path.join(good, 'tool'));
  });

  it('returns null when nothing matches', () => {
    expect(findOnPath('tool', dir())).toBeNull();
    expect(findOnPath('tool', undefined)).toBeNull();
  });

  it('discoverClaudeBinary finds claude on PATH without spawning `which`', () => {
    const bin = dir();
    fs.writeFileSync(path.join(bin, 'claude'), '', { mode: 0o755 });
    process.env.PATH = bin;
    expect(discoverClaudeBinary()).toBe(path.join(bin, 'claude'));
    expect(spawned).toEqual([]);
  });
});
