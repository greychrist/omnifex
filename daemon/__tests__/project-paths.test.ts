import { mkdtempSync, mkdirSync, rmSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { decodeProjectId, recoverProjectPath, recoverProjectPathAsync, encodeProjectId } from '../services/project-paths';

/**
 * The encoding Claude Code applies to a cwd is lossy, so the only honest way
 * to render a project's folder is to read the `cwd` the CLI itself recorded.
 * These pin that recovery, and the fallback for when there is nothing to read.
 */

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'omnifex-project-paths-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function project(name: string): string {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function session(dir: string, file: string, lines: object[], mtimeSec?: number): void {
  const path = join(dir, file);
  writeFileSync(path, lines.map((l) => JSON.stringify(l)).join('\n'));
  if (mtimeSec !== undefined) utimesSync(path, mtimeSec, mtimeSec);
}

describe('decodeProjectId', () => {
  it('turns the encoded dir name back into an absolute path', () => {
    expect(decodeProjectId('-Users-greg-Repos-personal-omnifex'))
      .toBe('/Users/greg/Repos/personal/omnifex');
  });

  it('is lossy on a folder whose own name contains a dash', () => {
    // Documented, not desired: this is exactly why recoverProjectPath exists.
    expect(decodeProjectId('-Users-dev-Repos-wombeats-ios'))
      .toBe('/Users/dev/Repos/wombeats/ios');
  });
});

describe('recoverProjectPath', () => {
  it('reads the authoritative cwd out of a transcript', () => {
    const dir = project('-Users-dev-Repos-wombeats-ios');
    session(dir, 'a.jsonl', [{ type: 'user', cwd: '/Users/dev/Repos/wombeats-ios' }]);

    expect(recoverProjectPath(dir, '-Users-dev-Repos-wombeats-ios'))
      .toBe('/Users/dev/Repos/wombeats-ios');
  });

  it('prefers the newest transcript, so a renamed folder shows its new name', () => {
    const dir = project('-Users-dev-Repos-greychrist');
    session(dir, 'old.jsonl', [{ type: 'user', cwd: '/Users/dev/Repos/greychrist' }], 1_000);
    session(dir, 'new.jsonl', [{ type: 'user', cwd: '/Users/dev/Repos/omnifex' }], 2_000);

    expect(recoverProjectPath(dir, '-Users-dev-Repos-greychrist'))
      .toBe('/Users/dev/Repos/omnifex');
  });

  it('falls back to the naive decode when no transcript carries a cwd', () => {
    const dir = project('-Users-dev-Repos-thing');
    session(dir, 'a.jsonl', [{ type: 'summary' }]);

    expect(recoverProjectPath(dir, '-Users-dev-Repos-thing')).toBe('/Users/dev/Repos/thing');
  });

  it('falls back rather than throwing when the directory is gone', () => {
    expect(recoverProjectPath(join(root, 'missing'), '-Users-dev-x')).toBe('/Users/dev/x');
  });
});

// Same contract, without blocking the daemon: the sessions page runs it over
// every project folder in the account on each visit.
describe('recoverProjectPathAsync', () => {
  it('reads the cwd, preferring the newest transcript', async () => {
    const dir = project('-Users-dev-Repos-greychrist');
    session(dir, 'old.jsonl', [{ type: 'user', cwd: '/Users/dev/Repos/greychrist' }], 1_000);
    session(dir, 'new.jsonl', [{ type: 'user', cwd: '/Users/dev/Repos/omnifex' }], 2_000);
    expect(await recoverProjectPathAsync(dir, '-Users-dev-Repos-greychrist')).toBe('/Users/dev/Repos/omnifex');
  });

  it('falls back to the naive decode when no transcript carries a cwd, or the folder is gone', async () => {
    const dir = project('-Users-dev-Repos-thing');
    session(dir, 'a.jsonl', [{ type: 'summary' }]);
    expect(await recoverProjectPathAsync(dir, '-Users-dev-Repos-thing')).toBe('/Users/dev/Repos/thing');
    expect(await recoverProjectPathAsync(join(root, 'missing'), '-Users-dev-x')).toBe('/Users/dev/x');
  });
});

// Only the head of a transcript is read, in chunks — a line longer than one
// chunk (the CLI's prompt snapshot runs to tens of KB) must not hide the cwd.
describe('recoverProjectPath — head read', () => {
  for (const [name, recover] of [
    ['sync', (d: string, id: string) => Promise.resolve(recoverProjectPath(d, id))],
    ['async', recoverProjectPathAsync],
  ] as const) {
    it(`finds a cwd after a line longer than one read chunk (${name})`, async () => {
      const dir = project('-Users-dev-Repos-big');
      session(dir, 'a.jsonl', [
        { type: 'attachment', blob: 'x'.repeat(200_000) },
        { type: 'user', cwd: '/Users/dev/Repos/big' },
      ]);
      expect(await recover(dir, '-Users-dev-Repos-big')).toBe('/Users/dev/Repos/big');
    });

    it(`stops after the first 50 lines (${name})`, async () => {
      const dir = project('-Users-dev-Repos-late');
      session(dir, 'a.jsonl', [
        ...Array.from({ length: 60 }, () => ({ type: 'summary' })),
        { type: 'user', cwd: '/Users/dev/Repos/late-cwd' },
      ]);
      expect(await recover(dir, '-Users-dev-Repos-late')).toBe('/Users/dev/Repos/late');
    });
  }
});

describe('encodeProjectId', () => {
  // Mirrors the CLI's own sanitizer, verified against 2.1.224 in
  // sessions-summary-query.test.ts and re-confirmed against 2.1.240 by reading
  // Greg's on-disk projects/ dirs. Anything short of "every non-alphanumeric
  // becomes a dash" silently misses directories that exist.
  it('replaces every non-alphanumeric character, not just slashes', () => {
    expect(encodeProjectId('/home/user/projects/my_app.v2'))
      .toBe('-home-user-projects-my-app-v2');
    expect(encodeProjectId('/Users/g/Repos/pi-tuitive/.claude-worktrees/PI-390'))
      .toBe('-Users-g-Repos-pi-tuitive--claude-worktrees-PI-390');
    expect(encodeProjectId('/home/user/my project')).toBe('-home-user-my-project');
  });

  it('still encodes a plain path the obvious way', () => {
    expect(encodeProjectId('/Users/foo/bar')).toBe('-Users-foo-bar');
  });

  it('truncates and hashes past the CLI length cap', () => {
    const long = '/home/user/' + 'a'.repeat(300);
    const encoded = encodeProjectId(long);
    expect(encoded.length).toBeLessThan(long.length);
    expect(encoded.startsWith('-home-user-' + 'a'.repeat(50))).toBe(true);
    // Two paths sharing a 200-char prefix must not collide on one directory.
    expect(encodeProjectId(long + 'x')).not.toBe(encoded);
  });
});
