# Codex Account Parity — Design

> **Status:** Approved design. Implementation to be planned next via `writing-plans`.
> **Authors:** Greg + Claude (brainstormed 2026-05-27).
> **Related:** Builds on the Phase 3 Codex work (`2026-05-25-cli-engine-and-codex-design.md`). Removes the v1 "Codex is single-account" simplification by promoting Codex accounts to first-class peers of Claude accounts. Pairs with the just-landed removal of `OMNIFEX_ENABLE_CODEX`, which leaves Codex UI on by default.

## Goals

1. **Codex accounts are first-class.** Same lifecycle as Claude accounts: scanned on first run, listed in Settings, edited in a unified dialog, bound to projects via path rules, surfaced in the new-session form via the agent picker.
2. **One Add/Edit dialog for both engines.** Engine is a field on the form, not a separate UI surface. Engine-specific fields (Thinking config, permission-mode options, model list) toggle off the engine radio.
3. **Path rules support per-engine defaults.** A single project path can pre-select a Claude account AND a Codex account; the agent picker at session start decides which one is used.
4. **Multi-account Codex works via `CODEX_HOME`.** Codex CLI honors this env var (defaults to `~/.codex`); per-account spawns set it from `account.config_dir`. Same pattern as Claude's `CLAUDE_CONFIG_DIR`.

## Non-Goals

- Cross-engine session migration. A tab's engine is still immutable per session (set at start).
- Account-level API-key storage. `OPENAI_API_KEY` is machine-wide; the dialog surfaces this in hint text and does not try to per-account it.
- Renaming the `agent`/`engine` term throughout the codebase. Existing `AgentKind` stays. The new column is `engine` for parallel naming with the existing `Account` fields; both terms refer to the same concept.
- Changing the immutable-per-tab agent identity model. Tab metadata still carries `agent`.
- Per-account installs of the `codex` or `claude` CLI binary. Binary resolution is unchanged.

## Architectural Overview

The change is layered top-to-bottom: schema, services (accounts/auth/walker), IPC, renderer (Settings dialog, new-session form, project open flow). The session/runtime layer (`electron/services/sessions/`, `agents/`) is unaffected — once the resolver hands a `{ configDir, engine }` pair to a spawn, the engine layer already knows how to use it.

```
electron/services/
  accounts.ts                # Account.engine, has_cost, subscription_label; resolve() → ResolvePair
  first-run-discovery.ts     # scans ~/.claude* AND ~/.codex*, returns engine-tagged entries
  codex-session-walker.ts    # aggregates across N Codex configDirs (not just ~/.codex)
  auth/codex-auth.ts         # per-configDir status/watch/login/logout

src/components/
  AccountSettings.tsx        # one list, engine badge per row, "Scan for accounts" button
  AccountDialog.tsx          # NEW: unified Add/Edit with engine-conditional fields
  NewSessionForm.tsx         # consumes ResolvePair, flips account on AgentPicker change
  AccountPickerDialog.tsx    # gains engineFilter prop
```

## 1. Schema — Migration v11

### Accounts table

```sql
-- Add engine column. Default 'claude' for backfill safety.
ALTER TABLE accounts ADD COLUMN engine TEXT NOT NULL DEFAULT 'claude';

-- Add has_cost column. Default 1 (most accounts cost).
ALTER TABLE accounts ADD COLUMN has_cost INTEGER NOT NULL DEFAULT 1;

-- Rename account_type → subscription_label (free text). SQLite supports
-- RENAME COLUMN as of 3.25, which we're well past. Single statement.
ALTER TABLE accounts RENAME COLUMN account_type TO subscription_label;

-- Backfill: existing rows are all Claude. Capitalize the old enum value
-- into the new label; flip has_cost to 0 for Max (the only no-cost tier).
UPDATE accounts SET subscription_label = 'Max', has_cost = 0 WHERE subscription_label = 'max';
UPDATE accounts SET subscription_label = 'Pro' WHERE subscription_label = 'pro';
UPDATE accounts SET subscription_label = 'Enterprise' WHERE subscription_label = 'enterprise';
UPDATE accounts SET subscription_label = 'Free' WHERE subscription_label = 'free';
```

`engine` is constrained at the application layer (`'claude' | 'codex'`); no CHECK constraint, mirroring how `account_path_rules.agent` was handled in v10.

### Path rules table

The `agent` column added in v10 becomes redundant once every rule binds to an account (engine is derivable via `account.engine`). Migration drops it and makes `account_id` NOT NULL.

