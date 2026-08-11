import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, mkdirSync, symlinkSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, isAbsolute, sep } from 'node:path';
import { createDatabase, type Database } from '../services/database';
import { createBrainService, VaultConflictError, type BrainService } from '../services/brain/registry';
import type { ParsedNote } from '../services/brain/types';

function note(body: string, type: ParsedNote['frontmatter']['type'] = 'Subsystem'): ParsedNote {
  return {
    frontmatter: {
      type, aliases: [], keywords: [],
      created: '2026-01-01', updated: '2026-01-01', sources: [],
    },
    body,
  };
}

describe('brain registry', () => {
  let dir: string;
  let db: Database;
  let brain: BrainService;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'omnifex-brain-'));
    db = createDatabase(':memory:');
    brain = createBrainService(db);
  });

  afterEach(() => {
    brain.closeAll();
    db.close();
    // open() fires git init in the background, so a `.git` directory can still
    // be growing while this runs. Retry rather than fail the test on ENOTEMPTY.
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });

  it('returns null for an account with no vault configured', () => {
    expect(brain.vaultPath(1)).toBeNull();
    expect(brain.open(1)).toBeNull();
  });

  it('search on an unconfigured account returns [] rather than throwing', () => {
    expect(brain.search(1, 'anything')).toEqual([]);
  });

  it('persists a vault path per account', () => {
    brain.setVaultPath(1, join(dir, 'personal'));
    expect(brain.vaultPath(1)).toBe(join(dir, 'personal'));
    expect(brain.vaultPath(2)).toBeNull();
  });

  it('creates the vault layout on open', () => {
    brain.setVaultPath(1, join(dir, 'personal'));
    const handle = brain.open(1);
    expect(handle).not.toBeNull();
    expect(handle!.root).toBe(join(dir, 'personal'));
    expect(existsSync(join(dir, 'personal', 'Subsystems'))).toBe(true);
  });

  it('rejects assigning one vault path to two accounts', () => {
    brain.setVaultPath(1, join(dir, 'shared'));
    expect(() => brain.setVaultPath(2, join(dir, 'shared'))).toThrow(VaultConflictError);
  });

  it('allows reassigning the same path to the same account', () => {
    brain.setVaultPath(1, join(dir, 'personal'));
    expect(() => brain.setVaultPath(1, join(dir, 'personal'))).not.toThrow();
  });

  it('frees a path once cleared', () => {
    brain.setVaultPath(1, join(dir, 'shared'));
    brain.clearVaultPath(1);
    expect(() => brain.setVaultPath(2, join(dir, 'shared'))).not.toThrow();
  });

  it('writes a note and finds it via search', () => {
    brain.setVaultPath(1, join(dir, 'personal'));
    brain.writeNote(1, 'Subsystems/A.md', note('the stdio bridge'), 'Manual edit');
    expect(brain.search(1, 'stdio').map((h) => h.notePath)).toEqual(['Subsystems/A.md']);
  });

  it('ISOLATION: a note written to one account is invisible to another', () => {
    brain.setVaultPath(1, join(dir, 'personal'));
    brain.setVaultPath(2, join(dir, 'work'));

    brain.writeNote(1, 'Subsystems/Personal.md', note('personal stdio secret'), 'Manual edit');
    brain.writeNote(2, 'Subsystems/Work.md', note('work stdio secret'), 'Manual edit');

    expect(brain.search(1, 'stdio').map((h) => h.notePath)).toEqual(['Subsystems/Personal.md']);
    expect(brain.search(2, 'stdio').map((h) => h.notePath)).toEqual(['Subsystems/Work.md']);
  });

  it('ISOLATION: each vault gets its own index database file', () => {
    brain.setVaultPath(1, join(dir, 'personal'));
    brain.setVaultPath(2, join(dir, 'work'));
    brain.open(1);
    brain.open(2);

    expect(existsSync(join(dir, 'personal', '.omnifex', 'index.db'))).toBe(true);
    expect(existsSync(join(dir, 'work', '.omnifex', 'index.db'))).toBe(true);
  });

  it('reuses one handle per account rather than reopening', () => {
    brain.setVaultPath(1, join(dir, 'personal'));
    expect(brain.open(1)).toBe(brain.open(1));
  });

  it('drops the cached handle when the path changes', () => {
    brain.setVaultPath(1, join(dir, 'first'));
    const first = brain.open(1);
    brain.setVaultPath(1, join(dir, 'second'));
    expect(brain.open(1)).not.toBe(first);
    expect(brain.open(1)!.root).toBe(join(dir, 'second'));
  });

  it('rejects a vault path that aliases another account via a symlink', () => {
    const real = join(dir, 'realvault');
    mkdirSync(real, { recursive: true });
    symlinkSync(real, join(dir, 'linkvault'));
    brain.setVaultPath(1, real);
    expect(() => brain.setVaultPath(2, join(dir, 'linkvault'))).toThrow(VaultConflictError);
  });

  it('rejects a case-variant path on a case-insensitive filesystem', () => {
    const upper = join(dir, 'Vault');
    mkdirSync(upper, { recursive: true });
    // Skip where aliasing is impossible; on a case-sensitive FS these are two dirs.
    if (!existsSync(join(dir, 'vault'))) return;
    brain.setVaultPath(1, upper);
    expect(() => brain.setVaultPath(2, join(dir, 'vault'))).toThrow(VaultConflictError);
  });

  it('rejects a vault path nested inside another account vault', () => {
    brain.setVaultPath(1, join(dir, 'personal'));
    expect(() => brain.setVaultPath(2, join(dir, 'personal', 'work'))).toThrow(VaultConflictError);
  });

  it('rejects a vault path that contains another account vault', () => {
    brain.setVaultPath(1, join(dir, 'outer', 'inner'));
    expect(() => brain.setVaultPath(2, join(dir, 'outer'))).toThrow(VaultConflictError);
  });

  it('rejects a non-integer accountId rather than silently keying on it', () => {
    expect(() => brain.setVaultPath('1' as unknown as number, join(dir, 'x'))).toThrow(/accountId/);
    expect(() => brain.open(NaN)).toThrow(/accountId/);
    expect(() => brain.search(0, 'x')).toThrow(/accountId/);
  });

  it('ignores non-path settings under the brain.vault namespace', () => {
    db.saveSetting('brain.vault.enabled', 'true');
    expect(() => brain.setVaultPath(1, join(dir, 'personal'))).not.toThrow();
  });

  it('rejects a symlink alias when the target does not exist at config time', () => {
    const real = join(dir, 'realvault');
    symlinkSync(real, join(dir, 'linkvault')); // dangling right now
    brain.setVaultPath(1, real);
    expect(() => brain.setVaultPath(2, join(dir, 'linkvault'))).toThrow(VaultConflictError);
  });

  it('rejects a case-variant alias when the directory does not exist at config time', () => {
    mkdirSync(join(dir, 'CaseProbe'), { recursive: true });
    if (!existsSync(join(dir, 'caseprobe'))) return; // case-sensitive FS: not aliasable
    brain.setVaultPath(1, join(dir, 'Vault'));       // NOT pre-created
    expect(() => brain.setVaultPath(2, join(dir, 'vault'))).toThrow(VaultConflictError);
  });

  it('rejects nesting under a case-variant parent', () => {
    mkdirSync(join(dir, 'CaseProbe2'), { recursive: true });
    if (!existsSync(join(dir, 'caseprobe2'))) return;
    brain.setVaultPath(1, join(dir, 'Personal'));
    expect(() => brain.setVaultPath(2, join(dir, 'personal', 'work'))).toThrow(VaultConflictError);
  });

  it('rejects an accountId beyond the safe integer range', () => {
    expect(() => brain.open(1e21)).toThrow(/accountId/);
  });

  it('rejects a vault path it cannot create', () => {
    const ro = join(dir, 'readonly');
    mkdirSync(ro, { recursive: true });
    chmodSync(ro, 0o555);
    try {
      expect(() => brain.setVaultPath(1, join(ro, 'Vault'))).toThrow(/cannot create vault directory/);
    } finally {
      chmodSync(ro, 0o755); // so afterEach can clean up
    }
  });

  it('does not leave a stray directory when the configuration is rejected', () => {
    brain.setVaultPath(1, join(dir, 'personal'));
    expect(() => brain.setVaultPath(2, join(dir, 'personal', 'work'))).toThrow(VaultConflictError);
    expect(existsSync(join(dir, 'personal', 'work'))).toBe(false);
  });

  it('stores a relative vault path in resolved form', () => {
    const cwd = process.cwd();
    process.chdir(dir);
    try {
      brain.setVaultPath(1, 'relvault');
      const stored = brain.vaultPath(1);
      expect(stored).not.toBeNull();
      expect(isAbsolute(stored!)).toBe(true);
      expect(stored!.endsWith(`${sep}relvault`)).toBe(true);
    } finally {
      process.chdir(cwd);
    }
  });

  it('detects an overlap introduced on disk after configuration', () => {
    brain.setVaultPath(1, join(dir, 'personal'));
    brain.setVaultPath(2, join(dir, 'work'));
    brain.open(1);
    brain.open(2);
    brain.closeAll();
    rmSync(join(dir, 'work'), { recursive: true, force: true });
    symlinkSync(join(dir, 'personal'), join(dir, 'work'));
    expect(() => brain.open(2)).toThrow(VaultConflictError);
  });

  // --- round 4 ---------------------------------------------------------------

  it('ISOLATION: re-validates a handle already cached when the swap happens', () => {
    brain.setVaultPath(1, join(dir, 'personal'));
    brain.setVaultPath(2, join(dir, 'work'));
    brain.writeNote(1, 'Subsystems/Personal.md', note('personal stdio secret'), 'Manual edit');

    // Cache account 2's handle, then swap its directory WITHOUT closing it.
    // A guard that only runs on a cold open is no guard at all: once the
    // process has a handle it keeps using it for the rest of its life.
    brain.open(2);
    rmSync(join(dir, 'work'), { recursive: true, force: true });
    symlinkSync(join(dir, 'personal'), join(dir, 'work'));

    expect(() =>
      brain.writeNote(2, 'Subsystems/Leak.md', note('written under account 2'), 'Manual edit'),
    ).toThrow(VaultConflictError);
    expect(existsSync(join(dir, 'personal', 'Subsystems', 'Leak.md'))).toBe(false);
    // Nothing is handed out either, so listNotes()/readNote() are unreachable.
    expect(() => brain.open(2)).toThrow(VaultConflictError);
  });

  it('does not scaffold inside the victim vault before rejecting a cold open', () => {
    brain.setVaultPath(1, join(dir, 'personal'));
    brain.setVaultPath(2, join(dir, 'work'));
    rmSync(join(dir, 'work'), { recursive: true, force: true });
    symlinkSync(join(dir, 'personal'), join(dir, 'work'));

    expect(() => brain.open(2)).toThrow(VaultConflictError);
    expect(existsSync(join(dir, 'personal', 'Subsystems'))).toBe(false);
    expect(existsSync(join(dir, 'personal', 'config', 'notes.json'))).toBe(false);
  });

  it('degrades search to [] instead of throwing when an overlap appears on disk', () => {
    brain.setVaultPath(1, join(dir, 'personal'));
    brain.setVaultPath(2, join(dir, 'work'));
    brain.writeNote(1, 'Subsystems/Personal.md', note('personal stdio secret'), 'Manual edit');
    brain.closeAll();

    rmSync(join(dir, 'work'), { recursive: true, force: true });
    symlinkSync(join(dir, 'personal'), join(dir, 'work'));

    // Account 1's configuration and directory never changed; the Brain is
    // auxiliary, so its search must not start throwing at the caller.
    expect(brain.search(1, 'stdio')).toEqual([]);
    expect(brain.search(2, 'stdio')).toEqual([]);
    // Anything that hands out access or writes still fails closed.
    expect(() => brain.open(1)).toThrow(VaultConflictError);
    expect(() =>
      brain.writeNote(2, 'Subsystems/Leak.md', note('leaked'), 'Manual edit'),
    ).toThrow(VaultConflictError);
  });

  it('rejects an empty or whitespace-only vault path', () => {
    const cwd = process.cwd();
    process.chdir(dir);
    try {
      expect(() => brain.setVaultPath(1, '')).toThrow(/vault path/);
      expect(() => brain.setVaultPath(1, '   ')).toThrow(/vault path/);
      expect(brain.vaultPath(1)).toBeNull();
    } finally {
      process.chdir(cwd);
    }
  });

  it('rejects an unexpanded ~ path rather than creating a literal ~ directory', () => {
    const cwd = process.cwd();
    process.chdir(dir);
    try {
      expect(() => brain.setVaultPath(1, '~/BrainVault')).toThrow(/vault path/);
      expect(existsSync(join(dir, '~'))).toBe(false);
      expect(brain.vaultPath(1)).toBeNull();
    } finally {
      process.chdir(cwd);
    }
  });

  it('rebinds a cached handle when its directory is replaced on disk', () => {
    brain.setVaultPath(1, join(dir, 'personal'));
    const first = brain.open(1);
    brain.writeNote(1, 'Subsystems/A.md', note('the stdio bridge'), 'Manual edit');
    expect(brain.search(1, 'stdio').map((h) => h.notePath)).toEqual(['Subsystems/A.md']);

    // Same path, different directory — a restore-from-backup, say. The cached
    // index handle still points at the unlinked index.db.
    rmSync(join(dir, 'personal'), { recursive: true, force: true });
    mkdirSync(join(dir, 'personal'), { recursive: true });

    expect(brain.open(1)).not.toBe(first);
    expect(brain.search(1, 'stdio')).toEqual([]);
  });
});
