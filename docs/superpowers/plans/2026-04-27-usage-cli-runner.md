# `/usage` CLI Runner — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Capture rich `/usage` data via PTY for the active project's account, feed it into existing rate-limit widgets, surface full detail in a popover, and refresh on demand + every 5 min.

**Architecture:** A new `usage-runner` service spawns `claude` in a real pseudo-terminal (via `node-pty`, already in deps), sends `/usage`, parses the rendered output, then dual-writes: per-window utilization → existing `rate-limits.ts` snapshot store; full `UsageData` → in-memory cache for the popover. Renderer side, a `useUsageAutoRefresh` hook drives a visibility-aware 5-min timer per active session, and a new `UsageDetailPopover` renders the cached payload when a `RateLimitWidget` is clicked.

**Tech Stack:** TypeScript, Electron, `node-pty`, `better-sqlite3`, Vitest, React 18, Radix Popover.

**Spec:** `docs/superpowers/specs/2026-04-27-usage-cli-runner-design.md`

---

## File Structure

**New**
- `electron/services/usage-runner.ts` — service entrypoint (spawn + dedup + cache)
- `electron/services/usage-runner/parser.ts` — pure ANSI-stripped text → `UsageData`
- `electron/services/usage-runner/ansi.ts` — small ANSI-stripping helper
- `electron/__tests__/usage-runner.test.ts` — runner tests with injected `spawnPty`
- `electron/__tests__/usage-runner-parser.test.ts` — fixture-driven parser tests
- `electron/__tests__/fixtures/usage-output/max-full.txt` (+ `.expected.json`)
- `electron/__tests__/fixtures/usage-output/fresh-account.txt` (+ `.expected.json`)
- `electron/__tests__/fixtures/usage-output/partial-render.txt` (+ `.expected.json`)
- `electron/__tests__/fixtures/usage-output/error-banner.txt` (+ `.expected.json`)
- `src/hooks/useUsageAutoRefresh.ts` — 5-min visibility-aware refresh hook
- `src/components/claude-code-session/UsageDetailPopover.tsx` — Radix popover

**Modified**
- `electron/services/database.ts` — migration v5: `ALTER TABLE accounts ADD COLUMN cli_path TEXT`
- `electron/services/accounts.ts` — `cli_path` on `Account`, `AccountRow`, `rowToAccount`, `createAccount`, `updateAccount`
- `electron/services/rate-limits.ts` — add `recordUtilization`; delete `refresh` + `parseStatusOutput`
- `electron/services/claude.ts` — extract `findClaudeBinary` to a shared helper consumed by both rate-limits and usage-runner (or move to `electron/services/util/find-claude-binary.ts`)
- `electron/main.ts` — construct `UsageRunnerService`, wire into IPC handlers
- `electron/ipc/handlers.ts` — add `usage_run_cli`, `usage_get_last`, `accounts_validate_cli_path`; remove `rate_limits_refresh`
- `electron/preload.ts` — allow-list updates
- `src/lib/api.ts` — typed wrappers for new channels; add `cliPath` field on account types
- `src/components/SessionHeader.tsx` — wire hook + popover triggers + reroute existing refresh button
- `src/components/claude-code-session/RateLimitWidget.tsx` — `onClick` opens popover (no data-shape change)
- `src/components/AccountSettings.tsx` — CLI path input + browse + validation

---

## Task 1: Schema migration — `cli_path` column on `accounts`

**Files:**
- Modify: `electron/services/database.ts:40-72`
- Test: `electron/__tests__/database.test.ts` (existing, add a case)

- [ ] **Step 1: Write the failing test**

Append to `electron/__tests__/database.test.ts`:

```ts
it('migration v5 adds cli_path column to accounts', () => {
  const { db } = createDatabase(':memory:');
  const cols = db.pragma('table_info(accounts)') as { name: string }[];
  expect(cols.some((c) => c.name === 'cli_path')).toBe(true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- database.test`
Expected: FAIL — `cli_path` column missing.

- [ ] **Step 3: Add migration v5**

In `electron/services/database.ts`, append to the `migrations` array (after the `version: 3` entry):

```ts
{
  version: 5,
  description: 'Add cli_path column to accounts',
  up: (db) => {
    const cols = db.pragma('table_info(accounts)') as { name: string }[];
    if (!cols.some((c) => c.name === 'cli_path')) {
      db.exec('ALTER TABLE accounts ADD COLUMN cli_path TEXT');
    }
  },
},
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- database.test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add electron/services/database.ts electron/__tests__/database.test.ts
git commit -m "feat(accounts): add cli_path column migration"
```

---

## Task 2: Accounts service — surface `cli_path` round-trip

**Files:**
- Modify: `electron/services/accounts.ts:17-28, 88-99, 113-130, 160-221`
- Test: `electron/__tests__/accounts.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `electron/__tests__/accounts.test.ts`:

```ts
it('round-trips cli_path through createAccount and updateAccount', () => {
  const accounts = createAccountsService({ db });
  const acct = accounts.createAccount('personal', '/tmp/cfg', false, 'max', undefined, undefined, undefined, '/Users/g/.local/bin/claude');
  expect(acct.cli_path).toBe('/Users/g/.local/bin/claude');

  accounts.updateAccount(acct.id, 'personal', '/tmp/cfg', 'max', undefined, undefined, undefined, null);
  const after = accounts.listAccounts().find((a) => a.id === acct.id)!;
  expect(after.cli_path).toBeNull();
});

it('defaults cli_path to null on createAccount when not provided', () => {
  const accounts = createAccountsService({ db });
  const acct = accounts.createAccount('work', '/tmp/cfg2', false);
  expect(acct.cli_path).toBeNull();
});
```

- [ ] **Step 2: Run to confirm failure**

Run: `npm test -- accounts.test`
Expected: FAIL — `cli_path` undefined / signature mismatch.

- [ ] **Step 3: Update types and service methods**

In `electron/services/accounts.ts`:

```ts
export interface Account {
  id: number;
  name: string;
  config_dir: string;
  is_default: boolean;
  account_type: string;
  color: string | null;
  icon: string | null;
  session_defaults?: SessionDefaults;
  cli_path: string | null;
  created_at: string;
  updated_at: string;
}

interface AccountRow {
  id: number;
  name: string;
  config_dir: string;
  is_default: number;
  account_type: string;
  color: string | null;
  icon: string | null;
  session_defaults: string | null;
  cli_path: string | null;
  created_at: string;
  updated_at: string;
}

