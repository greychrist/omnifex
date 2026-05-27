# Codex Account Parity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Promote Codex accounts to first-class peers of Claude accounts. One unified Add/Edit dialog, scan-for-both, multi-Codex via `CODEX_HOME`, per-engine path-rule slots, and a resolver that returns `{ claude, codex }` so a single project path can pre-select defaults for both engines.

**Architecture:** Schema-first refactor (migration v11) that adds an `engine` column to `accounts`, drops the now-redundant `agent` column from `account_path_rules`, and pivots the resolver to return a `{claude, codex}` pair. The dialog, scanner, auth service, and session walker all become engine-aware. Bottom-up implementation order keeps each task individually testable; later renderer tasks fix the consumer side of earlier signature changes.

**Tech Stack:** `better-sqlite3` migrations, existing `AccountsService` shape, existing `OneShotTerminal` pattern for Codex login, existing Radix UI / Tailwind v4 / shadcn primitives for the dialog. No new third-party deps.

**Spec:** `docs/superpowers/specs/2026-05-27-codex-account-parity-design.md`.

**Depends on:** Phase 3 Codex work (`2026-05-25-codex-engine-and-routing.md`) shipped in v0.4.67. `OMNIFEX_ENABLE_CODEX` feature flag was removed earlier in this session — Codex UI is unconditional.

---

## Non-Goals (out of scope for this plan)

- Per-account `OPENAI_API_KEY` storage. API key remains a machine-wide env var; dialog hint text discloses this.
- Engine-change on Edit. Engine radio is locked once an account exists; delete + recreate to switch.
- Per-project "last used engine" memory. When both slots are filled, Claude is the default. Cheap follow-up if users want it.
- Renaming `agent` → `engine` codebase-wide. `AgentKind` stays. New column is `engine` on `accounts` for parallel naming with other Account fields; both terms refer to the same concept.
- Rich settings editor for Codex `config.toml`. Defaults live on the account row only.

---

## File Structure

**New files:**
- `electron/__tests__/database-migration-v11.test.ts` — round-trip migration test.
- `src/components/AccountDialog.tsx` — unified Add/Edit dialog.
- `src/components/__tests__/AccountDialog.test.tsx`.
- `src/components/shared/SessionDefaultsRow.tsx` — extracted shared dropdowns (Model/Effort/Thinking/Permissions) keyed by engine.
- `src/components/shared/__tests__/SessionDefaultsRow.test.tsx`.
- `src/lib/sessionDefaultOptions.ts` — engine-keyed registry of option lists (models, efforts, permissions).

**Modified files:**
- `electron/services/database.ts` — migration v11 (accounts columns + path-rules rebuild + overrides composite-key).
- `electron/services/accounts.ts` — `Account.engine`/`has_cost`/`subscription_label`; CRUD signatures; `resolve()` returns `ResolvePair`.
- `electron/services/first-run-discovery.ts` — `discoverConfigDirs()` scans both engine prefixes; engine-tagged entries.
- `electron/services/auth/codex-auth.ts` — per-configDir status/watch/login/logout; watcher Map.
- `electron/services/codex-session-walker.ts` — multi-configDir aggregation.
- `electron/ipc/handlers.ts` — `resolve_account_for_project` returns pair; codex_auth_* handlers take `configDir` param; create/update account handlers carry engine + has_cost.
- `electron/preload.ts` — no new channels; existing channel param shapes change (validated at call sites).
- `electron/main.ts` — wire updated services; no structural change.
- `src/lib/api.ts` — `ResolvePair` type; `resolveAccountForProject` returns pair; `getCodexAuthStatus(configDir)`; `createAccount`/`updateAccount` carry engine.
- `src/components/AccountSettings.tsx` — single list with engine badges; Scan button rename; opens AccountDialog; remove inline forms + separate Codex section.
- `src/components/NewSessionForm.tsx` — consumes `ResolvePair`; AgentPicker re-derives account + defaults; "Choose account" affordance on empty slot; consumes shared `SessionDefaultsRow`.
- `src/components/AccountPickerDialog.tsx` — gains `engineFilter?: AccountEngine` prop.
- `src/App.tsx` — project open flow branches on resolve pair (both null / one filled / both filled).
- `src/hooks/useCodexAuthStatus.ts` — signature becomes `(configDir: string)`.
- `CHANGELOG.md` — Unreleased section.

**Deleted (folded into AccountDialog):**
- No file deletions, but large code regions go away in `AccountSettings.tsx`: the inline add-account form, the per-row inline-edit affordances, the separate Codex section. Code disappears, not files.

---

## Task 1: Migration v11 — schema

**Files:**
- Modify: `electron/services/database.ts`
- Create: `electron/__tests__/database-migration-v11.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// electron/__tests__/database-migration-v11.test.ts
import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../services/database';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

describe('migration v11 — codex account parity', () => {
  it('adds engine + has_cost; renames account_type → subscription_label; capitalizes labels; flips has_cost for max', () => {
    const db = new Database(':memory:');
    // Seed v10 shape
    db.exec(`
      CREATE TABLE accounts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT UNIQUE NOT NULL,
        config_dir TEXT NOT NULL,
        account_type TEXT NOT NULL DEFAULT 'pro',
        color TEXT, icon TEXT,
        session_defaults TEXT, cli_path TEXT,
        summarizeOnClose INTEGER NOT NULL DEFAULT 0,
        summaryModel TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      INSERT INTO accounts (name, config_dir, account_type) VALUES
        ('A', '/A', 'max'),
        ('B', '/B', 'pro'),
        ('C', '/C', 'enterprise'),
        ('D', '/D', 'free');
      CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
      INSERT INTO app_settings (key, value) VALUES ('schema_version', '10');
    `);

    runMigrations(db);

    const rows = db.prepare('SELECT name, engine, subscription_label, has_cost FROM accounts ORDER BY name').all() as any[];
    expect(rows[0]).toMatchObject({ name: 'A', engine: 'claude', subscription_label: 'Max', has_cost: 0 });
    expect(rows[1]).toMatchObject({ name: 'B', engine: 'claude', subscription_label: 'Pro', has_cost: 1 });
    expect(rows[2]).toMatchObject({ name: 'C', engine: 'claude', subscription_label: 'Enterprise', has_cost: 1 });
    expect(rows[3]).toMatchObject({ name: 'D', engine: 'claude', subscription_label: 'Free', has_cost: 1 });
  });

  it('drops account_path_rules.agent; makes account_id NOT NULL; backfills orphan Codex rules to discovered ~/.codex account', () => {
    // Seed tmpdir with a ~/.codex/ to trigger in-migration discovery
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'omnifex-mig-'));
    fs.mkdirSync(path.join(tmpHome, '.codex'));

    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE accounts (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE NOT NULL, config_dir TEXT NOT NULL, account_type TEXT NOT NULL DEFAULT 'pro', color TEXT, icon TEXT, session_defaults TEXT, cli_path TEXT, summarizeOnClose INTEGER NOT NULL DEFAULT 0, summaryModel TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
      INSERT INTO accounts (name, config_dir) VALUES ('Personal', '/Users/me/.claude-personal');
      CREATE TABLE account_path_rules (id INTEGER PRIMARY KEY, account_id INTEGER, path_prefix TEXT NOT NULL, priority INTEGER NOT NULL DEFAULT 0, agent TEXT NOT NULL DEFAULT 'claude', FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE);
      INSERT INTO account_path_rules (account_id, path_prefix, agent) VALUES
        (1, '/Users/me/Repos', 'claude'),
        (NULL, '/Users/me/CodexProjects', 'codex');
      CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
      INSERT INTO app_settings (key, value) VALUES ('schema_version', '10');
    `);

    runMigrations(db, { homeDir: tmpHome });

    const codexAccount = db.prepare("SELECT id, name, config_dir FROM accounts WHERE engine = 'codex'").get() as any;
    expect(codexAccount).toMatchObject({ name: 'Codex', config_dir: path.join(tmpHome, '.codex') });

    const rules = db.prepare('SELECT account_id, path_prefix FROM account_path_rules ORDER BY path_prefix').all() as any[];
    expect(rules).toHaveLength(2);
    expect(rules[0]).toMatchObject({ path_prefix: '/Users/me/CodexProjects', account_id: codexAccount.id });
    expect(rules[1]).toMatchObject({ path_prefix: '/Users/me/Repos', account_id: 1 });

    // Discovery flag set
    expect((db.prepare('SELECT value FROM app_settings WHERE key = ?').get('codex_discovery_completed') as any)?.value).toBe('true');

    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it('drops orphan Codex rules when no ~/.codex/ exists', () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'omnifex-mig-'));
    // No ~/.codex/ inside tmpHome

    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE accounts (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE NOT NULL, config_dir TEXT NOT NULL, account_type TEXT NOT NULL DEFAULT 'pro', color TEXT, icon TEXT, session_defaults TEXT, cli_path TEXT, summarizeOnClose INTEGER NOT NULL DEFAULT 0, summaryModel TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
      CREATE TABLE account_path_rules (id INTEGER PRIMARY KEY, account_id INTEGER, path_prefix TEXT NOT NULL, priority INTEGER NOT NULL DEFAULT 0, agent TEXT NOT NULL DEFAULT 'claude', FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE);
      INSERT INTO account_path_rules (account_id, path_prefix, agent) VALUES (NULL, '/x', 'codex');
      CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
      INSERT INTO app_settings (key, value) VALUES ('schema_version', '10');
    `);

    runMigrations(db, { homeDir: tmpHome });

    expect(db.prepare('SELECT COUNT(*) AS n FROM account_path_rules').get()).toMatchObject({ n: 0 });
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it('migrates project_account_overrides to composite (project_path, engine) PK', () => {
    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE accounts (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE NOT NULL, config_dir TEXT NOT NULL, account_type TEXT NOT NULL DEFAULT 'pro', color TEXT, icon TEXT, session_defaults TEXT, cli_path TEXT, summarizeOnClose INTEGER NOT NULL DEFAULT 0, summaryModel TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
      INSERT INTO accounts (name, config_dir) VALUES ('A', '/A');
      CREATE TABLE project_account_overrides (project_path TEXT PRIMARY KEY, account_id INTEGER NOT NULL, FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE);
      INSERT INTO project_account_overrides VALUES ('/proj', 1);
      CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
      INSERT INTO app_settings (key, value) VALUES ('schema_version', '10');
    `);

    runMigrations(db);
    const row = db.prepare('SELECT project_path, engine, account_id FROM project_account_overrides').get();
    expect(row).toMatchObject({ project_path: '/proj', engine: 'claude', account_id: 1 });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run electron/__tests__/database-migration-v11.test.ts