**Ordering note:** the orphan-Codex-rule backfill below depends on at least one Codex account existing in the `accounts` table. To make that true at migration time, migration v11 runs a synchronous **one-shot Codex discovery as its first step** (before any ALTER): if `~/.codex/` exists and no Codex account is in the table yet, insert one as `{ engine: 'codex', name: 'Codex', config_dir: '<home>/.codex', subscription_label: '', has_cost: 1 }`. This is the same row §8 would create on first-launch discovery — running it inside the migration avoids dropping pre-existing Codex path rules from Phase 3. The discovery flag (`codex_discovery_completed` in `app_settings`) is set in the same transaction.

```sql
-- Step 1 (in migration runner, before ALTERs): synchronous Codex discovery
-- (described above) ensures the SELECT below finds an account when the
-- user had a Phase 3 ~/.codex/ install.

-- Step 2: backfill any account_id=null rows (Codex-only rules from
-- Phase 3) by binding them to the discovered/preexisting Codex account.
UPDATE account_path_rules
   SET account_id = (
     SELECT id FROM accounts
      WHERE engine = 'codex'
      ORDER BY id ASC LIMIT 1
   )
 WHERE account_id IS NULL
   AND agent = 'codex'
   AND EXISTS (SELECT 1 FROM accounts WHERE engine = 'codex');

-- Drop any remaining orphan rules (no Codex account to bind to). Console
-- warning emitted from the migration step listing the dropped paths so
-- the user knows what happened.
DELETE FROM account_path_rules WHERE account_id IS NULL;

-- Table rebuild: drop agent column, NOT NULL account_id, same PK shape
-- as v10 (plain INTEGER PRIMARY KEY, no AUTOINCREMENT).
CREATE TABLE account_path_rules_new (
  id INTEGER PRIMARY KEY,
  account_id INTEGER NOT NULL,
  path_prefix TEXT NOT NULL,
  priority INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
);
INSERT INTO account_path_rules_new (id, account_id, path_prefix, priority)
  SELECT id, account_id, path_prefix, priority FROM account_path_rules;
DROP TABLE account_path_rules;
ALTER TABLE account_path_rules_new RENAME TO account_path_rules;
```

The schema now allows multiple rules with the same `path_prefix` (no UNIQUE constraint on path_prefix) — that's intentional and already true under v10. The new resolver (§4) interprets that shape as "two engines, two defaults for the same path."

### Project account overrides table

```sql
-- New composite PK so a single project can override both engines
-- independently. Existing rows are all Claude (Codex had no account
-- model in Phase 3); backfill engine='claude' for those.
CREATE TABLE project_account_overrides_new (
  project_path TEXT NOT NULL,
  engine TEXT NOT NULL DEFAULT 'claude',
  account_id INTEGER NOT NULL,
  PRIMARY KEY (project_path, engine),
  FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
);
INSERT INTO project_account_overrides_new (project_path, engine, account_id)
  SELECT project_path, 'claude', account_id FROM project_account_overrides;
DROP TABLE project_account_overrides;
ALTER TABLE project_account_overrides_new RENAME TO project_account_overrides;
```

### `Account` interface (`accounts.ts`)

```ts
export type AccountEngine = 'claude' | 'codex';

export interface Account {
  id: number;
  name: string;
  config_dir: string;
  engine: AccountEngine;                    // NEW
  subscription_label: string;               // was account_type; free text
  has_cost: boolean;                        // NEW; persisted as 0/1
  color: string | null;
  icon: string | null;
  session_defaults?: SessionDefaults;
  cli_path: string | null;
  created_at: string;
  updated_at: string;
  summarizeOnClose?: boolean;
  summaryModel?: string | null;
}

export interface SessionDefaults {
  model?: string;
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  /** Claude-only. Hidden in the Codex form. */
  thinkingConfig?: 'adaptive' | 'disabled';
  /**
   * Engine-specific. Claude: 'acceptEdits' | 'plan' | etc.
   * Codex: 'read-only' | 'workspace-edit' | 'full-access' (presets that
   * wrap approvalPolicy × sandboxPolicy). Validated at write time per engine.
   */
  permissionMode?: string;
}
```

`createAccount` / `updateAccount` signatures gain `engine: AccountEngine` and `hasCost: boolean`; old positional callers update.

## 2. Account discovery

Rename `discoverClaudeConfigDirs()` → `discoverConfigDirs()`. Returns engine-tagged entries:

