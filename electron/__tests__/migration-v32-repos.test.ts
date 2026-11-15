import { describe, it, expect, afterEach } from 'vitest';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import BetterSqlite3 from 'better-sqlite3';
import { runMigrations } from '../services/database';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function v31Db(): BetterSqlite3.Database {
  const db = new BetterSqlite3(':memory:');
  db.exec(`
    CREATE TABLE schema_version (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
    INSERT INTO schema_version VALUES (31, '2026-11-01T00:00:00Z');
    CREATE TABLE branch_colors (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_path TEXT NOT NULL,
      branch_name TEXT NOT NULL,
      color TEXT NOT NULL,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      UNIQUE(project_path, branch_name)
    );
    CREATE INDEX idx_branch_colors_project ON branch_colors(project_path);
  `);
  return db;
}

describe('migration v32 — repos', () => {
  it('copies colours into repo_branch_colors, folding worktree rows into the main checkout', () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gc-v32-')));
    dirs.push(root);
    const repo = path.join(root, 'r');
    fs.mkdirSync(repo);
    execSync('git init -q -b main && git -c user.email=t@e -c user.name=T commit -q --allow-empty -m i', { cwd: repo, stdio: 'pipe', shell: '/bin/sh' });
    const wt = path.join(root, 'wt');
    execSync(`git worktree add -q -b wt ${wt}`, { cwd: repo, stdio: 'pipe' });

    const db = v31Db();
    const ins = db.prepare('INSERT INTO branch_colors (project_path, branch_name, color, created_at) VALUES (?, ?, ?, 0)');
    // The worktree row first: the main checkout must still win the clash.
    ins.run(wt, 'feat', '#222222');
    ins.run(repo, 'feat', '#111111');
    ins.run(wt, 'wip', '#333333');
    ins.run('/not/a/repo', 'x', '#444444');

    runMigrations(db, { homeDir: '/nonexistent-home-for-test' });

    const rows = db.prepare('SELECT repo_path, branch_name, color FROM repo_branch_colors ORDER BY repo_path, branch_name').all();
    expect(rows).toEqual([
      { repo_path: '/not/a/repo', branch_name: 'x', color: '#444444' },
      { repo_path: repo, branch_name: 'feat', color: '#111111' },
      { repo_path: repo, branch_name: 'wip', color: '#333333' },
    ]);
  });

  // An older installed daemon shares this database with a dev build, and
  // prepares `... project_path ...` against branch_colors at start-up.
  it('leaves branch_colors untouched for older daemons', () => {
    const db = v31Db();
    db.prepare("INSERT INTO branch_colors (project_path, branch_name, color, created_at) VALUES ('/p', 'feat', '#111111', 0)").run();
    runMigrations(db, { homeDir: '/nonexistent-home-for-test' });
    expect(() => db.prepare('SELECT project_path, branch_name FROM branch_colors').all()).not.toThrow();
    expect(db.prepare('SELECT COUNT(*) AS n FROM branch_colors').get()).toEqual({ n: 1 });
  });

  it('creates the project repo tables and is safe to re-run', () => {
    const db = v31Db();
    runMigrations(db, { homeDir: '/nonexistent-home-for-test' });
    db.prepare('DELETE FROM schema_version WHERE version >= 32').run();
    expect(() => runMigrations(db, { homeDir: '/nonexistent-home-for-test' })).not.toThrow();
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map((t) => t.name);
    expect(tables).toEqual(expect.arrayContaining(['project_git_settings', 'project_git_repos']));
    db.prepare('INSERT INTO project_git_repos (project_path, repo_path, watched) VALUES (?, ?, 1)').run('/p', '/p/a');
    expect(db.prepare('SELECT scan_depth FROM project_git_settings').all()).toEqual([]);
  });
});