```

Expected: FAIL — migration v11 doesn't exist; `runMigrations` likely doesn't accept the `{ homeDir }` option.

- [ ] **Step 3: Implement migration v11 in `electron/services/database.ts`**

Find the migrations array (look for `migration: 10` near the rebuild of `account_path_rules`). Add migration `11` immediately after. Also widen `runMigrations` to accept `{ homeDir?: string }` so the in-migration Codex discovery can be parameterized for tests:

```ts
// Add to existing migrations array, after the v10 entry:
{
  version: 11,
  description: 'Codex account parity: engine + has_cost on accounts; subscription_label rename; drop agent col from path_rules; per-engine overrides',
  up: (db, opts = {}) => {
    const homeDir = opts.homeDir ?? os.homedir();

    // Step 1: In-migration Codex discovery so the rules backfill below has
    // something to bind to. Only runs if ~/.codex/ exists AND no Codex
    // account is present yet (idempotent; safe on rerun).
    const codexHome = path.join(homeDir, '.codex');
    const hasCodexDir = fs.existsSync(codexHome);
    const existingCodex = db
      .prepare(`SELECT id FROM accounts WHERE config_dir = ?`)
      .get(codexHome);
    if (hasCodexDir && !existingCodex) {
      // accounts schema at this point still has account_type, not subscription_label.
      // We use the legacy column name and let the rename later normalize it.
      db.prepare(
        `INSERT INTO accounts (name, config_dir, account_type) VALUES (?, ?, ?)`,
      ).run('Codex', codexHome, '');
    }
    if (hasCodexDir) {
      db.prepare(
        `INSERT OR REPLACE INTO app_settings (key, value, updated_at)
         VALUES ('codex_discovery_completed', 'true', CURRENT_TIMESTAMP)`,
      ).run();
    }

    // Step 2: accounts columns
    db.exec(`ALTER TABLE accounts ADD COLUMN engine TEXT NOT NULL DEFAULT 'claude'`);
    db.exec(`ALTER TABLE accounts ADD COLUMN has_cost INTEGER NOT NULL DEFAULT 1`);
    db.exec(`ALTER TABLE accounts RENAME COLUMN account_type TO subscription_label`);

    // Backfill values
    db.exec(`UPDATE accounts SET subscription_label = 'Max', has_cost = 0 WHERE subscription_label = 'max'`);
    db.exec(`UPDATE accounts SET subscription_label = 'Pro' WHERE subscription_label = 'pro'`);
    db.exec(`UPDATE accounts SET subscription_label = 'Enterprise' WHERE subscription_label = 'enterprise'`);
    db.exec(`UPDATE accounts SET subscription_label = 'Free' WHERE subscription_label = 'free'`);

    // The freshly-inserted Codex row from Step 1 still reads engine='claude'
    // because the ALTER above set it as default. Flip to 'codex'.
    db.prepare(`UPDATE accounts SET engine = 'codex' WHERE config_dir = ?`).run(codexHome);

    // Step 3: account_path_rules rebuild
    db.exec(`
      UPDATE account_path_rules
         SET account_id = (
           SELECT id FROM accounts WHERE engine = 'codex' ORDER BY id ASC LIMIT 1
         )
       WHERE account_id IS NULL
         AND agent = 'codex'
         AND EXISTS (SELECT 1 FROM accounts WHERE engine = 'codex')
    `);
    db.exec(`DELETE FROM account_path_rules WHERE account_id IS NULL`);

    db.exec(`
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
    `);

    // Step 4: project_account_overrides composite PK
    db.exec(`
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
    `);
  },
},
```

Update `runMigrations`' signature to plumb `opts` through:

```ts
export function runMigrations(db: Database.Database, opts: { homeDir?: string } = {}): void {
  // ... existing version-check + loop, but pass opts to each migration's up()
}
```

Update the canonical CREATE statements at the bottom of `database.ts` (for fresh installs) to match the post-v11 shape: `accounts` has `engine`/`has_cost`/`subscription_label`; `account_path_rules` has no `agent` column and NOT NULL `account_id`; `project_account_overrides` has composite PK.

- [ ] **Step 4: Run test to verify it passes**

```bash
npx vitest run electron/__tests__/database-migration-v11.test.ts
```

Expected: PASS — all four cases green.

- [ ] **Step 5: Run the full DB test suite to confirm no v10 regression**

```bash
npx vitest run electron/__tests__/database.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add electron/services/database.ts electron/__tests__/database-migration-v11.test.ts
git commit -m "$(cat <<'EOF'
feat(db): migration v11 — codex account parity schema

- Add engine + has_cost columns to accounts; rename account_type → subscription_label with capitalization backfill
- Drop agent column from account_path_rules; make account_id NOT NULL; backfill orphan Codex rules to discovered ~/.codex account
- Add engine to project_account_overrides composite PK
- In-migration Codex discovery as first step so the rules backfill has something to bind to

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: AccountsService — Account interface + CRUD signature changes

**Files:**
- Modify: `electron/services/accounts.ts`
- Modify: `electron/__tests__/accounts.test.ts`

- [ ] **Step 1: Update the failing tests**

Update existing CRUD round-trip tests in `accounts.test.ts` so they exercise the new field shape. Add:

```ts
it('round-trips engine, subscription_label, has_cost on create', () => {
  const svc = createAccountsService({ db: createDatabase(':memory:') });
  const created = svc.createAccount({
    name: 'CodexWork',
    configDir: '/x',
    engine: 'codex',
    subscriptionLabel: 'Plus',
    hasCost: true,
  });
  expect(created.engine).toBe('codex');
  expect(created.subscription_label).toBe('Plus');
  expect(created.has_cost).toBe(true);
  const list = svc.listAccounts();
  expect(list[0]).toMatchObject({ engine: 'codex', subscription_label: 'Plus', has_cost: true });
});

it('defaults engine=claude and has_cost=true when not specified (backward compat)', () => {
  const svc = createAccountsService({ db: createDatabase(':memory:') });
  const created = svc.createAccount({ name: 'A', configDir: '/A' });
  expect(created.engine).toBe('claude');
  expect(created.has_cost).toBe(true);
});
```

Update existing tests that assert on `account_type` → assert on `subscription_label` instead.

- [ ] **Step 2: Run tests to verify they fail**

```bash
npx vitest run electron/__tests__/accounts.test.ts
```

Expected: FAIL — `engine`/`subscription_label`/`has_cost` don't exist on the interface; positional CRUD signature mismatches the new object-shape calls.

- [ ] **Step 3: Update the `Account` interface and CRUD signatures**

In `accounts.ts`:

```ts
export type AccountEngine = 'claude' | 'codex';

export interface Account {
  id: number;
  name: string;
  config_dir: string;
  engine: AccountEngine;
  subscription_label: string;
  has_cost: boolean;
  color: string | null;
  icon: string | null;
  session_defaults?: SessionDefaults;
  cli_path: string | null;
  created_at: string;
  updated_at: string;
  summarizeOnClose?: boolean;
  summaryModel?: string | null;
}

// CRUD shifts from positional params to a single options object — too many
// optional fields now, and engine has to be among them.
export interface CreateAccountOptions {
  name: string;
  configDir: string;
  engine?: AccountEngine;             // default 'claude'
  subscriptionLabel?: string;         // default ''
  hasCost?: boolean;                  // default true
  color?: string;
  icon?: string;
  sessionDefaults?: SessionDefaults;
  cliPath?: string | null;
}

export interface UpdateAccountOptions {
  name: string;
  configDir: string;
  // engine intentionally omitted — immutable post-create (see spec §3)
  subscriptionLabel?: string;
  hasCost?: boolean;
  color?: string;
  icon?: string;
  sessionDefaults?: SessionDefaults | null;
  cliPath?: string | null;
}

export interface AccountsService {
  listAccounts(): Account[];
  createAccount(opts: CreateAccountOptions): Account;
  updateAccount(id: number, opts: UpdateAccountOptions): void;
  // ... rest unchanged for now
}
```

In the implementation: update the SQL INSERT/UPDATE statements to include `engine`/`has_cost`/`subscription_label`. Update the row-mapper that reads from `accounts` rows to populate the new fields (convert SQLite INTEGER 0/1 → boolean for `has_cost`).

- [ ] **Step 4: Update every internal caller of createAccount / updateAccount**

Grep for callers:

```bash
rg -n "createAccount\(" electron/ src/
rg -n "updateAccount\(" electron/ src/
```

Convert positional args to the options-object shape. For unrelated tests that don't care about engine, omit it — defaults kick in. Likely callers:
- `electron/services/first-run-discovery.ts` — pass `{ name, configDir }` (engine inferred via Task 3).
- `electron/ipc/handlers.ts` — adapt `create_account` / `update_account` handlers to forward the new fields.

- [ ] **Step 5: Run accounts tests to verify they pass**

```bash
npx vitest run electron/__tests__/accounts.test.ts
```

Expected: PASS.

- [ ] **Step 6: Run TypeScript check to catch any consumer breakage**

```bash
npm run check
```

Expected: PASS. Any errors here mean a caller still uses the old positional signature — fix those in this task, not later.

- [ ] **Step 7: Commit**

```bash
git add electron/services/accounts.ts electron/__tests__/accounts.test.ts electron/services/first-run-discovery.ts electron/ipc/handlers.ts
git commit -m "$(cat <<'EOF'
refactor(accounts): Account.engine + has_cost + subscription_label; options-object CRUD

CreateAccount/updateAccount now take options objects. Engine is immutable post-create (no engine field on UpdateAccountOptions).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Discovery — scan both engines, engine-tagged entries

**Files:**
- Modify: `electron/services/first-run-discovery.ts`
- Modify: `electron/__tests__/first-run-discovery.test.ts`

- [ ] **Step 1: Update the failing tests**

```ts
import { discoverConfigDirs, nameFromConfigDir } from '../services/first-run-discovery';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

describe('discoverConfigDirs', () => {
  it('finds both ~/.claude* and ~/.codex* and tags each with the right engine', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'omnifex-disc-'));
    fs.mkdirSync(path.join(home, '.claude'));
    fs.mkdirSync(path.join(home, '.claude-work'));
    fs.mkdirSync(path.join(home, '.codex'));
    fs.mkdirSync(path.join(home, '.codex-side_project'));
    fs.mkdirSync(path.join(home, '.claudette'));      // false-positive guard
    fs.mkdirSync(path.join(home, '.codexample'));     // false-positive guard

    const found = await discoverConfigDirs(home);
    const byDir = Object.fromEntries(found.map((f) => [f.dirName, f]));

    expect(byDir['.claude']).toMatchObject({ engine: 'claude' });
    expect(byDir['.claude-work']).toMatchObject({ engine: 'claude' });
    expect(byDir['.codex']).toMatchObject({ engine: 'codex' });
    expect(byDir['.codex-side_project']).toMatchObject({ engine: 'codex' });
    expect(byDir['.claudette']).toBeUndefined();
    expect(byDir['.codexample']).toBeUndefined();

    fs.rmSync(home, { recursive: true, force: true });
  });
});

describe('nameFromConfigDir', () => {
  it('derives engine-aware names', () => {
    expect(nameFromConfigDir('.claude', 'claude')).toBe('Claude');
    expect(nameFromConfigDir('.claude-work', 'claude')).toBe('Work');
    expect(nameFromConfigDir('.codex', 'codex')).toBe('Codex');
    expect(nameFromConfigDir('.codex-work', 'codex')).toBe('Work');
    expect(nameFromConfigDir('.codex-side_project', 'codex')).toBe('Side Project');
  });
});
```

Update existing `runFirstTimeDiscovery` tests so the `discover` stub returns the new tagged shape and the test asserts that `createAccount` is called with `{ engine }` propagated.

- [ ] **Step 2: Run tests to verify failure**

```bash
npx vitest run electron/__tests__/first-run-discovery.test.ts
```

Expected: FAIL — `discoverConfigDirs` doesn't exist; `nameFromConfigDir` has a different signature.

- [ ] **Step 3: Implement**

```ts
// electron/services/first-run-discovery.ts
import fs from 'node:fs/promises';
import path from 'node:path';
import type { AccountsService, AccountEngine } from './accounts';
import type { Database } from './database';

