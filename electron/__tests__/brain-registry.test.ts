import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  mkdtempSync, rmSync, existsSync, mkdirSync, symlinkSync, chmodSync, linkSync, renameSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, isAbsolute, sep } from 'node:path';
import { createDatabase, type Database } from '../services/database';
import {
  createBrainService,
  vaultSettingKey,
  VaultConflictError,
  type BrainService,
} from '../services/brain/registry';
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
    // open() fires `git init` in the background and nothing tracks the child
    // process, so a `.git` directory can still be filling while this runs.
    // Retry, then give up quietly: this is cleanup, not an assertion, and a
    // temp directory surviving in $TMPDIR must never fail a test.
    // The retry budget is deliberately small: node backs off linearly
    // (retryDelay x attempt), so a large one blows vitest's 10s hook timeout,
    // which is a worse failure than a surviving temp directory.
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    } catch {
      // Best effort — the OS reaps $TMPDIR.
    }
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

  // --- round 5 ---------------------------------------------------------------

  const indexDir = (name: string): string => join(dir, name, '.omnifex');
  const indexDb = (name: string): string => join(indexDir(name), 'index.db');

  /** Two configured vaults, each with one note and a built index. */
  function twoVaults(): void {
    brain.setVaultPath(1, join(dir, 'personal'));
    brain.setVaultPath(2, join(dir, 'work'));
    brain.writeNote(1, 'Subsystems/Personal.md', note('personal stdio secret'), 'Manual edit');
    brain.writeNote(2, 'Subsystems/Work.md', note('work stdio secret'), 'Manual edit');
    brain.closeAll();
  }

  it('ISOLATION: refuses an index directory symlinked into another vault', () => {
    twoVaults();
    rmSync(indexDir('work'), { recursive: true, force: true });
    symlinkSync(indexDir('personal'), indexDir('work'));

    expect(() => brain.open(2)).toThrow(VaultConflictError);
    expect(brain.search(2, 'stdio')).toEqual([]);
    expect(() =>
      brain.writeNote(2, 'Subsystems/Leak.md', note('leaked'), 'Manual edit'),
    ).toThrow(VaultConflictError);
  });

  it('ISOLATION: refuses an index database symlinked into another vault', () => {
    twoVaults();
    rmSync(indexDb('work'), { force: true });
    symlinkSync(indexDb('personal'), indexDb('work'));

    expect(() => brain.open(2)).toThrow(VaultConflictError);
    expect(brain.search(2, 'stdio')).toEqual([]);
  });

  it('ISOLATION: refuses a DANGLING index symlink, which SQLite would create', () => {
    brain.setVaultPath(1, join(dir, 'personal'));
    brain.setVaultPath(2, join(dir, 'work'));
    brain.writeNote(1, 'Subsystems/Personal.md', note('personal stdio secret'), 'Manual edit');
    brain.closeAll();
    // Account 2 has never been opened, so its index does not exist yet: the
    // link has no target until better-sqlite3 creates one inside account 1.
    mkdirSync(indexDir('work'), { recursive: true });
    symlinkSync(join(dir, 'personal', '.omnifex', 'nonexistent.db'), indexDb('work'));

    expect(() => brain.open(2)).toThrow(VaultConflictError);
    expect(existsSync(join(dir, 'personal', '.omnifex', 'nonexistent.db'))).toBe(false);
  });

  it('ISOLATION: refuses an index database HARD-LINKED to another vault', () => {
    twoVaults();
    rmSync(indexDb('work'), { force: true });
    linkSync(indexDb('personal'), indexDb('work'));

    // No path check can see this: both names are legitimately inside their own
    // vault, and there is no symlink anywhere. Only the inode gives it away.
    expect(() => brain.open(2)).toThrow(VaultConflictError);
    expect(brain.search(2, 'stdio')).toEqual([]);
  });

  it('ISOLATION: re-checks the index on a WARM handle', () => {
    brain.setVaultPath(1, join(dir, 'personal'));
    brain.setVaultPath(2, join(dir, 'work'));
    brain.writeNote(1, 'Subsystems/Personal.md', note('personal stdio secret'), 'Manual edit');
    brain.open(2); // warm — deliberately not closed
    rmSync(indexDir('work'), { recursive: true, force: true });
    symlinkSync(indexDir('personal'), indexDir('work'));

    expect(() =>
      brain.writeNote(2, 'Subsystems/Leak.md', note('leaked'), 'Manual edit'),
    ).toThrow(VaultConflictError);
    expect(() => brain.open(2)).toThrow(VaultConflictError);
  });

  it('accepts a vault reached through a symlinked root', () => {
    // The guard must not fire on a legitimate arrangement: a vault whose root
    // is itself a symlink is fine, so long as it overlaps nobody.
    mkdirSync(join(dir, 'elsewhere'), { recursive: true });
    symlinkSync(join(dir, 'elsewhere'), join(dir, 'linked'));
    brain.setVaultPath(1, join(dir, 'linked'));
    brain.writeNote(1, 'Subsystems/A.md', note('the stdio bridge'), 'Manual edit');
    expect(brain.search(1, 'stdio').map((h) => h.notePath)).toEqual(['Subsystems/A.md']);
  });

  it('trims a vault path before resolving it, not only before validating it', () => {
    const cwd = process.cwd();
    process.chdir(dir);
    try {
      brain.setVaultPath(1, `  ${join(dir, 'padded')}  `);
      expect(brain.vaultPath(1)).toBe(join(dir, 'padded'));
      // A leading space would have made the absolute path RELATIVE.
      expect(existsSync(join(dir, '  '))).toBe(false);
    } finally {
      process.chdir(cwd);
    }
  });

  it('treats the filesystem root as containing every other vault', () => {
    brain.setVaultPath(1, sep);
    expect(() => brain.setVaultPath(2, join(dir, 'work'))).toThrow(VaultConflictError);
  });

  it('re-checks the settings table on a warm handle whose directory is untouched', () => {
    brain.setVaultPath(2, join(dir, 'work'));
    brain.writeNote(2, 'Subsystems/Work.md', note('work stdio secret'), 'Manual edit');

    // A conflicting row written straight into app_settings: a migration, a
    // second service instance, a future writer. Nothing on disk moves, so the
    // handle's identity is unchanged and the cache would happily serve it.
    // Only running the guard BEFORE the cache catches this.
    db.saveSetting(vaultSettingKey(1), join(dir, 'work'));

    expect(() => brain.open(2)).toThrow(VaultConflictError);
    expect(() =>
      brain.writeNote(2, 'Subsystems/X.md', note('x'), 'Manual edit'),
    ).toThrow(VaultConflictError);
    expect(brain.search(2, 'stdio')).toEqual([]);
  });

  it('degrades a WARM search to [] when an overlap appears on disk', () => {
    brain.setVaultPath(1, join(dir, 'personal'));
    brain.setVaultPath(2, join(dir, 'work'));
    brain.writeNote(1, 'Subsystems/Personal.md', note('personal stdio secret'), 'Manual edit');
    brain.open(2); // both handles warm — no closeAll before the swap
    rmSync(join(dir, 'work'), { recursive: true, force: true });
    symlinkSync(join(dir, 'personal'), join(dir, 'work'));

    expect(brain.search(1, 'stdio')).toEqual([]);
    expect(brain.search(2, 'stdio')).toEqual([]);
  });

  // --- round 6 ---------------------------------------------------------------

  it('ISOLATION: refuses a hard-linked WAL sidecar, not just index.db', () => {
    brain.setVaultPath(1, join(dir, 'personal'));
    brain.setVaultPath(2, join(dir, 'work'));
    brain.writeNote(2, 'Subsystems/Work.md', note('work stdio secret'), 'Manual edit');
    brain.closeAll(); // account 2's own WAL is checkpointed away on close
    brain.writeNote(1, 'Subsystems/Personal.md', note('personal stdio secret'), 'Manual edit');
    // Account 1 stays warm, so its -wal exists and still holds its note.
    linkSync(join(indexDir('personal'), 'index.db-wal'), join(indexDir('work'), 'index.db-wal'));

    // Reopening account 2 replays account 1's WAL frames over account 2's
    // database: account 1's bodies appear and account 2's own note vanishes.
    expect(() => brain.open(2)).toThrow(VaultConflictError);
    expect(brain.search(2, 'stdio')).toEqual([]);
  });

  it('tolerates a subdirectory under the index directory', () => {
    brain.setVaultPath(1, join(dir, 'personal'));
    brain.writeNote(1, 'Subsystems/A.md', note('the stdio bridge'), 'Manual edit');
    // A directory legitimately has nlink > 1 — '.' plus its parent's entry for
    // it — so the hard-link test must never be applied to one.
    mkdirSync(join(indexDir('personal'), 'scratch'), { recursive: true });

    expect(brain.search(1, 'stdio').map((h) => h.notePath)).toEqual(['Subsystems/A.md']);
  });

  it('ISOLATION: refuses an index directory symlinked into the victim note tree', () => {
    brain.setVaultPath(1, join(dir, 'personal'));
    brain.setVaultPath(2, join(dir, 'work'));
    brain.writeNote(1, 'Subsystems/Personal.md', note('personal stdio secret'), 'Manual edit');
    brain.closeAll();
    rmSync(indexDir('work'), { recursive: true, force: true });
    // Not another .omnifex — an ordinary directory in the victim's note tree.
    // Its entries are innocent, so only the containment check can object.
    symlinkSync(join(dir, 'personal', 'Subsystems'), indexDir('work'));

    expect(() => brain.open(2)).toThrow(VaultConflictError);
    // Account 2's whole FTS database would otherwise be built in account 1's notes.
    expect(existsSync(join(dir, 'personal', 'Subsystems', 'index.db'))).toBe(false);
  });

  it('releases the SQLite descriptor when a cached handle is judged unsafe', () => {
    brain.setVaultPath(1, join(dir, 'personal'));
    brain.setVaultPath(2, join(dir, 'work'));
    const handle = brain.open(2)!;
    rmSync(join(dir, 'work'), { recursive: true, force: true });
    symlinkSync(join(dir, 'personal'), join(dir, 'work'));

    expect(() => brain.open(2)).toThrow(VaultConflictError);
    expect(() => handle.index.search('anything')).toThrow(/not open/);
  });

  it('rebuilds a handle when the configured path becomes an alias of the same directory', () => {
    mkdirSync(join(dir, 'real'), { recursive: true });
    symlinkSync(join(dir, 'real'), join(dir, 'alias'));
    brain.setVaultPath(1, join(dir, 'real'));
    const first = brain.open(1);

    // Same directory, different name, written straight into app_settings. Every
    // inode is unchanged, so only the path half of the cache key notices.
    db.saveSetting(vaultSettingKey(1), join(dir, 'alias'));

    const second = brain.open(1);
    expect(second).not.toBe(first);
    expect(second!.root).toBe(join(dir, 'alias'));
  });

  it('rebinds a cached handle when its root is replaced but its index survives', () => {
    brain.setVaultPath(1, join(dir, 'personal'));
    brain.writeNote(1, 'Subsystems/A.md', note('the stdio bridge'), 'Manual edit');
    const first = brain.open(1);

    // A different directory at the same path, carrying the SAME index file, so
    // only the root half of the identity changes. It has to: the handle's Vault
    // resolved its real root once and checks every note path against that.
    renameSync(join(dir, 'personal'), join(dir, 'personal-old'));
    mkdirSync(join(dir, 'personal'), { recursive: true });
    renameSync(join(dir, 'personal-old', '.omnifex'), indexDir('personal'));

    expect(brain.open(1)).not.toBe(first);
    expect(brain.search(1, 'stdio').map((h) => h.notePath)).toEqual(['Subsystems/A.md']);
  });

  it('rebinds a cached handle when its index database is deleted', () => {
    brain.setVaultPath(1, join(dir, 'personal'));
    brain.writeNote(1, 'Subsystems/A.md', note('the stdio bridge'), 'Manual edit');
    rmSync(indexDb('personal'), { force: true });

    brain.writeNote(1, 'Subsystems/B.md', note('another stdio note'), 'Manual edit');
    // A cached handle still holding the unlinked inode would swallow that write
    // silently: the file would never come back and the note would be missing
    // from the index for the life of the process.
    expect(existsSync(indexDb('personal'))).toBe(true);
    expect(brain.search(1, 'stdio').map((h) => h.notePath)).toEqual(['Subsystems/B.md']);
  });

  it('treats a whitespace-only stored path as unconfigured rather than scaffolding at cwd', () => {
    // Bypasses setVaultPath() entirely — the same way a raw app_settings write
    // (tests, or the dev-only raw-SQL channel) would. `db.saveSetting` is
    // truthy and survives the `if (!path) return null` guard in open(), so
    // only a read-side resolveVaultRoot() call catches it. open() returns null
    // rather than throwing: an unusable stored value is treated the same as
    // "no configured vault" for every other unconfigured-account case (e.g.
    // search() already returns [] rather than throwing).
    db.saveSetting(vaultSettingKey(1), '   ');
    const cwd = process.cwd();

    expect(brain.open(1)).toBeNull();
    expect(brain.search(1, 'anything')).toEqual([]);
    expect(existsSync(join(cwd, '   '))).toBe(false);
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

  describe('backlinks', () => {
    it('finds notes that link to the given note', () => {
      brain.setVaultPath(1, join(dir, 'links'));
      brain.writeNote(1, 'Subsystems/Sessions.md', note('the session layer'), 'test');
      brain.writeNote(1, 'Projects/omnifex.md', note('uses [[Sessions]] heavily'), 'test');
      brain.writeNote(1, 'Topics/Unrelated.md', note('nothing here'), 'test');

      expect(brain.backlinks(1, 'Subsystems/Sessions.md')).toEqual(['Projects/omnifex.md']);
    });

    it('matches a path-form link and a display-text link', () => {
      brain.setVaultPath(1, join(dir, 'links2'));
      brain.writeNote(1, 'Subsystems/Sessions.md', note('x'), 'test');
      brain.writeNote(1, 'Projects/a.md', note('[[Subsystems/Sessions]]'), 'test');
      brain.writeNote(1, 'Projects/b.md', note('[[Sessions|the layer]]'), 'test');

      expect(brain.backlinks(1, 'Subsystems/Sessions.md').sort()).toEqual([
        'Projects/a.md',
        'Projects/b.md',
      ]);
    });

    it('never lists the note itself', () => {
      brain.setVaultPath(1, join(dir, 'links3'));
      brain.writeNote(1, 'Notes/Self.md', note('I link to [[Self]]'), 'test');

      expect(brain.backlinks(1, 'Notes/Self.md')).toEqual([]);
    });

    it('skips a corrupt note rather than aborting the scan', () => {
      brain.setVaultPath(1, join(dir, 'links4'));
      brain.writeNote(1, 'Subsystems/Sessions.md', note('x'), 'test');
      brain.writeNote(1, 'Projects/a.md', note('[[Sessions]]'), 'test');
      writeFileSync(join(dir, 'links4', 'Topics', 'Bad.md'), 'no frontmatter\n');

      expect(brain.backlinks(1, 'Subsystems/Sessions.md')).toEqual(['Projects/a.md']);
    });

    it('returns empty for an account with no vault', () => {
      expect(brain.backlinks(1, 'Notes/A.md')).toEqual([]);
    });
  });

  describe('rebuild', () => {
    it('indexes notes that were written into the vault behind the service', () => {
      brain.setVaultPath(1, join(dir, 'preexisting'));
      const handle = brain.open(1)!;
      // Simulate a vault populated in Obsidian: files on disk, index empty.
      handle.vault.writeNote('Notes/Outside.md', note('written elsewhere'));
      expect(brain.search(1, 'elsewhere')).toEqual([]);

      expect(brain.rebuild(1)).toBe(1);
      expect(brain.search(1, 'elsewhere')).toHaveLength(1);
    });

    it('drops index rows for notes deleted on disk', () => {
      brain.setVaultPath(1, join(dir, 'stale'));
      brain.writeNote(1, 'Notes/A.md', note('alpha'), 'test');
      brain.open(1)!.vault.deleteNote('Notes/A.md');

      expect(brain.rebuild(1)).toBe(0);
      expect(brain.search(1, 'alpha')).toEqual([]);
    });

    it('throws for an account with no vault', () => {
      expect(() => brain.rebuild(1)).toThrow(/no vault configured/);
    });
  });

  describe('deleteNote', () => {
    it('removes the note from disk and from the index', () => {
      brain.setVaultPath(1, join(dir, 'delnote'));
      brain.writeNote(1, 'Notes/A.md', note('alpha'), 'test');
      expect(brain.search(1, 'alpha')).toHaveLength(1);

      brain.deleteNote(1, 'Notes/A.md');
      expect(brain.search(1, 'alpha')).toEqual([]);
      expect(brain.open(1)!.vault.listNotes()).not.toContain('Notes/A.md');
    });

    it('throws for an account with no vault', () => {
      expect(() => brain.deleteNote(1, 'Notes/A.md')).toThrow(/no vault configured/);
    });
  });

  describe('updateNoteBody', () => {
    it('replaces the body and reindexes', () => {
      brain.setVaultPath(1, join(dir, 'edit'));
      brain.writeNote(1, 'Notes/A.md', note('alpha'), 'test');

      const updated = brain.updateNoteBody(1, 'Notes/A.md', '## Summary\n\nomega\n');
      expect(updated.body).toBe('## Summary\n\nomega\n');
      expect(brain.search(1, 'omega')).toHaveLength(1);
      expect(brain.search(1, 'alpha')).toEqual([]);
    });

    it('preserves frontmatter the caller did not supply', () => {
      brain.setVaultPath(1, join(dir, 'edit2'));
      const original = note('alpha');
      original.frontmatter.sources = ['session:abc'];
      original.frontmatter.keywords = ['pty'];
      brain.writeNote(1, 'Notes/A.md', original, 'test');

      const updated = brain.updateNoteBody(1, 'Notes/A.md', 'rewritten\n');
      expect(updated.frontmatter.sources).toEqual(['session:abc']);
      expect(updated.frontmatter.keywords).toEqual(['pty']);
      expect(updated.frontmatter.type).toBe(original.frontmatter.type);
    });

    it('stamps updated with today', () => {
      brain.setVaultPath(1, join(dir, 'edit3'));
      const original = note('alpha');
      original.frontmatter.updated = '2020-01-01';
      brain.writeNote(1, 'Notes/A.md', original, 'test');

      const updated = brain.updateNoteBody(1, 'Notes/A.md', 'rewritten\n');
      expect(updated.frontmatter.updated).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(updated.frontmatter.updated).not.toBe('2020-01-01');
    });

    it('persists the change to disk, not just to the index', () => {
      brain.setVaultPath(1, join(dir, 'edit4'));
      brain.writeNote(1, 'Notes/A.md', note('alpha'), 'test');
      brain.updateNoteBody(1, 'Notes/A.md', 'rewritten\n');

      expect(brain.open(1)!.vault.readNote('Notes/A.md').body).toBe('rewritten\n');
    });

    it('throws for an account with no vault', () => {
      expect(() => brain.updateNoteBody(1, 'Notes/A.md', 'x')).toThrow(/no vault configured/);
    });
  });

  describe('status', () => {
    it('reports an unconfigured account without creating anything', async () => {
      expect(await brain.status(1)).toMatchObject({
        accountId: 1,
        configured: false,
        path: null,
        exists: false,
        initialized: false,
        noteCount: 0,
        indexedCount: null,
        conflict: null,
      });
    });

    it('reports a configured vault whose directory was deleted', async () => {
      const root = join(dir, 'gone');
      brain.setVaultPath(1, root);
      brain.closeAll();
      rmSync(root, { recursive: true, force: true });

      const status = await brain.status(1);
      expect(status.configured).toBe(true);
      expect(status.path).toBe(root);
      expect(status.exists).toBe(false);
      expect(status.initialized).toBe(false);
      expect(status.noteCount).toBe(0);
    });

    it('does not create the vault it reports on', async () => {
      const root = join(dir, 'never-created');
      db.saveSetting(vaultSettingKey(1), root);

      await brain.status(1);
      expect(existsSync(root)).toBe(false);
    });

    it('counts notes on disk and rows in the index separately', async () => {
      brain.setVaultPath(1, join(dir, 'populated'));
      brain.writeNote(1, 'Notes/A.md', note('alpha'), 'test');

      const status = await brain.status(1);
      expect(status.exists).toBe(true);
      expect(status.initialized).toBe(true);
      expect(status.noteCount).toBe(1);
      expect(status.indexedCount).toBe(1);
    });

    it('reports a stale index without rebuilding it', async () => {
      brain.setVaultPath(1, join(dir, 'stale-index'));
      const handle = brain.open(1)!;
      // A vault populated in Obsidian: files on disk, index untouched.
      handle.vault.writeNote('Notes/Outside.md', note('written elsewhere'));

      const status = await brain.status(1);
      expect(status.noteCount).toBe(1);
      expect(status.indexedCount).toBe(0);
    });

    it('reports a conflict instead of throwing', async () => {
      const shared = join(dir, 'shared');
      brain.setVaultPath(1, shared);
      // Write account 2's row directly: setVaultPath would reject the overlap,
      // and the point of this test is the state where a conflict already exists.
      db.saveSetting(vaultSettingKey(2), shared);

      const status = await brain.status(2);
      expect(status.conflict).toContain('overlaps');
      expect(status.configured).toBe(true);
    });

    it('reports a stored path that could never be opened as a conflict', async () => {
      db.saveSetting(vaultSettingKey(1), '   ');
      const status = await brain.status(1);
      expect(status.conflict).toBeTruthy();
      expect(status.exists).toBe(false);
    });

    it('rejects a malformed accountId', async () => {
      await expect(brain.status(0)).rejects.toThrow(/invalid accountId/);
    });
  });

  describe('git directory ownership', () => {
    it('rejects a symlinked .git', () => {
      const victimGit = join(dir, 'victim-git');
      mkdirSync(victimGit, { recursive: true });

      const root = join(dir, 'attacker');
      mkdirSync(root, { recursive: true });
      symlinkSync(victimGit, join(root, '.git'), 'dir');

      brain.setVaultPath(1, root);
      expect(() => brain.open(1)).toThrow(VaultConflictError);
    });

    it('rejects a .git gitfile that redirects elsewhere', () => {
      const root = join(dir, 'gitfile-vault');
      mkdirSync(root, { recursive: true });
      writeFileSync(join(root, '.git'), `gitdir: ${join(dir, 'somewhere-else')}\n`, 'utf8');

      brain.setVaultPath(1, root);
      expect(() => brain.open(1)).toThrow(VaultConflictError);
    });

    it('accepts a vault with an ordinary .git directory', () => {
      const root = join(dir, 'normal-vault');
      mkdirSync(join(root, '.git'), { recursive: true });

      brain.setVaultPath(1, root);
      expect(brain.open(1)).not.toBeNull();
    });

    it('accepts a vault with no .git at all', () => {
      brain.setVaultPath(1, join(dir, 'fresh-vault'));
      expect(brain.open(1)).not.toBeNull();
    });
  });
});
