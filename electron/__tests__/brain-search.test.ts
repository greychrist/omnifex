import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import BetterSqlite3 from 'better-sqlite3';
import {
  BrainIndexUnavailableError,
  createVaultIndex,
  openVaultIndexReadOnly,
  readIndexedCount,
  type VaultIndex,
} from '../services/brain/search';
import { createVault } from '../services/brain/vault';
import type { ParsedNote } from '../services/brain/types';

function note(over: Partial<ParsedNote['frontmatter']> = {}, body = ''): ParsedNote {
  return {
    frontmatter: {
      type: 'Subsystem', aliases: [], keywords: [],
      created: '2026-01-01', updated: '2026-01-01', sources: [], ...over,
    },
    body,
  };
}

describe('vault index', () => {
  let dir: string;
  let index: VaultIndex;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'omnifex-index-'));
    index = createVaultIndex(join(dir, 'index.db'));
  });

  afterEach(() => {
    index.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns nothing for an empty index', () => {
    expect(index.search('anything')).toEqual([]);
  });

  it('finds a note by body text', () => {
    index.upsert('Subsystems/A.md', 'A', note({}, 'the stdio bridge handles permissions'));
    expect(index.search('stdio').map((h) => h.notePath)).toEqual(['Subsystems/A.md']);
  });

  it('finds a note by alias', () => {
    index.upsert('Subsystems/A.md', 'A', note({ aliases: ['permission decider'] }, 'body'));
    expect(index.search('decider')).toHaveLength(1);
  });

  it('finds a note by keyword', () => {
    index.upsert('Subsystems/A.md', 'A', note({ keywords: ['acceptEdits'] }, 'body'));
    expect(index.search('acceptEdits')).toHaveLength(1);
  });

  it('matches hyphenated identifiers as a single token', () => {
    index.upsert('Topics/dep.md', 'dep', note({ type: 'Topic' }, 'node-pty must stay pinned'));
    expect(index.search('node-pty')).toHaveLength(1);
  });

  it('matches underscored identifiers as a single token', () => {
    index.upsert('Topics/dep.md', 'dep', note({ type: 'Topic' }, 'the can_use_tool bridge'));
    expect(index.search('can_use_tool')).toHaveLength(1);
  });

  it('stems English prose so singular finds plural', () => {
    index.upsert('Topics/p.md', 'p', note({ type: 'Topic' }, 'permissions are enforced'));
    expect(index.search('permission')).toHaveLength(1);
  });

  it('ranks a title match above a passing body mention', () => {
    index.upsert('Subsystems/Decider.md', 'Decider', note({}, 'unrelated prose'));
    index.upsert('Topics/Other.md', 'Other', note({ type: 'Topic' }, 'this merely mentions the decider once'));
    expect(index.search('decider')[0].notePath).toBe('Subsystems/Decider.md');
  });

  it('returns a snippet around the match', () => {
    index.upsert('Topics/p.md', 'p', note({ type: 'Topic' }, 'alpha beta stdio gamma delta'));
    expect(index.search('stdio')[0].snippet).toContain('stdio');
  });

  it('upsert replaces rather than duplicating', () => {
    index.upsert('Subsystems/A.md', 'A', note({}, 'first version'));
    index.upsert('Subsystems/A.md', 'A', note({}, 'second version'));
    expect(index.search('version')).toHaveLength(1);
    expect(index.search('first')).toHaveLength(0);
  });

  it('remove deletes a note from the index', () => {
    index.upsert('Subsystems/A.md', 'A', note({}, 'stdio'));
    index.remove('Subsystems/A.md');
    expect(index.search('stdio')).toEqual([]);
  });

  it('filters by note type', () => {
    index.upsert('Subsystems/A.md', 'A', note({}, 'stdio'));
    index.upsert('Topics/B.md', 'B', note({ type: 'Topic' }, 'stdio'));
    expect(index.search('stdio', { type: 'Topic' }).map((h) => h.notePath)).toEqual(['Topics/B.md']);
  });

  it('honours the limit', () => {
    for (let i = 0; i < 5; i++) index.upsert(`Topics/${i}.md`, `${i}`, note({ type: 'Topic' }, 'stdio'));
    expect(index.search('stdio', { limit: 2 })).toHaveLength(2);
  });

  it('returns [] for input that sanitises to nothing, without a SQL error', () => {
    index.upsert('Subsystems/A.md', 'A', note({}, 'stdio'));
    expect(index.search('***')).toEqual([]);
    expect(index.search('')).toEqual([]);
  });

  it('does not throw on input containing FTS5 operators and quotes', () => {
    index.upsert('Subsystems/A.md', 'A', note({}, 'stdio'));
    expect(() => index.search('NEAR("a" OR *b*)')).not.toThrow();
  });

  it('rebuild indexes every note in a vault and reports the count', () => {
    const vault = createVault(join(dir, 'vault'));
    vault.ensureLayout();
    vault.writeNote('Subsystems/A.md', note({}, 'stdio bridge'));
    vault.writeNote('Topics/B.md', note({ type: 'Topic' }, 'unrelated'));

    expect(index.rebuild(vault)).toBe(2);
    expect(index.search('stdio')).toHaveLength(1);
  });

  it('rebuild skips corrupt notes instead of aborting', () => {
    const vault = createVault(join(dir, 'vault'));
    vault.ensureLayout();
    vault.writeNote('Subsystems/Good.md', note({}, 'stdio'));
    // Bypass writeNote so the file is deliberately malformed.
    writeFileSync(join(dir, 'vault', 'Topics', 'Bad.md'), 'no fence\n');

    expect(index.rebuild(vault)).toBe(1);
    expect(index.search('stdio')).toHaveLength(1);
  });

  it('rebuild clears notes that no longer exist', () => {
    const vault = createVault(join(dir, 'vault'));
    vault.ensureLayout();
    index.upsert('Topics/Ghost.md', 'Ghost', note({ type: 'Topic' }, 'stdio'));

    index.rebuild(vault);
    expect(index.search('stdio')).toEqual([]);
  });

  describe('readIndexedCount', () => {
    it('returns null when no index database exists', () => {
      expect(readIndexedCount(join(dir, 'absent', 'index.db'))).toBeNull();
    });

    it('does not create the database it was asked about', () => {
      const path = join(dir, 'absent2', 'index.db');
      readIndexedCount(path);
      expect(existsSync(path)).toBe(false);
    });

    it('returns the row count of an existing index', () => {
      const path = join(dir, 'present', 'index.db');
      const other = createVaultIndex(path);
      other.upsert('Notes/A.md', 'A', note({}, 'alpha'));
      other.upsert('Notes/B.md', 'B', note({}, 'beta'));
      other.close();

      expect(readIndexedCount(path)).toBe(2);
    });

    it('returns null for a file that is not a vault index', () => {
      const path = join(dir, 'garbage.db');
      writeFileSync(path, 'not a database', 'utf8');
      expect(readIndexedCount(path)).toBeNull();
    });
  });

  describe('project filter', () => {
    it('returns only notes whose frontmatter project matches', () => {
      index.upsert('Subsystems/A.md', 'A', note({ project: '[[Projects/omnifex]]' }, 'permission decider'));
      index.upsert('Subsystems/B.md', 'B', note({ project: '[[Projects/win]]' }, 'permission decider'));

      expect(index.search('permission')).toHaveLength(2);
      expect(
        index.search('permission', { project: '[[Projects/omnifex]]' }).map((h) => h.notePath),
      ).toEqual(['Subsystems/A.md']);
    });

    it('excludes a note with no project when one is requested', () => {
      index.upsert('Subsystems/A.md', 'A', note({}, 'permission decider'));
      expect(index.search('permission', { project: '[[Projects/omnifex]]' })).toEqual([]);
    });
  });

  describe('schema migration', () => {
    it('rebuilds when it opens an index that predates the project column', () => {
      const path = join(dir, 'old', 'index.db');
      mkdirSync(join(dir, 'old'), { recursive: true });
      const raw = new BetterSqlite3(path);
      raw.exec(`CREATE VIRTUAL TABLE brain_fts USING fts5(
        note_path UNINDEXED, type UNINDEXED, title, aliases, keywords, summary, body)`);
      raw.prepare('INSERT INTO brain_fts VALUES (?,?,?,?,?,?,?)')
        .run('Old.md', 'Note', 'Old', '', '', '', 'stale');
      raw.close();

      const migrated = createVaultIndex(path);
      // The derived rows are discarded; the caller rebuilds from the vault.
      expect(migrated.search('stale')).toEqual([]);
      migrated.upsert('New.md', 'New', note({ project: '[[Projects/x]]' }, 'fresh'));
      expect(migrated.search('fresh', { project: '[[Projects/x]]' })).toHaveLength(1);
      migrated.close();
    });
  });
});

