import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  VaultConflictError,
  type BrainService,
  type VaultHandle,
  type VaultStatus,
} from '../services/brain/registry';
import { NoteParseError } from '../services/brain/frontmatter';
import type { VaultStats } from '../services/brain/stats';

type Params = Record<string, unknown>;

/** Matches the existing HandlerFn shape in handlers.ts:270. */
type HandlerFn = (event: unknown, params?: Params) => Promise<unknown>;

/**
 * accountId is always required. Defaulting it would risk reading or writing the
 * wrong account's vault, which is a confidentiality failure rather than a UX
 * annoyance — so this throws instead of falling back.
 *
 * Both camelCase and snake_case are accepted, matching the repo convention.
 */
function requireAccountId(params: Params): number {
  const raw = params.accountId ?? params.account_id;
  const id = typeof raw === 'string' ? Number(raw) : raw;
  if (typeof id !== 'number' || !Number.isFinite(id)) {
    throw new Error('accountId is required');
  }
  return id;
}

function requireString(params: Params, camel: string, snake: string): string {
  const value = params[camel] ?? params[snake];
  if (typeof value !== 'string' || !value) throw new Error(`${camel} is required`);
  return value;
}

/**
 * A note body may legitimately be the empty string — clearing a note is an
 * edit, not a missing parameter — so this does not reuse `requireString`,
 * which rejects `''` on purpose for names and paths.
 */
function requireBody(params: Params): string {
  const value = params.body;
  if (typeof value !== 'string') throw new Error('body is required');
  return value;
}

/**
 * What `status()` would return for an account with no vault. Used when the
 * service failed to construct: the Brain tab must still render something
 * truthful rather than an error, since the Brain is auxiliary.
 */
function unconfiguredStatus(accountId: number): VaultStatus {
  return {
    accountId,
    configured: false,
    path: null,
    exists: false,
    initialized: false,
    noteCount: 0,
    indexedCount: null,
    gitAvailable: false,
    lastGitError: null,
    conflict: null,
  };
}

/**
 * What `stats()` would report for an account with no vault.
 *
 * Hand-mirrors `computeVaultStats([], …)` rather than importing the service:
 * this layer must render something truthful even when the service failed to
 * construct, which is exactly when it cannot be called. `brain-ipc.test.ts` is
 * what keeps the two shapes honest.
 */
function emptyStats(): VaultStats {
  return {
    noteCount: 0,
    totalBytes: 0,
    byType: {},
    medianBytes: 0,
    largestBytes: 0,
    largestNote: null,
    estimatedTokens: { median: 0, largest: 0, vault: 0 },
    timelineBuckets: [
      { label: 'none', count: 0 },
      { label: '1–3', count: 0 },
      { label: '4–7', count: 0 },
      { label: '8–15', count: 0 },
      { label: '16+', count: 0 },
    ],
    qualifyingCount: 0,
    spentUsd: 0,
    recentlyCurated: [],
  };
}

/**
 * `brain` is optional so the app still boots if the service failed to
 * construct — the Brain is auxiliary and must never break IPC registration.
 *
 * Every handler here is `async`, so a synchronous throw anywhere in its body
 * (accountId validation, or a throw from the registry itself) becomes a
 * rejected Promise rather than an exception escaping the handler map — the
 * binding constraint is that no Brain failure may break a session, block the
 * UI, or crash the main process.
 *
 * The registry (Task 7) throws from several places, and not uniformly:
 *  - `setVaultPath` / `open` / `writeNote` fail closed (throw) by design —
 *    they are explicit user actions, or would otherwise hand out access to
 *    the wrong account's vault, so a silent empty result would be worse than
 *    an error message.
 *  - `search` already self-degrades to `[]` inside the registry when `open`
 *    reports a `VaultConflictError`, because a conflict on ANOTHER account's
 *    vault must not start throwing at an account whose configuration never
 *    changed.
 *  - `brain_list_notes` is a read path with the same shape as `search`, so it
 *    applies the identical degrade-to-`[]` rule here at the IPC boundary
 *    (the registry doesn't do it for `open()` itself, since `open()` is also
 *    what `writeNote`/`brain_read_note` rely on to fail closed).
 *
 * `brain` being `undefined` (service failed to construct) is handled per
 * handler, not uniformly: read handlers keep `brain?.` and degrade to `[]` /
 * `null`, matching the "Brain is auxiliary" rule above. `brain_set_vault_path`
 * and `brain_clear_vault_path` are writes — reporting success via `null` while
 * `brain` is undefined would be a write that silently never happened — so they
 * throw instead.
 */
/**
 * What the three `brain_mcp_*` handlers need: the registration itself, and the
 * one account lookup that turns an accountId into the config dir it writes to.
 *
 * Deliberately not the accounts service. These handlers need a config dir and
 * nothing else, and a wider dependency is one a future edit can reach into.
 */