```ts
export interface DiscoveredConfigDir {
  dirName: string;     // ".claude", ".codex-work"
  configDir: string;   // absolute path
  engine: AccountEngine;
}

export async function discoverConfigDirs(homeDir: string): Promise<DiscoveredConfigDir[]>;
```

Scans `<homeDir>/.claude*` AND `<homeDir>/.codex*`. `nameFromConfigDir` becomes engine-aware (factor the prefix out so the suffix-to-label transform is reused):

| Dir | Engine | Name |
|---|---|---|
| `~/.claude` | claude | "Claude" |
| `~/.claude-work` | claude | "Work" |
| `~/.codex` | codex | "Codex" |
| `~/.codex-work` | codex | "Work" |
| `~/.codex-side_project` | codex | "Side Project" |

Engine badge in the AccountSettings row disambiguates "Work (Claude)" from "Work (Codex)" visually.

`runFirstTimeDiscovery` is structurally unchanged — it iterates the discovery results and calls `createAccount(name, configDir, { engine, … })`. The `discovery_completed` flag still gates re-runs.

The manual escape-hatch button in Settings is renamed **"Scan for accounts"**. Status feedback strings drop "Claude" and read "Found N account(s)" / "No new accounts found".

## 3. Unified Add/Edit dialog (`AccountDialog.tsx`)

New component. Replaces:

- The inline Add Account form currently rendered above the accounts list in `AccountSettings.tsx`.
- The per-row edit-in-place affordances (color, name, type) on existing account rows.
- The separate Codex section at the bottom of `AccountSettings.tsx` (the row + sign-in modal collapse into the same dialog flow).

### Fields

| Field | Always | Notes |
|---|---|---|
| Name | ✓ | text |
| Engine | ✓ | radio: Claude / Codex. **Locked on Edit** (read-only display). |
| Config directory | ✓ | folder picker; default for new Codex = `~/.codex-<slug-of-name>` if Name set, else blank |
| Subscription label | ✓ | text (e.g. "Max", "Plus", "Personal") |
| Has cost | ✓ | checkbox |
| Color | ✓ | existing `ColorSwatchGrid` |
| Icon | ✓ | existing `IconPicker` |
| Model | ✓ | engine-specific list (existing `MODELS` for Claude; new list for Codex) |
| Effort | ✓ | engine-specific options (Claude: low/med/high/xhigh/max; Codex: low/med/high) |
| Thinking | claude-only | hidden when engine=codex |
| Permissions | ✓ | engine-specific options (Claude: existing `PERMISSION_MODES`; Codex: read-only / workspace-edit / full-access) |
| Sign-in (Codex only) | codex-only | status pill (signed-in/out + email if known) + "Sign in" / "Sign out" buttons; opens `CodexSignInModal` parameterized by `configDir` |

### Engine-locked-on-edit rationale

