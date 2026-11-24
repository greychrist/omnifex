import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import { createDatabase, type Database } from '../services/database';
import { createAccountsService, type AccountsService } from '../services/accounts';
import { encodeProjectId } from '../services/project-paths';

const PROJECT = '/home/user/projects/myapp';

function projectDirFor(configDir: string, projectPath = PROJECT): string {
  return path.join(configDir, 'projects', encodeProjectId(projectPath));
}

describe('resolve() — on-disk ownership', () => {
  let db: Database;

  function serviceSeeing(existing: string[]): AccountsService {
    const set = new Set(existing.map((p) => path.normalize(p)));
    return createAccountsService(db, {
      existsSync: (p: string) => set.has(path.normalize(p)),
    });
  }

  beforeEach(() => {
    db = createDatabase(':memory:');
  });

  afterEach(() => {
    db.close();
  });

  it('resolves to the one account whose config dir holds the project', () => {
    const seed = createAccountsService(db);
    seed.createAccount({ name: 'Personal', configDir: '/home/user/.claude-personal' });
    const work = seed.createAccount({ name: 'Work', configDir: '/home/user/.claude-work' });

    const accounts = serviceSeeing([projectDirFor('/home/user/.claude-work')]);

    const pair = accounts.resolve(PROJECT);
    expect(pair.claude?.account.id).toBe(work.id);
    expect(pair.claude?.matchType).toBe('on_disk');
  });

  it('resolves a path the CLI sanitizes beyond slashes (dots, underscores)', () => {
    // Written literally, not via encodeProjectId: the CLI dashes EVERY
    // non-alphanumeric character, not just `/`.
    const dotted = '/home/user/projects/my_app.v2';
    const seed = createAccountsService(db);
    seed.createAccount({ name: 'Personal', configDir: '/home/user/.claude-personal' });
    const work = seed.createAccount({ name: 'Work', configDir: '/home/user/.claude-work' });

    const accounts = serviceSeeing([
      path.join('/home/user/.claude-work', 'projects', '-home-user-projects-my-app-v2'),
    ]);

    const pair = accounts.resolve(dotted);
    expect(pair.claude?.account.id).toBe(work.id);
    expect(pair.claude?.matchType).toBe('on_disk');
  });

  it('reports the config dir it matched on, for the resolution UI', () => {
    const seed = createAccountsService(db);
    seed.createAccount({ name: 'Work', configDir: '/home/user/.claude-work' });

    const accounts = serviceSeeing([projectDirFor('/home/user/.claude-work')]);

    expect(accounts.resolve(PROJECT).claude?.matchDetail).toContain('.claude-work');
  });

  it('returns null when the project exists under more than one account', () => {
    const seed = createAccountsService(db);
    seed.createAccount({ name: 'Personal', configDir: '/home/user/.claude-personal' });
    seed.createAccount({ name: 'Work', configDir: '/home/user/.claude-work' });

    const accounts = serviceSeeing([
      projectDirFor('/home/user/.claude-personal'),
      projectDirFor('/home/user/.claude-work'),
    ]);

    expect(accounts.resolve(PROJECT).claude).toBeNull();
  });

  it('returns null when the project exists under no account', () => {
    const seed = createAccountsService(db);
    seed.createAccount({ name: 'Personal', configDir: '/home/user/.claude-personal' });
    seed.createAccount({ name: 'Work', configDir: '/home/user/.claude-work' });

    const accounts = serviceSeeing([]);

    expect(accounts.resolve(PROJECT).claude).toBeNull();
  });

  it('an explicit override still beats on-disk evidence', () => {
    const seed = createAccountsService(db);
    const personal = seed.createAccount({ name: 'Personal', configDir: '/home/user/.claude-personal' });
    seed.createAccount({ name: 'Work', configDir: '/home/user/.claude-work' });
    seed.setProjectOverride(PROJECT, personal.id);

    const accounts = serviceSeeing([projectDirFor('/home/user/.claude-work')]);

    const pair = accounts.resolve(PROJECT);
    expect(pair.claude?.account.id).toBe(personal.id);
    expect(pair.claude?.matchType).toBe('override');
  });

  it('a path rule still beats on-disk evidence', () => {
    const seed = createAccountsService(db);
    const personal = seed.createAccount({ name: 'Personal', configDir: '/home/user/.claude-personal' });
    seed.createAccount({ name: 'Work', configDir: '/home/user/.claude-work' });
    seed.addPathRule(personal.id, '/home/user/projects');

    const accounts = serviceSeeing([projectDirFor('/home/user/.claude-work')]);

    const pair = accounts.resolve(PROJECT);
    expect(pair.claude?.account.id).toBe(personal.id);
    expect(pair.claude?.matchType).toBe('path_rule');
  });

  it('does not fill the codex slot from on-disk evidence', () => {
    const seed = createAccountsService(db);
    seed.createAccount({ name: 'Codex', configDir: '/home/user/.codex', engine: 'codex' });

    const accounts = serviceSeeing([projectDirFor('/home/user/.codex')]);

    expect(accounts.resolve(PROJECT).codex).toBeNull();
  });

  it('does not let a codex account fill the claude slot', () => {
    const seed = createAccountsService(db);
    seed.createAccount({ name: 'Codex', configDir: '/home/user/.codex', engine: 'codex' });

    const accounts = serviceSeeing([projectDirFor('/home/user/.codex')]);

    expect(accounts.resolve(PROJECT).claude).toBeNull();
  });

  it('normalizes the project path before encoding it', () => {
    const seed = createAccountsService(db);
    const work = seed.createAccount({ name: 'Work', configDir: '/home/user/.claude-work' });

    const accounts = serviceSeeing([projectDirFor('/home/user/.claude-work')]);

    expect(accounts.resolve(`${PROJECT}/`).claude?.account.id).toBe(work.id);
  });
});
