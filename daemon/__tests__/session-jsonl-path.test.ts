import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSessionJsonlPathResolver, findSessionJsonlInAccount } from '../session-jsonl-path';
import { encodeProjectId } from '../services/project-paths';

describe('session jsonl path', () => {
  let root: string;
  const UUID = '11111111-2222-3333-4444-555555555555';

  function writeTranscript(cfgDir: string, dirName: string, uuid = UUID): string {
    const dir = join(root, cfgDir, 'projects', dirName);
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `${uuid}.jsonl`);
    writeFileSync(file, '{}\n');
    return file;
  }

  function resolver(accounts: { config_dir: string; name?: string }[], resolved?: string) {
    return createSessionJsonlPathResolver({
      listAccounts: () => accounts.map((a) => ({ config_dir: a.config_dir })),
      resolveConfigDir: () => resolved ?? null,
    });
  }

  beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'omnifex-jsonl-')); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  it('finds the transcript under the config dir it was given', () => {
    const personal = join(root, 'personal');
    const expected = writeTranscript('personal', encodeProjectId('/repo/app'));
    const find = resolver([{ config_dir: personal }]);

    expect(find(UUID, '/repo/app', personal)).toBe(expected);
  });

  // Claude Code replaces every non-alphanumeric character, not just slashes.
  it('encodes every non-alphanumeric character in the project path', () => {
    const personal = join(root, 'personal');
    const expected = writeTranscript('personal', encodeProjectId('/repo/my_app.v2 beta'));
    const find = resolver([{ config_dir: personal }]);

    expect(find(UUID, '/repo/my_app.v2 beta', personal)).toBe(expected);
  });

  it('scans the account for a renamed project directory', () => {
    const personal = join(root, 'personal');
    const expected = writeTranscript('personal', '-repo-old-name');
    const find = resolver([{ config_dir: personal }]);

    expect(find(UUID, '/repo/new-name', personal)).toBe(expected);
  });

  it('searches every account when the caller passes no config dir', () => {
    const personal = join(root, 'personal');
    const work = join(root, 'work');
    mkdirSync(join(root, 'personal', 'projects'), { recursive: true });
    const expected = writeTranscript('work', encodeProjectId('/repo/app'));
    const find = resolver([{ config_dir: personal }, { config_dir: work }]);

    expect(find(UUID, '/repo/app', null)).toBe(expected);
  });

  it('searches other accounts when the session is not in the one given', () => {
    const personal = join(root, 'personal');
    const work = join(root, 'work');
    mkdirSync(join(root, 'personal', 'projects'), { recursive: true });
    const expected = writeTranscript('work', encodeProjectId('/repo/app'));
    const find = resolver([{ config_dir: personal }, { config_dir: work }]);

    expect(find(UUID, '/repo/app', personal)).toBe(expected);
  });

  it('survives an account whose projects directory does not exist', () => {
    const missing = join(root, 'never-created');
    const work = join(root, 'work');
    const expected = writeTranscript('work', encodeProjectId('/repo/app'));
    const find = resolver([{ config_dir: missing }, { config_dir: work }]);

    expect(find(UUID, '/repo/app', null)).toBe(expected);
  });

  it('falls back to the encoded path under the config dir it was given', () => {
    const personal = join(root, 'personal');
    const find = resolver([{ config_dir: personal }]);

    expect(find(UUID, '/repo/app', personal)).toBe(
      join(personal, 'projects', encodeProjectId('/repo/app'), `${UUID}.jsonl`),
    );
  });

  it('falls back to the account the project resolves to when given none', () => {
    const work = join(root, 'work');
    const find = resolver([{ config_dir: work }], work);

    expect(find(UUID, '/repo/app', null)).toBe(
      join(work, 'projects', encodeProjectId('/repo/app'), `${UUID}.jsonl`),
    );
  });

  it('returns null rather than inventing an account', () => {
    const find = resolver([], undefined);
    expect(find(UUID, '/repo/unowned', null)).toBeNull();
  });

  // The CLI never moves a transcript across config dirs.
  describe('findSessionJsonlInAccount', () => {
    it('finds a transcript the CLI moved into a worktree project directory', () => {
      const work = join(root, 'work');
      const moved = writeTranscript('work', encodeProjectId('/repo/app/.claude/worktrees/PI-1'));

      expect(findSessionJsonlInAccount(work, UUID, '/repo/app')).toBe(moved);
    });

    it('prefers the encoded project directory', () => {
      const work = join(root, 'work');
      const home = writeTranscript('work', encodeProjectId('/repo/app'));
      writeTranscript('work', 'zzz-other');

      expect(findSessionJsonlInAccount(work, UUID, '/repo/app')).toBe(home);
    });

    it('never looks in another account', () => {
      writeTranscript('personal', encodeProjectId('/repo/app'));

      expect(findSessionJsonlInAccount(join(root, 'work'), UUID, '/repo/app')).toBeNull();
    });
  });
});