Switching engines on an existing account would require validating the configDir is well-shaped for the new engine, migrating session defaults (Claude's `acceptEdits` is meaningless to Codex), and handling sign-in state transfer. Cost is high; user need is low — if someone's engine is wrong, delete + recreate is two clicks. The radio renders disabled with a tooltip on the Edit path.

### Session defaults sub-section

A single row of dropdowns mirroring the existing `NewSessionForm` row, but keyed on the form's engine state. Claude shows four cells (Model / Effort / Thinking / Permissions); Codex shows three (Model / Effort / Permissions — Thinking is hidden). The dropdown components themselves stay the same (`DropdownTrigger`, `DropdownRow`) — only the option lists branch on engine. Extract the Claude option lists from `NewSessionForm.tsx` into a shared `SESSION_DEFAULT_OPTIONS` registry keyed by engine, consumed by both `AccountDialog` and `NewSessionForm`.

## 4. Path rule resolver

```ts
export interface ResolveSlot {
  account: Account;
  matchType: 'override' | 'path_rule';
  matchDetail: string;   // override → path; path_rule → matched prefix
}

export interface ResolvePair {
  claude: ResolveSlot | null;
  codex:  ResolveSlot | null;
}

interface AccountsService {
  resolve(projectPath: string): ResolvePair;
  // legacy single-engine resolve() removed
}
```

Logic per engine slot, in order:

1. **Explicit override** — `project_account_overrides` row matching `(project_path, engine)`. Wins absolutely.
2. **Longest matching path rule** whose `account.engine === engine`. Multiple rules with the same `path_prefix` are fine — each engine independently picks its own.
3. **`null`** — no preselection. Renderer surfaces an empty AccountBadge with a "Choose account" affordance.

Path rules are normalized (trailing `/` stripped, expanded `~`) before prefix-matching, same as today. The `isPathInside`-style guard from CLAUDE.md still applies.

`createPathRule` / `updatePathRule` / `deletePathRule` signatures drop the `agent` argument (engine derived from account). `setProjectOverride` gains an `engine` argument (derived from `accountId` — service can look it up and store it, no caller change needed).

## 5. New-session flow & account picking

`NewSessionForm` already takes `agent: AgentKind`, `setAgent`, `accountResolution`. Changes:

- `accountResolution: NewSessionFormAccountResolution | null` → `resolvePair: ResolvePair`.
- AgentPicker change handler re-derives the displayed AccountBadge from the matching slot.
- If the matching slot is `null`, the AccountBadge area renders a "Choose account" button that opens `AccountPickerDialog` filtered to the chosen engine. Selecting an account writes a `project_account_overrides` row scoped to `(project_path, engine)` and re-renders the form.
- Session defaults (model/effort/permissions) re-derive from the resolved account's `session_defaults`, re-populating the dropdown row when the engine flips. The form-local edits to those dropdowns are not persisted back to the account — they're per-session overrides, same as today.

### Project open flow (`App.tsx`)

When the user opens a project:

1. Compute `resolvePair = accounts.resolve(projectPath)`.
2. If both slots are `null` → show `AccountPickerDialog` with no engine filter; the user picks any account; that account's engine is the default for the new tab.
3. If exactly one slot is filled → that engine is the default; AgentPicker visible but pre-selected; the form opens immediately with the resolved account in the matching slot.
4. If both slots are filled → Claude is the default (matches current behavior). AgentPicker visible; flipping it swaps the AccountBadge to the Codex slot's account.

No new per-project "last used engine" memory in v1. If users find themselves repeatedly flipping the picker for a given project, we can add that as a follow-up — cheap to layer on (`app_settings` key per project), but not in scope here.

## 6. CodexAuthService rework

Today's single-`~/.codex/auth.json` watcher becomes per-configDir.

```ts
export interface CodexAuthService {
  getStatus(configDir: string): Promise<CodexAuthStatus>;
  watch(configDir: string, cb: (status: CodexAuthStatus) => void): { dispose(): void };
  startLoginFlow(opts: { configDir: string; codexBinaryPath?: string }): Promise<{ ptyHandle: string }>;
  cancelLoginFlow(ptyHandle: string): void;
  logout(configDir: string): Promise<void>;
  getBinaryPath(): string | null;
}
```

`startLoginFlow` spawns `codex login` with `env: { ...process.env, CODEX_HOME: configDir }` injected. Same `OneShotTerminal` plumbing as today.

`OPENAI_API_KEY` fallback semantics: it's a machine-wide env var, not per-account. `getStatus` checks the configDir's `auth.json` first; if missing, falls back to env. When the env-var path matches, status shows `mode='apikey'` for every Codex account on the machine. The AccountDialog hint text calls this out so the user understands why all their Codex accounts read "signed in via API key" at once.

The watcher Map is keyed by `configDir`; multiple subscribers per configDir share a single watcher (refcount + dispose when the last subscriber drops). Watcher cleanup on app quit walks every active key.

`useCodexAuthStatus` hook becomes `useCodexAuthStatus(configDir)` and mounts one subscription per Codex account row.

## 7. Codex session walker

`createCodexSessionWalker` currently hard-codes `~/.codex/sessions/`. New shape:

```ts
export interface CodexSessionWalker {
  listSessions(): Promise<CodexSessionEntry[]>;
}

export function createCodexSessionWalker(deps: {
  listCodexAccounts: () => Account[];   // injected; reads from AccountsService
}): CodexSessionWalker;
```

`listSessions` iterates every Codex account's `<config_dir>/sessions/`, tags each entry with the source account's `id`, and aggregates. The renderer's session list filter already supports per-agent badges; it gains a Codex-account badge column when more than one Codex account exists. (Single Codex account → badge omitted, matching the Claude column's behavior.)

## 8. Backward compatibility