export interface DiscoveredConfigDir {
  dirName: string;
  configDir: string;
  engine: AccountEngine;
}

/**
 * Scan a home directory for Claude and Codex config dirs.
 * - `.claude` and `.claude-*` (hyphen or underscore separator) → engine=claude
 * - `.codex`  and `.codex-*`                                  → engine=codex
 * False positives like `.claudette` / `.codexample` are excluded — the
 * post-prefix character must be the end of the string or `-`/`_`.
 */
export async function discoverConfigDirs(homeDir: string): Promise<DiscoveredConfigDir[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(homeDir);
  } catch {
    return [];
  }

  const found: DiscoveredConfigDir[] = [];
  for (const name of entries) {
    const engine = engineFromDirName(name);
    if (!engine) continue;
    const abs = path.join(homeDir, name);
    try {
      const stat = await fs.stat(abs);
      if (!stat.isDirectory()) continue;
    } catch {
      continue;
    }
    found.push({ dirName: name, configDir: abs, engine });
  }
  return found;
}

function engineFromDirName(name: string): AccountEngine | null {
  for (const [prefix, engine] of [['.claude', 'claude'], ['.codex', 'codex']] as const) {
    if (name === prefix) return engine;
    if (name.startsWith(prefix + '-') || name.startsWith(prefix + '_')) return engine;
  }
  return null;
}

export function nameFromConfigDir(dirName: string, engine: AccountEngine): string {
  const prefix = engine === 'claude' ? '.claude' : '.codex';
  const suffix = dirName === prefix ? engine : dirName.slice(prefix.length + 1);
  return suffix
    .split(/[-_]/)
    .filter((p) => p.length > 0)
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
    .join(' ');
}

// runFirstTimeDiscovery: existing structure, but iterates DiscoveredConfigDir
// and calls createAccount with { engine } propagated.
export async function runFirstTimeDiscovery(
  deps: FirstTimeDiscoveryDeps,
): Promise<FirstTimeDiscoveryResult> {
  if (deps.db.getSetting(DISCOVERY_FLAG_KEY) === 'true') return { ran: false, created: [] };
  if (deps.accounts.listAccounts().length > 0) return { ran: false, created: [] };
  const found = await deps.discover();
  const created: Array<{ name: string; configDir: string; engine: AccountEngine }> = [];
  for (const { dirName, configDir, engine } of found) {
    const name = nameFromConfigDir(dirName, engine);
    deps.accounts.createAccount({ name, configDir, engine });
    created.push({ name, configDir, engine });
  }
  deps.db.saveSetting(DISCOVERY_FLAG_KEY, 'true');
  return { ran: true, created };
}

export interface FirstTimeDiscoveryDeps {
  accounts: Pick<AccountsService, 'listAccounts' | 'createAccount'>;
  db: Pick<Database, 'getSetting' | 'saveSetting'>;
  discover: () => Promise<DiscoveredConfigDir[]>;
}

export interface FirstTimeDiscoveryResult {
  ran: boolean;
  created: Array<{ name: string; configDir: string; engine: AccountEngine }>;
}
```

- [ ] **Step 4: Wire production `discover` in `electron/main.ts` to use `discoverConfigDirs(os.homedir())`**

Find the existing call site that constructs the discovery deps and replace the Claude-only discoverer with `() => discoverConfigDirs(os.homedir())`.

- [ ] **Step 5: Run tests to verify pass**

```bash
npx vitest run electron/__tests__/first-run-discovery.test.ts
npm run check
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add electron/services/first-run-discovery.ts electron/__tests__/first-run-discovery.test.ts electron/main.ts
git commit -m "$(cat <<'EOF'
feat(accounts): discoverConfigDirs scans both ~/.claude* and ~/.codex* with engine tagging

Renames discoverClaudeConfigDirs → discoverConfigDirs; nameFromConfigDir takes engine. False-positive guard requires exact prefix or hyphen/underscore separator.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: AccountsService.resolve — ResolvePair shape + per-engine overrides

**Files:**
- Modify: `electron/services/accounts.ts`
- Modify: `electron/__tests__/accounts.test.ts` (and any other test that calls `resolve()`)

- [ ] **Step 1: Write the failing tests**

```ts
describe('AccountsService.resolve — ResolvePair', () => {
  it('returns both slots filled when project path has rules for both engines', () => {
    const svc = createAccountsService({ db: createDatabase(':memory:') });
    const claude = svc.createAccount({ name: 'C', configDir: '/c', engine: 'claude' });
    const codex = svc.createAccount({ name: 'X', configDir: '/x', engine: 'codex' });
    svc.createPathRule({ accountId: claude.id, pathPrefix: '/proj', priority: 0 });
    svc.createPathRule({ accountId: codex.id, pathPrefix: '/proj', priority: 0 });
    const pair = svc.resolve('/proj/sub');
    expect(pair.claude?.account.id).toBe(claude.id);
    expect(pair.codex?.account.id).toBe(codex.id);
    expect(pair.claude?.matchType).toBe('path_rule');
  });

  it('returns null for engines with no matching rule', () => {
    const svc = createAccountsService({ db: createDatabase(':memory:') });
    const claude = svc.createAccount({ name: 'C', configDir: '/c', engine: 'claude' });
    svc.createPathRule({ accountId: claude.id, pathPrefix: '/proj', priority: 0 });
    const pair = svc.resolve('/proj');
    expect(pair.claude?.account.id).toBe(claude.id);
    expect(pair.codex).toBeNull();
  });

  it('explicit override wins over path rule per-engine independently', () => {
    const svc = createAccountsService({ db: createDatabase(':memory:') });
    const claudeRule = svc.createAccount({ name: 'CR', configDir: '/cr', engine: 'claude' });
    const claudeOverride = svc.createAccount({ name: 'CO', configDir: '/co', engine: 'claude' });
    const codex = svc.createAccount({ name: 'X', configDir: '/x', engine: 'codex' });
    svc.createPathRule({ accountId: claudeRule.id, pathPrefix: '/proj', priority: 0 });
    svc.createPathRule({ accountId: codex.id, pathPrefix: '/proj', priority: 0 });
    svc.setProjectOverride({ projectPath: '/proj', accountId: claudeOverride.id });
    const pair = svc.resolve('/proj');
    expect(pair.claude?.account.id).toBe(claudeOverride.id);
    expect(pair.claude?.matchType).toBe('override');
    expect(pair.codex?.account.id).toBe(codex.id);
    expect(pair.codex?.matchType).toBe('path_rule');
  });

  it('longest matching prefix wins per engine', () => {
    const svc = createAccountsService({ db: createDatabase(':memory:') });
    const a = svc.createAccount({ name: 'A', configDir: '/a', engine: 'claude' });
    const b = svc.createAccount({ name: 'B', configDir: '/b', engine: 'claude' });
    svc.createPathRule({ accountId: a.id, pathPrefix: '/proj', priority: 0 });
    svc.createPathRule({ accountId: b.id, pathPrefix: '/proj/deep', priority: 0 });
    const pair = svc.resolve('/proj/deep/sub');
    expect(pair.claude?.account.id).toBe(b.id);
  });

  it('returns both null when nothing matches', () => {
    const svc = createAccountsService({ db: createDatabase(':memory:') });
    expect(svc.resolve('/random')).toEqual({ claude: null, codex: null });
  });
});
```

- [ ] **Step 2: Run tests to verify failure**

```bash
npx vitest run electron/__tests__/accounts.test.ts -t ResolvePair
```

Expected: FAIL.

- [ ] **Step 3: Update interfaces and implementation in `accounts.ts`**

```ts
export interface ResolveSlot {
  account: Account;
  matchType: 'override' | 'path_rule';
  matchDetail: string;
}

export interface ResolvePair {
  claude: ResolveSlot | null;
  codex: ResolveSlot | null;
}

// AccountsService:
resolve(projectPath: string): ResolvePair;
// createPathRule / updatePathRule: drop the `agent` arg (engine derived).
// setProjectOverride: accept either a positional accountId or an options object;
// implementation derives engine from account_id and writes the composite-key row.
setProjectOverride(opts: { projectPath: string; accountId: number }): void;
```

Implementation outline:

```ts
function resolve(projectPath: string): ResolvePair {
  const normalized = normalizePath(projectPath);
  const result: ResolvePair = { claude: null, codex: null };

  // 1. Explicit overrides, per engine
  const overrides = db.prepare(`
    SELECT o.engine, o.account_id, a.* FROM project_account_overrides o
    JOIN accounts a ON a.id = o.account_id
    WHERE o.project_path = ?
  `).all(normalized) as Array<Account & { engine: AccountEngine }>;
  for (const row of overrides) {
    const slot: ResolveSlot = {
      account: mapRow(row),
      matchType: 'override',
      matchDetail: normalized,
    };
    if (row.engine === 'claude') result.claude = slot;
    else result.codex = slot;
  }

  // 2. Path rules per engine — only for slots not already filled by override
  if (!result.claude || !result.codex) {
    const rules = db.prepare(`
      SELECT r.path_prefix, r.priority, a.* FROM account_path_rules r
      JOIN accounts a ON a.id = r.account_id
    `).all() as Array<Account & { path_prefix: string; priority: number }>;
    for (const engine of ['claude', 'codex'] as const) {
      if (result[engine]) continue;
      const matches = rules
        .filter((r) => r.engine === engine)
        .filter((r) => isPathInside(normalized, r.path_prefix))
        .sort((a, b) => b.path_prefix.length - a.path_prefix.length || b.priority - a.priority);
      if (matches.length > 0) {
        const m = matches[0];
        result[engine] = {
          account: mapRow(m),
          matchType: 'path_rule',
          matchDetail: m.path_prefix,
        };
      }
    }
  }

  return result;
}

function setProjectOverride(opts: { projectPath: string; accountId: number }): void {
  const acct = db.prepare(`SELECT engine FROM accounts WHERE id = ?`).get(opts.accountId) as { engine: AccountEngine } | undefined;
  if (!acct) throw new Error(`Account ${opts.accountId} not found`);
  db.prepare(`
    INSERT INTO project_account_overrides (project_path, engine, account_id)
    VALUES (?, ?, ?)
    ON CONFLICT(project_path, engine) DO UPDATE SET account_id = excluded.account_id
  `).run(opts.projectPath, acct.engine, opts.accountId);
}
```

Update `createPathRule`/`updatePathRule` signatures to drop `agent`. Update `PathRule` interface to drop `agent` if it had it.

- [ ] **Step 4: Update existing callers of resolve() / createPathRule / setProjectOverride**

```bash
rg -n "\.resolve\(" electron/services/ electron/ipc/ src/
rg -n "createPathRule\(" electron/ src/
rg -n "setProjectOverride\(" electron/ src/
```

Likely callers:
- `electron/ipc/handlers.ts:resolve_account_for_project` — convert pair → wire shape (decided in Task 7).
- `electron/services/sessions/lifecycle.ts` — was reading `{ agent, account }`; now reads from the pair based on the requested agent.
- AccountSettings tests / sessions-account-resolution tests.

