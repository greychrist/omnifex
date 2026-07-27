# Account Email Verification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Record an expected email on each Claude account and warn — at session start and in Settings — when the config dir is actually authenticated as somebody else (or nobody).

**Architecture:** A nullable `expected_email` column on `accounts`. A new `electron/services/account-identity.ts` exposes two operations with deliberately different costs: an instant `<configDir>/.claude.json` read (hot path, used at session start) and a `claude auth status --json` spawn (used only behind an explicit Settings button). `lifecycle.start()` runs the cheap check before spawning and emits `session-account-mismatch:<tabId>`; `runtime.ts` re-checks against the CLI's own `system:init` account payload for rich-mode sessions. Warnings never block a session.

**Tech Stack:** Electron main process (Node 20, TypeScript), `better-sqlite3`, Vitest, React 18 + Tailwind v4 renderer, Radix/shadcn primitives.

**Spec:** `docs/superpowers/specs/2026-07-27-account-email-verification-design.md`

## Global Constraints

- **TDD is mandatory.** Write the failing test, run it, watch it fail, then implement. Every task below is ordered that way.
- **Do NOT run `git commit`.** Repo rule (root `CLAUDE.md`): "Use `/commit` only when the user explicitly asks for a commit." Each task ends with a verification run, not a commit. Greg commits when he's ready.
- **After any vitest run, run `npm run rebuild:electron`** before the app is launched — the pretest hook rebuilds `better-sqlite3` against Node's ABI and Electron needs its own.
- **Every new invoke channel must be added to `INVOKE_CHANNELS` in `electron/ipc/channels.ts`.** The preload allow-list is built from that array (`electron/preload.ts:12`), and `ipc-channel-contract.test.ts` asserts every channel has a registered handler. A channel without a handler fails that test; a handler without a channel entry silently rejects at the preload boundary.
- **Event channels need no allow-list change** — `session-` is already in `EVENT_CHANNEL_PREFIXES` (`electron/ipc/channels.ts:229`).
- **Strip `undefined` optional params before crossing IPC** (`src/CLAUDE.md`). The main process does not distinguish `undefined` from missing.
- **Handler adapters accept camelCase and snake_case**: `data.configDir ?? data.config_dir`.
- **Email comparison is `.trim().toLowerCase()` on both sides.** No Gmail dot-stripping, no plus-address folding.
- **Renderer components call `src/lib/api.ts`**, never `window.electronAPI.invoke` directly.
- **Never touch account resolution order.** It stays override → longest path rule → null. This feature only observes.
- Verification gate for this work (cross-cutting): `npm run check`, `npm run build`, `npm run test:coverage`.

## File Structure

**Create:**
- `electron/services/account-identity.ts` — the two detection operations. No DB access, no Electron imports; pure Node + injected binary resolver, so it is trivially testable.
- `electron/__tests__/account-identity.test.ts` — unit tests for the above.
- `src/hooks/useAccountIdentity.ts` — renderer hook wrapping the cheap read, modeled on `src/hooks/useCodexAuthStatus.ts`.
- `src/components/AccountMismatchBanner.tsx` — the dismissible session-header warning.
- `src/components/__tests__/AccountMismatchBanner.test.tsx`

**Modify:**
- `electron/services/database.ts` — migration v17 (array currently ends at v16, `database.ts:451`).
- `electron/services/accounts.ts` — `Account`/`AccountRow`/`CreateAccountOptions`/`UpdateAccountOptions`/`rowToAccount`/`createAccount`/`updateAccount`, plus a new `getAccountByConfigDir`.
- `electron/services/sessions/lifecycle.ts` — pre-flight check in `start()` (~`:137`) and `startTuiColdStart()` (`:672`); new factory param.
- `electron/services/sessions/runtime.ts` — `RuntimeDeps` gains `accountMismatchSink`; the `case 'init'` block (`:148`) calls it.
- `electron/ipc/channels.ts` — two invoke channels.
- `electron/ipc/handlers.ts` — the `accountIdentity` adapter interface + handler entries.
- `electron/main.ts` — construct the service, wire the adapter, pass the sinks into `createSessionsService`.
- `electron/services/first-run-discovery.ts` — prefill `expectedEmail` on discovered Claude accounts.
- `src/lib/api.ts` — `Account.expected_email`, `AccountIdentity`/`AuthStatus` types, two wrapper methods.
- `src/components/AccountDialog.tsx` — Email field + Detect button; `AccountDialogSavePayload.expectedEmail`.
- `src/components/AccountSettings.tsx` — mismatch badge on the account row; pass `expectedEmail` through save.
- `src/components/AgentSession.tsx` — subscribe to the mismatch event, render the banner.
- `docs/session-lifecycle.md` — document the check and the TUI limitation.

---

### Task 1: `expected_email` column and accounts-service round-trip

