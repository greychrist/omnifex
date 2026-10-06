import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createFilesystemService } from '../services/filesystem';

// The filesystem service powers the FilePicker's `@`-mention navigation:
//   - listDirectoryContents(path)  → one level, sorted (dirs first, then
//                                    files, alpha within each), dotfiles
//                                    hidden by default.
//   - searchFiles(basePath, query) → recursive substring search, case-
//                                    insensitive, capped to prevent
//                                    runaway walks in deep monorepos.
//
// Both must surface a clean Error on missing / non-directory paths so the
// FilePicker can render the "Failed to load directory" state instead of
// hanging.

describe('createFilesystemService — listDirectoryContents', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'omnifex-fs-list-'));
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('returns entries with name, path, is_directory, size, and extension on files', async () => {
    fs.writeFileSync(path.join(tmp, 'a.ts'), 'export {};');
    fs.mkdirSync(path.join(tmp, 'sub'));

    const svc = createFilesystemService();
    const entries = await svc.listDirectoryContents(tmp);

    const file = entries.find((e) => e.name === 'a.ts');
    const dir = entries.find((e) => e.name === 'sub');
    expect(file).toMatchObject({
      name: 'a.ts',
      path: path.join(tmp, 'a.ts'),
      is_directory: false,
      extension: 'ts',
    });
    expect(typeof file?.size).toBe('number');
    expect(file?.size).toBeGreaterThan(0);
    expect(dir).toMatchObject({
      name: 'sub',
      path: path.join(tmp, 'sub'),
      is_directory: true,
      size: 0,
    });
    expect(dir?.extension).toBeUndefined();
  });

  it('sorts directories first, then files, alpha within each group', async () => {
    fs.writeFileSync(path.join(tmp, 'z.txt'), 'z');
    fs.writeFileSync(path.join(tmp, 'a.txt'), 'a');
    fs.mkdirSync(path.join(tmp, 'beta'));
    fs.mkdirSync(path.join(tmp, 'alpha'));

    const svc = createFilesystemService();
    const entries = await svc.listDirectoryContents(tmp);

    expect(entries.map((e) => e.name)).toEqual(['alpha', 'beta', 'a.txt', 'z.txt']);
  });

  it('hides dotfiles and dotted directories by default', async () => {
    fs.writeFileSync(path.join(tmp, 'visible.md'), 'v');
    fs.writeFileSync(path.join(tmp, '.env'), 'secret');
    fs.mkdirSync(path.join(tmp, '.git'));

    const svc = createFilesystemService();
    const entries = await svc.listDirectoryContents(tmp);

    expect(entries.map((e) => e.name)).toEqual(['visible.md']);
  });

  it('throws a clear error when the path does not exist', async () => {
    const svc = createFilesystemService();
    const missing = path.join(tmp, 'does-not-exist');
    await expect(svc.listDirectoryContents(missing)).rejects.toThrow(
      /not found|no such file|ENOENT/i,
    );
  });

  it('throws a clear error when the path is a file, not a directory', async () => {
    const f = path.join(tmp, 'plain.txt');
    fs.writeFileSync(f, 'hi');
    const svc = createFilesystemService();
    await expect(svc.listDirectoryContents(f)).rejects.toThrow(/not a directory/i);
  });

  it('omits the extension when the file name has no dot', async () => {
    fs.writeFileSync(path.join(tmp, 'Makefile'), 'all:');
    const svc = createFilesystemService();
    const entries = await svc.listDirectoryContents(tmp);
    const mk = entries.find((e) => e.name === 'Makefile');
    expect(mk).toBeDefined();
    expect(mk?.extension).toBeUndefined();
  });
});