For now, in the consumer code, do the **minimum** to keep compilation green: have IPC handlers return the pair shape, and have lifecycle pick the right slot based on `params.agent`. UI updates land in later tasks.

- [ ] **Step 5: Run tests to verify pass + check**

```bash
npx vitest run electron/__tests__/accounts.test.ts
npm run check
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add electron/services/accounts.ts electron/__tests__/accounts.test.ts electron/services/sessions/lifecycle.ts electron/ipc/handlers.ts
git commit -m "$(cat <<'EOF'
feat(accounts): resolve() returns ResolvePair; per-engine overrides

Per-engine slots for both path-rule and explicit-override resolution. Drop agent param from createPathRule/updatePathRule (engine derived from account). setProjectOverride writes composite-key (project_path, engine).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: CodexAuthService — per-configDir

**Files:**
- Modify: `electron/services/auth/codex-auth.ts`
- Modify: `electron/__tests__/auth/codex-auth.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
describe('CodexAuthService — multi-configDir', () => {
  it('getStatus reads <configDir>/auth.json independently per account', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-auth-multi-'));
    const a = path.join(home, '.codex-a'); fs.mkdirSync(a);
    const b = path.join(home, '.codex-b'); fs.mkdirSync(b);
    fs.writeFileSync(path.join(a, 'auth.json'), JSON.stringify({ account: { email: 'a@x.com' } }));
    const svc = createCodexAuthService({ oneShotTerminal: stubOneShot(), readEnv: () => ({}) });
    expect(await svc.getStatus(a)).toMatchObject({ authenticated: true, mode: 'oauth', email: 'a@x.com' });
    expect(await svc.getStatus(b)).toMatchObject({ authenticated: false });
  });

  it('watch fires per-configDir, isolated', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-auth-watch-'));
    const a = path.join(home, '.codex-a'); fs.mkdirSync(a);
    const b = path.join(home, '.codex-b'); fs.mkdirSync(b);
    const svc = createCodexAuthService({ oneShotTerminal: stubOneShot(), readEnv: () => ({}) });
    const fired: Array<{ dir: string; status: CodexAuthStatus }> = [];
    svc.watch(a, (s) => fired.push({ dir: 'a', status: s }));
    svc.watch(b, (s) => fired.push({ dir: 'b', status: s }));
    fs.writeFileSync(path.join(a, 'auth.json'), JSON.stringify({ account: { email: 'a@x.com' } }));
    await waitFor(() => expect(fired.some((f) => f.dir === 'a' && f.status.authenticated)).toBe(true));
    // No b firing
    expect(fired.find((f) => f.dir === 'b')).toBeUndefined();
  });

  it('startLoginFlow sets CODEX_HOME=configDir on the spawn env', () => {
    const spawn = vi.fn().mockReturnValue({ ptyHandle: 'h1' });
    const svc = createCodexAuthService({
      oneShotTerminal: { spawn, write: vi.fn(), kill: vi.fn(), resize: vi.fn() } as any,
      resolveCodexBinary: () => '/usr/local/bin/codex',
      readEnv: () => ({ PATH: '/usr/local/bin' }),
    });
    void svc.startLoginFlow({ configDir: '/tmp/my-codex' });
    expect(spawn).toHaveBeenCalledWith(expect.objectContaining({
      env: expect.objectContaining({ CODEX_HOME: '/tmp/my-codex' }),
    }));
  });

  it('logout removes <configDir>/auth.json idempotently', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-auth-logout-'));
    const a = path.join(home, '.codex'); fs.mkdirSync(a);
    fs.writeFileSync(path.join(a, 'auth.json'), '{}');
    const svc = createCodexAuthService({ oneShotTerminal: stubOneShot(), readEnv: () => ({}) });
    await svc.logout(a);
    expect(fs.existsSync(path.join(a, 'auth.json'))).toBe(false);
    await svc.logout(a); // idempotent
  });
});
```

- [ ] **Step 2: Run tests to verify failure**

```bash
npx vitest run electron/__tests__/auth/codex-auth.test.ts
```

Expected: FAIL.

- [ ] **Step 3: Refactor `codex-auth.ts` to per-configDir**

Drop the closed-over `authFilePath`. All public methods accept `configDir`. The watcher Map keys on `configDir` and refcounts subscribers.

```ts
export interface CodexAuthService {
  getStatus(configDir: string): Promise<CodexAuthStatus>;
  watch(configDir: string, cb: (status: CodexAuthStatus) => void): { dispose(): void };
  startLoginFlow(opts: { configDir: string; codexBinaryPath?: string }): Promise<{ ptyHandle: string }>;
  cancelLoginFlow(ptyHandle: string): void;
  logout(configDir: string): Promise<void>;
  getBinaryPath(): string | null;
}

export function createCodexAuthService(deps: CreateCodexAuthServiceDeps): CodexAuthService {
  const readEnv = deps.readEnv ?? (() => process.env);
  const resolveCodexBinary = deps.resolveCodexBinary ?? findSystemCodexBinary;

  type WatcherSlot = {
    fsWatcher: fs.FSWatcher | null;
    subscribers: Set<(s: CodexAuthStatus) => void>;
    debounceTimer: NodeJS.Timeout | null;
  };
  const watchers = new Map<string, WatcherSlot>();

  function authFilePath(configDir: string): string {
    return path.join(configDir, 'auth.json');
  }

  async function getStatus(configDir: string): Promise<CodexAuthStatus> {
    // ... existing implementation but read from authFilePath(configDir) ...
  }

  function watch(configDir: string, cb: (s: CodexAuthStatus) => void): { dispose(): void } {
    let slot = watchers.get(configDir);
    if (!slot) {
      slot = { fsWatcher: null, subscribers: new Set(), debounceTimer: null };
      watchers.set(configDir, slot);
      attachWatcher(configDir, slot);
    }
    slot.subscribers.add(cb);
    return {
      dispose: () => {
        slot!.subscribers.delete(cb);
        if (slot!.subscribers.size === 0) {
          if (slot!.fsWatcher) { try { slot!.fsWatcher.close(); } catch {} }
          if (slot!.debounceTimer) clearTimeout(slot!.debounceTimer);
          watchers.delete(configDir);
        }
      },
    };
  }

  function attachWatcher(configDir: string, slot: WatcherSlot): void {
    // Same fs.mkdirSync + fs.watch as today's implementation, parameterized
    // on configDir. On debounced fire: getStatus(configDir) → notify all
    // subscribers in slot.subscribers.
  }

  async function startLoginFlow(opts: { configDir: string; codexBinaryPath?: string }): Promise<{ ptyHandle: string }> {
    const binary = opts.codexBinaryPath ?? resolveCodexBinary();
    if (!binary) throw new Error('codex binary not found.');
    const handle = deps.oneShotTerminal.spawn({
      binary,
      args: ['login'],
      cwd: os.homedir(),
      env: { ...readEnv(), CODEX_HOME: opts.configDir },
    });
    return { ptyHandle: handle.ptyHandle };
  }

  async function logout(configDir: string): Promise<void> {
    try { fs.unlinkSync(authFilePath(configDir)); }
    catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e.code === 'ENOENT') return;
      throw err;
    }
  }

  // cancelLoginFlow + getBinaryPath unchanged
}
```

If `OneShotTerminalService.spawn` doesn't currently accept `env`, add it (back-compat: optional, defaults to current `process.env`-inherit behavior). Search:

```bash
rg -n "spawn\(" electron/services/one-shot-terminal.ts
```

- [ ] **Step 4: Run tests + check**

```bash
npx vitest run electron/__tests__/auth/codex-auth.test.ts
npm run check
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add electron/services/auth/codex-auth.ts electron/__tests__/auth/codex-auth.test.ts electron/services/one-shot-terminal.ts
git commit -m "$(cat <<'EOF'
refactor(codex-auth): per-configDir status, watch, login, logout

All public methods accept configDir. startLoginFlow injects CODEX_HOME so the resulting auth.json lands in the account's config dir. Watcher Map refcounts subscribers per configDir.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: Codex session walker — multi-configDir

**Files:**
- Modify: `electron/services/codex-session-walker.ts`
- Modify: `electron/__tests__/codex-session-walker.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
describe('CodexSessionWalker — multi-account', () => {
  it('aggregates rollouts across every Codex account, tagged with source account id', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-walk-'));
    const a = path.join(home, '.codex-a', 'sessions', '2026', '05'); fs.mkdirSync(a, { recursive: true });
    const b = path.join(home, '.codex-b', 'sessions', '2026', '05'); fs.mkdirSync(b, { recursive: true });
    fs.writeFileSync(path.join(a, 'rollout-019.jsonl'), '{"cwd":"/proj-a"}\n');
    fs.writeFileSync(path.join(b, 'rollout-020.jsonl'), '{"cwd":"/proj-b"}\n');

    const accounts: Account[] = [
      { id: 1, engine: 'codex', config_dir: path.join(home, '.codex-a'), name: 'A', /* … */ } as any,
      { id: 2, engine: 'codex', config_dir: path.join(home, '.codex-b'), name: 'B', /* … */ } as any,
    ];
    const walker = createCodexSessionWalker({ listCodexAccounts: () => accounts });
    const sessions = await walker.listSessions();
    expect(sessions).toHaveLength(2);
    expect(sessions.find((s) => s.conversationId === '019')?.accountId).toBe(1);
    expect(sessions.find((s) => s.conversationId === '020')?.accountId).toBe(2);
  });

  it('handles a Codex account with no sessions dir yet', async () => {
    const accounts: Account[] = [{ id: 1, engine: 'codex', config_dir: '/nonexistent/.codex', name: 'A' } as any];
    const walker = createCodexSessionWalker({ listCodexAccounts: () => accounts });
    expect(await walker.listSessions()).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify failure**

```bash
npx vitest run electron/__tests__/codex-session-walker.test.ts
```

Expected: FAIL.

- [ ] **Step 3: Implement**

Refactor `createCodexSessionWalker` to take `{ listCodexAccounts: () => Account[] }` instead of hard-coding `~/.codex`. The existing per-account scan logic moves into a helper that's called once per account in `listSessions()`. Add `accountId: number` to the `CodexSessionEntry` shape.

```ts
export interface CodexSessionEntry {
  conversationId: string;
  projectPath: string | null;
  lastActivity: string;
  jsonlPath: string;
  accountId: number; // NEW
}

export function createCodexSessionWalker(deps: {
  listCodexAccounts: () => Account[];
}): CodexSessionWalker {
  return {
    async listSessions(): Promise<CodexSessionEntry[]> {
      const accounts = deps.listCodexAccounts();
      const all: CodexSessionEntry[] = [];
      for (const acct of accounts) {
        const fromAcct = await scanOneCodexConfigDir(acct.config_dir);
        all.push(...fromAcct.map((e) => ({ ...e, accountId: acct.id })));
      }
      // Sort newest-first across all accounts (today's behavior, just unified)
      return all.sort((a, b) => b.lastActivity.localeCompare(a.lastActivity));
    },
  };
}
```

In `electron/main.ts`, update the walker construction to inject `() => accountsService.listAccounts().filter((a) => a.engine === 'codex')`.

- [ ] **Step 4: Run tests + check**

```bash
npx vitest run electron/__tests__/codex-session-walker.test.ts
npm run check
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add electron/services/codex-session-walker.ts electron/__tests__/codex-session-walker.test.ts electron/main.ts
git commit -m "$(cat <<'EOF'
feat(codex): session walker aggregates across all Codex accounts