**Files:**
- Modify: `electron/services/database.ts` (append after the v16 migration object, `database.ts:451`)
- Modify: `electron/services/accounts.ts:14-70` (interfaces), `:161-176` (`AccountRow`), `:209-228` (`rowToAccount`), `:263-287` (`createAccount`), `:289-340` (`updateAccount`)
- Test: `electron/__tests__/accounts.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `Account.expected_email: string | null`
  - `CreateAccountOptions.expectedEmail?: string | null`
  - `UpdateAccountOptions.expectedEmail?: string | null` (`undefined` preserves, `null` clears, string sets)
  - `AccountsService.getAccountByConfigDir(configDir: string): Account | null`

- [ ] **Step 1: Write the failing tests**

Append to `electron/__tests__/accounts.test.ts` (follow the existing `createDatabase(':memory:')` setup in that file):

```ts
describe('expected_email', () => {
  it('defaults to null on a freshly created account', () => {
    const acct = accounts.createAccount({ name: 'personal', configDir: '/tmp/.claude-personal' });
    expect(acct.expected_email).toBeNull();
  });

  it('round-trips expectedEmail through createAccount', () => {
    const acct = accounts.createAccount({
      name: 'personal',
      configDir: '/tmp/.claude-personal',
      expectedEmail: 'gpchristie@gmail.com',
    });
    expect(acct.expected_email).toBe('gpchristie@gmail.com');
  });

  it('updateAccount sets, preserves on undefined, and clears on null', () => {
    const acct = accounts.createAccount({
      name: 'personal',
      configDir: '/tmp/.claude-personal',
      expectedEmail: 'a@example.com',
    });
    const base = { name: 'personal', configDir: '/tmp/.claude-personal' };

    accounts.updateAccount(acct.id, { ...base, expectedEmail: 'b@example.com' });
    expect(accounts.listAccounts()[0].expected_email).toBe('b@example.com');

    // undefined preserves
    accounts.updateAccount(acct.id, { ...base });
    expect(accounts.listAccounts()[0].expected_email).toBe('b@example.com');

    // null clears
    accounts.updateAccount(acct.id, { ...base, expectedEmail: null });
    expect(accounts.listAccounts()[0].expected_email).toBeNull();
  });

  it('getAccountByConfigDir finds an account by normalized path and returns null otherwise', () => {
    accounts.createAccount({ name: 'personal', configDir: '/tmp/.claude-personal' });
    expect(accounts.getAccountByConfigDir('/tmp/.claude-personal')?.name).toBe('personal');
    expect(accounts.getAccountByConfigDir('/tmp/.claude-personal/')?.name).toBe('personal');
    expect(accounts.getAccountByConfigDir('/tmp/.claude-nope')).toBeNull();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run electron/__tests__/accounts.test.ts -t expected_email`
Expected: FAIL — `expected_email` is not a property on the returned object (`undefined`, not `null`), and `getAccountByConfigDir is not a function`.

- [ ] **Step 3: Add migration v17**

In `electron/services/database.ts`, append to the `migrations` array after the v16 object. Match the existing guarded-`ALTER` style used by v1/v2/v3:

```ts
  {
    version: 17,
    description:
      'Add expected_email to accounts — the address the user asserts this ' +
      'config dir should be logged in as. Nullable; null means "do not check". ' +
      'Compared at session start against the identity actually authenticated ' +
      'in the config dir. See docs/superpowers/specs/2026-07-27-account-email-verification-design.md',
    up: (db) => {
      const cols = db.pragma('table_info(accounts)') as { name: string }[];
      if (!cols.some((c) => c.name === 'expected_email')) {
        db.exec('ALTER TABLE accounts ADD COLUMN expected_email TEXT');
      }
    },
  },
```

- [ ] **Step 4: Thread the column through the accounts service**

In `electron/services/accounts.ts`:

Add to `interface Account` (after `cli_path`, `:36`):
```ts
  /**
   * The email the user asserts this config dir should be authenticated as.
   * Null means "don't check" — the session-start verification is skipped
   * entirely and does no I/O. Set from Settings, prefilled by discovery.
   */
  expected_email: string | null;
```

Add to `CreateAccountOptions` and `UpdateAccountOptions`:
```ts
  /** undefined preserves the current value, null clears it, string sets it. */
  expectedEmail?: string | null;
```

Add to `interface AccountRow` (`:161`):
```ts
  expected_email: string | null;
```

Add to `rowToAccount` (`:209`), after `cli_path`:
```ts
    expected_email: row.expected_email ?? null,
```

In `createAccount` (`:263`), extend the INSERT — column list, one more `?`, one more bound value:
```ts
        `INSERT INTO accounts
           (name, config_dir, engine, subscription_label, has_cost, color, icon, session_defaults, cli_path, expected_email)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
```
```ts
        opts.cliPath ?? null,
        opts.expectedEmail ?? null,
```

In `updateAccount` (`:289`), both branches use `COALESCE` so `undefined` preserves — the same trick already used for `subscription_label`. Add to each `SET` clause:
```sql
               expected_email = CASE WHEN ? = 1 THEN ? ELSE expected_email END,
```
and bind, in order, immediately after the existing `cli_path` binding:
```ts
        opts.expectedEmail === undefined ? 0 : 1,
        opts.expectedEmail ?? null,
```
(A plain `COALESCE(?, expected_email)` cannot distinguish "clear it" from "leave it" — both arrive as SQL NULL. The explicit `CASE` flag is why this differs from the `subscription_label` handling.)

Add `getAccountByConfigDir` beside `listAccounts` (`:256`), reusing the file's existing `normalizePath` helper (`:235`):
```ts
  function getAccountByConfigDir(configDir: string): Account | null {
    if (!configDir) return null;
    const target = normalizePath(configDir);
    const rows = raw.prepare('SELECT * FROM accounts').all() as AccountRow[];
    const match = rows.find((r) => normalizePath(r.config_dir) === target);
    return match ? rowToAccount(match) : null;
  }
```
Add `getAccountByConfigDir` to the `AccountsService` interface and to the returned object.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run electron/__tests__/accounts.test.ts`
Expected: PASS — the new block plus every pre-existing accounts test.

- [ ] **Step 6: Typecheck**

Run: `npm run check`
Expected: clean. If `rowToAccount` or a test fixture elsewhere constructs an `Account` literal, TypeScript will flag the missing `expected_email` — add `expected_email: null` to those fixtures.

---

### Task 2: `account-identity` service

**Files:**
- Create: `electron/services/account-identity.ts`
- Test: `electron/__tests__/account-identity.test.ts`

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces:
  - `readOauthIdentity(configDir: string): OauthIdentity | null`
  - `probeAuthStatus(configDir: string, deps: ProbeDeps): AuthStatus`
  - `emailsMatch(a: string | null | undefined, b: string | null | undefined): boolean`
  - `interface OauthIdentity { email: string | null; displayName: string | null; organizationName: string | null; organizationType: string | null }`
  - `interface AuthStatus { loggedIn: boolean; email: string | null; authMethod: string | null; apiProvider: string | null; orgName: string | null; subscriptionType: string | null }`
  - `interface ProbeDeps { resolveBinary: () => string | null; exec?: (bin: string, args: string[], env: NodeJS.ProcessEnv) => string }`

- [ ] **Step 1: Write the failing tests**

Create `electron/__tests__/account-identity.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  readOauthIdentity,
  probeAuthStatus,
  emailsMatch,
} from '../services/account-identity';

function tmpConfigDir(contents?: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'omnifex-identity-'));
  if (contents !== undefined) {
    fs.writeFileSync(path.join(dir, '.claude.json'), contents, 'utf8');
  }
  return dir;
}

describe('readOauthIdentity', () => {
  it('extracts the oauth identity from <configDir>/.claude.json', () => {
    const dir = tmpConfigDir(JSON.stringify({
      numStartups: 5,
      oauthAccount: {
        emailAddress: 'gpchristie@gmail.com',
        displayName: 'Greg',
        organizationName: "gpchristie@gmail.com's Organization",
        organizationType: 'claude_max',
      },
    }));
    expect(readOauthIdentity(dir)).toEqual({
      email: 'gpchristie@gmail.com',
      displayName: 'Greg',
      organizationName: "gpchristie@gmail.com's Organization",
      organizationType: 'claude_max',
    });
  });

  it('returns null when the file is missing', () => {
    expect(readOauthIdentity(tmpConfigDir())).toBeNull();
  });

  it('returns null when the file is malformed JSON instead of throwing', () => {
    expect(readOauthIdentity(tmpConfigDir('{ not json'))).toBeNull();
  });

  it('returns null when the file has no oauthAccount key (logged out)', () => {
    expect(readOauthIdentity(tmpConfigDir(JSON.stringify({ numStartups: 5 })))).toBeNull();
  });

  it('returns null for a nonexistent directory', () => {
    expect(readOauthIdentity('/tmp/omnifex-does-not-exist-xyz')).toBeNull();
  });
});

describe('probeAuthStatus', () => {
  const LOGGED_IN = JSON.stringify({
    loggedIn: true,
    authMethod: 'claude.ai',
    apiProvider: 'firstParty',
    email: 'gpchristie@gmail.com',
    orgId: '1f46',
    orgName: "gpchristie@gmail.com's Organization",
    subscriptionType: 'max',
  });

  it('parses the CLI JSON and passes CLAUDE_CONFIG_DIR through', () => {
    let seenEnv: NodeJS.ProcessEnv | null = null;
    let seenArgs: string[] = [];
    const status = probeAuthStatus('/tmp/.claude-personal', {
      resolveBinary: () => '/usr/local/bin/claude',
      exec: (_bin, args, env) => { seenArgs = args; seenEnv = env; return LOGGED_IN; },
    });
    expect(seenArgs).toEqual(['auth', 'status', '--json']);
    expect(seenEnv?.CLAUDE_CONFIG_DIR).toBe('/tmp/.claude-personal');
    expect(status).toEqual({
      loggedIn: true,
      email: 'gpchristie@gmail.com',
      authMethod: 'claude.ai',
      apiProvider: 'firstParty',
      orgName: "gpchristie@gmail.com's Organization",
      subscriptionType: 'max',
    });
  });

  it('reports logged out when the CLI says so', () => {
    const status = probeAuthStatus('/tmp/x', {
      resolveBinary: () => '/usr/local/bin/claude',
      exec: () => JSON.stringify({ loggedIn: false }),
    });
    expect(status.loggedIn).toBe(false);
    expect(status.email).toBeNull();
  });

  it('reports logged out rather than throwing on non-JSON stdout', () => {
    const status = probeAuthStatus('/tmp/x', {
      resolveBinary: () => '/usr/local/bin/claude',
      exec: () => 'command not found',
    });
    expect(status.loggedIn).toBe(false);
  });

  it('reports logged out rather than throwing when the spawn fails', () => {
    const status = probeAuthStatus('/tmp/x', {
      resolveBinary: () => '/usr/local/bin/claude',
      exec: () => { throw new Error('ENOENT'); },
    });
    expect(status.loggedIn).toBe(false);
  });

  it('reports logged out when no binary can be resolved', () => {
    const status = probeAuthStatus('/tmp/x', { resolveBinary: () => null });
    expect(status.loggedIn).toBe(false);
  });
});

describe('emailsMatch', () => {
  it('is case-insensitive and trims', () => {
    expect(emailsMatch('  Greg@Example.COM ', 'greg@example.com')).toBe(true);
  });

  it('does not fold gmail dots or plus-addresses', () => {
    expect(emailsMatch('g.p@gmail.com', 'gp@gmail.com')).toBe(false);
    expect(emailsMatch('gp+work@gmail.com', 'gp@gmail.com')).toBe(false);
  });

  it('treats null/undefined/empty as non-matching', () => {
    expect(emailsMatch(null, 'a@b.c')).toBe(false);
    expect(emailsMatch('a@b.c', undefined)).toBe(false);
    expect(emailsMatch('', '')).toBe(false);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run electron/__tests__/account-identity.test.ts`
Expected: FAIL — `Cannot find module '../services/account-identity'`.

- [ ] **Step 3: Implement the service**

Create `electron/services/account-identity.ts`:

```ts
// Account identity — "who is actually logged in to this config dir?"
//
// Two operations, deliberately different costs:
//
//   readOauthIdentity  — reads <configDir>/.claude.json. Instant, no spawn.
//                        This is the HOT PATH: it runs on session start.
//   probeAuthStatus    — spawns `claude auth status --json`. Authoritative
//                        (~1s). Only ever runs behind an explicit user action
//                        in Settings. Never on session start.
//
// `oauthAccount` lingers in .claude.json after a logout, so the cheap read
// detects the wrong-account case reliably but the logged-out case only
// sometimes. That's why the Settings surface offers the probe: it is the
// CLI's own answer, and it distinguishes logged-out from stale.
//
// No Electron imports and no DB access — the callers inject everything, so
// this module is directly unit-testable.

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

export interface OauthIdentity {
  email: string | null;
  displayName: string | null;
  organizationName: string | null;
  organizationType: string | null;
}

export interface AuthStatus {
  loggedIn: boolean;
  email: string | null;
  authMethod: string | null;
  apiProvider: string | null;
  orgName: string | null;
  subscriptionType: string | null;
}

export interface ProbeDeps {
  /** Resolves the `claude` binary. Null when none can be found. */
  resolveBinary: () => string | null;
  /** Injectable for tests. Defaults to execFileSync with a 10s timeout. */
  exec?: (bin: string, args: string[], env: NodeJS.ProcessEnv) => string;
}

const LOGGED_OUT: AuthStatus = {
  loggedIn: false,
  email: null,
  authMethod: null,
  apiProvider: null,
  orgName: null,
  subscriptionType: null,
};

function str(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

/**
 * Read the OAuth identity cached in `<configDir>/.claude.json`. Returns null
 * for every failure shape — missing dir, missing file, malformed JSON, or a
 * file with no `oauthAccount` (which is what a logged-out dir looks like on a
 * fresh install). Never throws: this runs on the session-start path and must
 * not be able to break a launch.
 */
export function readOauthIdentity(configDir: string): OauthIdentity | null {
  if (!configDir) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(path.join(configDir, '.claude.json'), 'utf8'));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const acct = (parsed as Record<string, unknown>).oauthAccount;
  if (!acct || typeof acct !== 'object') return null;
  const a = acct as Record<string, unknown>;
  return {
    email: str(a.emailAddress),
    displayName: str(a.displayName),
    organizationName: str(a.organizationName),
    organizationType: str(a.organizationType),
  };
}

/**
 * Ask the CLI directly. `claude auth status --json` honors CLAUDE_CONFIG_DIR,
 * so this reports the identity for exactly the dir we pass. Costs a spawn —
 * callers must keep it off hot paths.
 */
export function probeAuthStatus(configDir: string, deps: ProbeDeps): AuthStatus {
  const bin = deps.resolveBinary();
  if (!bin) return LOGGED_OUT;

  const run =
    deps.exec ??
    ((b: string, args: string[], env: NodeJS.ProcessEnv): string =>
      execFileSync(b, args, { encoding: 'utf8', timeout: 10_000, env }));

  let out: string;
  try {
    out = run(bin, ['auth', 'status', '--json'], {
      ...process.env,
      CLAUDE_CONFIG_DIR: configDir,
    });
  } catch {
    return LOGGED_OUT;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(out);
  } catch {
    return LOGGED_OUT;
  }
  if (!parsed || typeof parsed !== 'object') return LOGGED_OUT;

  const p = parsed as Record<string, unknown>;
  return {
    loggedIn: p.loggedIn === true,
    email: str(p.email),
    authMethod: str(p.authMethod),
    apiProvider: str(p.apiProvider),
    orgName: str(p.orgName),
    subscriptionType: str(p.subscriptionType),
  };
}

/**
 * Trimmed, case-insensitive comparison. Deliberately does NOT normalize Gmail
 * dots or plus-addressing: two addresses the user considers distinct must not
 * silently compare equal, or the check stops being a check.
 */
export function emailsMatch(
  a: string | null | undefined,
  b: string | null | undefined,
): boolean {
  const na = (a ?? '').trim().toLowerCase();
  const nb = (b ?? '').trim().toLowerCase();
  if (!na || !nb) return false;
  return na === nb;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run electron/__tests__/account-identity.test.ts`
Expected: PASS, all 15 cases.

- [ ] **Step 5: Confirm coverage on the new module**

Run: `npx vitest run electron/__tests__/account-identity.test.ts --coverage.enabled --coverage.include='electron/services/account-identity.ts'`
Expected: ≥80% lines (CLAUDE.md backend gate). If a branch is uncovered, add the case — don't lower the bar.

---

### Task 3: IPC surface for the two operations

**Files:**
- Modify: `electron/ipc/channels.ts` (Accounts block, `:13-22`)
- Modify: `electron/ipc/handlers.ts` (adapter interface near `codexAuth`, `:222`; handler map near `accounts_validate_cli_path`, `:582`)
- Modify: `electron/main.ts` (service construction + adapter wiring)
- Modify: `src/lib/api.ts` (`Account` interface `:94`, new types, two wrappers near `sessionAccountInfo` `:1242`)
- Test: `electron/__tests__/ipc-channel-contract.test.ts` (existing — it should pass unchanged once both sides are added)

**Interfaces:**
- Consumes: `readOauthIdentity`, `probeAuthStatus`, `AuthStatus`, `OauthIdentity` (Task 2); `Account.expected_email` (Task 1).
- Produces:
  - Channels `account_identity_read`, `account_identity_probe`
  - `api.readAccountIdentity(configDir: string): Promise<OauthIdentity | null>`
  - `api.probeAccountAuthStatus(configDir: string): Promise<AuthStatus>`

- [ ] **Step 1: Write the failing test**

Add to `electron/__tests__/ipc-channel-contract.test.ts` (the file already walks `INVOKE_CHANNELS` against the handler map; this asserts the two new names specifically so a half-wired change fails loudly):

```ts
it('exposes the account-identity channels with registered handlers', () => {
  for (const ch of ['account_identity_read', 'account_identity_probe']) {
    expect(INVOKE_CHANNELS).toContain(ch);
    expect(Object.keys(handlerMap)).toContain(ch);
  }
});
```

Use whatever the file already names the handler-map fixture; do not introduce a second way of building it.

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run electron/__tests__/ipc-channel-contract.test.ts`
Expected: FAIL — `expected [ … ] to contain 'account_identity_read'`.

- [ ] **Step 3: Add the channels**

In `electron/ipc/channels.ts`, in the `// Accounts` block:

```ts
  'accounts_validate_cli_path',
  // Account identity — who is actually logged in to a config dir.
  // `_read` is the cheap .claude.json read; `_probe` spawns the CLI.
  'account_identity_read',
  'account_identity_probe',
```

- [ ] **Step 4: Add the adapter interface and handlers**

In `electron/ipc/handlers.ts`, add to the deps interface beside `codexAuth` (`:222`):

```ts
  accountIdentity?: {
    read(configDir: string): import('../services/account-identity').OauthIdentity | null;
    probe(configDir: string): import('../services/account-identity').AuthStatus;
  };
```

Add to the handler map beside `accounts_validate_cli_path` (`:582`):

```ts
    account_identity_read: wrapWith((p: Record<string, unknown>) =>
      accountIdentity?.read((p?.configDir ?? p?.config_dir) as string) ?? null,
    ),
    account_identity_probe: wrapWith((p: Record<string, unknown>) =>
      accountIdentity?.probe((p?.configDir ?? p?.config_dir) as string) ?? null,
    ),
```

- [ ] **Step 5: Wire it in main.ts**

In `electron/main.ts`, import and pass the adapter into `registerIpcHandlers(...)`. `claudeBinaryService` already exists there and resolves the user's configured binary:

```ts
    accountIdentity: {
      read: (configDir: string) => readOauthIdentity(configDir),
      probe: (configDir: string) =>
        probeAuthStatus(configDir, {
          resolveBinary: () => claudeBinaryService.getPath(),
        }),
    },
```

Import at the top: `import { readOauthIdentity, probeAuthStatus } from './services/account-identity';`

- [ ] **Step 6: Add the renderer types and wrappers**

In `src/lib/api.ts`, add `expected_email` to `Account` (after `cli_path`, `:115`):

```ts
  /**
   * The email this config dir is expected to be authenticated as. Null means
   * no verification is performed for this account.
   */
  expected_email: string | null;
```

Add the two result types near `SessionAccountInfo` (`:747`):

```ts
/** Identity cached in `<configDir>/.claude.json`. Cheap; may be stale after a logout. */
export interface AccountIdentity {
  email: string | null;
  displayName: string | null;
  organizationName: string | null;
  organizationType: string | null;
}

/** The CLI's own answer from `claude auth status --json`. Authoritative; costs a spawn. */
export interface AccountAuthStatus {
  loggedIn: boolean;
  email: string | null;
  authMethod: string | null;
  apiProvider: string | null;
  orgName: string | null;
  subscriptionType: string | null;
}
```

Add the wrappers beside `sessionAccountInfo` (`:1242`):

```ts
  async readAccountIdentity(configDir: string): Promise<AccountIdentity | null> {
    return apiCall("account_identity_read", { configDir });
  },

  async probeAccountAuthStatus(configDir: string): Promise<AccountAuthStatus | null> {
    return apiCall("account_identity_probe", { configDir });
  },
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `npx vitest run electron/__tests__/ipc-channel-contract.test.ts && npm run check`
Expected: PASS and a clean typecheck.

---

### Task 4: Pre-flight check at session start

**Files:**
- Modify: `electron/services/sessions/lifecycle.ts:63-105` (factory params), `:137` (after re-resolution, before the TUI branch), `:672` (`startTuiColdStart`)
- Modify: `electron/main.ts` (pass the new argument to `createSessionsService`)
- Test: `electron/__tests__/sessions-account-resolution.test.ts`

**Interfaces:**
- Consumes: `emailsMatch`, `readOauthIdentity` (Task 2); `getAccountByConfigDir` (Task 1).
- Produces:
  - `createSessionsService(..., verifyAccountIdentity?: ((configDir: string) => AccountMismatch | null) | null)` — a new trailing optional parameter after `modelCatalogSink`.
  - `interface AccountMismatch { expected: string; detected: string | null; configDir: string; source: 'oauth-file' | 'session-init' }` — exported from `electron/services/sessions/types.ts`.
  - Event `session-account-mismatch:<tabId>` carrying an `AccountMismatch`.

The verifier is injected as a single closure rather than passing the accounts service into sessions, so `lifecycle.ts` gains no DB dependency and the tests can drive it directly.

- [ ] **Step 1: Write the failing tests**

Add to `electron/__tests__/sessions-account-resolution.test.ts`, matching the existing harness in that file (it already constructs the service with a `sendToRenderer` spy):

```ts
describe('session-start account verification', () => {
  it('emits session-account-mismatch and STILL starts the session', async () => {
    const sent: Array<[string, unknown]> = [];
    const verify = vi.fn(() => ({
      expected: 'work@example.com',
      detected: 'personal@example.com',
      configDir: '/tmp/.claude-personal',
      source: 'oauth-file' as const,
    }));
    const svc = createSessionsService(
      (ch, ...args) => { sent.push([ch, args[0]]); },
      {}, null, null, null, null, null, null, null, verify,
    );

    await svc.start({
      tabId: 'tab1',
      projectPath: '/tmp/proj',
      configDir: '/tmp/.claude-personal',
      mode: 'tui',
    } as never);

    expect(sent.find(([ch]) => ch === 'session-account-mismatch:tab1')?.[1]).toEqual({
      expected: 'work@example.com',
      detected: 'personal@example.com',
      configDir: '/tmp/.claude-personal',
      source: 'oauth-file',
    });
    // The session is not gated on the warning.
    expect(svc.isActive('tab1')).toBe(true);
  });

  it('emits nothing when the verifier reports a match', async () => {
    const sent: string[] = [];
    const svc = createSessionsService(
      (ch) => { sent.push(ch); },
      {}, null, null, null, null, null, null, null, () => null,
    );
    await svc.start({
      tabId: 'tab2', projectPath: '/tmp/proj', configDir: '/tmp/.claude-personal', mode: 'tui',
    } as never);
    expect(sent.some((ch) => ch.startsWith('session-account-mismatch:'))).toBe(false);
  });

  it('does no verification work at all when no verifier is injected', async () => {
    const sent: string[] = [];
    const svc = createSessionsService((ch) => { sent.push(ch); }, {});
    await svc.start({
      tabId: 'tab3', projectPath: '/tmp/proj', configDir: '/tmp/.claude-personal', mode: 'tui',
    } as never);
    expect(sent.some((ch) => ch.startsWith('session-account-mismatch:'))).toBe(false);
  });

  it('verifies against the RE-RESOLVED configDir, not the one the renderer sent', async () => {
    const seen: string[] = [];
    const svc = createSessionsService(
      () => {}, {}, null, null, null, null, null,
      () => '/tmp/.claude-work',            // resolveAccountConfigDir
      null,
      (dir) => { seen.push(dir); return null; },
    );
    await svc.start({
      tabId: 'tab4', projectPath: '/tmp/proj', configDir: '/tmp/.claude-personal', mode: 'tui',
    } as never);
    expect(seen).toEqual(['/tmp/.claude-work']);
  });
});
```

The last case is the one that matters most: `start()` re-resolves the config dir at launch (`lifecycle.ts:118-135`), so verifying the renderer-supplied value would check the wrong account exactly when a path rule just changed.

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run electron/__tests__/sessions-account-resolution.test.ts -t 'account verification'`
Expected: FAIL — no `session-account-mismatch:` event is ever emitted.

- [ ] **Step 3: Add the type**

In `electron/services/sessions/types.ts`, beside the other CLI payload shapes:

```ts
/**
 * Result of comparing an account's `expected_email` against the identity
 * actually authenticated in its config dir. `detected: null` means nobody is
 * logged in — treated as a mismatch, since that's the same failure class.
 */
export interface AccountMismatch {
  expected: string;
  detected: string | null;
  configDir: string;
  /** Which check produced this: the cheap pre-flight file read, or the
   *  authoritative `system:init` payload from the running CLI. */
  source: 'oauth-file' | 'session-init';
}
```

- [ ] **Step 4: Add the parameter and the pre-flight call**

In `electron/services/sessions/lifecycle.ts`, add a trailing parameter after `modelCatalogSink`:

```ts
  /**
   * Optional identity verifier. Given the resolved configDir, returns an
   * AccountMismatch when the account's expected_email disagrees with whoever
   * is actually authenticated there, or null when it matches / no expectation
   * is set. Injected as a closure so lifecycle keeps no DB dependency.
   *
   * Must be cheap — this runs on every cold start. main.ts wires it to the
   * .claude.json read, never to a CLI spawn.
   */
  verifyAccountIdentity: ((configDir: string) => AccountMismatch | null) | null = null,
```

In `start()`, immediately after the re-resolution block closes (`lifecycle.ts:137`) and **before** the `if (params.mode === 'tui')` branch — so both modes are covered by one call site:

```ts
    // Secondary confirmation: is this config dir actually logged in as the
    // account we think it is? Runs against the RE-RESOLVED configDir, and
    // never blocks — the session starts either way. See
    // docs/superpowers/specs/2026-07-27-account-email-verification-design.md
    if (verifyAccountIdentity && configDir) {
      try {
        const mismatch = verifyAccountIdentity(configDir);
        if (mismatch) {
          sendToRenderer(`session-account-mismatch:${tabId}`, mismatch);
          logging?.writeBatch([{
            timestamp: new Date().toISOString(),
            level: 'warn',
            source: 'backend',
            category: `session:${tabId}`,
            message:
              `account identity mismatch: expected=${mismatch.expected} ` +
              `detected=${mismatch.detected ?? '(not signed in)'} configDir=${configDir}`,
          }]);
        }
      } catch (err) {
        console.error('[sessions] account identity verification failed:', err);
      }
    }
```

Because this sits above the `mode === 'tui'` branch, `startTuiColdStart` needs no separate call — verify that by reading `lifecycle.ts:137-141` before assuming it. If the TUI branch is reachable by another path that bypasses `start()`, add the same block at the top of `startTuiColdStart` (`:672`) guarded so it can't double-fire for one launch.

Import `AccountMismatch` from `./types`.

- [ ] **Step 5: Wire it in main.ts**

Pass as the last argument to `createSessionsService`:

```ts
  (configDir: string) => {
    const account = accountsService.getAccountByConfigDir(configDir);
    const expected = account?.expected_email;
    if (!expected) return null;              // opt-in: no expectation, no I/O
    const identity = readOauthIdentity(configDir);
    if (emailsMatch(expected, identity?.email)) return null;
    return {
      expected,
      detected: identity?.email ?? null,
      configDir,
      source: 'oauth-file' as const,
    };
  },
```

Import `emailsMatch` alongside `readOauthIdentity`.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run electron/__tests__/sessions-account-resolution.test.ts`
Expected: PASS — the new block plus every pre-existing resolution test.

- [ ] **Step 7: Run the whole session suite for regressions**

Run: `npx vitest run electron/__tests__/sessions-*.test.ts`
Expected: PASS. The new trailing parameter defaults to `null`, so every existing bare construction keeps working — if something fails here, an argument-position mistake in a fixture is the first thing to check.

---

### Task 5: Post-init confirmation for rich-mode sessions

**Files:**
- Modify: `electron/services/sessions/runtime.ts:25-54` (`RuntimeDeps`), `:143-158` (the `case 'init'` block)
- Modify: `electron/services/sessions/lifecycle.ts` (pass the sink into `runtimeDeps`, `:93-100`)
- Modify: `electron/main.ts` (extend the injected verifier to take an optional observed email)
- Test: `electron/__tests__/sessions-runtime.test.ts`

**Interfaces:**
- Consumes: `AccountMismatch` (Task 4).
- Produces: `RuntimeDeps.accountMismatchSink?: ((configDir: string, observedEmail: string | null) => AccountMismatch | null) | null`

The `system:init` payload is the identity of the process actually doing the work — strictly better evidence than a file that can be stale. This is the belt to the pre-flight's braces.

- [ ] **Step 1: Write the failing test**

Add to `electron/__tests__/sessions-runtime.test.ts`, using the existing fake-engine harness in that file:

```ts
it('re-checks account identity against the system:init payload and emits with source=session-init', async () => {
  const sent: Array<[string, unknown]> = [];
  const engine = createFakeEngine({
    initData: { account: { email: 'personal@example.com' }, models: [] },
  });
  const sink = vi.fn(() => ({
    expected: 'work@example.com',
    detected: 'personal@example.com',
    configDir: '/tmp/.claude-work',
    source: 'session-init' as const,
  }));

  await runEngineLoop(handleFor(engine, { tabId: 'tab1', configDir: '/tmp/.claude-work' }), 'tab1', {
    ...baseDeps,
    sendToRenderer: (ch, ...args) => { sent.push([ch, args[0]]); },
    accountMismatchSink: sink,
  });

  engine.emitMessage({ type: 'system', subtype: 'init' });

  expect(sink).toHaveBeenCalledWith('/tmp/.claude-work', 'personal@example.com');
  expect(sent.find(([ch]) => ch === 'session-account-mismatch:tab1')?.[1]).toMatchObject({
    source: 'session-init',
  });
});

it('emits nothing on init when the sink reports a match', async () => {
  const sent: string[] = [];
  const engine = createFakeEngine({
    initData: { account: { email: 'work@example.com' }, models: [] },
  });
  await runEngineLoop(handleFor(engine, { tabId: 'tab2', configDir: '/tmp/.claude-work' }), 'tab2', {
    ...baseDeps,
    sendToRenderer: (ch) => { sent.push(ch); },
    accountMismatchSink: () => null,
  });
  engine.emitMessage({ type: 'system', subtype: 'init' });
  expect(sent.some((ch) => ch.startsWith('session-account-mismatch:'))).toBe(false);
});
```

Adapt the harness names (`createFakeEngine`, `runEngineLoop`, `baseDeps`) to whatever `sessions-runtime.test.ts` already uses — read the top of that file first and reuse it rather than adding a parallel harness.

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run electron/__tests__/sessions-runtime.test.ts -t 'system:init payload'`
Expected: FAIL — the sink is never called.

- [ ] **Step 3: Extend RuntimeDeps**

In `electron/services/sessions/runtime.ts`, add to `RuntimeDeps` (beside `modelCatalogSink`, `:53`):

```ts
  /**
   * Optional identity re-check against the CLI's own init payload. Called with
   * (configDir, observedEmail) when `system:init` carries an account block.
   * Returns a mismatch to report, or null. Stronger evidence than the
   * pre-flight file read — this is the identity of the running process.
   */
  accountMismatchSink?:
    | ((configDir: string, observedEmail: string | null) => AccountMismatch | null)
    | null;
```

- [ ] **Step 4: Call it from the init handler**

In the `case 'init'` block, after the existing `modelCatalogSink` write-through (`runtime.ts:156`) and inside the same block:

```ts
          if (deps.accountMismatchSink) {
            const acct = handle.initData?.account as { email?: unknown } | undefined;
            const observed = typeof acct?.email === 'string' ? acct.email : null;
            try {
              const mismatch = deps.accountMismatchSink(handle.configDir, observed);
              if (mismatch) sendToRenderer(`session-account-mismatch:${tabId}`, mismatch);
            } catch (err) {
              console.error('[sessions] account mismatch re-check failed:', err);
            }
          }
```

Import `AccountMismatch` from `./types`.

- [ ] **Step 5: Thread it through lifecycle**

In `lifecycle.ts`, add to the `runtimeDeps` object literal (`:93-100`):

```ts
    accountMismatchSink,
```

and add the matching factory parameter after `verifyAccountIdentity`:

```ts
  accountMismatchSink:
    | ((configDir: string, observedEmail: string | null) => AccountMismatch | null)
    | null = null,
```

- [ ] **Step 6: Wire it in main.ts**

Pass as the final argument to `createSessionsService`. Note this compares against the **observed** email, not the file:

```ts
  (configDir: string, observedEmail: string | null) => {
    const account = accountsService.getAccountByConfigDir(configDir);
    const expected = account?.expected_email;
    if (!expected || observedEmail === null) return null;
    if (emailsMatch(expected, observedEmail)) return null;
    return { expected, detected: observedEmail, configDir, source: 'session-init' as const };
  },
```

`observedEmail === null` returns null deliberately: an init payload with no account block is missing evidence, not evidence of absence, and the pre-flight check already covered the logged-out case.

- [ ] **Step 7: Run the tests to verify they pass**

Run: `npx vitest run electron/__tests__/sessions-runtime.test.ts && npx vitest run electron/__tests__/sessions-*.test.ts`
Expected: PASS.

---

### Task 6: Email field and Detect button in the account dialog

**Files:**
- Modify: `src/components/AccountDialog.tsx:25-34` (payload), `:89` (state), `:104-137` (seed effect), `:154-173` (`handleSave`), `:283` (field placement)
- Modify: `src/components/AccountSettings.tsx` (pass `expectedEmail` through to create/update)
- Test: `src/components/__tests__/AccountDialog.test.tsx`

**Interfaces:**
- Consumes: `api.probeAccountAuthStatus` (Task 3); `Account.expected_email` (Task 1).
- Produces: `AccountDialogSavePayload.expectedEmail: string | null`

- [ ] **Step 1: Write the failing tests**

Add to `src/components/__tests__/AccountDialog.test.tsx` (the file already has an edit-mode + codex block at `:114` — follow its render helper):

```ts
it('edit mode seeds the email field from account.expected_email', () => {
  renderDialog({ mode: 'edit', account: { ...baseAccount, expected_email: 'a@example.com' } });
  expect(screen.getByLabelText(/email/i)).toHaveValue('a@example.com');
});

it('saves the typed email as expectedEmail', async () => {
  const onSave = vi.fn();
  renderDialog({ mode: 'edit', account: baseAccount, onSave });
  await userEvent.clear(screen.getByLabelText(/email/i));
  await userEvent.type(screen.getByLabelText(/email/i), 'b@example.com');
  await userEvent.click(screen.getByRole('button', { name: /save/i }));
  expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ expectedEmail: 'b@example.com' }));
});

it('saves null when the field is emptied, so the check is turned off', async () => {
  const onSave = vi.fn();
  renderDialog({ mode: 'edit', account: { ...baseAccount, expected_email: 'a@example.com' }, onSave });
  await userEvent.clear(screen.getByLabelText(/email/i));
  await userEvent.click(screen.getByRole('button', { name: /save/i }));
  expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ expectedEmail: null }));
});

it('Detect fills the field from the CLI probe', async () => {
  vi.spyOn(api, 'probeAccountAuthStatus').mockResolvedValue({
    loggedIn: true, email: 'detected@example.com', authMethod: 'claude.ai',
    apiProvider: 'firstParty', orgName: 'Org', subscriptionType: 'max',
  });
  renderDialog({ mode: 'edit', account: baseAccount });
  await userEvent.click(screen.getByRole('button', { name: /detect/i }));
  await waitFor(() => expect(screen.getByLabelText(/email/i)).toHaveValue('detected@example.com'));
});

it('does not render the email field for codex accounts', () => {
  renderDialog({ mode: 'edit', account: { ...baseAccount, engine: 'codex' } });
  expect(screen.queryByLabelText(/email/i)).toBeNull();
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run src/components/__tests__/AccountDialog.test.tsx`
Expected: FAIL — `Unable to find a label with the text of: /email/i`.

- [ ] **Step 3: Implement the field**

In `src/components/AccountDialog.tsx`:

Extend the payload (`:25`):
```ts
  /** Expected login email. null turns the session-start check off. */
  expectedEmail: string | null;
```

Add state beside `subscriptionLabel` (`:89`):
```ts
  const [expectedEmail, setExpectedEmail] = useState("");
  const [detecting, setDetecting] = useState(false);
  const [detectError, setDetectError] = useState<string | null>(null);
```

Seed it in both branches of the open-effect (`:104-137`): `setExpectedEmail(account.expected_email ?? "")` in the edit branch, `setExpectedEmail("")` in the add branch.

Add to `handleSave` (`:155`):
```ts
      expectedEmail: expectedEmail.trim() || null,
```

Add the Detect handler:
```ts
  const handleDetect = (): void => {
    if (!configDir) return;
    setDetecting(true);
    setDetectError(null);
    void api
      .probeAccountAuthStatus(configDir)
      .then((status) => {
        if (status?.email) setExpectedEmail(status.email);
        else setDetectError("No signed-in account found in this config dir.");
      })
      .catch(() => { setDetectError("Couldn't reach the Claude CLI."); })
      .finally(() => { setDetecting(false); });
  };
```

Render the field next to the subscription-label input (`:283`), Claude-only. Match the surrounding markup's label/input/spacing classes rather than inventing new ones:

```tsx
{engine === "claude" && (
  <div className="space-y-1.5">
    <label htmlFor="account-email" className="text-sm text-foreground/70">
      Email
    </label>
    <div className="flex gap-2">
      <Input
        id="account-email"
        value={expectedEmail}
        onChange={(e) => { setExpectedEmail(e.target.value); }}
        placeholder="you@example.com"
        autoComplete="off"
        spellCheck={false}
      />
      <Button
        type="button"
        variant="outline"
        onClick={handleDetect}
        disabled={detecting || !configDir}
      >
        {detecting ? "Detecting…" : "Detect"}
      </Button>
    </div>
    <p className="text-xs text-foreground/50">
      {detectError ??
        "Sessions warn if this config dir is signed in as someone else. Leave blank to skip the check."}
    </p>
  </div>
)}
```

- [ ] **Step 4: Pass it through AccountSettings**

In `src/components/AccountSettings.tsx`, the save handler that consumes `AccountDialogSavePayload` must forward `expectedEmail` into both `api.createAccount` and `api.updateAccount`. Per `src/CLAUDE.md`, strip `undefined` before it crosses IPC — `expectedEmail` is `string | null` here, never `undefined`, so pass it straight through.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run src/components/__tests__/AccountDialog.test.tsx`
Expected: PASS. Existing AccountDialog tests must still pass — if a fixture `Account` literal now fails typecheck, add `expected_email: null`.

- [ ] **Step 6: Typecheck and build**

Run: `npm run check && npm run build`
Expected: clean.

---

### Task 7: Mismatch badge on the Settings account row

**Files:**
- Create: `src/hooks/useAccountIdentity.ts`
- Modify: `src/components/AccountSettings.tsx` (account row rendering)
- Test: `src/components/__tests__/AccountSettings.test.tsx`

**Interfaces:**
- Consumes: `api.readAccountIdentity` (Task 3); `Account.expected_email` (Task 1).
- Produces: `useAccountIdentity(configDir: string | null): { identity: AccountIdentity | null; loaded: boolean }`

The `loaded` flag is load-bearing, not decoration: without it, the pre-resolution state (`identity === null`) is indistinguishable from "nobody is signed in", and every Settings open would flash an amber "Not signed in" badge before the read completes.

- [ ] **Step 1: Write the failing tests**

Add to `src/components/__tests__/AccountSettings.test.tsx`:

```ts
it('shows a mismatch badge when the detected email differs from expected', async () => {
  vi.spyOn(api, 'readAccountIdentity').mockResolvedValue({
    email: 'personal@example.com', displayName: 'Greg',
    organizationName: 'Org', organizationType: 'claude_max',
  });
  renderSettings({ accounts: [{ ...baseAccount, expected_email: 'work@example.com' }] });
  expect(await screen.findByText(/signed in as personal@example\.com/i)).toBeInTheDocument();
});

it('shows no badge when expected and detected agree', async () => {
  vi.spyOn(api, 'readAccountIdentity').mockResolvedValue({
    email: 'work@example.com', displayName: null,
    organizationName: null, organizationType: null,
  });
  renderSettings({ accounts: [{ ...baseAccount, expected_email: 'work@example.com' }] });
  await waitFor(() => { expect(api.readAccountIdentity).toHaveBeenCalled(); });
  expect(screen.queryByText(/signed in as/i)).toBeNull();
});

it('shows a not-signed-in badge when no identity can be read', async () => {
  vi.spyOn(api, 'readAccountIdentity').mockResolvedValue(null);
  renderSettings({ accounts: [{ ...baseAccount, expected_email: 'work@example.com' }] });
  expect(await screen.findByText(/not signed in/i)).toBeInTheDocument();
});

it('shows no badge before the identity read resolves', () => {
  // Never-resolving promise: this is the pre-load state.
  vi.spyOn(api, 'readAccountIdentity').mockReturnValue(new Promise(() => {}));
  renderSettings({ accounts: [{ ...baseAccount, expected_email: 'work@example.com' }] });
  expect(screen.queryByText(/not signed in/i)).toBeNull();
  expect(screen.queryByText(/signed in as/i)).toBeNull();
});

it('never reads identity for an account with no expected_email', async () => {
  const spy = vi.spyOn(api, 'readAccountIdentity');
  renderSettings({ accounts: [{ ...baseAccount, expected_email: null }] });
  await waitFor(() => { expect(screen.getByText(baseAccount.name)).toBeInTheDocument(); });
  expect(spy).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run src/components/__tests__/AccountSettings.test.tsx`
Expected: FAIL — no badge text is rendered.

- [ ] **Step 3: Write the hook**

Create `src/hooks/useAccountIdentity.ts`, modeled on `src/hooks/useCodexAuthStatus.ts:20-55`:

```ts
import { useEffect, useState } from "react";
import { api, type AccountIdentity } from "@/lib/api";

/**
 * The identity cached in `<configDir>/.claude.json`, or null when the dir has
 * no signed-in account. Pass `null` to disable — callers do that for accounts
 * with no `expected_email`, so Settings performs zero I/O for accounts that
 * haven't opted into verification.
 *
 * Deliberately uses the cheap read, not `probeAccountAuthStatus`: opening
 * Settings with N accounts must not spawn N CLIs.
 */
export function useAccountIdentity(configDir: string | null): {
  identity: AccountIdentity | null;
  loaded: boolean;
} {
  const [state, setState] = useState<{ identity: AccountIdentity | null; loaded: boolean }>({
    identity: null,
    loaded: false,
  });

  useEffect(() => {
    if (configDir === null) {
      setState({ identity: null, loaded: false });
      return;
    }
    let cancelled = false;
    setState({ identity: null, loaded: false });
    api
      .readAccountIdentity(configDir)
      .then((next) => { if (!cancelled) setState({ identity: next, loaded: true }); })
      // A failed read is indistinguishable from "not signed in" from the UI's
      // point of view, and both warrant the same badge — so mark it loaded.
      .catch(() => { if (!cancelled) setState({ identity: null, loaded: true }); });
    return () => { cancelled = true; };
  }, [configDir]);

  return state;
}
```

- [ ] **Step 4: Render the badge**

In `src/components/AccountSettings.tsx`, inside the per-account row component (if the row is inline JSX rather than its own component, extract it — a hook cannot be called inside a `.map()` callback):

```tsx
const { identity, loaded } = useAccountIdentity(
  account.expected_email ? account.config_dir : null,
);
const detected = identity?.email ?? null;
const expected = account.expected_email;
// `loaded` gates the whole thing — an unresolved read must not render as
// "not signed in".
const mismatch =
  loaded &&
  !!expected &&
  (detected === null ||
    detected.trim().toLowerCase() !== expected.trim().toLowerCase());
```

Then, where the row's secondary metadata renders:

```tsx
{mismatch && (
  <span className="text-xs text-amber-500">
    {detected ? `Signed in as ${detected}` : "Not signed in"}
  </span>
)}
```

Note on styling: per the `border-color-utilities-dead` finding, unlayered `* { border-color }` in `styles.css:338` overrides Tailwind border-color utilities app-wide. Use text/background color for this badge, not a border color, or it will silently render wrong.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run src/components/__tests__/AccountSettings.test.tsx`
Expected: PASS.

---

### Task 8: Session-header mismatch banner

**Files:**
- Create: `src/components/AccountMismatchBanner.tsx`
- Create: `src/components/__tests__/AccountMismatchBanner.test.tsx`
- Modify: `src/components/AgentSession.tsx` (subscribe to the event, render the banner, clear on session reset near `:1800`)

**Interfaces:**
- Consumes: the `session-account-mismatch:<tabId>` event (Tasks 4 and 5).
- Produces: `<AccountMismatchBanner mismatch={…} onDismiss={…} />`

- [ ] **Step 1: Write the failing tests**

Create `src/components/__tests__/AccountMismatchBanner.test.tsx`:

```tsx
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi } from 'vitest';
import { AccountMismatchBanner } from '../AccountMismatchBanner';

const MISMATCH = {
  expected: 'work@example.com',
  detected: 'personal@example.com',
  configDir: '/tmp/.claude-personal',
  source: 'oauth-file' as const,
};

describe('AccountMismatchBanner', () => {
  it('names both the expected and the detected account', () => {
    render(<AccountMismatchBanner mismatch={MISMATCH} onDismiss={() => {}} />);
    expect(screen.getByText(/work@example\.com/)).toBeInTheDocument();
    expect(screen.getByText(/personal@example\.com/)).toBeInTheDocument();
  });

  it('says "not signed in" when nothing was detected', () => {
    render(
      <AccountMismatchBanner mismatch={{ ...MISMATCH, detected: null }} onDismiss={() => {}} />,
    );
    expect(screen.getByText(/not signed in/i)).toBeInTheDocument();
  });

  it('calls onDismiss when dismissed', async () => {
    const onDismiss = vi.fn();
    render(<AccountMismatchBanner mismatch={MISMATCH} onDismiss={onDismiss} />);
    await userEvent.click(screen.getByRole('button', { name: /dismiss/i }));
    expect(onDismiss).toHaveBeenCalled();
  });

  it('renders nothing when there is no mismatch', () => {
    const { container } = render(<AccountMismatchBanner mismatch={null} onDismiss={() => {}} />);
    expect(container).toBeEmptyDOMElement();
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run src/components/__tests__/AccountMismatchBanner.test.tsx`
Expected: FAIL — `Cannot find module '../AccountMismatchBanner'`.

- [ ] **Step 3: Implement the banner**

Create `src/components/AccountMismatchBanner.tsx`:

```tsx
import React from "react";
import { AlertTriangle, X } from "lucide-react";

export interface AccountMismatch {
  expected: string;
  detected: string | null;
  configDir: string;
  source: "oauth-file" | "session-init";
}

export interface AccountMismatchBannerProps {
  mismatch: AccountMismatch | null;
  onDismiss: () => void;
}

/**
 * Non-blocking warning shown when a session's config dir is authenticated as
 * somebody other than the account's recorded email. Deliberately informational
 * — the session already started. See
 * docs/superpowers/specs/2026-07-27-account-email-verification-design.md
 */
export const AccountMismatchBanner: React.FC<AccountMismatchBannerProps> = ({
  mismatch,
  onDismiss,
}) => {
  if (!mismatch) return null;
  return (
    <div className="flex items-start gap-2 px-3 py-2 text-xs bg-amber-500/10 text-amber-600 dark:text-amber-400">
      <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" aria-hidden />
      <div className="flex-1">
        This session expects <span className="font-mono">{mismatch.expected}</span>, but{" "}
        <span className="font-mono">{mismatch.configDir}</span> is{" "}
        {mismatch.detected ? (
          <>signed in as <span className="font-mono">{mismatch.detected}</span></>
        ) : (
          <>not signed in</>
        )}
        .
      </div>
      <button
        type="button"
        aria-label="Dismiss"
        onClick={onDismiss}
        className="shrink-0 opacity-60 hover:opacity-100"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );
};
```

- [ ] **Step 4: Subscribe in AgentSession**

In `src/components/AgentSession.tsx`, add state and a subscription alongside the existing `session-*` subscriptions:

```tsx
const [accountMismatch, setAccountMismatch] = useState<AccountMismatch | null>(null);

useEffect(() => {
  const unsub = window.electronAPI.onEvent(
    `session-account-mismatch:${tabId}`,
    (payload) => { setAccountMismatch(payload as AccountMismatch); },
  );
  return unsub;
}, [tabId]);
```

Clear it wherever the session resets — the same place `setSdkAccountInfo(null)` is called (`AgentSession.tsx:1800`) — so a stale warning can't outlive the session that produced it:

```tsx
setAccountMismatch(null);
```

Render `<AccountMismatchBanner mismatch={accountMismatch} onDismiss={() => { setAccountMismatch(null); }} />` directly under the session header.

Note: `AgentSession.tsx` uses `TabContent` inline closures; per the `tabcontent-callback-loop` finding, do not add a new callback prop dependency to a `useEffect` here — the `onDismiss` above is a local closure over `setAccountMismatch` only, which is safe.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run src/components/__tests__/AccountMismatchBanner.test.tsx && npm run check && npm run build`
Expected: PASS and clean.

---

### Task 9: Discovery prefill, docs, and full verification

**Files:**
- Modify: `electron/services/first-run-discovery.ts:67-73` (the create loop)
- Modify: `docs/session-lifecycle.md`
- Test: `electron/__tests__/first-run-discovery.test.ts`

**Interfaces:**
- Consumes: `readOauthIdentity` (Task 2); `CreateAccountOptions.expectedEmail` (Task 1).
- Produces: nothing downstream.

- [ ] **Step 1: Write the failing test**

Add to `electron/__tests__/first-run-discovery.test.ts`, using the injected-`discover` harness already in that file:

```ts
it('prefills expectedEmail for discovered Claude accounts', async () => {
  const created: unknown[] = [];
  await runFirstTimeDiscovery({
    accounts: {
      listAccounts: () => [],
      createAccount: (opts) => { created.push(opts); return {} as never; },
    },
    db: { getSetting: () => null, saveSetting: () => {} },
    discover: async () => [
      { dirName: '.claude-personal', configDir: '/tmp/.claude-personal', engine: 'claude' },
    ],
    readIdentity: () => ({
      email: 'gpchristie@gmail.com', displayName: 'Greg',
      organizationName: null, organizationType: null,
    }),
  });
  expect(created[0]).toMatchObject({ expectedEmail: 'gpchristie@gmail.com' });
});

it('leaves expectedEmail unset when no identity can be read', async () => {
  const created: Array<Record<string, unknown>> = [];
  await runFirstTimeDiscovery({
    accounts: {
      listAccounts: () => [],
      createAccount: (opts) => { created.push(opts as never); return {} as never; },
    },
    db: { getSetting: () => null, saveSetting: () => {} },
    discover: async () => [
      { dirName: '.codex', configDir: '/tmp/.codex', engine: 'codex' },
    ],
    readIdentity: () => null,
  });
  expect(created[0].expectedEmail ?? null).toBeNull();
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run electron/__tests__/first-run-discovery.test.ts`
Expected: FAIL — `expectedEmail` is absent from the created options.

- [ ] **Step 3: Implement the prefill**

In `electron/services/first-run-discovery.ts`, add to `FirstTimeDiscoveryDeps`:

```ts
  /**
   * Reads the OAuth identity for a config dir so discovered accounts get their
   * expected email prefilled — the verification feature then works without the
   * user typing anything. Injectable for tests; main passes readOauthIdentity.
   */
  readIdentity?: (configDir: string) => { email: string | null } | null;
```

In the create loop (`:68-73`):

```ts
  for (const { dirName, configDir, engine } of found) {
    const name = nameFromConfigDir(dirName, engine);
    // Claude only — Codex identity lives in ~/.codex/auth.json and is already
    // surfaced by codexAuth.getStatus.
    const expectedEmail =
      engine === 'claude' ? (deps.readIdentity?.(configDir)?.email ?? null) : null;
    deps.accounts.createAccount({ name, configDir, engine, expectedEmail });
    created.push({ name, configDir, engine });
  }
```

In `electron/main.ts`, pass `readIdentity: readOauthIdentity` where `runFirstTimeDiscovery` is called.

- [ ] **Step 4: Document the behavior and its limit**

Add a section to `docs/session-lifecycle.md`:

```markdown
## Account identity verification

An account may carry an `expected_email`. When set, session start performs a
secondary confirmation that the resolved config dir is actually authenticated
as that address. Null means no check and no I/O.

Two checks, both non-blocking — the session starts regardless:

1. **Pre-flight** (`lifecycle.start()`, both rich and TUI modes) — reads
   `<configDir>/.claude.json` → `oauthAccount.emailAddress`. Runs against the
   *re-resolved* config dir, not the one the renderer supplied. No CLI spawn.
2. **Post-init** (`runtime.ts`, rich mode only) — compares against the
   `account.email` in the CLI's own `system:init` payload. Stronger evidence:
   it is the identity of the process actually running the session.

Both emit `session-account-mismatch:<tabId>` with
`{ expected, detected, configDir, source }`. `detected: null` means nobody is
signed in, which is treated as a mismatch.

**Known limitation:** TUI-mode sessions get only check 1, because TUI mode
produces no init data (`getInitData()` returns null). A `.claude.json` that has
gone stale relative to the live credential state will therefore not be caught in
TUI mode. `claude auth status --json` is the authoritative answer and is
available in Settings behind the **Detect** button; it is never run on the
session-start path because it costs a process spawn.
```

- [ ] **Step 5: Run the full verification gate**

```bash
npm run check
npm run build
npm run test:coverage
```
Expected: typecheck clean, build succeeds, all tests pass, and `electron/services/account-identity.ts` at ≥80% line coverage.

- [ ] **Step 6: Restore the Electron ABI**

Run: `npm run rebuild:electron`
Expected: success. The vitest run rebuilt `better-sqlite3` against Node's ABI; without this the app won't start.

- [ ] **Step 7: Manual smoke check**

```bash
npm start
```
1. Settings → Accounts → edit a Claude account. The Email field shows the discovered address. Press **Detect** — it should repopulate with the same value from `claude auth status`.
2. Type a deliberately wrong address (e.g. `wrong@example.com`) and save. The account row shows an amber "Signed in as …" badge.
3. Open a session on a project routed to that account. The header shows the mismatch banner, **and the session still runs** — send a prompt to confirm.
4. Repeat step 3 in TUI mode; the pre-flight banner should still appear.
5. Clear the Email field and save. Both the badge and the banner disappear, and no further identity reads occur.

---

## Self-Review

**Spec coverage:**

| Spec section | Task |
|---|---|
| §1 Data model — migration v17, `expected_email`, create/update options | Task 1 |
| §2 `account-identity.ts` — `readOauthIdentity`, `probeAuthStatus` | Task 2 |
| §2 Codex dispatch to existing `codexAuth.getStatus` | Task 6 (dialog renders the email field for Claude only; the Codex branch at `AccountDialog.tsx:340` is untouched and keeps its own auth row) |
| §2 IPC channels `account_identity_read` / `account_identity_probe` | Task 3 |
| §3 Pre-flight check, both modes, re-resolved dir, non-blocking | Task 4 |
| §3 Post-init confirmation, rich mode | Task 5 |
| §3 Logged-out treated as mismatch | Tasks 4 (`detected: null`) and 7 (badge) |
| §3 Trimmed, case-insensitive comparison, no dot-folding | Task 2 (`emailsMatch` + tests) |
| §3 Zero cost when `expected_email` is null | Task 4 step 1 test 3; Task 7 test 4 |
| §4 Dialog field + Detect | Task 6 |
| §4 Settings row badge, cheap read only | Task 7 |
| §4 Session header banner | Task 8 |
| §4 Discovery prefill | Task 9 |
| §5 Testing, 80% coverage | Every task; gate in Task 9 |
| §Out of scope — no blocking, no polling, no resolution change | Honored: no gate exists anywhere in Tasks 4/5/8 |

No gaps.

**Placeholder scan:** No TBDs. Two places instruct the implementer to read existing code before writing — Task 4 step 4 (confirm the TUI branch is downstream of the check) and Task 5 step 1 (reuse the existing fake-engine harness). Both are deliberate: inventing a parallel test harness or duplicating the check is the more likely failure than getting the placement wrong, and the exact harness names in `sessions-runtime.test.ts` are the one thing this plan cannot pin down without over-specifying a file it doesn't otherwise touch.

**Type consistency:** `AccountMismatch` is defined once in `electron/services/sessions/types.ts` (Task 4) and re-declared structurally in `src/components/AccountMismatchBanner.tsx` (Task 8) because the renderer cannot import from `electron/`. Both have identical fields — `expected: string`, `detected: string | null`, `configDir: string`, `source: 'oauth-file' | 'session-init'`. `expectedEmail` (camelCase) is the option/payload name throughout; `expected_email` (snake_case) is the DB column and the `Account` field, matching the file's existing convention (`config_dir`, `cli_path`, `subscription_label`). `readAccountIdentity` / `probeAccountAuthStatus` are the renderer method names in every task that uses them.