describe('openVaultIndexReadOnly', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'omnifex-ro-index-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('reads an existing index', () => {
    const path = join(dir, 'index.db');
    const writer = createVaultIndex(path);
    writer.upsert('Topics/T.md', 'T', note({ type: 'Topic' }, 'node-pty leak'));
    writer.close();

    const reader = openVaultIndexReadOnly(path);
    expect(reader.search('node-pty').map((h) => h.notePath)).toEqual(['Topics/T.md']);
    reader.close();
  });

  it('throws for a missing file and creates nothing', () => {
    const path = join(dir, 'absent', 'index.db');
    expect(() => openVaultIndexReadOnly(path)).toThrow(BrainIndexUnavailableError);
    expect(existsSync(path)).toBe(false);
  });

  it('throws for a file that is not a vault index', () => {
    const path = join(dir, 'garbage.db');
    writeFileSync(path, 'not a database', 'utf8');
    expect(() => openVaultIndexReadOnly(path)).toThrow(BrainIndexUnavailableError);
  });

  it('throws for an index that predates the project column', () => {
    const path = join(dir, 'old.db');
    const raw = new BetterSqlite3(path);
    raw.exec(`CREATE VIRTUAL TABLE brain_fts USING fts5(
      note_path UNINDEXED, type UNINDEXED, title, aliases, keywords, summary, body)`);
    raw.close();

    expect(() => openVaultIndexReadOnly(path)).toThrow(BrainIndexUnavailableError);
  });

  it('ranks identically to the read-write index over the same corpus', () => {
    const path = join(dir, 'index.db');
    const writer = createVaultIndex(path);
    writer.upsert('Subsystems/Queue.md', 'Queue', note({ keywords: ['queue.ts'] }, 'the drain worker'));
    writer.upsert('Topics/Drain.md', 'Drain', note({ type: 'Topic' }, 'mentions the queue in passing'));
    const expected = writer.search('queue');
    writer.close();

    const reader = openVaultIndexReadOnly(path);
    expect(reader.search('queue')).toEqual(expected);
    reader.close();
  });

  it('honours the type and project filters', () => {
    const path = join(dir, 'index.db');
    const writer = createVaultIndex(path);
    writer.upsert('Subsystems/A.md', 'A', note({ project: '[[Projects/omnifex]]' }, 'shared word'));
    writer.upsert('Topics/B.md', 'B', note({ type: 'Topic' }, 'shared word'));
    writer.close();

    const reader = openVaultIndexReadOnly(path);
    expect(reader.search('shared', { type: 'Topic' }).map((h) => h.notePath)).toEqual(['Topics/B.md']);
    expect(reader.search('shared', { project: '[[Projects/omnifex]]' }).map((h) => h.notePath))
      .toEqual(['Subsystems/A.md']);
    reader.close();
  });
});