function rowToAccount(row: AccountRow): Account {
  return {
    id: row.id,
    name: row.name,
    config_dir: row.config_dir,
    is_default: !!row.is_default,
    account_type: row.account_type,
    color: row.color,
    icon: row.icon,
    session_defaults: row.session_defaults
      ? safeParseSessionDefaults(row.session_defaults)
      : undefined,
    cli_path: row.cli_path,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}
```

Update `createAccount` signature and body:

```ts
function createAccount(
  name: string,
  configDir: string,
  isDefault: boolean,
  accountType: string = 'max',
  color?: string,
  icon?: string,
  sessionDefaults?: SessionDefaults,
  cliPath?: string | null,
): Account {
  if (isDefault) {
    raw.prepare('UPDATE accounts SET is_default = 0').run();
  }
  const info = raw
    .prepare(
      `INSERT INTO accounts (name, config_dir, is_default, account_type, color, icon, session_defaults, cli_path)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      name, configDir, isDefault ? 1 : 0, accountType,
      color ?? null, icon ?? null,
      sessionDefaults ? JSON.stringify(sessionDefaults) : null,
      cliPath ?? null,
    );
  const row = raw
    .prepare('SELECT * FROM accounts WHERE id = ?')
    .get(info.lastInsertRowid) as AccountRow;
  return rowToAccount(row);
}
```

Update `updateAccount`:

```ts
function updateAccount(
  id: number,
  name: string,
  configDir: string,
  accountType?: string,
  color?: string,
  icon?: string,
  sessionDefaults?: SessionDefaults | null,
  cliPath?: string | null,
): void {
  if (sessionDefaults !== undefined) {
    raw
      .prepare(
        `UPDATE accounts
         SET name = ?, config_dir = ?, account_type = COALESCE(?, account_type),
             color = ?, icon = ?, session_defaults = ?, cli_path = ?, updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
      )
      .run(
        name, configDir, accountType ?? null,
        color ?? null, icon ?? null,
        sessionDefaults !== null ? JSON.stringify(sessionDefaults) : null,
        cliPath ?? null, id,
      );
  } else {
    raw
      .prepare(
        `UPDATE accounts
         SET name = ?, config_dir = ?, account_type = COALESCE(?, account_type),
             color = ?, icon = ?, cli_path = ?, updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
      )
      .run(
        name, configDir, accountType ?? null,
        color ?? null, icon ?? null,
        cliPath ?? null, id,
      );
  }
}
```

Update the `AccountsService` interface signatures to match.

- [ ] **Step 4: Run tests**

Run: `npm test -- accounts.test`
Expected: PASS.

- [ ] **Step 5: Run full check**

Run: `npm run check`
Expected: clean (some IPC handler call sites may need updates — fix them in Task 7 if a type error remains, otherwise leave as-is).

- [ ] **Step 6: Commit**

```bash
git add electron/services/accounts.ts electron/__tests__/accounts.test.ts
git commit -m "feat(accounts): round-trip cli_path through accounts service"
```

---

## Task 3: CLI path validator IPC

**Files:**
- Create: `electron/services/cli-path-validator.ts`
- Test: `electron/__tests__/cli-path-validator.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, chmodSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { validateCliPath } from '../services/cli-path-validator';

describe('validateCliPath', () => {
  it('returns ok for null/empty input', () => {
    expect(validateCliPath(null)).toEqual({ ok: true });
    expect(validateCliPath('')).toEqual({ ok: true });
  });

  it('rejects a non-existent path', () => {
    const r = validateCliPath('/definitely/does/not/exist/claude');
    expect(r.ok).toBe(false);
  });

  it('rejects a directory', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'cli-validate-'));
    const r = validateCliPath(dir);
    expect(r.ok).toBe(false);
  });

  it('rejects a non-executable regular file', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'cli-validate-'));
    const p = path.join(dir, 'notexec');
    writeFileSync(p, '#!/bin/sh\necho hi\n');
    chmodSync(p, 0o644);
    const r = validateCliPath(p);
    expect(r.ok).toBe(false);
  });

  it('accepts an executable file', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'cli-validate-'));
    const p = path.join(dir, 'iscool');
    writeFileSync(p, '#!/bin/sh\necho hi\n');
    chmodSync(p, 0o755);
    const r = validateCliPath(p);
    expect(r.ok).toBe(true);
  });
});
```

- [ ] **Step 2: Run to confirm fails**

Run: `npm test -- cli-path-validator`
Expected: module not found.

- [ ] **Step 3: Implement**

```ts
// electron/services/cli-path-validator.ts
import fs from 'node:fs';

export type ValidateCliPathResult = { ok: true } | { ok: false; error: string };

export function validateCliPath(input: string | null | undefined): ValidateCliPathResult {
  if (input == null || input === '') return { ok: true };
  let stat: fs.Stats;
  try {
    stat = fs.statSync(input);
  } catch (err) {
    return { ok: false, error: `Path not found: ${input}` };
  }
  if (!stat.isFile()) return { ok: false, error: `Not a regular file: ${input}` };
  try {
    fs.accessSync(input, fs.constants.X_OK);
  } catch {
    return { ok: false, error: `Not executable: ${input}` };
  }
  return { ok: true };
}
```

- [ ] **Step 4: Run tests**

Run: `npm test -- cli-path-validator`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add electron/services/cli-path-validator.ts electron/__tests__/cli-path-validator.test.ts
git commit -m "feat(accounts): add cli_path validator helper"
```

---

## Task 4: rate-limits — `recordUtilization` method

**Files:**
- Modify: `electron/services/rate-limits.ts` (add new method to interface + impl)
- Test: `electron/__tests__/rate-limits.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `electron/__tests__/rate-limits.test.ts`:

```ts
it('recordUtilization preserves SDK-derived status on existing snapshot', () => {
  const h = makeHarness();
  // First, an SDK event sets status: 'rejected'
  h.service.recordEvent('/cfg', {
    status: 'rejected',
    rateLimitType: 'five_hour',
    utilization: 100,
    resetsAt: 1234,
  });
  // Now a PTY refresh comes in with newer numbers but no status signal
  h.service.recordUtilization('/cfg', 'five_hour', 60, 9999);
  const snap = h.service.getSnapshotsByAccount('personal').find((s) => s.rate_limit_type === 'five_hour')!;
  expect(snap.utilization).toBe(60);
  expect(snap.resets_at).toBe(9999);
  expect(snap.status).toBe('rejected'); // preserved
});

it('recordUtilization creates new snapshot with status=allowed when none exists', () => {
  const h = makeHarness();
  h.service.recordUtilization('/cfg', 'seven_day_sonnet', 6, 5555);
  const snap = h.service.getSnapshotsByAccount('personal').find((s) => s.rate_limit_type === 'seven_day_sonnet')!;
  expect(snap.utilization).toBe(6);
  expect(snap.resets_at).toBe(5555);
  expect(snap.status).toBe('allowed');
});
```

(Re-use whatever `makeHarness()` helper the existing test file uses; otherwise mirror the setup pattern from existing tests in that file.)

- [ ] **Step 2: Run to confirm failure**

Run: `npm test -- rate-limits.test`
Expected: FAIL — `recordUtilization` not defined.

- [ ] **Step 3: Implement**

In `electron/services/rate-limits.ts`, add to the service interface:

```ts
recordUtilization(
  configDir: string,
  rateLimitType: string,
  utilization: number,
  resetsAt: number | null,
): void;
```

Implementation (place near `recordEvent`):

```ts
function recordUtilization(
  configDir: string,
  rateLimitType: string,
  utilization: number,
  resetsAt: number | null,
): void {
  const account = accounts.listAccounts().find((a) => a.config_dir === configDir);
  if (!account) {
    logWarn('recordUtilization: unknown configDir', { configDir });
    return;
  }
  const observedAt = nowFn();
  // Update only utilization + resets_at; preserve status (and create with
  // status='allowed' when no row exists yet).
  db.raw
    .prepare(
      `INSERT INTO rate_limit_snapshots
         (account_name, rate_limit_type, status, utilization, resets_at, payload_json, observed_at)
       VALUES (?, ?, 'allowed', ?, ?, ?, ?)
       ON CONFLICT(account_name, rate_limit_type)
       DO UPDATE SET
         utilization = excluded.utilization,
         resets_at = excluded.resets_at,
         observed_at = excluded.observed_at`,
    )
    .run(
      account.name,
      rateLimitType,
      utilization,
      resetsAt,
      JSON.stringify({ source: 'usage_cli', utilization, resetsAt }),
      observedAt,
    );
  sendToRenderer('rate_limit_snapshot', { account: account.name });
}
```

Add `recordUtilization` to the returned object.

- [ ] **Step 4: Run tests**

Run: `npm test -- rate-limits.test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add electron/services/rate-limits.ts electron/__tests__/rate-limits.test.ts
git commit -m "feat(rate-limits): add recordUtilization that preserves SDK status"
```

---

## Task 5: ANSI stripper

**Files:**
- Create: `electron/services/usage-runner/ansi.ts`
- Test: `electron/__tests__/usage-runner-ansi.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest';
import { stripAnsi } from '../services/usage-runner/ansi';

describe('stripAnsi', () => {
  it('removes CSI color codes', () => {
    expect(stripAnsi('[31mred[0m')).toBe('red');
  });
  it('removes cursor movement and erase codes', () => {
    expect(stripAnsi('a[2Kb[1;1Hc')).toBe('abc');
  });
  it('removes OSC sequences (BEL terminated)', () => {
    expect(stripAnsi(']0;titlehi')).toBe('hi');
  });
  it('removes OSC sequences (ST terminated)', () => {
    expect(stripAnsi(']0;title\\hi')).toBe('hi');
  });
  it('preserves newlines and unicode', () => {
    expect(stripAnsi('[1mline1[0m\nline2 — ✓')).toBe('line1\nline2 — ✓');
  });
});
```

- [ ] **Step 2: Run to fail**

Run: `npm test -- usage-runner-ansi`
Expected: module not found.

- [ ] **Step 3: Implement**

```ts
// electron/services/usage-runner/ansi.ts
//
// Compact ANSI stripper covering what claude's TUI emits: CSI sequences,
// OSC sequences (BEL- or ST-terminated), and standalone control bytes that
// would otherwise show up as garbage in parsed text.

const CSI = /\[[0-?]*[ -/]*[@-~]/g;
const OSC = /\][^]*(?:|\\)/g;
const BARE_ESC = /[NOPQ\\\^_]/g;

export function stripAnsi(input: string): string {
  return input
    .replace(OSC, '')
    .replace(CSI, '')
    .replace(BARE_ESC, '');
}
```

- [ ] **Step 4: Run tests**

Run: `npm test -- usage-runner-ansi`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add electron/services/usage-runner/ansi.ts electron/__tests__/usage-runner-ansi.test.ts
git commit -m "feat(usage-runner): add ANSI stripper"
```

---

## Task 6: Usage parser + fixtures

**Files:**
- Create: `electron/services/usage-runner/parser.ts`
- Create: `electron/__tests__/usage-runner-parser.test.ts`
- Create: 4 fixture pairs under `electron/__tests__/fixtures/usage-output/`

- [ ] **Step 1: Author fixtures**

Create `electron/__tests__/fixtures/usage-output/max-full.txt` from the canonical screenshot:

```
Session
Total cost:             $0.0000
Total duration (API):   0s
Total duration (wall):  3s
Total code changes:     0 lines added, 0 lines removed
Usage:                  0 input, 0 output, 0 cache read, 0 cache write

Current session
33% used
Resets 9:40am (America/New_York)

Current week (all models)
68% used
Resets 7pm (America/New_York)

Current week (Sonnet only)
6% used
Resets 7pm (America/New_York)

What's contributing to your limits usage?
Approximate, based on local sessions on this machine — does not include other devices or claude.ai

Last 24h · these are independent characteristics of your usage, not a breakdown

86% of your usage was at >150k context
  Longer sessions are more expensive even when cached. /compact mid-task, /clear
  when switching to new tasks.

67% of your usage came from subagent-heavy sessions
  Each subagent runs its own requests. Be deliberate about spawning them — and
  prefer plan mode for short-lived work.
```

Create `max-full.expected.json`:

```json
{
  "session": {
    "cost_usd": 0,
    "api_duration_s": 0,
    "wall_duration_s": 3,
    "code_added": 0,
    "code_removed": 0,
    "input_tokens": 0,
    "output_tokens": 0,
    "cache_read": 0,
    "cache_write": 0
  },
  "windows": [
    { "label": "current_session", "pct_used": 33, "resets_at_label": "9:40am (America/New_York)" },
    { "label": "week_all_models", "pct_used": 68, "resets_at_label": "7pm (America/New_York)" },
    { "label": "week_sonnet", "pct_used": 6, "resets_at_label": "7pm (America/New_York)" }
  ],
  "contributing": [
    {
      "headline": "86% of your usage was at >150k context",
      "detail": "Longer sessions are more expensive even when cached. /compact mid-task, /clear when switching to new tasks."
    },
    {
      "headline": "67% of your usage came from subagent-heavy sessions",
      "detail": "Each subagent runs its own requests. Be deliberate about spawning them — and prefer plan mode for short-lived work."
    }
  ]
}
```

`fresh-account.txt`:

```
Session
Total cost:             $0.0000
Total duration (API):   0s
Total duration (wall):  0s
Total code changes:     0 lines added, 0 lines removed
Usage:                  0 input, 0 output, 0 cache read, 0 cache write

Current session
0% used
Resets in 5h

Current week (all models)
0% used
Resets in 7d
```

`fresh-account.expected.json`:

```json
{
  "session": {
    "cost_usd": 0,
    "api_duration_s": 0,
    "wall_duration_s": 0,
    "code_added": 0,
    "code_removed": 0,
    "input_tokens": 0,
    "output_tokens": 0,
    "cache_read": 0,
    "cache_write": 0
  },
  "windows": [
    { "label": "current_session", "pct_used": 0, "resets_at_label": "in 5h" },
    { "label": "week_all_models", "pct_used": 0, "resets_at_label": "in 7d" }
  ],
  "contributing": []
}
```

`partial-render.txt` — truncated mid-render after 2 windows:

```
Session
Total cost:             $0.0123
Total duration (API):   12s
Total duration (wall):  45s
Total code changes:     17 lines added, 4 lines removed
Usage:                  1234 input, 567 output, 8901 cache read, 234 cache write

Current session
12% used
Resets 9:40am (America/New_York)

Current week (all m
```

`partial-render.expected.json`:

```json
{
  "session": {
    "cost_usd": 0.0123,
    "api_duration_s": 12,
    "wall_duration_s": 45,
    "code_added": 17,
    "code_removed": 4,
    "input_tokens": 1234,
    "output_tokens": 567,
    "cache_read": 8901,
    "cache_write": 234
  },
  "windows": [
    { "label": "current_session", "pct_used": 12, "resets_at_label": "9:40am (America/New_York)" }
  ],
  "contributing": []
}
```

`error-banner.txt`:

```
Authentication required. Run /login to continue.
```

`error-banner.expected.json` — sentinel for parser failure (no windows extracted):

```json
{ "ok": false, "reason": "no_windows" }
```

- [ ] **Step 2: Write the failing test**

```ts
// electron/__tests__/usage-runner-parser.test.ts
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { parseUsageOutput } from '../services/usage-runner/parser';

const fixDir = path.join(__dirname, 'fixtures', 'usage-output');

describe('parseUsageOutput fixtures', () => {
  const txts = readdirSync(fixDir).filter((f) => f.endsWith('.txt'));
  for (const txt of txts) {
    const name = txt.replace(/\.txt$/, '');
    it(name, () => {
      const raw = readFileSync(path.join(fixDir, txt), 'utf-8');
      const expected = JSON.parse(
        readFileSync(path.join(fixDir, `${name}.expected.json`), 'utf-8'),
      );
      const result = parseUsageOutput(raw);
      if (expected.ok === false) {
        expect(result.ok).toBe(false);
      } else {
        expect(result.ok).toBe(true);
        if (result.ok) expect(result.data).toEqual(expected);
      }
    });
  }
});
```

- [ ] **Step 3: Run to confirm fail**

Run: `npm test -- usage-runner-parser`
Expected: module not found.

- [ ] **Step 4: Implement parser**

```ts
// electron/services/usage-runner/parser.ts
export type UsageWindow = {
  label: 'current_session' | 'week_all_models' | 'week_sonnet';
  pct_used: number;
  resets_at_label: string;
};

export type UsageData = {
  session: {
    cost_usd: number;
    api_duration_s: number;
    wall_duration_s: number;
    code_added: number;
    code_removed: number;
    input_tokens: number;
    output_tokens: number;
    cache_read: number;
    cache_write: number;
  };
  windows: UsageWindow[];
  contributing: { headline: string; detail: string }[];
};

export type ParseResult =
  | { ok: true; data: UsageData }
  | { ok: false; reason: string };

const SECTION_HEADERS = {
  session: /^Session\s*$/m,
  current_session: /^Current session\s*$/m,
  week_all_models: /^Current week \(all models\)\s*$/m,
  week_sonnet: /^Current week \(Sonnet only\)\s*$/m,
  contributing: /^What's contributing to your limits usage\?\s*$/m,
};

const DURATION_S = /([\d.]+)\s*s\b/;

export function parseUsageOutput(input: string): ParseResult {
  const text = input.replace(/\r\n/g, '\n');

  const session = parseSessionBlock(text);
  const windows: UsageWindow[] = [];
  const cs = parseWindow(text, 'current_session', SECTION_HEADERS.current_session);
  if (cs) windows.push(cs);
  const wm = parseWindow(text, 'week_all_models', SECTION_HEADERS.week_all_models);
  if (wm) windows.push(wm);
  const ws = parseWindow(text, 'week_sonnet', SECTION_HEADERS.week_sonnet);
  if (ws) windows.push(ws);

  if (windows.length === 0) return { ok: false, reason: 'no_windows' };

  const contributing = parseContributing(text);

  return {
    ok: true,
    data: { session, windows, contributing },
  };
}

function sliceSection(text: string, startRe: RegExp, ...nextRes: RegExp[]): string | null {
  const m = startRe.exec(text);
  if (!m) return null;
  const start = m.index + m[0].length;
  let end = text.length;
  for (const re of nextRes) {
    const re2 = new RegExp(re.source, re.flags);
    re2.lastIndex = start;
    const n = re2.exec(text);
    if (n && n.index < end) end = n.index;
  }
  return text.slice(start, end);
}

function parseSessionBlock(text: string): UsageData['session'] {
  const block = sliceSection(
    text,
    SECTION_HEADERS.session,
    SECTION_HEADERS.current_session,
    SECTION_HEADERS.week_all_models,
    SECTION_HEADERS.week_sonnet,
    SECTION_HEADERS.contributing,
  ) ?? '';

  const cost = /Total cost:\s*\$([\d.]+)/.exec(block)?.[1];
  const apiD = /Total duration \(API\):\s*([\d.]+)\s*s/.exec(block)?.[1];
  const wallD = /Total duration \(wall\):\s*([\d.]+)\s*s/.exec(block)?.[1];
  const codeChange = /Total code changes:\s*([\d,]+)\s*lines added,\s*([\d,]+)\s*lines removed/.exec(block);
  const usage = /Usage:\s*([\d,]+)\s*input,\s*([\d,]+)\s*output,\s*([\d,]+)\s*cache read,\s*([\d,]+)\s*cache write/.exec(block);

  const num = (s: string | undefined) => (s ? parseFloat(s.replace(/,/g, '')) : 0);
  const intnum = (s: string | undefined) => (s ? parseInt(s.replace(/,/g, ''), 10) : 0);

  return {
    cost_usd: num(cost),
    api_duration_s: num(apiD),
    wall_duration_s: num(wallD),
    code_added: intnum(codeChange?.[1]),
    code_removed: intnum(codeChange?.[2]),
    input_tokens: intnum(usage?.[1]),
    output_tokens: intnum(usage?.[2]),
    cache_read: intnum(usage?.[3]),
    cache_write: intnum(usage?.[4]),
  };
}

function parseWindow(
  text: string,
  label: UsageWindow['label'],
  header: RegExp,
): UsageWindow | null {
  const block = sliceSection(
    text,
    header,
    SECTION_HEADERS.current_session,
    SECTION_HEADERS.week_all_models,
    SECTION_HEADERS.week_sonnet,
    SECTION_HEADERS.contributing,
  );
  if (!block) return null;
  const pct = /(\d+(?:\.\d+)?)\s*%\s*used/i.exec(block)?.[1];
  if (pct == null) return null;
  const resetsLine = /Resets\s+(.+)$/m.exec(block)?.[1]?.trim();
  return {
    label,
    pct_used: parseFloat(pct),
    resets_at_label: resetsLine ?? '',
  };
}

function parseContributing(text: string): { headline: string; detail: string }[] {
  const block = sliceSection(text, SECTION_HEADERS.contributing) ?? '';
  // Each entry starts with a percentage-headed headline at column 0, then one
  // or more indented detail lines that we collapse into a single paragraph.
  const lines = block.split('\n');
  const out: { headline: string; detail: string }[] = [];
  let current: { headline: string; detail: string[] } | null = null;
  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '');
    if (!line.trim()) {
      if (current) {
        out.push({ headline: current.headline, detail: current.detail.join(' ').trim() });
        current = null;
      }
      continue;
    }
    if (/^\d+%/.test(line)) {
      if (current) out.push({ headline: current.headline, detail: current.detail.join(' ').trim() });
      current = { headline: line.trim(), detail: [] };
    } else if (current && /^\s+/.test(raw)) {
      current.detail.push(line.trim());
    }
  }
  if (current) out.push({ headline: current.headline, detail: current.detail.join(' ').trim() });
  return out;
}
```

- [ ] **Step 5: Run tests**

Run: `npm test -- usage-runner-parser`
Expected: all four fixtures PASS.

If any fixture fails, fix the parser (not the fixture) — the fixtures are the source of truth.

- [ ] **Step 6: Commit**

```bash
git add electron/services/usage-runner/parser.ts electron/__tests__/usage-runner-parser.test.ts electron/__tests__/fixtures/usage-output/
git commit -m "feat(usage-runner): parser + fixture-driven tests"
```

---

## Task 7: Shared `findClaudeBinary` helper

**Files:**
- Create: `electron/services/util/find-claude-binary.ts`
- Modify: `electron/services/rate-limits.ts` to import the helper instead of defining it inline
- Test: `electron/__tests__/find-claude-binary.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest';
import { findClaudeBinary } from '../services/util/find-claude-binary';

describe('findClaudeBinary', () => {
  it('returns null when no candidate exists', () => {
    expect(findClaudeBinary({ which: () => null, exists: () => false })).toBeNull();
  });
  it('returns the `which` result if it exists', () => {
    expect(findClaudeBinary({ which: () => '/usr/local/bin/claude', exists: (p) => p === '/usr/local/bin/claude' }))
      .toBe('/usr/local/bin/claude');
  });
  it('falls back to known locations', () => {
    const exists = (p: string) => p === '/opt/homebrew/bin/claude';
    expect(findClaudeBinary({ which: () => null, exists, fallbacks: ['/opt/homebrew/bin/claude'] }))
      .toBe('/opt/homebrew/bin/claude');
  });
});
```

- [ ] **Step 2: Run to fail**

Run: `npm test -- find-claude-binary`
Expected: module not found.

- [ ] **Step 3: Implement**

```ts
// electron/services/util/find-claude-binary.ts
import { execSync } from 'node:child_process';
import fs from 'node:fs';

export interface FindClaudeBinaryDeps {
  which?: () => string | null;
  exists?: (p: string) => boolean;
  fallbacks?: string[];
}

const DEFAULT_FALLBACKS = [
  `${process.env.HOME ?? ''}/.local/bin/claude`,
  '/usr/local/bin/claude',
  '/opt/homebrew/bin/claude',
];

export function findClaudeBinary(deps: FindClaudeBinaryDeps = {}): string | null {
  const which = deps.which ?? defaultWhich;
  const exists = deps.exists ?? fs.existsSync;
  const fallbacks = deps.fallbacks ?? DEFAULT_FALLBACKS;

  const w = which();
  if (w && exists(w)) return w;
  for (const p of fallbacks) {
    if (p && exists(p)) return p;
  }
  return null;
}

function defaultWhich(): string | null {
  try {
    const out = execSync('which claude', { encoding: 'utf-8' });
    const trimmed = out.trim().split('\n')[0].trim();
    return trimmed || null;
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: Update rate-limits.ts to use it**

In `electron/services/rate-limits.ts`, delete the inline `findClaudeBinary` (around line 440-462) and replace usage with:

```ts
import { findClaudeBinary } from './util/find-claude-binary';
```

- [ ] **Step 5: Run tests**

Run: `npm test -- find-claude-binary rate-limits`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add electron/services/util/find-claude-binary.ts electron/services/rate-limits.ts electron/__tests__/find-claude-binary.test.ts
git commit -m "refactor: extract findClaudeBinary helper"
```

---

## Task 8: Usage runner service (PTY + dedup + cache + dual-write)

**Files:**
- Create: `electron/services/usage-runner.ts`
- Test: `electron/__tests__/usage-runner.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
// electron/__tests__/usage-runner.test.ts
import { describe, it, expect, vi } from 'vitest';
import { createUsageRunnerService, type PtySpawner, type FakePty } from '../services/usage-runner';

const MAX_FULL_FIXTURE = `
Session
Total cost:             $0.0000
Total duration (API):   0s
Total duration (wall):  3s
Total code changes:     0 lines added, 0 lines removed
Usage:                  0 input, 0 output, 0 cache read, 0 cache write

Current session
33% used
Resets 9:40am (America/New_York)

Current week (all models)
68% used
Resets 7pm (America/New_York)

Current week (Sonnet only)
6% used
Resets 7pm (America/New_York)
`;

function makeFakeAccountsService() {
  return {
    listAccounts: () => [
      { id: 1, name: 'personal', config_dir: '/cfg/personal', cli_path: null, is_default: true,
        account_type: 'max', color: null, icon: null, created_at: '', updated_at: '' },
    ],
  } as any;
}

function makeFakeRateLimits() {
  return {
    recordUtilization: vi.fn(),
  } as any;
}

function makeScriptedSpawn(scriptedOutput: string, settleDelayMs = 50): PtySpawner {
  return (cmd, args, opts) => {
    const dataHandlers: ((d: string) => void)[] = [];
    const exitHandlers: ((code: { exitCode: number }) => void)[] = [];
    const writes: string[] = [];
    let killed = false;
    setTimeout(() => {
      if (killed) return;
      // Initial idle output
      for (const h of dataHandlers) h('> ');
    }, 5);
    const fake: FakePty = {
      write: (data: string) => {
        writes.push(data);
        if (data.includes('/usage')) {
          setTimeout(() => {
            if (killed) return;
            for (const h of dataHandlers) h(scriptedOutput);
          }, settleDelayMs);
        }
      },
      kill: () => {
        killed = true;
        for (const h of exitHandlers) h({ exitCode: 0 });
      },
      onData: (cb) => { dataHandlers.push(cb); },
      onExit: (cb) => { exitHandlers.push(cb); },
    };
    return fake;
  };
}

describe('usage-runner', () => {
  it('happy path: parses, dual-writes recordUtilization, caches result', async () => {
    const accounts = makeFakeAccountsService();
    const rateLimits = makeFakeRateLimits();
    const runner = createUsageRunnerService({
      accounts, rateLimits,
      spawnPty: makeScriptedSpawn(MAX_FULL_FIXTURE),
      findClaudeBinary: () => '/fake/claude',
      now: () => 1700000000000,
      // Tighten timings for tests
      settleQuietMs: 30,
      usageQuietMs: 60,
      hardTimeoutMs: 5000,
    });
    const result = await runner.run('personal');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.parsed.windows.length).toBe(3);
    expect(rateLimits.recordUtilization).toHaveBeenCalledWith(
      '/cfg/personal', 'five_hour', 33, expect.any(Number),
    );
    expect(rateLimits.recordUtilization).toHaveBeenCalledWith(
      '/cfg/personal', 'seven_day', 68, expect.any(Number),
    );
    expect(rateLimits.recordUtilization).toHaveBeenCalledWith(
      '/cfg/personal', 'seven_day_sonnet', 6, expect.any(Number),
    );
    const cached = runner.getLast('personal');
    expect(cached?.ok).toBe(true);
  });

  it('returns ok:false when account is unknown', async () => {
    const runner = createUsageRunnerService({
      accounts: makeFakeAccountsService(),
      rateLimits: makeFakeRateLimits(),
      spawnPty: makeScriptedSpawn(''),
      findClaudeBinary: () => '/fake/claude',
      now: () => 1,
    });
    const r = await runner.run('does-not-exist');
    expect(r.ok).toBe(false);
  });

  it('returns ok:false when no claude binary found', async () => {
    const runner = createUsageRunnerService({
      accounts: makeFakeAccountsService(),
      rateLimits: makeFakeRateLimits(),
      spawnPty: makeScriptedSpawn(MAX_FULL_FIXTURE),
      findClaudeBinary: () => null,
      now: () => 1,
    });
    const r = await runner.run('personal');
    expect(r.ok).toBe(false);
  });

  it('dedups concurrent calls for the same account', async () => {
    const accounts = makeFakeAccountsService();
    const rateLimits = makeFakeRateLimits();
    let spawnCount = 0;
    const wrapped: PtySpawner = (cmd, args, opts) => {
      spawnCount += 1;
      return makeScriptedSpawn(MAX_FULL_FIXTURE)(cmd, args, opts);
    };
    const runner = createUsageRunnerService({
      accounts, rateLimits,
      spawnPty: wrapped,
      findClaudeBinary: () => '/fake/claude',
      now: () => 1,
      settleQuietMs: 30, usageQuietMs: 60, hardTimeoutMs: 5000,
    });
    const [a, b] = await Promise.all([runner.run('personal'), runner.run('personal')]);
    expect(spawnCount).toBe(1);
    expect(a).toBe(b);
  });

  it('uses account.cli_path when set, otherwise findClaudeBinary', async () => {
    const accounts = {
      listAccounts: () => [
        { id: 1, name: 'personal', config_dir: '/cfg/personal', cli_path: '/custom/claude',
          is_default: true, account_type: 'max', color: null, icon: null, created_at: '', updated_at: '' },
      ],
    } as any;
    const seen: string[] = [];
    const wrapped: PtySpawner = (cmd, args, opts) => {
      seen.push(cmd);
      return makeScriptedSpawn(MAX_FULL_FIXTURE)(cmd, args, opts);
    };
    const runner = createUsageRunnerService({
      accounts,
      rateLimits: makeFakeRateLimits(),
      spawnPty: wrapped,
      findClaudeBinary: () => '/fake/claude',
      now: () => 1,
      settleQuietMs: 30, usageQuietMs: 60, hardTimeoutMs: 5000,
    });
    await runner.run('personal');
    expect(seen[0]).toBe('/custom/claude');
  });
});
```

- [ ] **Step 2: Run tests to confirm fail**

Run: `npm test -- usage-runner.test`
Expected: module not found.

- [ ] **Step 3: Implement**

```ts
// electron/services/usage-runner.ts
import os from 'node:os';
import type { AccountsService } from './accounts';
import type { RateLimitsService } from './rate-limits';
import { findClaudeBinary as defaultFindClaudeBinary } from './util/find-claude-binary';
import { stripAnsi } from './usage-runner/ansi';
import { parseUsageOutput, type UsageData } from './usage-runner/parser';
import type { LoggingService } from './logging';

export interface FakePty {
  write(data: string): void;
  kill(): void;
  onData(cb: (data: string) => void): void;
  onExit(cb: (code: { exitCode: number }) => void): void;
}

export type PtySpawner = (
  command: string,
  args: string[],
  opts: { cwd: string; env: NodeJS.ProcessEnv; cols: number; rows: number },
) => FakePty;

export type UsageRunResult =
  | { ok: true; observed_at: number; raw: string; parsed: UsageData }
  | { ok: false; observed_at: number; error: string; raw?: string };

export interface UsageRunnerService {
  run(accountName: string): Promise<UsageRunResult>;
  getLast(accountName: string): UsageRunResult | null;
}

export interface UsageRunnerDeps {
  accounts: AccountsService;
  rateLimits: RateLimitsService;
  spawnPty?: PtySpawner;
  findClaudeBinary?: () => string | null;
  now?: () => number;
  logging?: LoggingService | null;
  // Tunables (defaults match the spec)
  settleQuietMs?: number;
  usageQuietMs?: number;
  hardTimeoutMs?: number;
  killGraceMs?: number;
}

const PARSER_LABEL_TO_RATE_LIMIT_TYPE: Record<UsageData['windows'][number]['label'], string> = {
  current_session: 'five_hour',
  week_all_models: 'seven_day',
  week_sonnet: 'seven_day_sonnet',
};

export function createUsageRunnerService(deps: UsageRunnerDeps): UsageRunnerService {
  const spawnPty = deps.spawnPty ?? defaultSpawnPty;
  const findBinary = deps.findClaudeBinary ?? (() => defaultFindClaudeBinary());
  const now = deps.now ?? Date.now;
  const settleQuietMs = deps.settleQuietMs ?? 750;
  const usageQuietMs = deps.usageQuietMs ?? 1500;
  const hardTimeoutMs = deps.hardTimeoutMs ?? 20000;
  const killGraceMs = deps.killGraceMs ?? 500;

  const inFlight = new Map<string, Promise<UsageRunResult>>();
  const cache = new Map<string, UsageRunResult>();

  function logWarn(msg: string, ctx?: Record<string, unknown>) {
    deps.logging?.warn?.(`[usage-runner] ${msg}`, ctx);
  }

  async function run(accountName: string): Promise<UsageRunResult> {
    const existing = inFlight.get(accountName);
    if (existing) return existing;

    const account = deps.accounts.listAccounts().find((a) => a.name === accountName);
    if (!account) {
      const r: UsageRunResult = { ok: false, observed_at: now(), error: `Unknown account: ${accountName}` };
      // Don't cache failures over a prior success
      if (!cache.has(accountName)) cache.set(accountName, r);
      return r;
    }

    const binary = account.cli_path && account.cli_path.length > 0
      ? account.cli_path
      : findBinary();
    if (!binary) {
      const r: UsageRunResult = { ok: false, observed_at: now(), error: 'claude binary not found' };
      return r;
    }

    const promise = doRun(account.name, account.config_dir, binary)
      .finally(() => { inFlight.delete(accountName); });
    inFlight.set(accountName, promise);
    return promise;
  }

  async function doRun(
    accountName: string,
    configDir: string,
    binary: string,
  ): Promise<UsageRunResult> {
    const observedAt = now();
    const pty = spawnPty(binary, [], {
      cwd: os.homedir(),
      env: { ...process.env, CLAUDE_CONFIG_DIR: configDir },
      cols: 200,
      rows: 60,
    });
    let buffer = '';
    let lastByteAt = Date.now();
    pty.onData((chunk) => {
      buffer += chunk;
      lastByteAt = Date.now();
    });
    let exited = false;
    pty.onExit(() => { exited = true; });

    const hardDeadline = Date.now() + hardTimeoutMs;

    // Phase 1: wait for TUI to settle
    while (Date.now() < hardDeadline) {
      if (Date.now() - lastByteAt >= settleQuietMs && buffer.length > 0) break;
      if (exited) break;
      await sleep(50);
    }
    if (exited || Date.now() >= hardDeadline) {
      pty.kill();
      return cacheAndReturn(accountName, {
        ok: false, observed_at: observedAt, error: 'pty exited or timed out before /usage',
        raw: stripAnsi(buffer),
      });
    }

    // Phase 2: send /usage
    const beforeUsage = buffer.length;
    pty.write('/usage\r');

    // Phase 3: wait for /usage rendering to settle
    let lastSeenLen = beforeUsage;
    let stableSince = Date.now();
    while (Date.now() < hardDeadline) {
      if (buffer.length !== lastSeenLen) {
        lastSeenLen = buffer.length;
        stableSince = Date.now();
      } else if (Date.now() - stableSince >= usageQuietMs) {
        break;
      }
      if (exited) break;
      await sleep(50);
    }

    // Phase 4: clean up
    try { pty.write('/quit\r'); } catch {}
    setTimeout(() => { try { pty.kill(); } catch {} }, killGraceMs);

    const raw = stripAnsi(buffer.slice(beforeUsage));
    const parsed = parseUsageOutput(raw);
    if (!parsed.ok) {
      return cacheAndReturn(accountName, {
        ok: false, observed_at: observedAt, error: `parse_failed: ${parsed.reason}`, raw,
      });
    }
    // Dual-write to rate-limits
    for (const w of parsed.data.windows) {
      const type = PARSER_LABEL_TO_RATE_LIMIT_TYPE[w.label];
      deps.rateLimits.recordUtilization(configDir, type, w.pct_used, null);
    }
    return cacheAndReturn(accountName, {
      ok: true, observed_at: observedAt, raw, parsed: parsed.data,
    });
  }

  function cacheAndReturn(accountName: string, result: UsageRunResult): UsageRunResult {
    const prior = cache.get(accountName);
    // Don't replace a prior ok:true with an ok:false
    if (result.ok || !prior || !prior.ok) cache.set(accountName, result);
    return result;
  }

  function getLast(accountName: string): UsageRunResult | null {
    return cache.get(accountName) ?? null;
  }

  return { run, getLast };
}

function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}

function defaultSpawnPty(
  command: string,
  args: string[],
  opts: { cwd: string; env: NodeJS.ProcessEnv; cols: number; rows: number },
): FakePty {
  // Inline import so tests can replace this without pulling node-pty into
  // the unit-test runtime.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const pty = require('node-pty').spawn(command, args, opts);
  return {
    write: (d) => pty.write(d),
    kill: () => pty.kill(),
    onData: (cb) => { pty.onData(cb); },
    onExit: (cb) => { pty.onExit((evt: any) => cb({ exitCode: evt.exitCode ?? 0 })); },
  };
}
```

- [ ] **Step 4: Run tests**

Run: `npm test -- usage-runner.test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add electron/services/usage-runner.ts electron/__tests__/usage-runner.test.ts
git commit -m "feat(usage-runner): PTY-based /usage runner with dedup, cache, dual-write"
```

---

## Task 9: Side fix — remove broken `/status` refresh path

**Files:**
- Modify: `electron/services/rate-limits.ts` — delete `refresh()`, `parseStatusOutput()`, the import of `execSync`/`fs` if no longer used
- Modify: `electron/ipc/handlers.ts` — remove `rate_limits_refresh` handler
- Modify: `electron/preload.ts` — remove `rate_limits_refresh` from allow-list
- Modify: `src/lib/api.ts` — remove typed wrapper if any
- Test: `electron/__tests__/rate-limits.test.ts` and `electron/__tests__/ipc-handlers.test.ts`

- [ ] **Step 1: Find every caller**

Run: `grep -rn 'rate_limits_refresh\|rateLimits\.refresh\b\|parseStatusOutput' electron src`
Expected: hits to remove from rate-limits.ts, ipc/handlers.ts, preload.ts, api.ts, and any UI component.

- [ ] **Step 2: Update tests first**

Remove or update any test that exercises `refresh()` or `rate_limits_refresh`. If a test currently asserts the broken behavior, delete it; if a test asserts that the channel exists in the allow-list, update the expected list to omit `rate_limits_refresh`.

- [ ] **Step 3: Run tests to confirm fail**

Run: `npm test -- rate-limits ipc-handlers`
Expected: FAIL only on the renamed/removed expectations from Step 2.

- [ ] **Step 4: Make the deletions**

In `electron/services/rate-limits.ts`:
- Delete the `refresh` method declaration from the `RateLimitsService` interface.
- Delete the `refresh` function and the `parseStatusOutput` function.
- Drop `refresh` from the returned object.
- Drop the `findClaudeBinary` (already moved in Task 7) and any now-unused imports (`execSync`, `fs`).

In `electron/ipc/handlers.ts`:
- Remove the `rate_limits_refresh` handler entry.

In `electron/preload.ts`:
- Remove `'rate_limits_refresh'` from the allow-list.

In `src/lib/api.ts`:
- Remove the typed wrapper if it exists.

In any UI component that called this (likely `SessionHeader.tsx` or `RateLimitWidget.tsx`'s onClick): leave the click handler stub for now — Task 12 wires it back to `runUsageCli`.

- [ ] **Step 5: Run tests**

Run: `npm test`
Expected: PASS.

- [ ] **Step 6: Run full check**

Run: `npm run check`
Expected: clean.

- [ ] **Step 7: Commit**

```bash
git add electron/services/rate-limits.ts electron/ipc/handlers.ts electron/preload.ts src/lib/api.ts electron/__tests__/
git commit -m "fix(rate-limits): remove broken /status refresh path"
```

---

## Task 10: IPC wiring for usage-runner

**Files:**
- Modify: `electron/main.ts` — construct service, pass to handlers
- Modify: `electron/ipc/handlers.ts` — register channels
- Modify: `electron/preload.ts` — allow-list
- Modify: `src/lib/api.ts` — typed wrappers
- Test: `electron/__tests__/ipc-handlers.test.ts`

- [ ] **Step 1: Write failing test**

In `electron/__tests__/ipc-handlers.test.ts`, append:

```ts
it('usage_run_cli routes to UsageRunnerService.run', async () => {
  const usageRunner = { run: vi.fn().mockResolvedValue({ ok: true, observed_at: 1, raw: '', parsed: {} }), getLast: vi.fn() };
  const handlers = registerIpcHandlersForTest({ usageRunner });
  await invoke(handlers, 'usage_run_cli', { accountName: 'personal' });
  expect(usageRunner.run).toHaveBeenCalledWith('personal');
});

it('usage_get_last routes to UsageRunnerService.getLast', async () => {
  const usageRunner = { run: vi.fn(), getLast: vi.fn().mockReturnValue(null) };
  const handlers = registerIpcHandlersForTest({ usageRunner });
  await invoke(handlers, 'usage_get_last', { accountName: 'personal' });
  expect(usageRunner.getLast).toHaveBeenCalledWith('personal');
});

it('accounts_validate_cli_path routes to validator', async () => {
  const handlers = registerIpcHandlersForTest({});
  const r = await invoke(handlers, 'accounts_validate_cli_path', { path: '' });
  expect(r).toEqual({ ok: true });
});
```

(Re-use `registerIpcHandlersForTest` and `invoke` helpers from the existing file. If those don't exist with that exact name, mirror the patterns already in the file.)

- [ ] **Step 2: Run to fail**

Run: `npm test -- ipc-handlers`
Expected: FAIL — handlers not registered.

- [ ] **Step 3: Wire handlers**

In `electron/ipc/handlers.ts`, add to the deps interface:

```ts
usageRunner?: UsageRunnerService;
```

Register handlers:

```ts
import { validateCliPath } from '../services/cli-path-validator';
// ...
usage_run_cli: wrapWith((p: Record<string, unknown>) =>
  usageRunner?.run((p.accountName ?? p.account_name) as string) ?? null),
usage_get_last: wrapWith((p: Record<string, unknown>) =>
  usageRunner?.getLast((p.accountName ?? p.account_name) as string) ?? null),
accounts_validate_cli_path: wrapWith((p: Record<string, unknown>) =>
  validateCliPath(((p.path ?? p.cli_path) as string) ?? null)),
```

In `electron/preload.ts`, add to the allow-list:

```ts
'usage_run_cli',
'usage_get_last',
'accounts_validate_cli_path',
```

In `electron/main.ts`, construct and pass the service:

```ts
import { createUsageRunnerService } from './services/usage-runner';
// ... after rateLimits + accounts services exist:
const usageRunner = createUsageRunnerService({
  accounts,
  rateLimits,
  logging,
});
// pass into registerIpcHandlers({ ..., usageRunner })
```

In `src/lib/api.ts`, add typed wrappers:

```ts
import type { UsageRunResult } from '../../electron/services/usage-runner';

// In the API object:
runUsageCli: (accountName: string): Promise<UsageRunResult> =>
  invoke('usage_run_cli', { accountName }),
getLastUsageCli: (accountName: string): Promise<UsageRunResult | null> =>
  invoke('usage_get_last', { accountName }),
validateCliPath: (path: string | null): Promise<{ ok: true } | { ok: false; error: string }> =>
  invoke('accounts_validate_cli_path', { path }),
```

(Adapt to the actual shape of `src/lib/api.ts` — likely a `createApi(adapter)` factory with `invoke` already in scope.)

- [ ] **Step 4: Run tests**

Run: `npm test -- ipc-handlers`
Expected: PASS.

- [ ] **Step 5: Run check**

Run: `npm run check`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add electron/main.ts electron/ipc/handlers.ts electron/preload.ts src/lib/api.ts electron/__tests__/ipc-handlers.test.ts
git commit -m "feat(ipc): wire usage-runner channels + cli_path validator"
```

---

## Task 11: `useUsageAutoRefresh` hook

**Files:**
- Create: `src/hooks/useUsageAutoRefresh.ts`
- Test: `src/hooks/__tests__/useUsageAutoRefresh.test.ts` (if no test infra for renderer hooks exists, skip the test file — note in PR)

- [ ] **Step 1: Implement**

```ts
// src/hooks/useUsageAutoRefresh.ts
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '@/lib/api';
import type { UsageRunResult } from '../../electron/services/usage-runner';

const REFRESH_MS = 5 * 60_000;
const STALE_MS = 5 * 60_000;

export function useUsageAutoRefresh(accountName: string | null): {
  data: UsageRunResult | null;
  loading: boolean;
  refresh: () => Promise<void>;
} {
  const [data, setData] = useState<UsageRunResult | null>(null);
  const [loading, setLoading] = useState(false);
  const lastRunAt = useRef<number>(0);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const doRun = useCallback(async () => {
    if (!accountName) return;
    setLoading(true);
    try {
      const r = await api.runUsageCli(accountName);
      lastRunAt.current = Date.now();
      setData(r);
    } finally {
      setLoading(false);
    }
  }, [accountName]);

  // Initial fetch (read cache, then refresh if missing/stale)
  useEffect(() => {
    let cancelled = false;
    if (!accountName) { setData(null); return; }
    (async () => {
      const cached = await api.getLastUsageCli(accountName);
      if (cancelled) return;
      if (cached) {
        setData(cached);
        lastRunAt.current = cached.observed_at;
      }
      const stale = !cached || Date.now() - cached.observed_at > STALE_MS;
      if (stale) await doRun();
    })();
    return () => { cancelled = true; };
  }, [accountName, doRun]);

  // Visibility-aware periodic timer
  useEffect(() => {
    if (!accountName) return;

    const start = () => {
      if (intervalRef.current) return;
      intervalRef.current = setInterval(() => {
        if (document.visibilityState === 'visible') {
          void doRun();
        }
      }, REFRESH_MS);
    };
    const stop = () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    };
    const onVis = () => {
      if (document.visibilityState === 'visible') {
        // Catch up if we drifted past an interval while hidden
        if (Date.now() - lastRunAt.current >= REFRESH_MS) void doRun();
        start();
      } else {
        stop();
      }
    };
    if (document.visibilityState === 'visible') start();
    document.addEventListener('visibilitychange', onVis);
    return () => {
      document.removeEventListener('visibilitychange', onVis);
      stop();
    };
  }, [accountName, doRun]);

  return { data, loading, refresh: doRun };
}
```

- [ ] **Step 2: Run check**

Run: `npm run check`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add src/hooks/useUsageAutoRefresh.ts
git commit -m "feat(usage): visibility-aware auto-refresh hook"
```

---

## Task 12: `UsageDetailPopover` component

**Files:**
- Create: `src/components/claude-code-session/UsageDetailPopover.tsx`

- [ ] **Step 1: Implement**

```tsx
// src/components/claude-code-session/UsageDetailPopover.tsx
import * as React from 'react';
import * as Popover from '@radix-ui/react-popover';
import { Loader2, RefreshCw } from 'lucide-react';
import type { UsageRunResult } from '../../../electron/services/usage-runner';
import { cn } from '@/lib/utils';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  trigger: React.ReactNode;
  data: UsageRunResult | null;
  loading: boolean;
  onRefresh: () => void;
  nowMs?: number;
}

const WINDOW_LABELS: Record<string, string> = {
  current_session: 'Current session (5h)',
  week_all_models: 'Current week (all models)',
  week_sonnet: 'Current week (Sonnet only)',
};

function ageLabel(observedAt: number, now: number): string {
  const ms = now - observedAt;
  if (ms < 60_000) return 'just now';
  const min = Math.floor(ms / 60_000);
  if (min < 60) return `${min}m ago`;
  const hrs = Math.floor(min / 60);
  return `${hrs}h ${min % 60}m ago`;
}

function pctColor(pct: number): string {
  if (pct >= 90) return 'bg-red-400';
  if (pct >= 75) return 'bg-orange-400';
  if (pct >= 50) return 'bg-yellow-400';
  return 'bg-green-400';
}

export function UsageDetailPopover({ open, onOpenChange, trigger, data, loading, onRefresh, nowMs }: Props) {
  const now = nowMs ?? Date.now();
  return (
    <Popover.Root open={open} onOpenChange={onOpenChange}>
      <Popover.Trigger asChild>{trigger}</Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          align="end"
          sideOffset={6}
          className={cn(
            'z-50 w-[420px] max-h-[70vh] overflow-y-auto rounded-md border border-border',
            'bg-background p-4 shadow-lg outline-none',
            'data-[state=open]:animate-in data-[state=closed]:animate-out',
          )}
        >
          {data == null && (
            <div className="text-sm text-muted-foreground">No usage data yet.</div>
          )}
          {data && data.ok === false && (
            <div className="space-y-2">
              <div className="text-sm font-medium text-red-400">Couldn't fetch /usage</div>
              <div className="text-xs text-muted-foreground">{data.error}</div>
              {data.raw && (
                <details>
                  <summary className="cursor-pointer text-xs text-muted-foreground">Raw output</summary>
                  <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap text-[11px] text-muted-foreground">
                    {data.raw}
                  </pre>
                </details>
              )}
            </div>
          )}
          {data && data.ok && (
            <div className="space-y-4">
              <Section title="Session">
                <KV k="Cost" v={`$${data.parsed.session.cost_usd.toFixed(4)}`} />
                <KV k="API duration" v={`${data.parsed.session.api_duration_s}s`} />
                <KV k="Wall duration" v={`${data.parsed.session.wall_duration_s}s`} />
                <KV
                  k="Code"
                  v={`+${data.parsed.session.code_added} / -${data.parsed.session.code_removed}`}
                />
                <KV
                  k="Tokens"
                  v={`${data.parsed.session.input_tokens} in / ${data.parsed.session.output_tokens} out`}
                />
                <KV
                  k="Cache"
                  v={`${data.parsed.session.cache_read} read / ${data.parsed.session.cache_write} write`}
                />
              </Section>

              <Section title="Limits">
                {data.parsed.windows.map((w) => (
                  <div key={w.label} className="space-y-1">
                    <div className="flex justify-between text-xs">
                      <span>{WINDOW_LABELS[w.label] ?? w.label}</span>
                      <span className="font-mono">{w.pct_used.toFixed(0)}%</span>
                    </div>
                    <div className="h-1.5 w-full overflow-hidden rounded bg-foreground/10">
                      <div
                        className={cn('h-full', pctColor(w.pct_used))}
                        style={{ width: `${Math.min(100, Math.max(0, w.pct_used))}%` }}
                      />
                    </div>
                    <div className="text-[11px] text-muted-foreground">
                      Resets {w.resets_at_label}
                    </div>
                  </div>
                ))}
              </Section>

              {data.parsed.contributing.length > 0 && (
                <Section title="What's contributing">
                  {data.parsed.contributing.map((c, i) => (
                    <div key={i} className="space-y-0.5">
                      <div className="text-xs font-medium">{c.headline}</div>
                      <div className="text-[11px] text-muted-foreground">{c.detail}</div>
                    </div>
                  ))}
                </Section>
              )}

              <div className="flex items-center justify-between pt-2 border-t border-border">
                <span className="text-[11px] text-muted-foreground">
                  observed {ageLabel(data.observed_at, now)}
                </span>
                <button
                  type="button"
                  onClick={onRefresh}
                  disabled={loading}
                  className={cn(
                    'inline-flex items-center gap-1 rounded px-2 py-1 text-xs font-medium',
                    'hover:bg-foreground/10 disabled:opacity-50',
                  )}
                >
                  {loading
                    ? <Loader2 className="h-3 w-3 animate-spin" />
                    : <RefreshCw className="h-3 w-3" />}
                  Refresh
                </button>
              </div>
            </div>
          )}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="space-y-2">
      <div className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
        {title}
      </div>
      <div className="space-y-1.5">{children}</div>
    </div>
  );
}

function KV({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex justify-between text-xs">
      <span className="text-muted-foreground">{k}</span>
      <span className="font-mono">{v}</span>
    </div>
  );
}
```

- [ ] **Step 2: Run check**

Run: `npm run check`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add src/components/claude-code-session/UsageDetailPopover.tsx
git commit -m "feat(usage): UsageDetailPopover component"
```

---

## Task 13: SessionHeader integration

**Files:**
- Modify: `src/components/SessionHeader.tsx` — wire `useUsageAutoRefresh`, popover triggers, reroute existing 7d refresh button
- Modify: `src/components/claude-code-session/RateLimitWidget.tsx` — accept `onClick` from parent (already accepts; verify wiring)

- [ ] **Step 1: Read current SessionHeader to find the 7d widget refresh button + click hookups**

Run: open `src/components/SessionHeader.tsx`. Find where `RateLimitWidget` is rendered for 5-hour and 7-day windows, and the existing refresh button next to the 7-day widget.

- [ ] **Step 2: Wire the hook + popover**

Inside `SessionHeader`, near the rate-limit widget rendering:

```tsx
import { useUsageAutoRefresh } from '@/hooks/useUsageAutoRefresh';
import { UsageDetailPopover } from './claude-code-session/UsageDetailPopover';

// Inside the component:
const accountName = activeAccount?.name ?? null;
const { data: usageData, loading: usageLoading, refresh: refreshUsage } =
  useUsageAutoRefresh(accountName);
const [popoverOpen, setPopoverOpen] = React.useState(false);
```

Replace the existing 7-day refresh button's `onClick` to call `refreshUsage()` (it previously called `api.refreshRateLimits` or similar — that's gone after Task 9).