Walker takes a listCodexAccounts dep and scans each account's <config_dir>/sessions. Entries tagged with source accountId.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: IPC handler updates

**Files:**
- Modify: `electron/ipc/handlers.ts`
- Modify: `electron/__tests__/ipc-handlers.test.ts`

- [ ] **Step 1: Update / add failing handler tests**

```ts
describe('resolve_account_for_project — returns ResolvePair', () => {
  it('serializes both slots over IPC', async () => {
    const accounts = stubAccountsServiceWithBothEngines();
    const handlers = getHandlerMap({ accounts });
    const result = await invoke(handlers, 'resolve_account_for_project', { projectPath: '/proj' });
    expect(result).toMatchObject({
      claude: { account: expect.objectContaining({ engine: 'claude' }) },
      codex: { account: expect.objectContaining({ engine: 'codex' }) },
    });
  });
});

describe('codex_auth_status — takes configDir', () => {
  it('forwards configDir to the service', async () => {
    const getStatus = vi.fn().mockResolvedValue({ authenticated: true, mode: 'oauth', email: 'a@x.com' });
    const handlers = getHandlerMap({ codexAuth: { getStatus, startLoginFlow: vi.fn(), cancelLoginFlow: vi.fn(), getBinaryPath: vi.fn(), logout: vi.fn() } as any });
    await invoke(handlers, 'codex_auth_status', { configDir: '/tmp/.codex-a' });
    expect(getStatus).toHaveBeenCalledWith('/tmp/.codex-a');
  });
});

describe('create_account — engine + has_cost', () => {
  it('forwards engine and has_cost to the service', async () => {
    const createAccount = vi.fn().mockReturnValue({ id: 1 });
    const handlers = getHandlerMap({ accounts: { createAccount, listAccounts: () => [] } as any });
    await invoke(handlers, 'create_account', {
      name: 'X', configDir: '/x', engine: 'codex', subscriptionLabel: 'Plus', hasCost: true,
    });
    expect(createAccount).toHaveBeenCalledWith(expect.objectContaining({
      name: 'X', configDir: '/x', engine: 'codex', subscriptionLabel: 'Plus', hasCost: true,
    }));
  });
});
```

- [ ] **Step 2: Run to verify failure**

```bash
npx vitest run electron/__tests__/ipc-handlers.test.ts
```

Expected: FAIL.

- [ ] **Step 3: Update handlers**

In `handlers.ts`:

1. `resolve_account_for_project` — return the pair directly. Renderer interface (in `src/lib/api.ts`, Task 8) updates to match.
2. All `codex_auth_*` handlers — accept `configDir` (with snake_case adapter `data.configDir ?? data.config_dir` per CLAUDE.md handler convention).
3. `create_account` / `update_account` — accept `engine`, `subscriptionLabel`, `hasCost` (and snake_case variants) and forward to the options-object service signatures.
4. `set_project_override` — drop any `agent` param; engine is derived service-side.
5. `create_path_rule` / `update_path_rule` — drop `agent` param.
6. `codex_session_list` — unchanged signature; entries now carry `accountId` (renderer-side handling in later tasks).

- [ ] **Step 4: Run tests + check**

```bash
npx vitest run electron/__tests__/ipc-handlers.test.ts
npm run check
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add electron/ipc/handlers.ts electron/__tests__/ipc-handlers.test.ts
git commit -m "$(cat <<'EOF'
feat(ipc): handlers carry engine/has_cost/subscriptionLabel; resolve returns pair; codex_auth_* take configDir

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 8: Renderer API surface — `src/lib/api.ts`

**Files:**
- Modify: `src/lib/api.ts`

- [ ] **Step 1: Update types and method signatures**

```ts
export type AccountEngine = 'claude' | 'codex';

export interface Account {
  id: number;
  name: string;
  config_dir: string;
  engine: AccountEngine;
  subscription_label: string;
  has_cost: boolean;
  color: string | null;
  icon: string | null;
  session_defaults?: SessionDefaults;
  cli_path: string | null;
  // … existing fields
}

export interface ResolveSlot {
  account: Account;
  matchType: 'override' | 'path_rule';
  matchDetail: string;
}
export interface ResolvePair {
  claude: ResolveSlot | null;
  codex: ResolveSlot | null;
}

// api.resolveAccountForProject return type → ResolvePair
async resolveAccountForProject(projectPath: string): Promise<ResolvePair> {
  return apiCall('resolve_account_for_project', { projectPath });
}

// api.createAccount / updateAccount — options object
async createAccount(opts: {
  name: string;
  configDir: string;
  engine: AccountEngine;
  subscriptionLabel?: string;
  hasCost?: boolean;
  color?: string;
  icon?: string;
  sessionDefaults?: SessionDefaults;
  cliPath?: string | null;
}): Promise<Account> {
  return apiCall('create_account', opts);
}
// Strip undefineds per src/CLAUDE.md before forwarding

// api.codexAuthStatus / startCodexLogin / codexLogout — take configDir
async getCodexAuthStatus(configDir: string): Promise<CodexAuthStatus> {
  return apiCall('codex_auth_status', { configDir });
}
async startCodexLogin(opts: { configDir: string; codexBinaryPath?: string }): Promise<{ ptyHandle: string }> {
  return apiCall('codex_auth_start_login', opts);
}
async codexLogout(configDir: string): Promise<void> {
  return apiCall('codex_logout', { configDir });
}
```

Remove the old no-arg `getCodexAuthStatus()` if any; remove the old positional `createAccount`/`updateAccount` signatures.

- [ ] **Step 2: Run `npm run check` to discover broken consumers**

```bash
npm run check
```

Expected: FAIL — every renderer consumer of these methods now has type errors. **Do not fix them in this task.** The errors are scaffolding for Tasks 11–15 which rewrite those consumers. Move forward.

- [ ] **Step 3: Commit (with known consumer breakage)**

```bash
git add src/lib/api.ts
git commit -m "$(cat <<'EOF'
refactor(api): typed renderer API for engine-aware accounts and per-configDir codex auth

Breaking: createAccount/updateAccount now options-object; resolveAccountForProject returns ResolvePair; getCodexAuthStatus takes configDir. Consumers updated in subsequent tasks (AccountSettings, NewSessionForm, useCodexAuthStatus).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 9: Extract shared `SessionDefaultsRow` + `sessionDefaultOptions` registry

**Files:**
- Create: `src/lib/sessionDefaultOptions.ts`
- Create: `src/components/shared/SessionDefaultsRow.tsx`
- Create: `src/components/shared/__tests__/SessionDefaultsRow.test.tsx`
- Modify: `src/components/NewSessionForm.tsx` (consume the new shared component for its dropdown row)
- Modify: `src/components/__tests__/NewSessionForm.test.tsx` (interaction tests still work after the extract)

- [ ] **Step 1: Write the failing test for the shared row**

```tsx
// SessionDefaultsRow.test.tsx
describe('SessionDefaultsRow', () => {
  it('renders 4 dropdowns for claude (Model/Effort/Thinking/Permissions)', () => {
    render(<SessionDefaultsRow engine="claude" model="opus[1m]" setModel={() => {}} effort="high" setEffort={() => {}} thinkingConfig="adaptive" setThinkingConfig={() => {}} permissionMode="acceptEdits" setPermissionMode={() => {}} />);
    expect(screen.getByLabelText(/model/i)).toBeTruthy();
    expect(screen.getByLabelText(/effort/i)).toBeTruthy();
    expect(screen.getByLabelText(/thinking/i)).toBeTruthy();
    expect(screen.getByLabelText(/permissions/i)).toBeTruthy();
  });

  it('renders 3 dropdowns for codex (no Thinking)', () => {
    render(<SessionDefaultsRow engine="codex" model="gpt-5-codex" setModel={() => {}} effort="medium" setEffort={() => {}} permissionMode="workspace-edit" setPermissionMode={() => {}} />);
    expect(screen.getByLabelText(/model/i)).toBeTruthy();
    expect(screen.queryByLabelText(/thinking/i)).toBeNull();
    expect(screen.getByLabelText(/permissions/i)).toBeTruthy();
  });

  it('codex permission options are read-only / workspace-edit / full-access', async () => {
    render(<SessionDefaultsRow engine="codex" model="gpt-5-codex" setModel={() => {}} effort="medium" setEffort={() => {}} permissionMode="workspace-edit" setPermissionMode={() => {}} />);
    fireEvent.click(screen.getByLabelText(/permissions/i));
    await screen.findByText('Read-only');
    expect(screen.getByText('Workspace-edit')).toBeTruthy();
    expect(screen.getByText('Full-access')).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run to confirm failure**

```bash
npx vitest run src/components/shared/__tests__/SessionDefaultsRow.test.tsx
```

Expected: FAIL — component doesn't exist.

- [ ] **Step 3: Implement the registry**

```ts
// src/lib/sessionDefaultOptions.ts
import type { AccountEngine } from '@/lib/api';
import { MODELS } from '@/components/ModelPicker';

export interface DropdownOption { id: string; label: string; description?: string }

export const MODEL_OPTIONS: Record<AccountEngine, DropdownOption[]> = {
  claude: MODELS.map((m) => ({ id: m.id, label: m.label })),
  codex: [
    { id: 'gpt-5-codex', label: 'GPT-5 Codex' },
    { id: 'o3-codex', label: 'o3 Codex' },
    // List sourced from Codex CLI's `--models` output as of v0.75. Update when models ship.
  ],
};

export const EFFORT_OPTIONS: Record<AccountEngine, DropdownOption[]> = {
  claude: [
    { id: 'low', label: 'Low' }, { id: 'medium', label: 'Medium' }, { id: 'high', label: 'High' },
    { id: 'xhigh', label: 'Extra High' }, { id: 'max', label: 'Max' },
  ],
  codex: [
    { id: 'low', label: 'Low' }, { id: 'medium', label: 'Medium' }, { id: 'high', label: 'High' },
  ],
};

export const PERMISSION_OPTIONS: Record<AccountEngine, DropdownOption[]> = {
  claude: [
    { id: 'acceptEdits', label: 'Accept Edits', description: 'Accept file edits without prompting' },
    { id: 'plan', label: 'Plan', description: 'Plan only — no tool execution' },
    { id: 'bypassPermissions', label: 'Bypass', description: 'Allow all tools' },
    { id: 'default', label: 'Default', description: 'Prompt per tool' },
  ],
  codex: [
    { id: 'read-only', label: 'Read-only', description: 'Read files but no edits or exec' },
    { id: 'workspace-edit', label: 'Workspace-edit', description: 'Edit within workspace; exec needs approval' },
    { id: 'full-access', label: 'Full-access', description: 'No sandbox; danger mode' },
  ],
};