export interface BrainMcpHandlerDeps {
  isRegistered(configDir: string): boolean;
  register(configDir: string, vaultRoot: string): void;
  unregister(configDir: string): void;
  /** The account's config dir, or null when there is no such account. */
  configDirFor(accountId: number): string | null;
}

export function createBrainHandlers(
  brain?: BrainService,
  brainMcp?: BrainMcpHandlerDeps,
): Record<string, HandlerFn> {
  return {
    async brain_vault_path(_event, params = {}) {
      return brain?.vaultPath(requireAccountId(params)) ?? null;
    },

    async brain_set_vault_path(_event, params = {}) {
      // Unlike the read handlers, this is a write: `brain?.` here would report
      // success while doing nothing when the service failed to construct. A
      // write path must not claim to have performed a write it did not do.
      if (!brain) throw new Error('brain service unavailable');
      // Tilde expansion is the UI layer's job; the registry rejects a path
      // whose first segment is `~` and that rejection message is surfaced
      // as-is below, not special-cased.
      brain.setVaultPath(requireAccountId(params), requireString(params, 'path', 'path'));
      return null;
    },

    async brain_clear_vault_path(_event, params = {}) {
      // Same reasoning as brain_set_vault_path above: a silent no-op here
      // would look like a successful clear when nothing was cleared.
      if (!brain) throw new Error('brain service unavailable');
      brain.clearVaultPath(requireAccountId(params));
      return null;
    },

    async brain_status(_event, params = {}) {
      const accountId = requireAccountId(params);
      if (!brain) return unconfiguredStatus(accountId);
      return brain.status(accountId);
    },

    async brain_default_vault_path(_event, params = {}) {
      const name = requireString(params, 'accountName', 'account_name');
      // The name becomes a directory name, so it must not be able to steer the
      // suggestion out of the Brain folder. This is only a SUGGESTION — the
      // registry validates whatever is actually submitted — but a suggestion
      // pre-filled into a text box is one click away from being submitted.
      if (name.includes('/') || name.includes('\\') || name.includes('\0')) {
        throw new Error(`account name is not usable as a folder name: ${name}`);
      }
      return join(homedir(), 'Documents', 'OmniFex Brain', name);
    },

    async brain_rebuild(_event, params = {}) {
      if (!brain) throw new Error('brain service unavailable');
      return brain.rebuild(requireAccountId(params));
    },

    async brain_update_note(_event, params = {}) {
      if (!brain) throw new Error('brain service unavailable');
      return brain.updateNoteBody(
        requireAccountId(params),
        requireString(params, 'notePath', 'note_path'),
        requireBody(params),
      );
    },

    async brain_delete_note(_event, params = {}) {
      if (!brain) throw new Error('brain service unavailable');
      brain.deleteNote(requireAccountId(params), requireString(params, 'notePath', 'note_path'));
      return null;
    },

    async brain_backlinks(_event, params = {}) {
      const accountId = requireAccountId(params);
      if (!brain) return [];
      return brain.backlinks(accountId, requireString(params, 'notePath', 'note_path'));
    },

    async brain_set_excluded_projects(_event, params = {}) {
      // A write. Reporting success while the service is missing would claim an
      // exclusion that does not exist — and the user would then trust that a
      // temp project is being kept out of the vault when it is not.
      if (!brain) throw new Error('brain service unavailable');
      const raw = params.decisions;
      if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
        throw new Error('decisions is required');
      }
      const decisions: Record<string, boolean> = {};
      for (const [key, value] of Object.entries(raw)) {
        if (typeof value === 'boolean') decisions[key] = value;
      }
      brain.setExcludedProjects(requireAccountId(params), decisions);
      return null;
    },

    async brain_list_sources(_event, params = {}) {
      const accountId = requireAccountId(params);
      // A read path, so it degrades to [] when the service failed to
      // construct — matching brain_list_notes and the "Brain is auxiliary"
      // rule in this file's module doc.
      if (!brain) return [];
      const includeExcluded = params.includeExcluded === true || params.include_excluded === true;
      return brain.listSources(accountId, { includeExcluded });
    },

    async brain_source_preview(_event, params = {}) {
      const accountId = requireAccountId(params);
      if (!brain) return null;
      return brain.previewSource(accountId, requireString(params, 'itemKey', 'item_key'));
    },

    async brain_index_source(_event, params = {}) {
      // Neither a read nor an ordinary write: this one spends tokens. A `null`
      // result while the service is missing would report an indexing run that
      // never happened, so it throws like the other write handlers.
      if (!brain) throw new Error('brain service unavailable');
      return brain.indexSource(
        requireAccountId(params),
        requireString(params, 'itemKey', 'item_key'),
      );
    },

    async brain_curate_note(_event, params = {}) {
      // Spends tokens, like brain_index_source: a null result while the
      // service is missing would report a curation that never happened.
      if (!brain) throw new Error('brain service unavailable');
      return brain.curateNote(
        requireAccountId(params),
        requireString(params, 'notePath', 'note_path'),
      );
    },

    async brain_enqueue_curation(_event, params = {}) {
      // A write that queues token-spending work, like brain_backfill.
      if (!brain) throw new Error('brain service unavailable');
      return brain.enqueueCuration(requireAccountId(params));
    },

    async brain_stats(_event, params = {}) {
      const accountId = requireAccountId(params);
      // A read: degrades so the stats panel renders truthful zeroes rather
      // than an error when the service failed to construct.
      if (!brain) return emptyStats();
      return brain.stats(accountId);
    },

    async brain_queue_counts(_event, params = {}) {
      const accountId = requireAccountId(params);
      // A read: degrades so the Brain tab renders truthful zeroes rather than
      // an error when the service failed to construct.
      if (!brain) return { pending: 0, running: 0, done: 0, failed: 0 };
      return brain.queueCounts(accountId);
    },

    async brain_queue_list(_event, params = {}) {
      const accountId = requireAccountId(params);
      if (!brain) return [];
      const limit = typeof params.limit === 'number' ? params.limit : undefined;
      return brain.queueList(accountId, limit);
    },

    async brain_backfill(_event, params = {}) {
      // A write that queues token-spending work. Reporting a count while the
      // service is missing would claim a backfill that never happened.
      if (!brain) throw new Error('brain service unavailable');
      return brain.backfill(requireAccountId(params));
    },

    async brain_enqueue_project_sources(_event, params = {}) {
      // A write that queues token-spending work, like brain_backfill: a count
      // returned while the service is missing would claim an enqueue that
      // never happened.
      if (!brain) throw new Error('brain service unavailable');
      return brain.enqueueProjectSources(
        requireAccountId(params),
        requireString(params, 'projectPath', 'project_path'),
      );
    },

    async brain_queue_clear(_event, params = {}) {
      if (!brain) throw new Error('brain service unavailable');
      brain.clearFinishedQueue(requireAccountId(params));
      return null;
    },

    async brain_search(_event, params = {}) {
      const accountId = requireAccountId(params);
      if (!brain) return [];
      const query = typeof params.query === 'string' ? params.query : '';
      const type = typeof params.type === 'string' ? params.type : undefined;
      const limit = typeof params.limit === 'number' ? params.limit : undefined;
      return brain.search(accountId, query, { type, limit });
    },

    async brain_list_notes(_event, params = {}) {
      const accountId = requireAccountId(params);
      if (!brain) return [];
      let handle: VaultHandle | null;
      try {
        handle = brain.open(accountId);
      } catch (err) {
        // A read path: a conflict detected against another account's vault
        // must not break listing for THIS account. See the module doc above
        // and registry.ts's own `search()`, which applies the same rule for
        // the same reason. Anything that hands out write access (open/
        // writeNote) or is an explicit read action (brain_read_note) still
        // fails closed.
        if (err instanceof VaultConflictError) return [];
        throw err;
      }
      return handle ? handle.vault.listNotes() : [];
    },

    /**
     * Whether this account's Brain is exposed to sessions started OUTSIDE
     * OmniFex, and whether it could be. A read, so it degrades to a truthful
     * "no, and not available" rather than throwing — a Brain tab must render.
     */
    async brain_mcp_status(_event, params = {}) {
      const accountId = requireAccountId(params);
      const configDir = brainMcp?.configDirFor(accountId);
      if (!brainMcp || !configDir) return { registered: false, available: false };
      return {
        registered: brainMcp.isRegistered(configDir),
        available: Boolean(brain?.vaultPath(accountId)),
      };
    },

    async brain_mcp_register(_event, params = {}) {
      // A write into a real Claude config dir. Reporting success while the
      // service is missing would claim residue that was never created — and
      // the toggle would then show a state that does not exist.
      if (!brainMcp || !brain) throw new Error('brain service unavailable');
      const accountId = requireAccountId(params);
      const configDir = brainMcp.configDirFor(accountId);
      if (!configDir) throw new Error('no such account');
      const vaultRoot = brain.vaultPath(accountId);
      // Registering a vault-less account would point the CLI at a server that
      // has nothing to serve, and the tools would fail on every call.
      if (!vaultRoot) throw new Error('no vault configured for this account');
      brainMcp.register(configDir, vaultRoot);
      return null;
    },

    async brain_mcp_unregister(_event, params = {}) {
      if (!brainMcp) throw new Error('brain service unavailable');
      const configDir = brainMcp.configDirFor(requireAccountId(params));
      if (!configDir) throw new Error('no such account');
      brainMcp.unregister(configDir);
      return null;
    },

    async brain_read_note(_event, params = {}) {
      const handle = brain?.open(requireAccountId(params));
      if (!handle) throw new Error('no vault configured for this account');
      const notePath = requireString(params, 'notePath', 'note_path');
      try {
        return handle.vault.readNote(notePath);
      } catch (err) {
        // Surface a corrupt note as a readable message rather than a stack.
        if (err instanceof NoteParseError) throw new Error(`cannot read note: ${err.message}`);
        throw err;
      }
    },
  };
}