Wrap *both* `RateLimitWidget` instances with `UsageDetailPopover`:

```tsx
<UsageDetailPopover
  open={popoverOpen}
  onOpenChange={setPopoverOpen}
  data={usageData}
  loading={usageLoading}
  onRefresh={refreshUsage}
  trigger={
    <RateLimitWidget
      // ...existing props
      onClick={() => setPopoverOpen(true)}
    />
  }
/>
```

(One popover instance, two triggers — easiest is to render two `UsageDetailPopover` instances since they share state via the same `open` / `setPopoverOpen` pair, OR refactor to a single popover anchored to whichever widget was last clicked. The simpler path: two popover instances each with their own `useState`. Pick whichever the existing component layout makes cleaner.)

- [ ] **Step 3: Run check**

Run: `npm run check`
Expected: clean.

- [ ] **Step 4: Smoke test in app**

Run: `npm start` and verify:
- Open a session for an account that has Claude installed.
- After ~3-5s, the 5h and 7d widgets fill with `/usage` data.
- Click either widget — popover opens with full detail.
- Click Refresh in popover — spinner, then refresh.
- Wait 5 min — widgets refresh automatically.
- Hide the window for >5 min, then show it — refresh fires immediately.

- [ ] **Step 5: Commit**

```bash
git add src/components/SessionHeader.tsx src/components/claude-code-session/RateLimitWidget.tsx
git commit -m "feat(session-header): live /usage refresh + popover"
```

