import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createVaultGit, type ExecGit } from '../services/brain/git';

describe('vault git', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'omnifex-git-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('reports available when git runs', async () => {
    expect(await createVaultGit(dir).available()).toBe(true);
  });

  it('reports unavailable when git cannot be spawned', async () => {
    const failing: ExecGit = async () => { throw new Error('ENOENT'); };
    expect(await createVaultGit(dir, failing).available()).toBe(false);
  });

  it('init creates a repo', async () => {
    await createVaultGit(dir).init();
    expect(existsSync(join(dir, '.git'))).toBe(true);
  });

  it('init is idempotent', async () => {
    const git = createVaultGit(dir);
    await git.init();
    await git.init();
    expect(existsSync(join(dir, '.git'))).toBe(true);
  });

  it('commitAll commits new files and reports ok', async () => {
    const git = createVaultGit(dir);
    await git.init();
    writeFileSync(join(dir, 'a.md'), 'hello');
    expect(await git.commitAll('Index session abc')).toEqual({ ok: true });

    const log = execFileSync('git', ['log', '--format=%s'], { cwd: dir, encoding: 'utf8' });
    expect(log.trim()).toBe('Index session abc');
  });

  it('serialises concurrent commits through the mutex', async () => {
    const order: string[] = [];
    const slow: ExecGit = async (args) => {
      if (args[0] === 'status') return ' M a.md\n';
      if (args[0] === 'commit') {
        order.push(`start:${args[args.length - 1]}`);
        await new Promise((r) => setTimeout(r, 10));
        order.push(`end:${args[args.length - 1]}`);
      }
      return '';
    };
    const git = createVaultGit(dir, slow);
    await Promise.all([git.commitAll('A'), git.commitAll('B')]);

    // No interleaving: each commit's start is immediately followed by its end.
    expect(order).toEqual(['start:A', 'end:A', 'start:B', 'end:B']);
  });

  describe('commitAll result', () => {
    it('reports ok when there is something to commit', async () => {
      const calls: string[][] = [];
      const exec: ExecGit = async (args) => {
        calls.push(args);
        return args[0] === 'status' ? ' M Notes/A.md\n' : '';
      };

      expect(await createVaultGit(dir, exec).commitAll('Manual edit')).toEqual({ ok: true });
      expect(calls).toEqual([
        ['add', '-A'],
        ['status', '--porcelain'],
        ['commit', '-q', '-m', 'Manual edit'],
      ]);
    });

    it('reports nothing-to-commit without invoking commit', async () => {
      const calls: string[][] = [];
      const exec: ExecGit = async (args) => {
        calls.push(args);
        return '';
      };

      expect(await createVaultGit(dir, exec).commitAll('Manual edit')).toEqual({
        ok: false,
        reason: 'nothing-to-commit',
      });
      expect(calls.map((c) => c[0])).not.toContain('commit');
    });

    it('reports a real failure with its message', async () => {
      const exec: ExecGit = async (args) => {
        if (args[0] === 'status') return ' M Notes/A.md\n';
        if (args[0] === 'commit') throw new Error('fatal: unable to write');
        return '';
      };

      expect(await createVaultGit(dir, exec).commitAll('Manual edit')).toEqual({
        ok: false,
        reason: 'failed',
        message: 'fatal: unable to write',
      });
    });

    it('reports a missing git binary as a failure, not as nothing-to-commit', async () => {
      const exec: ExecGit = async () => { throw new Error('spawn git ENOENT'); };

      expect(await createVaultGit(dir, exec).commitAll('Manual edit')).toEqual({
        ok: false,
        reason: 'failed',
        message: 'spawn git ENOENT',
      });
    });

    it('reports nothing-to-commit against a real repo with no changes', async () => {
      const git = createVaultGit(dir);
      await git.init();
      writeFileSync(join(dir, 'a.md'), 'hello');
      await git.commitAll('first');

      expect(await git.commitAll('second')).toEqual({
        ok: false,
        reason: 'nothing-to-commit',
      });
    });
  });

  it('creates its own repo when the vault is nested inside another repo', async () => {
    const outer = mkdtempSync(join(tmpdir(), 'omnifex-outer-'));
    execFileSync('git', ['init', '-q'], { cwd: outer });
    execFileSync('git', ['config', 'user.email', 't@t'], { cwd: outer });
    execFileSync('git', ['config', 'user.name', 'T'], { cwd: outer });
    writeFileSync(join(outer, 'unrelated-wip.txt'), 'do not commit me');

    const vaultDir = join(outer, 'brain-vault');
    mkdirSync(vaultDir);
    const git = createVaultGit(vaultDir);
    await git.init();

    // The vault must have its OWN repo, not the outer one.
    expect(existsSync(join(vaultDir, '.git'))).toBe(true);

    execFileSync('git', ['config', 'user.email', 't@t'], { cwd: vaultDir });
    execFileSync('git', ['config', 'user.name', 'T'], { cwd: vaultDir });
    writeFileSync(join(vaultDir, 'note.md'), 'x');
    expect(await git.commitAll('Index session xyz')).toEqual({ ok: true });

    // The outer repo must be completely untouched: no commits, and the
    // unrelated file still unstaged.
    const outerCommits = execFileSync('git', ['rev-list', '--count', '--all'], { cwd: outer, encoding: 'utf8' }).trim();
    expect(outerCommits).toBe('0');
    const outerStatus = execFileSync('git', ['status', '--porcelain'], { cwd: outer, encoding: 'utf8' });
    expect(outerStatus).toContain('unrelated-wip.txt');

    rmSync(outer, { recursive: true, force: true });
  });
});
