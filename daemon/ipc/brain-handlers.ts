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

type HandlerFn = (event: unknown, params?: Params) => Promise<unknown>;

// Never default accountId: the wrong account's vault is a confidentiality failure.
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

/** `''` is a valid body (clearing a note), unlike names and paths. */
function requireBody(params: Params): string {
  const value = params.body;
  if (typeof value !== 'string') throw new Error('body is required');
  return value;
}

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
    offloadedCount: null,
  };
}

/** Hand-mirrors computeVaultStats([]): it must work when the service failed to construct. */
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
  };
}

export interface BrainMcpHandlerDeps {
  isRegistered(configDir: string): boolean;
  register(configDir: string, vaultRoot: string): void;
  unregister(configDir: string): void;
  configDirFor(accountId: number): string | null;
}

/** `brain` may be undefined (the Brain is auxiliary): reads degrade to empty, writes and token-spending calls throw rather than report work that never happened. */
export function createBrainHandlers(
  brain?: BrainService,
  brainMcp?: BrainMcpHandlerDeps,
): Record<string, HandlerFn> {
  return {
    async brain_vault_path(_event, params = {}) {
      return brain?.vaultPath(requireAccountId(params)) ?? null;
    },

    async brain_set_vault_path(_event, params = {}) {
      if (!brain) throw new Error('brain service unavailable');
      const accountId = requireAccountId(params);
      brain.setVaultPath(accountId, requireString(params, 'path', 'path'));
      // An opted-in persistent registration bakes OMNIFEX_VAULT into .claude.json, so rewrite it.
      const configDir = brainMcp?.configDirFor(accountId);
      const vaultRoot = brain.vaultPath(accountId);
      if (brainMcp && configDir && vaultRoot && brainMcp.isRegistered(configDir)) {
        brainMcp.register(configDir, vaultRoot);
      }
      return null;
    },

    async brain_clear_vault_path(_event, params = {}) {
      if (!brain) throw new Error('brain service unavailable');
      const accountId = requireAccountId(params);
      brain.clearVaultPath(accountId);
      // A registration with no vault behind it would fail every tool call.
      const configDir = brainMcp?.configDirFor(accountId);
      if (brainMcp && configDir && brainMcp.isRegistered(configDir)) {
        brainMcp.unregister(configDir);
      }
      return null;
    },

    async brain_status(_event, params = {}) {
      const accountId = requireAccountId(params);
      if (!brain) return unconfiguredStatus(accountId);
      return brain.status(accountId);
    },

    async brain_default_vault_path(_event, params = {}) {
      const name = requireString(params, 'accountName', 'account_name');
      // The name becomes a directory: it must not steer the suggestion out of the Brain folder.
      if (name.includes('/') || name.includes('\\') || name.includes('\0')) {
        throw new Error(`account name is not usable as a folder name: ${name}`);
      }
      // Home root, never ~/Documents or ~/Desktop: file providers evict contents to stubs and git hangs for minutes.
      return join(homedir(), 'OmniFex Brain', name);
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
      if (!brain) return [];
      const includeExcluded = params.includeExcluded === true || params.include_excluded === true;
      return brain.listSources(accountId, { includeExcluded });
    },

    async brain_source_preview(_event, params = {}) {
      const accountId = requireAccountId(params);
      if (!brain) return null;
      return brain.previewSource(accountId, requireString(params, 'itemKey', 'item_key'));
    },

    async brain_index_selection(_event, params = {}) {
      if (!brain) throw new Error('brain service unavailable');
      const raw = params.itemKeys ?? params.item_keys;
      if (!Array.isArray(raw) || raw.some((k) => typeof k !== 'string')) {
        throw new Error('itemKeys must be an array of strings');
      }
      // `force` only from an explicit press; absent, the admission gate applies.
      return brain.indexSelection(requireAccountId(params), raw as string[], {
        force: params.force === true,
      });
    },

    async brain_active_run() {
      if (!brain) return null;
      return brain.activeRun();
    },

    async brain_current_run(_event, params = {}) {
      const accountId = requireAccountId(params);
      if (!brain) return null;
      return brain.currentRun(accountId);
    },

    async brain_curate_note(_event, params = {}) {
      if (!brain) throw new Error('brain service unavailable');
      return brain.curateNote(
        requireAccountId(params),
        requireString(params, 'notePath', 'note_path'),
      );
    },

    async brain_enqueue_curation(_event, params = {}) {
      if (!brain) throw new Error('brain service unavailable');
      return brain.enqueueCuration(requireAccountId(params));
    },

    async brain_stats(_event, params = {}) {
      const accountId = requireAccountId(params);
      if (!brain) return emptyStats();
      return brain.stats(accountId);
    },

    async brain_queue_counts(_event, params = {}) {
      const accountId = requireAccountId(params);
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
      if (!brain) throw new Error('brain service unavailable');
      return brain.backfill(requireAccountId(params));
    },

    async brain_enqueue_project_sources(_event, params = {}) {
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
        // A conflict on another account's vault must not break listing for this one; write paths still fail closed.
        if (err instanceof VaultConflictError) return [];
        throw err;
      }
      return handle ? handle.vault.listNotes() : [];
    },

    async brain_list_note_meta(_event, params = {}) {
      const accountId = requireAccountId(params);
      if (!brain) return [];
      try {
        return brain.listNoteMeta(accountId);
      } catch (err) {
        if (err instanceof VaultConflictError) return [];
        throw err;
      }
    },

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
      if (!brainMcp || !brain) throw new Error('brain service unavailable');
      const accountId = requireAccountId(params);
      const configDir = brainMcp.configDirFor(accountId);
      if (!configDir) throw new Error('no such account');
      const vaultRoot = brain.vaultPath(accountId);
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
        if (err instanceof NoteParseError) throw new Error(`cannot read note: ${err.message}`);
        throw err;
      }
    },
  };
}