---

## Task 14: AccountSettings — `cli_path` UI

**Files:**
- Modify: `src/components/AccountSettings.tsx`

- [ ] **Step 1: Add the field to the account form**

Locate where `account.config_dir` is edited. Below it, add an optional `cli_path` input:

```tsx
import { useState } from 'react';
import { api } from '@/lib/api';

// Inside the form for one account:
const [cliPath, setCliPath] = useState<string>(account.cli_path ?? '');
const [cliPathError, setCliPathError] = useState<string | null>(null);

async function onCliPathBlur() {
  if (!cliPath) { setCliPathError(null); return; }
  const r = await api.validateCliPath(cliPath);
  setCliPathError(r.ok ? null : r.error);
}

async function onBrowse() {
  const r = await api.openFilePicker({ title: 'Select claude binary or wrapper' });
  if (r.path) setCliPath(r.path);
}
```

Render:

```tsx
<label className="block text-sm font-medium">CLI path (optional)</label>
<div className="flex gap-2">
  <input
    type="text"
    value={cliPath}
    onChange={(e) => setCliPath(e.target.value)}
    onBlur={onCliPathBlur}
    placeholder="/Users/you/.local/bin/claude"
    className="flex-1 rounded border px-2 py-1 text-sm"
  />
  <button type="button" onClick={onBrowse} className="rounded border px-2 py-1 text-sm">
    Browse…
  </button>
</div>
{cliPathError && <div className="text-xs text-red-400">{cliPathError}</div>}
<p className="text-[11px] text-muted-foreground">
  Defaults to <code>claude</code> on PATH. Override only for a specific binary
  or wrapper. Shell aliases like <code>claude-personal</code> are resolved by
  your interactive shell and won't work here — paste the resolved path instead
  (e.g. <code>~/.local/bin/claude</code>).
</p>
```

