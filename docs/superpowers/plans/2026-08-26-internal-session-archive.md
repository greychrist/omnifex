# Internal Session Archive Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Retain the transcripts OmniFex's own CLI calls produce, in a clearable per-account archive, and fold their cost into the Cost Report attributed per kind.

**Architecture:** `runCliOnce`'s runner stops `rm -rf`ing the transcript the CLI writes and moves it to `<userData>/internal-sessions/<account>/<kind>/<date>/` instead. The cost backfill gains that archive as a second scan root, stamping a new nullable `internal_kind` column and a display `project_path`. The Brain must exclude the archive or it will index its own output.

**Tech Stack:** Electron main process, TypeScript, `better-sqlite3`, Vitest.

**Spec:** `docs/superpowers/specs/2026-08-26-internal-session-archive-design.md`

## Global Constraints

- TDD. Failing test first, every task. Repo rule, not a preference.
- Backend tests live in `electron/__tests__/*.test.ts`; DB-backed tests use `createDatabase(':memory:')`.
- Run backend tests with `npm test -- <file>`, never bare `npx vitest` — the `pretest` hook rebuilds `better-sqlite3` for the Node ABI and `npx` skips it.
- Run `npm run rebuild:electron` after any vitest run, before the app is launched.
- Kind slugs are exactly `session-summarization`, `brain-index`, `brain-curation`.
- Display labels are exactly `OmniFex/Session summarization`, `OmniFex/Brain index`, `OmniFex/Brain curation`.
- Archive root is `<userData>/internal-sessions`. `userData` is `app.getPath('userData')`, injected — never hard-coded.
- Setting key `internal.archive.retentionDays`, default `90`, `0` means keep forever.
- Every new invoke channel goes in `electron/ipc/channels.ts` AND the preload allow-list.
- Migration 23 must guard on a `sqlite_master` existence check (migration 22's documented trap).

---

### Task 1: Archive path + move primitives

**Files:**
- Create: `electron/services/sessions/internal-archive.ts`
- Test: `electron/__tests__/internal-archive.test.ts`

**Interfaces:**
- Produces: `INTERNAL_KINDS`, `type InternalKind`, `INTERNAL_LABEL`, `ARCHIVE_ROOT_NAME`, `internalArchiveRoot(userData)`, `archiveDirFor(root, account, kind, date)`, `archiveTranscripts(deps)`.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest';
import { internalArchiveRoot, archiveDirFor, INTERNAL_LABEL } from '../services/sessions/internal-archive';

describe('internal archive paths', () => {
  it('roots under userData, partitioned by account, kind and date', () => {
    const root = internalArchiveRoot('/u');
    expect(root).toBe('/u/internal-sessions');
    expect(archiveDirFor(root, 'Work', 'brain-index', '2026-08-26'))
      .toBe('/u/internal-sessions/Work/brain-index/2026-08-26');
  });

  it('labels every kind for the cost report', () => {
    expect(INTERNAL_LABEL['session-summarization']).toBe('OmniFex/Session summarization');
    expect(INTERNAL_LABEL['brain-index']).toBe('OmniFex/Brain index');
    expect(INTERNAL_LABEL['brain-curation']).toBe('OmniFex/Brain curation');
  });

  // An account named "Work/Personal" or ".." must not escape the root.
  it('sanitises account names into a single path segment', () => {
    const d = archiveDirFor('/u/internal-sessions', '../evil', 'brain-index', '2026-08-26');
    expect(d.startsWith('/u/internal-sessions/')).toBe(true);
    expect(d).not.toContain('..');
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

`npm test -- electron/__tests__/internal-archive.test.ts` — fails, module not found.

- [ ] **Step 3: Implement**

```ts
import path from 'path';

export const ARCHIVE_ROOT_NAME = 'internal-sessions';

export const INTERNAL_KINDS = ['session-summarization', 'brain-index', 'brain-curation'] as const;
export type InternalKind = (typeof INTERNAL_KINDS)[number];

/** Display label. Doubles as `project_path`, so `shortProject()` renders the
 *  last two segments and these read correctly in every existing table. */
export const INTERNAL_LABEL: Record<InternalKind, string> = {
  'session-summarization': 'OmniFex/Session summarization',
  'brain-index': 'OmniFex/Brain index',
  'brain-curation': 'OmniFex/Brain curation',
};

export function internalArchiveRoot(userDataPath: string): string {
  return path.join(userDataPath, ARCHIVE_ROOT_NAME);
}

/** Account names are user-supplied and reach the filesystem here, so anything
 *  that is not a safe segment character is collapsed. `..` must never survive. */
function segment(name: string): string {
  const s = name.replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+/, '_');
  return s.length ? s : '_';
}

export function archiveDirFor(root: string, account: string, kind: InternalKind, date: string): string {
  return path.join(root, segment(account), kind, date);
}
```

- [ ] **Step 4: Run tests — pass**
- [ ] **Step 5: Commit** — `feat: internal archive path primitives`

---

### Task 2: The move, and it must not lose money

**Files:**
- Modify: `electron/services/sessions/internal-archive.ts`
- Test: `electron/__tests__/internal-archive.test.ts`

**Interfaces:**
- Produces: `archiveTranscripts({ fs, projectsDir, destDir }): Promise<{ moved: string[]; failed: string[] }>`

- [ ] **Step 1: Write the failing tests** — move succeeds; a failing move leaves the source intact and reports it; a missing projects dir is not an error.

```ts
it('moves each jsonl and reports what moved', async () => {
  const fs = fakeFs({ '/p/a.jsonl': 'x', '/p/b.jsonl': 'y' });
  const r = await archiveTranscripts({ fs, projectsDir: '/p', destDir: '/d' });
  expect(r.moved.sort()).toEqual(['/d/a.jsonl', '/d/b.jsonl']);
  expect(r.failed).toEqual([]);
  expect(fs.exists('/p/a.jsonl')).toBe(false);
});

// The whole point: a failed move must never delete the only copy.
it('leaves the source in place when the move fails', async () => {
  const fs = fakeFs({ '/p/a.jsonl': 'x' }, { failRename: true });
  const r = await archiveTranscripts({ fs, projectsDir: '/p', destDir: '/d' });
  expect(r.failed).toEqual(['/p/a.jsonl']);
  expect(fs.exists('/p/a.jsonl')).toBe(true);
});

it('treats a missing projects dir as nothing to do', async () => {
  const r = await archiveTranscripts({ fs: fakeFs({}), projectsDir: '/nope', destDir: '/d' });
  expect(r).toEqual({ moved: [], failed: [] });
});
```

- [ ] **Step 2: Run — fail**
- [ ] **Step 3: Implement.** `mkdir -p destDir`, list `*.jsonl`, `rename` each; on `EXDEV` fall back to copy-then-unlink; verify the destination exists before considering it moved; collect failures rather than throwing.
- [ ] **Step 4: Run — pass**
- [ ] **Step 5: Commit** — `feat: archive transcripts instead of deleting them`

---

### Task 3: Wire the runner — kind becomes required

**Files:**
- Modify: `electron/services/sessions/summary-query.ts` (`SummaryQueryOptions`, `SummaryQueryDeps`, the `finally` block at ~line 240)
- Modify: `electron/services/brain/extract.ts:326`, `electron/services/brain/curation.ts:168`, `electron/main.ts:528`
- Test: `electron/__tests__/sessions-summary-query.test.ts`

**Interfaces:**
- Consumes: `archiveTranscripts`, `archiveDirFor`, `InternalKind` (Tasks 1–2).
- Produces: `SummaryQueryOptions.kind: InternalKind` (required); `SummaryQueryDeps.archiveRoot?: string`, `SummaryQueryDeps.now?: () => Date`.

- [ ] **Step 1: Write the failing test** — the runner archives to `<root>/<account>/<kind>/<date>/` and does NOT delete; a run still clears the scratch projects dir afterwards.
- [ ] **Step 2: Run — fail**
- [ ] **Step 3: Implement.** Replace the `fsPromises.rm(projectsDir)` sweep with: `archiveTranscripts(...)` → then `rm` the (now empty) projects dir. Account name comes from the caller's `configDir` via the injected account lookup — never `resolve()`. Callers pass `kind`: `sessions-summary` → `session-summarization`, `extract.ts` → `brain-index`, `curation.ts` → `brain-curation`.
- [ ] **Step 4: Run — pass**
- [ ] **Step 5: Commit** — `feat: internal CLI runs archive their transcripts`

---

### Task 4: Migration 23 — `internal_kind`

**Files:**
- Modify: `electron/services/database.ts` (append after the migration 22 entry, ~line 797)
- Test: `electron/__tests__/database-migration-v23.test.ts`

- [ ] **Step 1: Write the failing test** — column exists and defaults NULL; existing rows keep NULL; idempotent; safe against a partial image with no `session_cost_daily`.
- [ ] **Step 2: Run — fail**
- [ ] **Step 3: Implement**

```ts
{
  version: 23,
  description:
    'Add session_cost_daily.internal_kind: which OmniFex-internal activity paid '
    + 'for a row (session-summarization | brain-index | brain-curation), NULL for '
    + 'a real user session. Nullable so every existing row and every existing '
    + 'query keeps its current meaning. See '
    + 'docs/superpowers/specs/2026-08-26-internal-session-archive-design.md.',
  up: (db) => {
    const exists = db
      .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='session_cost_daily'")
      .get() !== undefined;
    if (!exists) return;
    const has = (db.prepare('PRAGMA table_info(session_cost_daily)').all() as Array<{ name: string }>)
      .some((c) => c.name === 'internal_kind');
    if (!has) db.exec('ALTER TABLE session_cost_daily ADD COLUMN internal_kind TEXT');
  },
}
```

- [ ] **Step 4: Run — pass**
- [ ] **Step 5: Commit** — `feat: migration 23, internal_kind on session_cost_daily`

---

### Task 5: Cost ingest scans the archive

**Files:**
- Modify: `electron/services/cost/cost-history.ts` (`backfill` ~line 591, `replaceSession` insert ~line 370, `SessionCostDailyRow`)
- Modify: `electron/services/cost/session-cost-core.ts` (carry `internal_kind` through)
- Test: `electron/__tests__/cost-internal-archive.test.ts`

**Interfaces:**
- Consumes: `internalArchiveRoot`, `INTERNAL_LABEL`, `InternalKind`.
- Produces: `backfill(accounts, opts?: { archiveRoot?: string })`.

- [ ] **Step 1: Write the failing test** — an archived transcript is priced, stamped with its `internal_kind`, and its `project_path` is the display label; a normal session still gets `internal_kind` NULL; re-running is idempotent.
- [ ] **Step 2: Run — fail**
- [ ] **Step 3: Implement.** Walk `<archiveRoot>/<account>/<kind>/<date>/*.jsonl`, same parser and pricing as the projects walk. `account_name` from the directory, `project_path` from `INTERNAL_LABEL[kind]`, `internal_kind` from the directory. Reuse `sessionFileSignature` so unchanged files are skipped.
- [ ] **Step 4: Run — pass**
- [ ] **Step 5: Commit** — `feat: price archived internal transcripts`

---

### Task 6: The Brain must not index its own output

**Files:**
- Modify: `electron/services/brain/sources/session-transcripts.ts`
- Test: `electron/__tests__/brain-source-excludes-archive.test.ts`

- [ ] **Step 1: Write the failing test** — a source scan pointed at a config dir plus an archive root returns zero items from the archive, including nested date directories. This test must fail loudly; a feedback loop here costs money on every cycle.
- [ ] **Step 2: Run — fail**
- [ ] **Step 3: Implement.** The archive lives outside `<configDir>/projects`, so the existing walk should not reach it — the test pins that, and the scratch-name exclusion stays for pre-change leftovers.
- [ ] **Step 4: Run — pass**
- [ ] **Step 5: Commit** — `test: pin that the Brain never indexes the internal archive`

---

### Task 7: Retention — prune and clear

**Files:**
- Modify: `electron/services/sessions/internal-archive.ts`
- Modify: `electron/ipc/channels.ts`, `electron/ipc/handlers.ts`, `electron/preload.ts`, `electron/main.ts`, `src/lib/api.ts`
- Test: `electron/__tests__/internal-archive-retention.test.ts`

**Interfaces:**
- Produces: `pruneInternalArchive(fs, root, retentionDays, today)`, `internalArchiveStats(fs, root)`, `clearInternalArchive(fs, root)`; channels `internal_archive_stats`, `internal_archive_clear`.

- [ ] **Step 1: Write the failing tests** — prunes date dirs older than the cap, keeps newer; `0` keeps everything; **pruning leaves `session_cost_daily` untouched, before and after a backfill** (the property the single accounting path depends on); stats report file count and bytes.
- [ ] **Step 2: Run — fail**
- [ ] **Step 3: Implement.** Prune on the existing background timer. Setting `internal.archive.retentionDays` read from `app_settings`, default 90.
- [ ] **Step 4: Run — pass**
- [ ] **Step 5: Commit** — `feat: internal archive retention and clear`

---

### Task 8: Settings UI

**Files:**
- Modify: the Brain/Advanced settings pane under `src/components/`
- Test: `src/components/__tests__/InternalArchiveSettings.test.tsx` (needs `// @vitest-environment jsdom`)

- [ ] **Step 1: Write the failing test** — renders size and file count; Clear asks for confirmation; confirming calls the channel and re-reads stats; the copy states that cost history is unaffected.
- [ ] **Step 2: Run — fail**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run — pass**
- [ ] **Step 5: Commit** — `feat: internal archive controls in settings`

---

### Task 9: Historical reconciliation

**Files:**
- Modify: `electron/services/database.ts` (migration 24)
- Test: `electron/__tests__/database-migration-v24.test.ts`

- [ ] **Step 1: Write the failing test** — racy scratch-derived rows (`project_path LIKE '%omnifex-summary-scratch%'`) are removed; authoritative rows are inserted from `brain_spend` with the right `internal_kind` and label; running twice does not double the Brain rows.
- [ ] **Step 2: Run — fail**
- [ ] **Step 3: Implement.** `kind='index'` → `brain-index`, `kind='curation'` → `brain-curation`. Pre-change session-summarization spend is unrecoverable and is NOT invented.
- [ ] **Step 4: Run — pass**
- [ ] **Step 5: Commit** — `feat: migration 24, reconcile historical internal spend`

---

### Task 10: Docs

**Files:**
- Modify: `CLAUDE.md` (the Brain "Rules that are load-bearing" bullet)
- Modify: `docs/superpowers/specs/2026-08-26-internal-session-archive-design.md` (status → implemented)

- [ ] **Step 1:** Delete "Extraction transcripts are swept, so nothing else on the machine can see this spend." It is already false (382 files on disk) and this change makes it deliberately so. Replace with the archive's location and the fact that internal spend is folded into the Cost Report per kind.
- [ ] **Step 2: Commit** — `docs: internal transcripts are retained, not swept`

---

## Self-Review

**Spec coverage:** archive layout → T1; writer/move safety → T2; caller wiring + required kind → T3; `internal_kind` → T4; ingest + attribution → T5; Brain exclusion → T6; retention + clear → T7; settings surface → T8; historical reconciliation → T9; the false `CLAUDE.md` invariant → T10. The two catalog handshakes (`models.ts`, `commands-catalog.ts`) are verification-only per the spec and are checked during T3.

**Type consistency:** `InternalKind` slugs and `INTERNAL_LABEL` keys are identical in T1, T3, T5 and T9. `archiveTranscripts` returns `{ moved, failed }` in T2 and is consumed that way in T3.