// Thinking only applies to Claude
export const THINKING_OPTIONS: DropdownOption[] = [
  { id: 'adaptive', label: 'Adaptive' },
  { id: 'disabled', label: 'Disabled' },
];
```

(Copy real Codex model IDs from the Phase 3 Codex engine source if more are wired up; verify with Context7 if uncertain.)

- [ ] **Step 4: Implement the component**

```tsx
// src/components/shared/SessionDefaultsRow.tsx
import type { AccountEngine } from '@/lib/api';
import { MODEL_OPTIONS, EFFORT_OPTIONS, PERMISSION_OPTIONS, THINKING_OPTIONS } from '@/lib/sessionDefaultOptions';
// Reuse DropdownTrigger / DropdownRow from NewSessionForm by exporting them
// from a shared spot first (e.g. src/components/shared/Dropdown.tsx).

export interface SessionDefaultsRowProps {
  engine: AccountEngine;
  model: string;
  setModel: (v: string) => void;
  effort: string;
  setEffort: (v: string) => void;
  thinkingConfig?: string;
  setThinkingConfig?: (v: string) => void;
  permissionMode: string;
  setPermissionMode: (v: string) => void;
  /** Optional className for the wrapping grid. */
  className?: string;
}

export const SessionDefaultsRow: React.FC<SessionDefaultsRowProps> = (props) => {
  const showThinking = props.engine === 'claude';
  // Render 3 or 4 dropdowns in a grid. Use the existing visual treatment
  // from NewSessionForm — extract DropdownTrigger/DropdownRow into shared
  // first if not already shared.
  return (
    <div className={cn('grid gap-2', showThinking ? 'grid-cols-4' : 'grid-cols-3', props.className)}>
      {/* Model dropdown using MODEL_OPTIONS[props.engine] */}
      {/* Effort dropdown using EFFORT_OPTIONS[props.engine] */}
      {showThinking && /* Thinking dropdown using THINKING_OPTIONS */}
      {/* Permissions dropdown using PERMISSION_OPTIONS[props.engine] */}
    </div>
  );
};
```

- [ ] **Step 5: Migrate NewSessionForm to consume the shared row**

Replace the inline 4-dropdown block in `NewSessionForm.tsx` with `<SessionDefaultsRow engine="claude" … />` (engine wired to the new `agent` prop in Task 13). Drop the local `MODELS`/`EFFORT_LEVELS`/`THINKING_CONFIGS`/`PERMISSION_MODES` constants if they're now duplicated in the registry, leaving the originals in `ModelPicker.tsx`/`ControlBar.tsx` where other code depends on them.

- [ ] **Step 6: Run tests + check**

```bash
npx vitest run src/components/shared/__tests__/SessionDefaultsRow.test.tsx
npx vitest run src/components/__tests__/NewSessionForm.test.tsx
npm run check
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/lib/sessionDefaultOptions.ts src/components/shared/SessionDefaultsRow.tsx src/components/shared/__tests__/SessionDefaultsRow.test.tsx src/components/NewSessionForm.tsx
git commit -m "$(cat <<'EOF'
refactor(ui): extract SessionDefaultsRow + engine-keyed sessionDefaultOptions registry

NewSessionForm consumes the new shared row. AccountDialog will reuse it next.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 10: AccountDialog component (new)

**Files:**
- Create: `src/components/AccountDialog.tsx`
- Create: `src/components/__tests__/AccountDialog.test.tsx`

- [ ] **Step 1: Write the failing tests**

```tsx
describe('AccountDialog', () => {
  it('Add mode: engine radio is enabled and toggles session defaults shape', async () => {
    render(<AccountDialog mode="add" open onClose={() => {}} onSave={() => {}} />);
    // Default engine is Claude
    expect(screen.getByLabelText(/thinking/i)).toBeTruthy();
    fireEvent.click(screen.getByRole('radio', { name: /codex/i }));
    expect(screen.queryByLabelText(/thinking/i)).toBeNull();
  });

  it('Edit mode: engine radio is disabled', () => {
    const acct = makeAccount({ engine: 'codex' });
    render(<AccountDialog mode="edit" account={acct} open onClose={() => {}} onSave={() => {}} />);
    expect(screen.getByRole('radio', { name: /codex/i }).getAttribute('aria-checked')).toBe('true');
    expect(screen.getByRole('radio', { name: /codex/i }).hasAttribute('disabled')).toBe(true);
  });

  it('Edit mode: Codex shows the sign-in row with status from useCodexAuthStatus', () => {
    const acct = makeAccount({ engine: 'codex', config_dir: '/tmp/.codex-x' });
    vi.mocked(useCodexAuthStatus).mockReturnValue({ authenticated: true, mode: 'oauth', email: 'x@y.com' });
    render(<AccountDialog mode="edit" account={acct} open onClose={() => {}} onSave={() => {}} />);
    expect(screen.getByText('x@y.com')).toBeTruthy();
    expect(screen.getByRole('button', { name: /sign out/i })).toBeTruthy();
  });

  it('save fires onSave with engine + has_cost + subscription_label + session defaults', () => {
    const onSave = vi.fn();
    render(<AccountDialog mode="add" open onClose={() => {}} onSave={onSave} />);
    fireEvent.change(screen.getByLabelText(/name/i), { target: { value: 'New' } });
    fireEvent.change(screen.getByLabelText(/config directory/i), { target: { value: '/x' } });
    fireEvent.change(screen.getByLabelText(/subscription/i), { target: { value: 'Pro' } });
    fireEvent.click(screen.getByLabelText(/has cost/i));  // toggle to off
    fireEvent.click(screen.getByRole('button', { name: /save/i }));
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({
      name: 'New', configDir: '/x', engine: 'claude', subscriptionLabel: 'Pro', hasCost: false,
    }));
  });
});
```

- [ ] **Step 2: Run to confirm failure**

```bash
npx vitest run src/components/__tests__/AccountDialog.test.tsx
```

Expected: FAIL.

- [ ] **Step 3: Implement `AccountDialog`**

```tsx
// src/components/AccountDialog.tsx
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { ColorSwatchGrid } from '@/components/ui/ColorSwatchGrid';
import { IconPicker } from '@/components/IconPicker';
import { SessionDefaultsRow } from '@/components/shared/SessionDefaultsRow';
import { useCodexAuthStatus } from '@/hooks/useCodexAuthStatus';
import { CodexSignInModal } from '@/components/codex/CodexSignInModal';
import { useState } from 'react';
import type { Account, AccountEngine, SessionDefaults } from '@/lib/api';

export interface AccountDialogSavePayload {
  name: string;
  configDir: string;
  engine: AccountEngine;
  subscriptionLabel: string;
  hasCost: boolean;
  color?: string;
  icon?: string;
  sessionDefaults?: SessionDefaults;
}

export interface AccountDialogProps {
  mode: 'add' | 'edit';
  account?: Account;            // required when mode='edit'
  open: boolean;
  onClose: () => void;
  onSave: (payload: AccountDialogSavePayload) => void;
}

export const AccountDialog: React.FC<AccountDialogProps> = ({ mode, account, open, onClose, onSave }) => {
  const [name, setName] = useState(account?.name ?? '');
  const [configDir, setConfigDir] = useState(account?.config_dir ?? '');
  const [engine, setEngine] = useState<AccountEngine>(account?.engine ?? 'claude');
  const [subscriptionLabel, setSubscriptionLabel] = useState(account?.subscription_label ?? '');
  const [hasCost, setHasCost] = useState(account?.has_cost ?? true);
  const [color, setColor] = useState(account?.color ?? '');
  const [icon, setIcon] = useState(account?.icon ?? '');
  const [model, setModel] = useState(account?.session_defaults?.model ?? '');
  const [effort, setEffort] = useState(account?.session_defaults?.effort ?? 'high');
  const [thinking, setThinking] = useState(account?.session_defaults?.thinkingConfig ?? 'adaptive');
  const [permission, setPermission] = useState(account?.session_defaults?.permissionMode ?? (engine === 'codex' ? 'workspace-edit' : 'acceptEdits'));

  const [showSignIn, setShowSignIn] = useState(false);
  const codexAuth = useCodexAuthStatus(engine === 'codex' ? configDir : null);

  // Reset Codex-specific defaults when flipping engine in Add mode
  useEffect(() => {
    if (mode !== 'add') return;
    if (engine === 'codex') {
      setThinking('adaptive');                       // hidden anyway
      setPermission('workspace-edit');
      setEffort('medium');
    } else {
      setPermission('acceptEdits');
      setEffort('high');
    }
  }, [engine, mode]);

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{mode === 'add' ? 'Add account' : 'Edit account'}</DialogTitle>
        </DialogHeader>

        {/* Name */}
        <div className="space-y-2">
          <Label htmlFor="acct-name">Name</Label>
          <Input id="acct-name" value={name} onChange={(e) => setName(e.target.value)} />
        </div>

        {/* Engine (locked on Edit) */}
        <div className="space-y-2">
          <Label>Type</Label>
          <div role="radiogroup">
            <label>
              <input type="radio" name="engine" checked={engine === 'claude'} disabled={mode === 'edit'}
                onChange={() => setEngine('claude')} aria-label="Claude" /> Claude
            </label>
            <label>
              <input type="radio" name="engine" checked={engine === 'codex'} disabled={mode === 'edit'}
                onChange={() => setEngine('codex')} aria-label="Codex" /> Codex
            </label>
          </div>
        </div>

        {/* Config directory + folder picker */}
        <div className="space-y-2">
          <Label htmlFor="acct-dir">Config directory</Label>
          <div className="flex gap-2">
            <Input id="acct-dir" value={configDir} onChange={(e) => setConfigDir(e.target.value)} />
            <Button variant="outline" onClick={async () => {
              const picked = await window.electronAPI.showOpenDialog({ properties: ['openDirectory'] });
              if (picked?.filePaths?.[0]) setConfigDir(picked.filePaths[0]);
            }}>Browse…</Button>
          </div>
        </div>

        {/* Subscription label + has-cost */}
        <div className="grid grid-cols-[1fr_auto] gap-3">
          <div className="space-y-2">
            <Label htmlFor="acct-tier">Subscription label</Label>
            <Input id="acct-tier" placeholder="Max, Plus, Personal…" value={subscriptionLabel} onChange={(e) => setSubscriptionLabel(e.target.value)} />
          </div>
          <div className="flex items-end gap-2 pb-2">
            <Checkbox id="acct-cost" checked={hasCost} onCheckedChange={(c) => setHasCost(c === true)} />
            <Label htmlFor="acct-cost">Has cost</Label>
          </div>
        </div>

        {/* Color + icon */}
        <div className="space-y-2">
          <Label>Color</Label>
          <ColorSwatchGrid value={color} onChange={setColor} />
        </div>
        <div className="space-y-2">
          <Label>Icon</Label>
          <IconPicker value={icon} onChange={setIcon} />
        </div>

        {/* Session defaults */}
        <div className="space-y-2">
          <Label>Session defaults</Label>
          <SessionDefaultsRow
            engine={engine}
            model={model} setModel={setModel}
            effort={effort} setEffort={setEffort}
            thinkingConfig={engine === 'claude' ? thinking : undefined}
            setThinkingConfig={engine === 'claude' ? setThinking : undefined}
            permissionMode={permission} setPermissionMode={setPermission}
          />
        </div>

        {/* Codex sign-in row */}
        {engine === 'codex' && mode === 'edit' && (
          <div className="space-y-2 border-t pt-3">
            <Label>Sign-in</Label>
            {codexAuth?.authenticated ? (
              <div className="flex items-center justify-between">
                <span>{codexAuth.email ?? `Signed in (${codexAuth.mode})`}</span>
                <Button variant="outline" onClick={async () => {
                  await api.codexLogout(configDir);
                }}>Sign out</Button>
              </div>
            ) : (
              <Button onClick={() => setShowSignIn(true)}>Sign in</Button>
            )}
            <p className="text-xs text-muted-foreground">
              OPENAI_API_KEY env var, if set, applies machine-wide to every Codex account.
            </p>
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={() => onSave({
            name, configDir, engine, subscriptionLabel, hasCost, color, icon,
            sessionDefaults: {
              model, effort: effort as SessionDefaults['effort'],
              thinkingConfig: engine === 'claude' ? (thinking as SessionDefaults['thinkingConfig']) : undefined,
              permissionMode: permission,
            },
          })}>Save</Button>
        </DialogFooter>

        <CodexSignInModal
          open={showSignIn}
          configDir={configDir}
          onClose={() => setShowSignIn(false)}
        />
      </DialogContent>
    </Dialog>
  );
};
```