- [ ] **Step 2: Persist via existing update flow**

When the form saves, include `cliPath` in the call to `api.updateAccount(...)`. Update `src/lib/api.ts`'s `updateAccount` typed wrapper signature if needed to include the new optional `cliPath` argument; the IPC adapter should already pass through unknown fields, but verify.

- [ ] **Step 3: Verify file picker IPC exists**

If `api.openFilePicker` doesn't exist, add a minimal handler now in `electron/ipc/handlers.ts`:

```ts
import { dialog } from 'electron';
// ...
open_file_picker: wrapWith(async (p: Record<string, unknown>) => {
  const r = await dialog.showOpenDialog({
    title: (p.title as string) ?? 'Select file',
    properties: ['openFile'],
  });
  if (r.canceled || r.filePaths.length === 0) return { path: null };
  return { path: r.filePaths[0] };
}),
```

Add to preload allow-list and `api.ts`:

```ts
openFilePicker: (opts: { title?: string }) => invoke('open_file_picker', opts),
```

- [ ] **Step 4: Run check**

Run: `npm run check`
Expected: clean.

- [ ] **Step 5: Smoke**

Run: `npm start`, open AccountSettings, browse for a binary, save, reopen, verify it persists.

- [ ] **Step 6: Commit**

```bash
git add src/components/AccountSettings.tsx src/lib/api.ts electron/ipc/handlers.ts electron/preload.ts
git commit -m "feat(accounts): cli_path UI with browse + validation"
```

