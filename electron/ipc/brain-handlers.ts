import { VaultConflictError, type BrainService, type VaultHandle } from '../services/brain/registry';
import { NoteParseError } from '../services/brain/frontmatter';

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
 */
export function createBrainHandlers(brain?: BrainService): Record<string, HandlerFn> {
  return {
    async brain_vault_path(_event, params = {}) {
      return brain?.vaultPath(requireAccountId(params)) ?? null;
    },

    async brain_set_vault_path(_event, params = {}) {
      // Tilde expansion is the UI layer's job; the registry rejects a path
      // whose first segment is `~` and that rejection message is surfaced
      // as-is below, not special-cased.
      brain?.setVaultPath(requireAccountId(params), requireString(params, 'path', 'path'));
      return null;
    },

    async brain_clear_vault_path(_event, params = {}) {
      brain?.clearVaultPath(requireAccountId(params));
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