If `CodexSignInModal` doesn't currently accept `configDir`, update it (parameterize on the prop and forward to `api.startCodexLogin({ configDir })`).

- [ ] **Step 4: Run tests + check**

```bash
npx vitest run src/components/__tests__/AccountDialog.test.tsx
npm run check
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/components/AccountDialog.tsx src/components/__tests__/AccountDialog.test.tsx src/components/codex/CodexSignInModal.tsx
git commit -m "$(cat <<'EOF'
feat(ui): AccountDialog — unified Add/Edit for Claude + Codex accounts

Engine radio locked on Edit. Session defaults row reuses shared SessionDefaultsRow. Codex sign-in row (Edit-only) uses useCodexAuthStatus + per-configDir login modal.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 11: useCodexAuthStatus per-configDir hook

**Files:**
- Modify: `src/hooks/useCodexAuthStatus.ts`
- Modify: any test files that exercise the hook (likely component tests via mocking)

- [ ] **Step 1: Update the hook signature**

```ts
// src/hooks/useCodexAuthStatus.ts
import { useState, useEffect } from 'react';
import { api, type CodexAuthStatus } from '@/lib/api';

/**
 * Reactive Codex auth status for a single account's configDir. Pass null
 * to disable (e.g. when the surrounding component conditionally renders
 * the Codex section). Subscribes to `codex-auth-status-changed:<configDir>`
 * events so the renderer re-renders on login/logout without polling.
 */
export function useCodexAuthStatus(configDir: string | null): CodexAuthStatus | null {
  const [status, setStatus] = useState<CodexAuthStatus | null>(null);

  useEffect(() => {
    if (configDir === null) { setStatus(null); return; }
    let cancelled = false;
    api.getCodexAuthStatus(configDir)
      .then((s) => { if (!cancelled) setStatus(s); })
      .catch(() => { if (!cancelled) setStatus({ authenticated: false }); });

    const off = api.onCodexAuthStatusChanged(configDir, (s) => { if (!cancelled) setStatus(s); });
    return () => { cancelled = true; off(); };
  }, [configDir]);

  return status;
}
```

If `api.onCodexAuthStatusChanged` doesn't yet take a configDir, update it (and the underlying main-process broadcast in `electron/main.ts:codexAuthService.watch(...)`) to scope the event to a configDir — emit `codex-auth-status-changed:<configDir>` per watched account.

- [ ] **Step 2: Update callers**

```bash
rg -n "useCodexAuthStatus\(" src/
```

`AccountDialog.tsx` already calls it correctly per Task 10. Any other caller (the now-removed Codex section in old AccountSettings) is covered by the AccountSettings rewrite in Task 12.

- [ ] **Step 3: Run check**

```bash
npm run check
```

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/hooks/useCodexAuthStatus.ts src/lib/api.ts electron/main.ts
git commit -m "$(cat <<'EOF'
refactor(ui): useCodexAuthStatus(configDir) — per-account status subscription

Per-configDir event channel; null configDir disables the subscription so callers can conditionally render.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 12: AccountSettings rewrite — single list, engine badges, AccountDialog launcher

**Files:**
- Modify: `src/components/AccountSettings.tsx`
- Modify: `src/components/__tests__/AccountSettings.test.tsx` (or create if absent)

- [ ] **Step 1: Update the failing tests**

```tsx
describe('AccountSettings — unified list', () => {
  it('renders both Claude and Codex accounts in one list with engine badges', async () => {
    vi.mocked(api.listAccounts).mockResolvedValue([
      makeAccount({ name: 'Personal', engine: 'claude' }),
      makeAccount({ name: 'Codex Work', engine: 'codex' }),
    ]);
    render(<AccountSettings />);
    await screen.findByText('Personal');
    expect(screen.getByText('Codex Work')).toBeTruthy();
    // Engine badge text or aria-label disambiguates
    expect(screen.getAllByText(/claude/i).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/codex/i).length).toBeGreaterThan(0);
  });

  it('"Add account" opens AccountDialog in Add mode', async () => {
    render(<AccountSettings />);
    fireEvent.click(screen.getByRole('button', { name: /add account/i }));
    expect(await screen.findByRole('dialog', { name: /add account/i })).toBeTruthy();
  });

  it('Edit pencil on a row opens AccountDialog in Edit mode with that account', async () => {
    vi.mocked(api.listAccounts).mockResolvedValue([makeAccount({ id: 1, name: 'Codex', engine: 'codex' })]);
    render(<AccountSettings />);
    await screen.findByText('Codex');
    fireEvent.click(screen.getByRole('button', { name: /edit codex/i }));
    expect(await screen.findByRole('dialog', { name: /edit account/i })).toBeTruthy();
  });

  it('"Scan for accounts" button calls runDiscovery and refreshes the list', async () => {
    vi.mocked(api.scanForConfigDirs).mockResolvedValue({ created: [{ name: 'New', engine: 'codex' }] });
    render(<AccountSettings />);
    fireEvent.click(screen.getByRole('button', { name: /scan for accounts/i }));
    await waitFor(() => expect(api.listAccounts).toHaveBeenCalledTimes(2));
  });
});
```

- [ ] **Step 2: Run to confirm failure**

Expected: FAIL.

- [ ] **Step 3: Rewrite `AccountSettings.tsx`**

Replace the existing 1000+ line component with a leaner one:

- Single list rendering both engines. Each row: AccountBadge (color + name + icon), engine pill, subscription label, edit pencil, delete button.
- "Add account" button at top → opens `AccountDialog` in Add mode.
- Edit pencil per row → opens `AccountDialog` in Edit mode with that account preloaded.
- "Scan for accounts" button (renamed from "Scan for Claude") at the bottom of the Accounts section.
- Path Rules section unchanged in shape but the dropdown of accounts now shows engine pills next to each option so users don't accidentally bind a Claude path rule to a Codex account (validation: path rule UI works the same; multiple rules for same path now allowed).
- **Remove**: the inline Add Account form (replaced by AccountDialog), the per-row inline-edit affordances, the separate Codex section at the bottom (folded into per-row sign-in in AccountDialog Edit mode).

Concretely, the file shrinks substantially. Pseudocode for the list:

```tsx
{accounts.map((acct) => (
  <div key={acct.id} className="flex items-center gap-3 py-2 border-b">
    <AccountBadge name={acct.name} color={acct.color} />
    <EnginePill engine={acct.engine} />
    <span className="text-xs text-muted-foreground">{acct.subscription_label}</span>
    {!acct.has_cost && <span className="text-xs">no cost</span>}
    <div className="flex-1" />
    <Button variant="ghost" size="sm" aria-label={`Edit ${acct.name}`}
      onClick={() => setEditAccount(acct)}>
      <Pencil className="h-3 w-3" />
    </Button>
    <Button variant="ghost" size="sm" aria-label={`Delete ${acct.name}`}
      onClick={() => handleDelete(acct.id)}>
      <Trash className="h-3 w-3" />
    </Button>
  </div>
))}
```

`<EnginePill engine="codex" />` — small new component (or inline span) with engine-colored styling so users see at a glance which kind of account each row is. Place it where the old `account_type` tier text rendered.

`api.scanForConfigDirs()` — add a renderer-side wrapper for the "manual rescan" affordance. Mirror the existing one for `scanForClaude` if there is one; just rename. The backend handler runs discovery in non-first-run mode (without the `discovery_completed` gate) and returns the list of accounts created.

- [ ] **Step 4: Run tests + check**

```bash
npx vitest run src/components/__tests__/AccountSettings.test.tsx
npm run check
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/components/AccountSettings.tsx src/components/__tests__/AccountSettings.test.tsx
git commit -m "$(cat <<'EOF'
feat(ui): AccountSettings — unified list, AccountDialog launcher, Scan for accounts

Drops the inline add form, per-row inline-edit, and separate Codex section. Engine badge on each row disambiguates Claude vs Codex.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 13: NewSessionForm consumes ResolvePair

**Files:**
- Modify: `src/components/NewSessionForm.tsx`
- Modify: `src/components/__tests__/NewSessionForm.test.tsx`

- [ ] **Step 1: Write the failing tests**

```tsx
describe('NewSessionForm — ResolvePair', () => {
  const claudeAcct = makeAccount({ id: 1, name: 'C', engine: 'claude' });
  const codexAcct = makeAccount({ id: 2, name: 'X', engine: 'codex' });
  const fullPair: ResolvePair = {
    claude: { account: claudeAcct, matchType: 'path_rule', matchDetail: '/proj' },
    codex:  { account: codexAcct,  matchType: 'path_rule', matchDetail: '/proj' },
  };

  it('flipping AgentPicker swaps the AccountBadge from claude slot to codex slot', () => {
    render(<Harness resolvePair={fullPair} />);
    expect(screen.getByText('C')).toBeTruthy(); // claude default
    fireEvent.click(screen.getByRole('radio', { name: /codex/i }));
    expect(screen.getByText('X')).toBeTruthy();
  });

  it('null slot shows "Choose account" affordance instead of AccountBadge', () => {
    const partial: ResolvePair = { claude: fullPair.claude, codex: null };
    render(<Harness resolvePair={partial} />);
    fireEvent.click(screen.getByRole('radio', { name: /codex/i }));
    expect(screen.getByRole('button', { name: /choose account/i })).toBeTruthy();
  });

  it('session defaults repopulate from the matching account when engine flips', () => {
    const c = makeAccount({ id: 1, engine: 'claude', session_defaults: { model: 'opus[1m]', permissionMode: 'plan' } });
    const x = makeAccount({ id: 2, engine: 'codex', session_defaults: { model: 'gpt-5-codex', permissionMode: 'read-only' } });
    const pair = { claude: { account: c, matchType: 'path_rule' as const, matchDetail: '/p' }, codex: { account: x, matchType: 'path_rule' as const, matchDetail: '/p' } };
    render(<Harness resolvePair={pair} />);
    // Initial: claude
    expect(screen.getByText(/opus/i)).toBeTruthy();
    fireEvent.click(screen.getByRole('radio', { name: /codex/i }));
    expect(screen.getByText(/gpt-5-codex/i)).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run to confirm failure**

Expected: FAIL.

- [ ] **Step 3: Refactor NewSessionForm**

- Replace `accountResolution: NewSessionFormAccountResolution | null` prop with `resolvePair: ResolvePair`.
- AgentPicker is always present (already true post-flag-removal).
- Effect that re-derives `accountResolution`-style display from `resolvePair[agent]`:

```ts
const activeSlot = resolvePair[agent];
const showAccountCell = activeSlot !== null;
const showChooseAccount = activeSlot === null;
```

- When `activeSlot === null`, render a "Choose account" button that opens `AccountPickerDialog` (with `engineFilter={agent}`); on selection, call `api.setProjectOverride({ projectPath, accountId })` and trigger a `resolvePair` refresh in the parent (lift state up via `onResolvePairChanged` callback or have parent re-call `resolveAccountForProject`).
- Session defaults dropdowns re-derive their starting values from `activeSlot?.account.session_defaults` whenever `agent` flips. Render via `<SessionDefaultsRow engine={agent} … />`.

- [ ] **Step 4: Update every NewSessionForm caller**

```bash
rg -n "NewSessionForm" src/
```

Likely callers: `App.tsx`, `TabContent.tsx`. Update them to pass `resolvePair` instead of `accountResolution`. App.tsx fetches via `api.resolveAccountForProject(projectPath)` already; just consume the new shape.

- [ ] **Step 5: Run tests + check**

```bash
npx vitest run src/components/__tests__/NewSessionForm.test.tsx
npm run check
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/components/NewSessionForm.tsx src/components/__tests__/NewSessionForm.test.tsx src/components/TabContent.tsx
git commit -m "$(cat <<'EOF'
feat(ui): NewSessionForm consumes ResolvePair; per-engine account derivation