---

## Task 15: Final verification

- [ ] **Step 1: Type check**

Run: `npm run check`
Expected: clean.

- [ ] **Step 2: Build**

Run: `npm run build`
Expected: clean.

- [ ] **Step 3: Coverage**

Run: `npm run test:coverage`
Expected: ≥80% lines on backend code (per CLAUDE.md). Verify usage-runner, parser, ANSI stripper, find-claude-binary, cli-path-validator all hit ≥80%.

- [ ] **Step 4: Manual integration**

Run: `npm run rebuild:electron && npm start`
Verify in app:
1. Session opens; widgets fill within ~5s.
2. 5h, 7d bars match what `/usage` shows in `claude-personal` terminal session.
3. Click widget → popover with all 3 windows + contributing factors.
4. Refresh button works in both popover and existing 7d widget.
5. Switch tabs (different account) → widgets refresh for new account independently.
6. AccountSettings → set a custom `cli_path` (e.g. `/usr/bin/false` to test failure path), reload session, see error in popover instead of silent break.

- [ ] **Step 5: Final commit (only if changes pending)**

If anything was tweaked during smoke testing:

```bash
git add -A
git commit -m "fix: smoke-test adjustments for /usage runner"
```

---

## Self-review checklist

- [x] Spec coverage: every section of the spec has a task (schema, accounts, validator, recordUtilization, parser+fixtures, ANSI, runner, IPC, side fix, hook, popover, SessionHeader wiring, AccountSettings UI, verification).
- [x] No placeholders — every step shows actual code or commands.
- [x] Type consistency — `UsageRunResult`, `UsageData`, `UsageWindow` referenced consistently across tasks; `cli_path` field flows from migration → service → IPC → renderer.
- [x] Committable steps — each task ends in a commit; tasks are independently working.
