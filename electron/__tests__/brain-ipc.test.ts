import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDatabase, type Database } from '../services/database';
import { createBrainService, type BrainService } from '../services/brain/registry';
import { createBrainHandlers } from '../ipc/brain-handlers';
import { getHandlerMap } from '../ipc/handlers';
import type { ParsedNote } from '../services/brain/types';

const NOTE: ParsedNote = {
  frontmatter: {
    type: 'Subsystem', aliases: ['decider'], keywords: [],
    created: '2026-01-01', updated: '2026-01-01', sources: [],
  },
  body: '# A\n\n## Summary\nthe stdio bridge\n',
};

const CHANNELS = [
  'brain_clear_vault_path',
  'brain_list_notes',
  'brain_read_note',
  'brain_search',
  'brain_set_vault_path',
  'brain_vault_path',
];

describe('brain IPC handlers', () => {
  let dir: string;
  let db: Database;
  let brain: BrainService;
  let handlers: Record<string, (event: unknown, params?: Record<string, unknown>) => Promise<unknown>>;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'omnifex-brain-ipc-'));
    db = createDatabase(':memory:');
    brain = createBrainService(db);
    handlers = createBrainHandlers(brain);
  });

  afterEach(() => {
    brain.closeAll();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('exposes exactly the expected channels', () => {
    expect(Object.keys(handlers).sort()).toEqual(CHANNELS);
  });

  it('is wired into the main handler map', () => {
    const map = getHandlerMap({ brain });
    for (const channel of CHANNELS) expect(map[channel]).toBeTypeOf('function');
  });

  it('round-trips the vault path', async () => {
    await handlers.brain_set_vault_path(null, { accountId: 1, path: join(dir, 'personal') });
    expect(await handlers.brain_vault_path(null, { accountId: 1 })).toBe(join(dir, 'personal'));
  });

  it('accepts snake_case params as well as camelCase', async () => {
    await handlers.brain_set_vault_path(null, { account_id: 1, path: join(dir, 'personal') });
    expect(await handlers.brain_vault_path(null, { account_id: 1 })).toBe(join(dir, 'personal'));
  });

  it('searches within one account only', async () => {
    await handlers.brain_set_vault_path(null, { accountId: 1, path: join(dir, 'personal') });
    await handlers.brain_set_vault_path(null, { accountId: 2, path: join(dir, 'work') });
    brain.writeNote(1, 'Subsystems/A.md', NOTE, 'Manual edit');

    expect(await handlers.brain_search(null, { accountId: 1, query: 'stdio' })).toHaveLength(1);
    expect(await handlers.brain_search(null, { accountId: 2, query: 'stdio' })).toEqual([]);
  });

  it('lists and reads notes for an account', async () => {
    await handlers.brain_set_vault_path(null, { accountId: 1, path: join(dir, 'personal') });
    brain.writeNote(1, 'Subsystems/A.md', NOTE, 'Manual edit');

    expect(await handlers.brain_list_notes(null, { accountId: 1 })).toEqual(['Subsystems/A.md']);
    const read = (await handlers.brain_read_note(null, {
      accountId: 1, notePath: 'Subsystems/A.md',
    })) as ParsedNote;
    expect(read.frontmatter.aliases).toEqual(['decider']);
  });

  it('returns [] rather than throwing for an unconfigured account', async () => {
    expect(await handlers.brain_search(null, { accountId: 99, query: 'x' })).toEqual([]);
    expect(await handlers.brain_list_notes(null, { accountId: 99 })).toEqual([]);
  });

  it('rejects a missing accountId instead of defaulting', async () => {
    await expect(handlers.brain_search(null, { query: 'x' })).rejects.toThrow(/accountId/);
  });

  it('brain_clear_vault_path actually clears a configured path', async () => {
    await handlers.brain_set_vault_path(null, { accountId: 1, path: join(dir, 'personal') });
    expect(await handlers.brain_vault_path(null, { accountId: 1 })).not.toBeNull();

    await handlers.brain_clear_vault_path(null, { accountId: 1 });
    expect(await handlers.brain_vault_path(null, { accountId: 1 })).toBeNull();
  });

  it('brain_read_note wraps a corrupt note as a readable error, not a raw parse stack', async () => {
    await handlers.brain_set_vault_path(null, { accountId: 1, path: join(dir, 'personal') });
    // Scaffold the vault (creates Topics/ etc.), then drop a frontmatter-less
    // file straight on disk — the same setup brain-vault.test.ts uses to
    // trigger NoteParseError from `readNote`.
    await handlers.brain_list_notes(null, { accountId: 1 });
    writeFileSync(join(dir, 'personal', 'Topics', 'Bad.md'), 'no frontmatter here\n');

    await expect(
      handlers.brain_read_note(null, { accountId: 1, notePath: 'Topics/Bad.md' }),
    ).rejects.toThrow(/cannot read note/);
  });

  it('returns inert results when no brain service is wired at all', async () => {
    const none = createBrainHandlers(undefined);
    expect(await none.brain_search(null, { accountId: 1, query: 'x' })).toEqual([]);
    expect(await none.brain_vault_path(null, { accountId: 1 })).toBeNull();
  });

  it('write handlers throw rather than silently no-op when no brain service is wired', async () => {
    // Unlike the read handlers above, a write must not report success (via a
    // `null` return) when nothing was actually written.
    const none = createBrainHandlers(undefined);
    await expect(
      none.brain_set_vault_path(null, { accountId: 1, path: join(dir, 'personal') }),
    ).rejects.toThrow(/brain service unavailable/);
    await expect(
      none.brain_clear_vault_path(null, { accountId: 1 }),
    ).rejects.toThrow(/brain service unavailable/);
  });

  // --- error-shape behaviour beyond the brief -------------------------------
  //
  // The registry (Task 7) went through six security-fix rounds and now throws
  // from more places than a naive handler anticipates. The rule the tests
  // below enforce: `brain_list_notes` is a read path and must degrade to []
  // on a detected vault conflict (mirroring registry.ts's own `search()`),
  // while `brain_read_note` and `brain_set_vault_path` are explicit user
  // actions and must keep failing loudly.

  /** Configure two accounts, then swap account 2's directory for a symlink
   *  into account 1's vault — the same on-disk-conflict setup used by
   *  brain-registry.test.ts's "detects an overlap introduced on disk" case. */
  async function induceConflictForAccount2(): Promise<void> {
    await handlers.brain_set_vault_path(null, { accountId: 1, path: join(dir, 'personal') });
    await handlers.brain_set_vault_path(null, { accountId: 2, path: join(dir, 'work') });
    brain.closeAll();
    rmSync(join(dir, 'work'), { recursive: true, force: true });
    symlinkSync(join(dir, 'personal'), join(dir, 'work'));
  }

  it('brain_list_notes degrades to [] when open() detects a vault conflict', async () => {
    await induceConflictForAccount2();
    expect(await handlers.brain_list_notes(null, { accountId: 2 })).toEqual([]);
  });

  it('brain_read_note still throws when open() detects a vault conflict', async () => {
    await induceConflictForAccount2();
    await expect(
      handlers.brain_read_note(null, { accountId: 2, notePath: 'Subsystems/A.md' }),
    ).rejects.toThrow();
  });

  it('brain_set_vault_path surfaces a VaultConflictError message generically', async () => {
    await handlers.brain_set_vault_path(null, { accountId: 1, path: join(dir, 'personal') });
    await expect(
      handlers.brain_set_vault_path(null, { accountId: 2, path: join(dir, 'personal') }),
    ).rejects.toThrow(/overlaps/);
  });

  it('brain_set_vault_path surfaces a plain-Error message too, not just VaultConflictError', async () => {
    // accountId 0 passes the handler's own finite-number check but fails the
    // registry's stricter positive-integer check, so this exercises the
    // registry's plain `Error` branch rather than `VaultConflictError`.
    await expect(
      handlers.brain_set_vault_path(null, { accountId: 0, path: join(dir, 'x') }),
    ).rejects.toThrow(/invalid accountId/);
  });

  it('does not expand a leading tilde — surfaces the registry rejection instead', async () => {
    await expect(
      handlers.brain_set_vault_path(null, { accountId: 1, path: '~/vault' }),
    ).rejects.toThrow(/expanded/);
  });

  it('rejects cleanly when the underlying service throws an unexpected error', async () => {
    const boom = new Error('disk on fire');
    const stub: BrainService = {
      vaultPath: () => { throw boom; },
      setVaultPath: () => { throw boom; },
      clearVaultPath: () => { throw boom; },
      open: () => { throw boom; },
      status: () => { throw boom; },
      search: () => { throw boom; },
      writeNote: () => { throw boom; },
      rebuild: () => { throw boom; },
      deleteNote: () => { throw boom; },
      updateNoteBody: () => { throw boom; },
      backlinks: () => { throw boom; },
      closeAll: () => {},
    };
    const stubHandlers = createBrainHandlers(stub);

    await expect(stubHandlers.brain_vault_path(null, { accountId: 1 })).rejects.toThrow('disk on fire');
    await expect(
      stubHandlers.brain_set_vault_path(null, { accountId: 1, path: join(dir, 'x') }),
    ).rejects.toThrow('disk on fire');
    await expect(stubHandlers.brain_list_notes(null, { accountId: 1 })).rejects.toThrow('disk on fire');
  });
});
