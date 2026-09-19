import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import { listChangedFiles, readFileDiff } from '../services/git-diff';

/**
 * These tests drive real `git` against real throwaway repos rather than
 * mocking execFile. The whole point of this service is that it agrees with
 * git's porcelain contract — a mock would only assert that we agree with our
 * own assumptions about it, which is exactly the bug class worth catching.
 */

function git(dir: string, args: string): void {
  execSync(`git ${args}`, { cwd: dir, stdio: 'pipe' });
}

function initRepo(dir: string): void {
  git(dir, 'init -q -b main');
  git(dir, 'config user.email t@t');
  git(dir, 'config user.name t');
  git(dir, 'config commit.gpgsign false');
}

function commitAll(dir: string, msg: string): void {
  git(dir, 'add -A');
  git(dir, `commit -q -m ${msg}`);
}

describe('listChangedFiles', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'omnifex-git-diff-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns [] for a directory that is not a git repo', async () => {
    expect(await listChangedFiles(dir)).toEqual([]);
  });

  it('returns [] for a clean repo', async () => {
    initRepo(dir);
    writeFileSync(join(dir, 'a.txt'), 'one\n');
    commitAll(dir, 'initial');
    expect(await listChangedFiles(dir)).toEqual([]);
  });

  it('reports an unstaged edit as modified and not staged', async () => {
    initRepo(dir);
    writeFileSync(join(dir, 'a.txt'), 'one\n');
    commitAll(dir, 'initial');
    writeFileSync(join(dir, 'a.txt'), 'two\n');

    expect(await listChangedFiles(dir)).toEqual([
      { path: 'a.txt', status: 'modified', staged: false },
    ]);
  });

  it('reports a staged edit as staged', async () => {
    initRepo(dir);
    writeFileSync(join(dir, 'a.txt'), 'one\n');
    commitAll(dir, 'initial');
    writeFileSync(join(dir, 'a.txt'), 'two\n');
    git(dir, 'add a.txt');

    expect(await listChangedFiles(dir)).toEqual([
      { path: 'a.txt', status: 'modified', staged: true },
    ]);
  });

  it('reports an untracked file', async () => {
    initRepo(dir);
    writeFileSync(join(dir, 'a.txt'), 'one\n');
    commitAll(dir, 'initial');
    writeFileSync(join(dir, 'new.txt'), 'fresh\n');

    expect(await listChangedFiles(dir)).toEqual([
      { path: 'new.txt', status: 'untracked', staged: false },
    ]);
  });

  it('reports a staged new file as added, not untracked', async () => {
    initRepo(dir);
    writeFileSync(join(dir, 'a.txt'), 'one\n');
    commitAll(dir, 'initial');
    writeFileSync(join(dir, 'new.txt'), 'fresh\n');
    git(dir, 'add new.txt');

    expect(await listChangedFiles(dir)).toEqual([
      { path: 'new.txt', status: 'added', staged: true },
    ]);
  });

  it('reports a deleted file', async () => {
    initRepo(dir);
    writeFileSync(join(dir, 'a.txt'), 'one\n');
    commitAll(dir, 'initial');
    rmSync(join(dir, 'a.txt'));

    expect(await listChangedFiles(dir)).toEqual([
      { path: 'a.txt', status: 'deleted', staged: false },
    ]);
  });

  it('carries the original path on a rename so the list can show both', async () => {
    initRepo(dir);
    writeFileSync(join(dir, 'a.txt'), 'one\ntwo\nthree\nfour\n');
    commitAll(dir, 'initial');
    git(dir, 'mv a.txt b.txt');

    expect(await listChangedFiles(dir)).toEqual([
      { path: 'b.txt', status: 'renamed', staged: true, origPath: 'a.txt' },
    ]);
  });

  it('does not let a rename entry shift the paths of later files', async () => {
    // The -z rename entry carries a second NUL-delimited field. Consuming
    // only one field leaves the parser reading the ORIGINAL path as the next
    // status pair, which silently corrupts every file after a rename.
    initRepo(dir);
    writeFileSync(join(dir, 'a.txt'), 'one\ntwo\nthree\nfour\n');
    writeFileSync(join(dir, 'z.txt'), 'zed\n');
    commitAll(dir, 'initial');
    git(dir, 'mv a.txt b.txt');
    writeFileSync(join(dir, 'z.txt'), 'zed changed\n');

    const files = await listChangedFiles(dir);
    expect(files.map((f) => f.path).sort()).toEqual(['b.txt', 'z.txt']);
    expect(files.find((f) => f.path === 'z.txt')?.status).toBe('modified');
  });

  it('returns repo-relative paths for files in subdirectories', async () => {
    initRepo(dir);
    mkdirSync(join(dir, 'src', 'deep'), { recursive: true });
    writeFileSync(join(dir, 'src', 'deep', 'a.txt'), 'one\n');
    commitAll(dir, 'initial');
    writeFileSync(join(dir, 'src', 'deep', 'a.txt'), 'two\n');

    expect(await listChangedFiles(dir)).toEqual([
      { path: 'src/deep/a.txt', status: 'modified', staged: false },
    ]);
  });

  it('lists a file that is staged AND has further unstaged edits once', async () => {
    initRepo(dir);
    writeFileSync(join(dir, 'a.txt'), 'one\n');
    commitAll(dir, 'initial');
    writeFileSync(join(dir, 'a.txt'), 'two\n');
    git(dir, 'add a.txt');
    writeFileSync(join(dir, 'a.txt'), 'three\n');

    const files = await listChangedFiles(dir);
    expect(files).toHaveLength(1);
    expect(files[0].path).toBe('a.txt');
    expect(files[0].staged).toBe(true);
  });
});

