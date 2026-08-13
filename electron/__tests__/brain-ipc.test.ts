import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
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
  'brain_backfill',
  'brain_backlinks',
  'brain_clear_vault_path',
  'brain_default_vault_path',
  'brain_delete_note',
  'brain_enqueue_project_sources',
  'brain_index_source',
  'brain_list_notes',
  'brain_list_sources',
  'brain_mcp_register',
  'brain_mcp_status',
  'brain_mcp_unregister',
  'brain_queue_clear',
  'brain_queue_counts',
  'brain_queue_drain',
  'brain_queue_list',
  'brain_read_note',
  'brain_rebuild',
  'brain_search',
  'brain_set_vault_path',
  'brain_source_preview',
  'brain_status',
  'brain_update_note',
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
    // A stub git runner: no child process, so nothing is still writing into
    // `.git` when afterEach removes the directory. This replaced a
    // retry-and-swallow rmSync that raced an untracked `git init`.
    brain = createBrainService(db, { execGit: async () => '' });
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

  it('rejects a source listing with no accountId', async () => {
    // Same rule as every other brain handler: defaulting the account would
    // read the wrong vault's material, which is a confidentiality failure
    // rather than a UX annoyance.
    await expect(handlers.brain_list_sources(null, {})).rejects.toThrow(/accountId/);
  });

  it('accepts snake_case params and returns null for an unknown item', async () => {
    // No sources are wired into this file's service, so discovery finds
    // nothing and the preview is null — which is the point: the handler must
    // pass both params through and not throw.
    await expect(
      handlers.brain_source_preview(null, { account_id: 1, item_key: 'nope' }),
    ).resolves.toBeNull();
  });

  it('degrades to an empty listing when the service is unavailable', async () => {
    const bare = createBrainHandlers(undefined);
    await expect(bare.brain_list_sources(null, { accountId: 1 })).resolves.toEqual([]);
    await expect(bare.brain_source_preview(null, { accountId: 1, itemKey: 'x' })).resolves.toBeNull();
  });

  it('brain_index_source requires an accountId and an itemKey', async () => {
    await expect(handlers.brain_index_source(null, {})).rejects.toThrow(/accountId/);
    await expect(handlers.brain_index_source(null, { accountId: 1 })).rejects.toThrow(/itemKey/);
  });

  it('queue reads degrade and queue writes throw when the service is unavailable', async () => {
    const bare = createBrainHandlers(undefined);
    // Reads stay inert so the Brain tab can still render something truthful.
    await expect(bare.brain_queue_counts(null, { accountId: 1 }))
      .resolves.toMatchObject({ pending: 0, failed: 0 });
    await expect(bare.brain_queue_list(null, { accountId: 1 })).resolves.toEqual([]);
    // Writes must not report work that never happened.
    await expect(bare.brain_backfill(null, { accountId: 1 })).rejects.toThrow(/unavailable/);
    await expect(bare.brain_queue_drain(null, {})).rejects.toThrow(/unavailable/);
    await expect(bare.brain_queue_clear(null, { accountId: 1 })).rejects.toThrow(/unavailable/);
  });

  it('brain_backfill requires an accountId', async () => {
    await expect(handlers.brain_backfill(null, {})).rejects.toThrow(/accountId/);
  });

  it('brain_index_source throws rather than degrading when the service is unavailable', async () => {
    // Unlike the read handlers, this is a WRITE that also spends tokens.
    // Returning a null result would report an indexing run that never happened.
    const bare = createBrainHandlers(undefined);
    await expect(
      bare.brain_index_source(null, { account_id: 1, item_key: 'sess-a' }),
    ).rejects.toThrow(/brain service unavailable/);
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
      listSources: () => { throw boom; },
      previewSource: () => { throw boom; },
      indexSource: () => { throw boom; },
      curateNote: () => { throw boom; },
      enqueueCuration: () => { throw boom; },
      enqueueSource: () => { throw boom; },
      enqueueProjectSources: () => { throw boom; },
      backfill: () => { throw boom; },
      stats: () => { throw boom; },
      queueCounts: () => { throw boom; },
      queueList: () => { throw boom; },
      clearFinishedQueue: () => { throw boom; },
      drainQueue: () => { throw boom; },
      queueCurrent: () => { throw boom; },
      closeAll: () => {},
    };
    const stubHandlers = createBrainHandlers(stub);

    await expect(stubHandlers.brain_vault_path(null, { accountId: 1 })).rejects.toThrow('disk on fire');
    await expect(
      stubHandlers.brain_set_vault_path(null, { accountId: 1, path: join(dir, 'x') }),
    ).rejects.toThrow('disk on fire');
    await expect(stubHandlers.brain_list_notes(null, { accountId: 1 })).rejects.toThrow('disk on fire');
  });

  describe('brain_status', () => {
    it('returns a status object for a configured account', async () => {
      await handlers.brain_set_vault_path(null, { accountId: 1, path: join(dir, 'v') });
      const status = (await handlers.brain_status(null, { accountId: 1 })) as { configured: boolean };
      expect(status.configured).toBe(true);
    });

    it('accepts snake_case', async () => {
      const status = (await handlers.brain_status(null, { account_id: 1 })) as { accountId: number };
      expect(status.accountId).toBe(1);
    });

    it('degrades to an unconfigured status when the service is unavailable', async () => {
      const none = createBrainHandlers(undefined);
      const status = (await none.brain_status(null, { accountId: 1 })) as { configured: boolean };
      expect(status.configured).toBe(false);
    });
  });

  describe('brain_default_vault_path', () => {
    it('suggests a path under the user home, named for the account', async () => {
      expect(await handlers.brain_default_vault_path(null, { accountName: 'personal' })).toBe(
        join(homedir(), 'Documents', 'OmniFex Brain', 'personal'),
      );
    });

    it('rejects an account name containing a path separator', async () => {
      await expect(
        handlers.brain_default_vault_path(null, { accountName: '../escape' }),
      ).rejects.toThrow(/folder name/);
    });
  });

  describe('brain_rebuild', () => {
    it('reindexes and returns the count', async () => {
      await handlers.brain_set_vault_path(null, { accountId: 1, path: join(dir, 'rb') });
      brain.writeNote(1, 'Subsystems/A.md', NOTE, 'test');

      expect(await handlers.brain_rebuild(null, { accountId: 1 })).toBe(1);
    });

    it('throws when the service is unavailable rather than reporting success', async () => {
      const none = createBrainHandlers(undefined);
      await expect(none.brain_rebuild(null, { accountId: 1 })).rejects.toThrow(
        /brain service unavailable/,
      );
    });
  });

  describe('brain_update_note', () => {
    it('writes the body and returns the updated note', async () => {
      await handlers.brain_set_vault_path(null, { accountId: 1, path: join(dir, 'up') });
      brain.writeNote(1, 'Subsystems/A.md', NOTE, 'test');

      const updated = (await handlers.brain_update_note(null, {
        accountId: 1, notePath: 'Subsystems/A.md', body: 'omega\n',
      })) as ParsedNote;
      expect(updated.body).toBe('omega\n');
    });

    it('accepts an empty body', async () => {
      await handlers.brain_set_vault_path(null, { accountId: 1, path: join(dir, 'up2') });
      brain.writeNote(1, 'Subsystems/A.md', NOTE, 'test');

      const updated = (await handlers.brain_update_note(null, {
        account_id: 1, note_path: 'Subsystems/A.md', body: '',
      })) as ParsedNote;
      expect(updated.body).toBe('');
    });

    it('throws when the service is unavailable', async () => {
      const none = createBrainHandlers(undefined);
      await expect(
        none.brain_update_note(null, { accountId: 1, notePath: 'Subsystems/A.md', body: 'x' }),
      ).rejects.toThrow(/brain service unavailable/);
    });
  });

  describe('brain_delete_note', () => {
    it('deletes the note', async () => {
      await handlers.brain_set_vault_path(null, { accountId: 1, path: join(dir, 'del') });
      brain.writeNote(1, 'Subsystems/A.md', NOTE, 'test');

      await handlers.brain_delete_note(null, { accountId: 1, notePath: 'Subsystems/A.md' });
      expect(await handlers.brain_list_notes(null, { accountId: 1 })).toEqual([]);
    });

    it('throws when the service is unavailable', async () => {
      const none = createBrainHandlers(undefined);
      await expect(
        none.brain_delete_note(null, { accountId: 1, notePath: 'Subsystems/A.md' }),
      ).rejects.toThrow(/brain service unavailable/);
    });
  });

  describe('brain_backlinks', () => {
    it('returns linking notes', async () => {
      await handlers.brain_set_vault_path(null, { accountId: 1, path: join(dir, 'bl') });
      brain.writeNote(1, 'Subsystems/A.md', NOTE, 'test');
      brain.writeNote(1, 'Topics/B.md', { ...NOTE, body: 'see [[A]]' }, 'test');

      expect(await handlers.brain_backlinks(null, {
        accountId: 1, notePath: 'Subsystems/A.md',
      })).toEqual(['Topics/B.md']);
    });

    it('degrades to empty when the service is unavailable', async () => {
      const none = createBrainHandlers(undefined);
      expect(await none.brain_backlinks(null, {
        accountId: 1, notePath: 'Subsystems/A.md',
      })).toEqual([]);
    });
  });

  describe('brain_mcp_*', () => {
    /** A registration double: records calls, answers from its own state. */
    function fakeMcp(overrides: Partial<Record<string, unknown>> = {}) {
      const registered = new Set<string>();
      const calls: { register: string[]; unregister: string[] } = { register: [], unregister: [] };
      return {
        deps: {
          isRegistered: (cfg: string) => registered.has(cfg),
          register: (cfg: string, vault: string) => {
            calls.register.push(`${cfg}|${vault}`);
            registered.add(cfg);
          },
          unregister: (cfg: string) => {
            calls.unregister.push(cfg);
            registered.delete(cfg);
          },
          configDirFor: (id: number) => (id === 1 ? '/cfg/personal' : null),
          ...overrides,
        },
        calls,
      };
    }

    it('reports not-registered and not-available with no registration service', async () => {
      const bare = createBrainHandlers(undefined);
      expect(await bare.brain_mcp_status(null, { accountId: 1 })).toEqual({
        registered: false,
        available: false,
      });
    });

    it('reports available only once a vault is configured', async () => {
      const mcp = fakeMcp();
      const h = createBrainHandlers(brain, mcp.deps);
      expect(await h.brain_mcp_status(null, { accountId: 1 })).toEqual({
        registered: false,
        available: false,
      });

      await handlers.brain_set_vault_path(null, { accountId: 1, path: join(dir, 'mcpvault') });
      expect(await h.brain_mcp_status(null, { accountId: 1 })).toEqual({
        registered: false,
        available: true,
      });
    });

    it('registers with the account\'s own config dir and vault', async () => {
      await handlers.brain_set_vault_path(null, { accountId: 1, path: join(dir, 'mcpvault2') });
      const mcp = fakeMcp();
      const h = createBrainHandlers(brain, mcp.deps);

      await h.brain_mcp_register(null, { accountId: 1 });

      expect(mcp.calls.register).toEqual([`/cfg/personal|${join(dir, 'mcpvault2')}`]);
      expect(await h.brain_mcp_status(null, { accountId: 1 })).toMatchObject({ registered: true });
    });

    it('refuses to register an account with no vault', async () => {
      const h = createBrainHandlers(brain, fakeMcp().deps);
      await expect(h.brain_mcp_register(null, { accountId: 1 })).rejects.toThrow(
        /no vault configured/,
      );
    });

    it('refuses to register an unknown account', async () => {
      const h = createBrainHandlers(brain, fakeMcp().deps);
      await expect(h.brain_mcp_register(null, { accountId: 99 })).rejects.toThrow(/no such account/);
    });

    it('throws rather than silently doing nothing when unwired', async () => {
      // A write that reports success while writing nothing would leave the
      // toggle showing a state that does not exist.
      const bare = createBrainHandlers(brain);
      await expect(bare.brain_mcp_register(null, { accountId: 1 })).rejects.toThrow(/unavailable/);
      await expect(bare.brain_mcp_unregister(null, { accountId: 1 })).rejects.toThrow(/unavailable/);
    });

    it('unregisters the account it was asked about', async () => {
      await handlers.brain_set_vault_path(null, { accountId: 1, path: join(dir, 'mcpvault3') });
      const mcp = fakeMcp();
      const h = createBrainHandlers(brain, mcp.deps);
      await h.brain_mcp_register(null, { accountId: 1 });

      await h.brain_mcp_unregister(null, { accountId: 1 });

      expect(mcp.calls.unregister).toEqual(['/cfg/personal']);
    });

    it('requires an accountId', async () => {
      const h = createBrainHandlers(brain, fakeMcp().deps);
      await expect(h.brain_mcp_status(null, {})).rejects.toThrow(/accountId is required/);
    });
  });
});
