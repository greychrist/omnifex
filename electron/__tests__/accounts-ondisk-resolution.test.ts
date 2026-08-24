import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import { createDatabase, type Database } from '../services/database';
import { createAccountsService, type AccountsService } from '../services/accounts';
import { encodeProjectId } from '../services/project-paths';

/**
 * On-disk ownership as a resolution step.
 *
 * When a project's `projects/<encoded>` directory physically exists under
 * exactly one account's config dir, that account owns it — the sessions are
 * literally there. Requiring a path rule to re-derive a fact already sitting on
 * disk was what produced the state where `listProjects` reported a project as
 * belonging to Work while `getProjectSessions` threw NO_ACCOUNT_FOR_PROJECT for
 * the same folder.
 *
 * This is evidence, not a default: when the directory exists under two accounts
 * (the same repo opened under personal and work) or under none, resolution
 * still returns null and the picker asks. See CLAUDE.md "Multi-Account Rules".
 */

const PROJECT = '/home/user/projects/myapp';

/** The `projects/<encoded>` path a given config dir would use for PROJECT. */
function projectDirFor(configDir: string, projectPath = PROJECT): string {
  return path.join(configDir, 'projects', encodeProjectId(projectPath));
}

describe('resolve() — on-disk ownership', () => {
  let db: Database;

  /** Build a service whose existence check only sees the listed paths. */
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
    // The directory name here is written out literally rather than run through
    // encodeProjectId, because a test that derives the fixture from the code
    // under test can only ever prove self-consistency. This is the name the
    // CLI actually creates: EVERY non-alphanumeric character becomes a dash,
    // not just `/`. Greg's own tree has
    // `-Users-gregorychristie-Repos-work-pi-tuitive--claude-worktrees-PI-390`
    // for `.../pi-tuitive/.claude-worktrees/PI-390`, while the slash-only
    // encoding looked for `...-pi-tuitive-.claude-worktrees-PI-390` and found
    // nothing — so step 3 reported "no evidence" for a project sitting right
    // there on disk.
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

  // The guard that keeps this from becoming a silent default: two accounts
  // both holding the folder is genuinely ambiguous, so it must not guess.
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

    // Sessions live under Work, but the user said Personal.
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

  // Codex reads a single ~/.codex and has no per-account `projects/<encoded>`
  // layout, so there is no on-disk evidence to read for that slot.
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

    // Trailing slash from the renderer must still find the same directory.
    expect(accounts.resolve(`${PROJECT}/`).claude?.account.id).toBe(work.id);
  });
});