describe('readFileDiff', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'omnifex-git-diff-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns a unified patch for an unstaged edit', async () => {
    initRepo(dir);
    writeFileSync(join(dir, 'a.txt'), 'one\n');
    commitAll(dir, 'initial');
    writeFileSync(join(dir, 'a.txt'), 'two\n');

    const patch = await readFileDiff(dir, 'a.txt');
    expect(patch).toContain('--- a/a.txt');
    expect(patch).toContain('+++ b/a.txt');
    expect(patch).toContain('-one');
    expect(patch).toContain('+two');
  });

  it('includes STAGED changes, which a plain `git diff` would omit', async () => {
    // This is the whole reason the service diffs against HEAD. A working tree
    // whose changes are all staged renders as an empty patch under `git diff`.
    initRepo(dir);
    writeFileSync(join(dir, 'a.txt'), 'one\n');
    commitAll(dir, 'initial');
    writeFileSync(join(dir, 'a.txt'), 'two\n');
    git(dir, 'add a.txt');

    const patch = await readFileDiff(dir, 'a.txt');
    expect(patch).toContain('-one');
    expect(patch).toContain('+two');
  });

  it('renders an untracked file as an all-additions patch', async () => {
    initRepo(dir);
    writeFileSync(join(dir, 'a.txt'), 'one\n');
    commitAll(dir, 'initial');
    writeFileSync(join(dir, 'new.txt'), 'alpha\nbeta\n');

    const patch = await readFileDiff(dir, 'new.txt');
    expect(patch).toContain('+alpha');
    expect(patch).toContain('+beta');
    expect(patch).toContain('new.txt');
    expect(patch).not.toContain('-alpha');
  });

  it('renders a deleted file as an all-removals patch', async () => {
    initRepo(dir);
    writeFileSync(join(dir, 'a.txt'), 'gone\n');
    commitAll(dir, 'initial');
    rmSync(join(dir, 'a.txt'));

    const patch = await readFileDiff(dir, 'a.txt');
    expect(patch).toContain('-gone');
  });

  it('returns an empty string for a path with no changes', async () => {
    initRepo(dir);
    writeFileSync(join(dir, 'a.txt'), 'one\n');
    commitAll(dir, 'initial');

    expect(await readFileDiff(dir, 'a.txt')).toBe('');
  });

  it('returns an empty string rather than throwing outside a repo', async () => {
    writeFileSync(join(dir, 'a.txt'), 'one\n');
    expect(await readFileDiff(dir, 'a.txt')).toBe('');
  });

  it('refuses a path that escapes the project directory', async () => {
    // The path arrives from the renderer over IPC. `git diff -- ../../etc/passwd`
    // would otherwise read outside the project the user opened.
    initRepo(dir);
    writeFileSync(join(dir, 'a.txt'), 'one\n');
    commitAll(dir, 'initial');

    await expect(readFileDiff(dir, '../escape.txt')).rejects.toThrow(/outside/i);
  });

  it('refuses an absolute path', async () => {
    initRepo(dir);
    writeFileSync(join(dir, 'a.txt'), 'one\n');
    commitAll(dir, 'initial');

    await expect(readFileDiff(dir, '/etc/passwd')).rejects.toThrow(/outside/i);
  });

  it('defaults to three lines of context, as git does', async () => {
    initRepo(dir);
    const lines = Array.from({ length: 40 }, (_, i) => `line${i + 1}`);
    writeFileSync(join(dir, 'a.txt'), lines.join('\n') + '\n');
    commitAll(dir, 'initial');
    lines[19] = 'CHANGED';
    writeFileSync(join(dir, 'a.txt'), lines.join('\n') + '\n');

    // Assert on BODY lines only. git puts a section heading after the `@@`
    // marker (`@@ -17,7 +17,7 @@ line16`), so a naive `not.toContain` on the
    // whole patch fails on a correct 3-line context.
    const body = (await readFileDiff(dir, 'a.txt'))
      .split('\n')
      .filter((l) => /^[ +-]/.test(l) && !l.startsWith('--- ') && !l.startsWith('+++ '))
      .map((l) => l.slice(1));

    expect(body).toContain('line17');
    expect(body).not.toContain('line16');
    expect(body).toContain('line23');
    expect(body).not.toContain('line24');
  });

  it('widens the context when asked, for the expand affordance', async () => {
    initRepo(dir);
    const lines = Array.from({ length: 40 }, (_, i) => `line${i + 1}`);
    writeFileSync(join(dir, 'a.txt'), lines.join('\n') + '\n');
    commitAll(dir, 'initial');
    lines[19] = 'CHANGED';
    writeFileSync(join(dir, 'a.txt'), lines.join('\n') + '\n');

    const patch = await readFileDiff(dir, 'a.txt', { contextLines: 15 });
    expect(patch).toContain('line5');
    expect(patch).toContain('line35');
  });

  it('returns the whole file at a very large context', async () => {
    initRepo(dir);
    const lines = Array.from({ length: 40 }, (_, i) => `line${i + 1}`);
    writeFileSync(join(dir, 'a.txt'), lines.join('\n') + '\n');
    commitAll(dir, 'initial');
    lines[19] = 'CHANGED';
    writeFileSync(join(dir, 'a.txt'), lines.join('\n') + '\n');

    const patch = await readFileDiff(dir, 'a.txt', { contextLines: 100000 });
    expect(patch).toContain('line1\n');
    expect(patch).toContain('line40');
  });

  it('honours contextLines for an untracked file too', async () => {
    initRepo(dir);
    writeFileSync(join(dir, 'a.txt'), 'one\n');
    commitAll(dir, 'initial');
    writeFileSync(join(dir, 'new.txt'), 'alpha\nbeta\n');

    const patch = await readFileDiff(dir, 'new.txt', { contextLines: 50 });
    expect(patch).toContain('+alpha');
    expect(patch).toContain('+beta');
  });

  it('diffs a file whose name begins with a dash', async () => {
    // Without a `--` separator git parses `-x.txt` as a flag.
    initRepo(dir);
    writeFileSync(join(dir, '-x.txt'), 'one\n');
    commitAll(dir, 'initial');
    writeFileSync(join(dir, '-x.txt'), 'two\n');

    const patch = await readFileDiff(dir, '-x.txt');
    expect(patch).toContain('-one');
    expect(patch).toContain('+two');
  });
});