- **Existing Claude accounts:** migrated automatically by §1. No user action.
- **Existing `~/.codex/` install (single-account Phase 3 user):** the v11 migration runs a synchronous one-shot Codex discovery as its **first step** (see §1, "Ordering note"). If `~/.codex/` exists and no Codex account is in the `accounts` table yet, it inserts `{ engine: 'codex', name: 'Codex', config_dir: '<home>/.codex', subscription_label: '', has_cost: 1 }` and sets `app_settings.codex_discovery_completed = 'true'`. This guarantees a Codex account exists in the table before the orphan-rule UPDATE runs, so pre-existing Phase 3 path rules survive the migration. Discovery flag is checked before the insert so re-runs are no-ops.
- **Existing `useCodexAuthStatus()` callsites:** the no-arg signature is removed; callers updated to pass `account.config_dir`. There is no machine-wide "is Codex signed in" anymore; that concept is per-account.
- **Old `account_type` consumers:** anywhere code reads `account.account_type` to render a tier badge, that becomes `account.subscription_label`. The cost-tracking gate (`if account.account_type === 'max' then no cost`) becomes `if !account.has_cost`.
- **Renderer feature gates:** the `OMNIFEX_ENABLE_CODEX` env var is already gone (removed earlier this session). No gates remain.

## 9. Testing

- **Migration v11** — round-trip seeded v10 data (mixed account_types incl. `'max'`; mixed path rules with `agent='claude'` and `agent='codex'` w/ null account_id; project overrides). Assert end-state: engine column populated, subscription_label capitalized, has_cost flipped for Max, path rules NOT NULL account_id, orphan rules bound to discovered Codex account, overrides composite-keyed.
- **`discoverConfigDirs`** — fixture tmpdir with mixed `~/.claude*` and `~/.codex*` shapes; assert engine tagging and name derivation; assert no false positives for `~/.claudette` / `~/.codexample` (must require exact prefix or hyphen/underscore separator).
- **`AccountsService.resolve`** — table of (rules, overrides, project_path) → expected `ResolvePair`, including: both slots filled, only one slot filled, neither slot filled, override-wins-over-rule per engine independently, longest-prefix per engine independently.
- **`CodexAuthService` per-configDir** — concurrent watchers on two configDirs; sign-in writes to one doesn't fire the other's callback; logout on one doesn't affect the other; refcount disposal correctness.
- **`AccountDialog`** — engine radio toggles session-defaults dropdowns; Edit path renders engine as locked; Codex sign-in button opens the modal with the right `configDir`; per-engine permission/model lists render the correct options.
- **`NewSessionForm`** — flipping AgentPicker re-derives account + session defaults from `resolvePair`; null slot renders "Choose account" affordance; choosing an account writes the per-engine override.
- **Codex session walker** — multi-configDir aggregation; per-account tagging on entries; empty configDir handled (account exists, no sessions yet).

## 10. Scope, sequencing, file impact

This is a substantial but coherent change. ~15-20 files touched. Implementation should land as a single coordinated PR — the schema migration, resolver semantics, and CodexAuthService rewrite are coupled and don't split cleanly into shippable intermediate states.

**High-touch files:**

- `electron/services/database.ts` — migration v11
- `electron/services/accounts.ts` — Account interface, resolve() pair shape, CRUD signature changes
- `electron/services/first-run-discovery.ts` — engine-tagged discovery
- `electron/services/auth/codex-auth.ts` — per-configDir refactor
- `electron/services/codex-session-walker.ts` — multi-configDir aggregation
- `electron/ipc/handlers.ts` — handler signature changes (resolve pair, codex auth per-configDir)
- `electron/preload.ts` — no new channels; existing channels' param shapes change
- `src/lib/api.ts` — typed API: `resolve` returns ResolvePair, `getCodexAuthStatus(configDir)`, etc.
- `src/components/AccountSettings.tsx` — list rewrite (engine badges, single list, Scan button rename)
- `src/components/AccountDialog.tsx` — **new file**
- `src/components/NewSessionForm.tsx` — resolvePair plumbing
- `src/components/AccountPickerDialog.tsx` — engineFilter prop
- `src/App.tsx` — project open flow branches on resolve pair shape
- `src/hooks/useCodexAuthStatus.ts` — per-configDir signature
- `electron/__tests__/` — new tests for everything above
- `src/components/__tests__/` — new + updated tests for AccountDialog, NewSessionForm, AccountSettings

**Out of scope (explicitly):**

- Per-account `OPENAI_API_KEY` storage
- Engine-change-on-edit
- Cross-engine session migration
- Renaming `agent` → `engine` codebase-wide