AgentPicker flip swaps account + session defaults from the matching slot. Empty slot renders "Choose account" affordance that writes a per-engine override.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 14: AccountPickerDialog engineFilter prop

**Files:**
- Modify: `src/components/AccountPickerDialog.tsx`
- Modify: `src/components/__tests__/AccountPickerDialog.test.tsx` (or create if missing)

- [ ] **Step 1: Write the failing test**

```tsx
it('engineFilter=codex hides Claude accounts', () => {
  vi.mocked(api.listAccounts).mockResolvedValue([
    makeAccount({ id: 1, name: 'C', engine: 'claude' }),
    makeAccount({ id: 2, name: 'X', engine: 'codex' }),
  ]);
  render(<AccountPickerDialog open onPick={() => {}} onClose={() => {}} engineFilter="codex" />);
  // Wait for list to render
  expect(screen.queryByText('C')).toBeNull();
  expect(screen.getByText('X')).toBeTruthy();
});

it('engineFilter undefined shows both engines', () => {
  vi.mocked(api.listAccounts).mockResolvedValue([
    makeAccount({ id: 1, engine: 'claude' }),
    makeAccount({ id: 2, engine: 'codex' }),
  ]);
  render(<AccountPickerDialog open onPick={() => {}} onClose={() => {}} />);
  // Both rendered
  expect(screen.getAllByRole('button', { name: /pick/i }).length).toBe(2);
});
```

- [ ] **Step 2: Run to confirm failure**

Expected: FAIL.

- [ ] **Step 3: Add the prop**

```tsx
export interface AccountPickerDialogProps {
  open: boolean;
  onPick: (acct: Account) => void;
  onClose: () => void;
  engineFilter?: AccountEngine;
}

// Inside the component, filter listAccounts() by engineFilter when set.
const visible = engineFilter
  ? accounts.filter((a) => a.engine === engineFilter)
  : accounts;
```

- [ ] **Step 4: Run tests + check**

```bash
npx vitest run src/components/__tests__/AccountPickerDialog.test.tsx
npm run check
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/components/AccountPickerDialog.tsx src/components/__tests__/AccountPickerDialog.test.tsx
git commit -m "$(cat <<'EOF'
feat(ui): AccountPickerDialog gains engineFilter prop

Used by NewSessionForm's "Choose account" affordance to scope picks to the active engine.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 15: App.tsx project open flow

**Files:**
- Modify: `src/App.tsx`
- Modify: corresponding tests if any

- [ ] **Step 1: Update the project-open flow**

In the function that opens a project (currently calls `api.resolveAccountForProject` and routes to AccountPickerDialog vs NewSessionForm):

```ts
const pair = await api.resolveAccountForProject(projectPath);
if (pair.claude === null && pair.codex === null) {
  // Both slots empty — pick any account; engine derived from pick.
  openAccountPicker({ projectPath, engineFilter: undefined, onPick: (acct) => {
    void api.setProjectOverride({ projectPath, accountId: acct.id });
    openNewSession({ projectPath, agent: acct.engine, /* re-fetched pair */ });
  } });
  return;
}
// One or both slots filled — default agent = claude if available else codex
const defaultAgent: AgentKind = pair.claude ? 'claude' : 'codex';
openNewSession({ projectPath, agent: defaultAgent, resolvePair: pair });
```

- [ ] **Step 2: Run check**

```bash
npm run check
```

Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/App.tsx
git commit -m "$(cat <<'EOF'
feat(ui): App project-open flow branches on ResolvePair shape

Both-null → AccountPickerDialog with no filter; one-or-both filled → NewSessionForm with the pair, default agent = claude when present.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 16: Full verification + CHANGELOG

**Files:**
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Run the full verification gate**

```bash
npm run check && npm run build && npm run test:coverage
```

Expected: PASS. If coverage dips below 80% on a touched file, add targeted tests for the gap before continuing.

- [ ] **Step 2: Manual smoke (renderer)**

```bash
npm start
```

Walk through:
1. Settings → Accounts. Both Claude and Codex accounts appear in one list with engine badges.
2. Click "Add account" — dialog opens. Toggle Engine radio between Claude and Codex; observe session-defaults row drops Thinking on Codex.
3. Create a Codex account. Click Edit pencil. Engine radio is disabled. Sign-in row shows.
4. Click Sign in → CodexSignInModal opens with `CODEX_HOME=<account.config_dir>` set in the spawn env; `~/.codex-<slug>/auth.json` lands after OAuth.
5. Path rules: create a rule pointing at the new Codex account on a project path that already has a Claude rule. Open that project. Agent picker visible; flipping engines swaps accounts.
6. Session list: open a project that has Codex sessions across two Codex accounts. Confirm rows appear with the per-account badge column.
7. Logout the Codex account; confirm `auth.json` is gone and the dialog re-renders to "Sign in" state without restart.

- [ ] **Step 3: Rebuild Electron ABI for the next `npm start`**

```bash
npm run rebuild:electron
```

- [ ] **Step 4: Add CHANGELOG entry**

```markdown
## [Unreleased]

### Added

- **Codex accounts are first-class.** Multi-account Codex via `CODEX_HOME`; sign-in is per-account. Accounts list, Add/Edit dialog, path rules, and project overrides all support both engines.
- **Unified Add/Edit dialog (`AccountDialog`).** One form for Claude and Codex accounts. Engine radio (locked on Edit). Subscription label is free text. New `has_cost` checkbox replaces the implicit "max = free" inference. Session defaults row branches on engine (Claude: Model/Effort/Thinking/Permissions; Codex: Model/Effort/Permissions).
- **Combined account discovery.** First-run scan and the renamed "Scan for accounts" button now find both `~/.claude*` and `~/.codex*` config dirs and create engine-tagged account rows. `discovery_completed` flag still gates re-runs.

### Changed

- **`account_type` → `subscription_label` + `has_cost`** (migration v11). Existing rows backfilled (`'max'` → `subscription_label='Max'`, `has_cost=false`; others capitalized with `has_cost=true`).
- **Path rules drop the `agent` column** (migration v11). Engine is derived from `account.engine`. Multiple rules per path_prefix supported — one Claude rule and one Codex rule on the same path is the new normal. Orphan Codex rules (Phase 3 `account_id=null` rows) backfilled to the auto-discovered Codex account; orphans without a Codex account to bind to are dropped (warned in the console at migration time).
- **`project_account_overrides` composite-keyed by `(project_path, engine)`** so a single project can override both engines independently.
- **`AccountsService.resolve()` returns `ResolvePair = { claude, codex }`** instead of a single result. Per-engine resolution: override → longest-prefix path rule → null. New-session form consumes the pair; AgentPicker flip swaps the account and session defaults from the matching slot. Null slot renders a "Choose account" affordance.
- **`CodexAuthService` is per-configDir.** All methods take `configDir`; watchers keyed by configDir; `startLoginFlow` injects `CODEX_HOME` so the resulting auth file lands in the account's dir.
- **`CodexSessionWalker` aggregates across all Codex accounts.** Session list rows tagged with source account id; per-account badge column appears when more than one Codex account exists.

### Notes

- `OPENAI_API_KEY` remains machine-wide — if set, every Codex account reads as authenticated in API-key mode. Called out in the AccountDialog hint text.
- Engine is immutable post-create. Switching engines = delete + recreate the account.
- Per-project "last used engine" memory is not in v1. When both slots are filled, Claude is the default. Cheap follow-up if users want it.
```

- [ ] **Step 5: Commit**

```bash
git add CHANGELOG.md
git commit -m "$(cat <<'EOF'
docs(changelog): codex account parity — unified dialog, multi-account, ResolvePair

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Self-Review

**Spec coverage** (checked section-by-section against `2026-05-27-codex-account-parity-design.md`):

- §1 Schema migration → Task 1 ✓ (incl. in-migration Codex discovery, accounts columns, path-rules rebuild, overrides composite-key)
- §2 Account discovery → Task 3 ✓
- §3 Unified Add/Edit dialog → Tasks 9 (shared row) + 10 (dialog itself) ✓
- §4 Path rule resolver → Task 4 ✓
- §5 New-session flow + project open → Tasks 13 (NewSessionForm) + 14 (AccountPickerDialog filter) + 15 (App.tsx) ✓
- §6 CodexAuthService rework → Task 5 ✓
- §7 Codex session walker → Task 6 ✓
- §8 Backward compat → covered across Tasks 1 (migration + in-migration discovery), 2 (default `engine='claude'` for old callers), 11 (useCodexAuthStatus signature), 12 (AccountSettings removes old Codex section) ✓
- §9 Testing → each task includes test steps; aggregate coverage validated in Task 16 ✓

**Placeholder scan**: every code step contains real code or specific instructions (file paths, command outputs, line-level guidance for boilerplate). No "TBD" / "TODO" / "implement appropriately". The few places that say "follow existing pattern X" reference a concrete file or function name.

**Type consistency**:
- `AccountEngine` ('claude' | 'codex') — same name across Tasks 2, 3, 4, 8, 10, 14.
- `ResolvePair` — defined in Task 4, consumed in Tasks 8, 13, 15.
- `ResolveSlot` — Task 4, surfaced through API in Task 8.
- `CreateAccountOptions` — Task 2, threaded through Tasks 7 (IPC) and 8 (renderer API).
- `useCodexAuthStatus(configDir: string | null)` — Task 11 matches AccountDialog's `configDir` prop in Task 10.

**Scope check**: single coherent change. Ships as one PR (Greg's pattern for refactors is single PR per coordinated change; tasks 1-16 are commits within the same branch). Does not split into independent shippable sub-projects.

---

## Execution Handoff

**Plan complete and saved to `docs/superpowers/plans/2026-05-27-codex-account-parity.md`. Two execution options:**

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints

**Which approach?**
