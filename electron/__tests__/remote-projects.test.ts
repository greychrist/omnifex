import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createProjectRegistry, type ProjectRegistry } from '../remote/projects';
import { encodeProjectId } from '../services/project-paths';

describe('remote project registry', () => {
  let root: string;
  let file: string;
  let repoA: string;
  let registry: ProjectRegistry;
  const resolved = new Map<string, { accountId: number; configDir: string }>();

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'omnifex-projects-'));
    file = join(root, 'projects.json');
    repoA = join(root, 'repoA');
    mkdirSync(repoA);
    resolved.clear();
    registry = createProjectRegistry({
      file,
      resolveAccount: (p) => resolved.get(p) ?? null,
    });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('adds a directory and derives the CLI\'s own project id from its path', () => {
    const real = require('node:fs').realpathSync(repoA) as string;
    const p = registry.add(repoA, 'Repo A');
    expect(p).toMatchObject({ projectId: encodeProjectId(real), path: real, title: 'Repo A' });
    expect(registry.get(p.projectId)?.path).toBe(real);
  });

  it('is idempotent on the same path and keeps the existing title', () => {
    registry.add(repoA, 'Repo A');
    const again = registry.add(repoA);
    expect(again.title).toBe('Repo A');
    expect(registry.list()).toHaveLength(1);
  });

  it('defaults the title to the folder name', () => {
    expect(registry.add(repoA).title).toBe('repoA');
  });

  it('rejects a relative path, a missing directory and a file', () => {
    expect(() => registry.add('Repos/x')).toThrow(/absolute/);
    expect(() => registry.add(join(root, 'nope'))).toThrow(/not a directory/);
    const f = join(root, 'file.txt');
    require('node:fs').writeFileSync(f, 'x');
    expect(() => registry.add(f)).toThrow(/not a directory/);
  });

  it('stores the canonical path — the CLI realpaths its cwd, so we must too', () => {
    const { symlinkSync, realpathSync } = require('node:fs') as typeof import('node:fs');
    const link = join(root, 'link-to-repoA');
    symlinkSync(repoA, link);
    const p = registry.add(link);
    expect(p.path).toBe(realpathSync(repoA));
    expect(p.projectId).toBe(encodeProjectId(realpathSync(repoA)));
    // Adding via the real path is the same project.
    expect(registry.add(repoA).projectId).toBe(p.projectId);
    expect(registry.list()).toHaveLength(1);
  });

  it('persists to disk and reloads', () => {
    registry.add(repoA, 'Repo A');
    const real = require('node:fs').realpathSync(repoA) as string;
    expect(JSON.parse(readFileSync(file, 'utf8'))).toMatchObject({ projects: [{ path: real }] });
    const reloaded = createProjectRegistry({ file, resolveAccount: () => null });
    expect(reloaded.list().map((p) => p.path)).toEqual([real]);
  });

  it('resolves the owning account live on every read, never caching it', () => {
    registry.add(repoA);
    expect(registry.list()[0]).toMatchObject({ accountId: null, configDir: null });
    resolved.set(require('node:fs').realpathSync(repoA), { accountId: 2, configDir: '/Users/greg/.claude-work' });
    expect(registry.list()[0]).toMatchObject({ accountId: 2, configDir: '/Users/greg/.claude-work' });
    // The file never holds account data — path rules can change under it.
    expect(readFileSync(file, 'utf8')).not.toContain('claude-work');
  });

  it('removes by id and reports whether anything was removed', () => {
    const p = registry.add(repoA);
    expect(registry.remove(p.projectId)).toBe(true);
    expect(registry.remove(p.projectId)).toBe(false);
    expect(registry.list()).toEqual([]);
  });

  it('notifies listeners on add and remove with the full list', () => {
    const seen: number[] = [];
    registry.onChange((list) => { seen.push(list.length); });
    const p = registry.add(repoA);
    registry.remove(p.projectId);
    expect(seen).toEqual([1, 0]);
  });

  it('tolerates a corrupt or absent file', () => {
    require('node:fs').writeFileSync(file, '{oops');
    const r = createProjectRegistry({ file, resolveAccount: () => null });
    expect(r.list()).toEqual([]);
    expect(existsSync(file)).toBe(true);
  });
});
