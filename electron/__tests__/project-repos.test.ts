import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDatabase, type Database } from '../services/database';
import { createProjectReposService, type ProjectReposService } from '../services/project-repos';
import type { DiscoveryResult } from '../services/git-repos';

/** A fake checkout: `.git/HEAD` is enough for isRepoDir/repoIdentity. */
function fakeRepo(dir: string): string {
  fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  return dir;
}

describe('project repos service', () => {
  let db: Database;
  let root: string;
  let discovered: DiscoveryResult;
  let discover: ReturnType<typeof vi.fn<(p: string, d: number) => Promise<DiscoveryResult>>>;
  let svc: ProjectReposService;

  beforeEach(() => {
    db = createDatabase(':memory:');
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gc-prj-repos-')));
    fakeRepo(path.join(root, 'a'));
    fakeRepo(path.join(root, 'b'));
    discovered = {
      rootIsRepo: false,
      repos: [{ path: path.join(root, 'a'), name: 'a' }, { path: path.join(root, 'b'), name: 'b' }],
      truncated: false,
    };
    discover = vi.fn(async (_p: string, _d: number) => discovered);
    svc = createProjectReposService({ db, discover });
  });

  afterEach(() => {
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('lists discovered repos unwatched by default at scan depth 1', async () => {
    const res = await svc.get(root);
    expect(discover).toHaveBeenCalledWith(root, 1);
    expect(res.scanDepth).toBe(1);
    expect(res.rootIsRepo).toBe(false);
    expect(res.repos.map((r) => [r.name, r.watched, r.missing])).toEqual([['a', false, false], ['b', false, false]]);
    expect(svc.watchedRepos(root)).toEqual([]);
    expect(await svc.foundCount(root)).toBe(2);
  });

  it('setWatched persists, notifies, and narrows foundCount', async () => {
    const listener = vi.fn();
    svc.onChange(listener);
    svc.setWatched(root, path.join(root, 'b'), true);
    expect(listener).toHaveBeenCalledWith(root);
    expect(svc.watchedRepos(root)).toEqual([{ path: path.join(root, 'b'), name: 'b' }]);
    expect((await svc.get(root)).repos.find((r) => r.name === 'b')?.watched).toBe(true);
    expect(await svc.foundCount(root)).toBe(1);
  });

  it('puts the project root first when it is a repo', () => {
    fakeRepo(root);
    svc.setWatched(root, path.join(root, 'a'), true);
    expect(svc.watchedRepos(root)).toEqual([
      { path: root, name: '' },
      { path: path.join(root, 'a'), name: 'a' },
    ]);
  });

  it('clamps scan depth to 1..5 and passes it to discovery', async () => {
    svc.setScanDepth(root, 9);
    await svc.get(root);
    expect(discover).toHaveBeenLastCalledWith(root, 5);
    svc.setScanDepth(root, 0);
    expect((await svc.get(root)).scanDepth).toBe(1);
  });

  it('keeps a watched repo discovery no longer returns, marked missing once its folder is gone', async () => {
    svc.setWatched(root, path.join(root, 'b'), true);
    discovered = { ...discovered, repos: [discovered.repos[0]] };
    let b = (await svc.get(root)).repos.find((r) => r.name === 'b');
    expect(b).toMatchObject({ watched: true, missing: false });
    expect(svc.watchedRepos(root)).toHaveLength(1);

    fs.rmSync(path.join(root, 'b'), { recursive: true });
    b = (await svc.get(root)).repos.find((r) => r.name === 'b');
    expect(b).toMatchObject({ watched: true, missing: true });
    expect(svc.watchedRepos(root)).toEqual([]);

    svc.remove(root, path.join(root, 'b'));
    expect((await svc.get(root)).repos.find((r) => r.name === 'b')).toBeUndefined();
  });
});
