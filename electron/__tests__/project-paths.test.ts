import { mkdtempSync, mkdirSync, rmSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { decodeProjectId, recoverProjectPath } from '../services/project-paths';

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