describe('createFilesystemService — searchFiles', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'omnifex-fs-search-'));
    // Populate a small tree:
    //   tmp/
    //     a.ts
    //     deep/
    //       nested/
    //         alpha.md
    //         README.md
    //       sibling.ts
    //     .hidden/
    //       secret.txt
    fs.writeFileSync(path.join(tmp, 'a.ts'), '');
    fs.mkdirSync(path.join(tmp, 'deep', 'nested'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'deep', 'nested', 'alpha.md'), '');
    fs.writeFileSync(path.join(tmp, 'deep', 'nested', 'README.md'), '');
    fs.writeFileSync(path.join(tmp, 'deep', 'sibling.ts'), '');
    fs.mkdirSync(path.join(tmp, '.hidden'));
    fs.writeFileSync(path.join(tmp, '.hidden', 'secret.txt'), '');
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('finds matches across subdirectories with case-insensitive substring matching', async () => {
    const svc = createFilesystemService();
    const results = await svc.searchFiles(tmp, 'readme');
    expect(results.map((e) => e.name)).toEqual(['README.md']);
  });

  it('returns multiple matches when several names contain the query', async () => {
    const svc = createFilesystemService();
    const results = await svc.searchFiles(tmp, '.ts');
    const names = results.map((e) => e.name).sort();
    expect(names).toEqual(['a.ts', 'sibling.ts']);
  });

  it('does not descend into dot-prefixed directories', async () => {
    const svc = createFilesystemService();
    const results = await svc.searchFiles(tmp, 'secret');
    expect(results).toEqual([]);
  });

  it('returns an empty array when nothing matches', async () => {
    const svc = createFilesystemService();
    expect(await svc.searchFiles(tmp, 'no-such-thing')).toEqual([]);
  });

  it('returns an empty array for an empty / whitespace-only query', async () => {
    const svc = createFilesystemService();
    expect(await svc.searchFiles(tmp, '')).toEqual([]);
    expect(await svc.searchFiles(tmp, '   ')).toEqual([]);
  });

  it('throws a clear error when basePath does not exist', async () => {
    const svc = createFilesystemService();
    await expect(svc.searchFiles(path.join(tmp, 'no-dir'), 'x')).rejects.toThrow(
      /not found|no such file|ENOENT/i,
    );
  });

  it('caps results so deep monorepos can\'t produce runaway responses', async () => {
    // Drop 250 matching files into a single subdir.
    fs.mkdirSync(path.join(tmp, 'bulk'));
    for (let i = 0; i < 250; i++) {
      fs.writeFileSync(path.join(tmp, 'bulk', `match-${i}.json`), '');
    }
    const svc = createFilesystemService({ maxResults: 200 });
    const results = await svc.searchFiles(tmp, 'match-');
    expect(results.length).toBe(200);
  });
});

// createDirectory backs the Projects page's New Project button: the renderer
// shows a native save dialog (parent folder + name) and this makes the folder.
// An existing FOLDER is returned as-is: the save dialog offers "Replace?" for
// one, and a retry after a cancelled account picker names the folder the first
// attempt already made — both mean "open that folder", never "wipe it". It
// never conjures missing parents from a typo'd path.
describe('createFilesystemService — createDirectory', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'omnifex-fs-mkdir-'));
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('creates the folder and returns its path', async () => {
    const target = path.join(tmp, 'my-project');
    const svc = createFilesystemService();
    await expect(svc.createDirectory(target)).resolves.toBe(target);
    expect(fs.statSync(target).isDirectory()).toBe(true);
  });

  it('returns an existing folder as-is, leaving its contents untouched', async () => {
    const target = path.join(tmp, 'existing');
    fs.mkdirSync(target);
    fs.writeFileSync(path.join(target, 'keep.txt'), 'x');
    const svc = createFilesystemService();
    await expect(svc.createDirectory(target)).resolves.toBe(target);
    expect(fs.readFileSync(path.join(target, 'keep.txt'), 'utf8')).toBe('x');
  });

  it('rejects a path that exists as a file', async () => {
    const target = path.join(tmp, 'a-file');
    fs.writeFileSync(target, 'x');
    const svc = createFilesystemService();
    await expect(svc.createDirectory(target)).rejects.toThrow(/not a folder/);
    expect(fs.readFileSync(target, 'utf8')).toBe('x');
  });

  it('does not create missing parent folders', async () => {
    const target = path.join(tmp, 'missing-parent', 'child');
    const svc = createFilesystemService();
    await expect(svc.createDirectory(target)).rejects.toThrow();
    expect(fs.existsSync(path.join(tmp, 'missing-parent'))).toBe(false);
  });

  it('rejects a relative path', async () => {
    const svc = createFilesystemService();
    await expect(svc.createDirectory('relative/dir')).rejects.toThrow(/absolute/);
  });
});
