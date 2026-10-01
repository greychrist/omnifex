import { describe, it, expect, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ExecFileException } from 'node:child_process';

// A bare command name makes libuv on macOS posix_spawn once per PATH entry
// until one succeeds; XNU creates a process for every miss and syspolicyd logs
// each one. `limactl` polled every 5 s cost 18 syspolicyd lines per tick.

const execFileCalls = vi.hoisted(() => [] as { file: string; args: string[]; opts: unknown }[]);
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    execFile: ((file: string, args: string[], opts: unknown, cb: unknown) => {
      execFileCalls.push({ file, args, opts });
      return (actual.execFile as (...a: unknown[]) => unknown)(file, args, opts, cb);
    }) as typeof actual.execFile,
  };
});

import { resolveCommand, execFileOnPath } from '../services/util/spawn';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  execFileCalls.length = 0;
});

function dir(): string {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gc-spawn-')));
  dirs.push(d);
  return d;
}

function install(d: string, name: string, body = '#!/bin/sh\necho ok\n'): string {
  const p = path.join(d, name);
  fs.writeFileSync(p, body, { mode: 0o755 });
  return p;
}

let n = 0;
/** Each test gets its own command name — the cache is module-wide. */
const freshName = () => `gc-tool-${process.pid}-${++n}`;

describe('resolveCommand', () => {
  it('returns the first executable on PATH, skipping missing dirs, non-executables and directories', () => {
    const name = freshName();
    const notExec = dir();
    fs.writeFileSync(path.join(notExec, name), '#!/bin/sh\n', { mode: 0o644 });
    const isDir = dir();
    fs.mkdirSync(path.join(isDir, name));
    const good = dir();
    const later = dir();
    install(later, name);
    const expected = install(good, name);
    const PATH = [path.join(os.tmpdir(), 'gc-spawn-missing'), '', notExec, isDir, good, later].join(path.delimiter);
    expect(resolveCommand(name, PATH)).toBe(expected);
  });

  it('passes an absolute path through untouched — a single spawn attempt', () => {
    expect(resolveCommand('/no/such/tool', '/usr/bin')).toBe('/no/such/tool');
  });

  it('returns null when nothing on PATH has it, and never caches the miss', () => {
    const name = freshName();
    const d = dir();
    expect(resolveCommand(name, d)).toBeNull();
    const installed = install(d, name);
    expect(resolveCommand(name, d)).toBe(installed);
  });

  it('re-resolves when the cached binary disappears', () => {
    const name = freshName();
    const first = dir();
    const second = dir();
    const PATH = [first, second].join(path.delimiter);
    const a = install(first, name);
    const b = install(second, name);
    expect(resolveCommand(name, PATH)).toBe(a);
    fs.rmSync(a);
    expect(resolveCommand(name, PATH)).toBe(b);
    fs.rmSync(b);
    expect(resolveCommand(name, PATH)).toBeNull();
  });

  it('re-resolves when PATH changes', () => {
    const name = freshName();
    const first = dir();
    const second = dir();
    const a = install(first, name);
    const b = install(second, name);
    expect(resolveCommand(name, first)).toBe(a);
    expect(resolveCommand(name, second)).toBe(b);
  });

  it('defaults to process.env.PATH — the login-shell PATH main and the daemon install at startup', () => {
    const name = freshName();
    const d = dir();
    const p = install(d, name);
    const saved = process.env.PATH;
    process.env.PATH = d;
    try {
      expect(resolveCommand(name)).toBe(p);
    } finally {
      process.env.PATH = saved;
    }
  });
});

describe('execFileOnPath', () => {
  it('spawns the absolute path, never the bare name', async () => {
    const name = freshName();
    const d = dir();
    const p = install(d, name);
    const stdout = await new Promise<string>((resolve, reject) => {
      execFileOnPath(name, [], { env: { PATH: d } }, (err, out) => { if (err) reject(err); else resolve(out); });
    });
    expect(stdout.trim()).toBe('ok');
    expect(execFileCalls.map((c) => c.file)).toEqual([p]);
  });

  it('searches the PATH in opts.env when one is given, as libuv would', async () => {
    const name = freshName();
    const d = dir();
    const p = install(d, name);
    await new Promise<void>((resolve) => {
      execFileOnPath(name, [], { env: { PATH: d } }, () => { resolve(); });
    });
    expect(execFileCalls[0]?.file).toBe(p);
  });

  it('fails with ENOENT without spawning anything when the command is not on PATH', async () => {
    const name = freshName();
    const err = await new Promise<ExecFileException | null>((resolve) => {
      execFileOnPath(name, ['--version'], { env: { PATH: dir() } }, (e) => { resolve(e); });
    });
    expect(err?.code).toBe('ENOENT');
    expect(err?.message).toContain(name);
    expect(execFileCalls).toEqual([]);
  });

  it('reports ENOENT asynchronously, like execFile', () => {
    let called = false;
    execFileOnPath(freshName(), [], { env: { PATH: dir() } }, () => { called = true; });
    expect(called).toBe(false);
  });
});
