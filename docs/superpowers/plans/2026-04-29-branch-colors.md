# Branch Colors Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add per-project pinned branch colors with auto-cycling that never duplicates within a view, plus side-tasks: convert all raw `<select>` to shadcn `<Select>` and fix the Opus 200K context-window mis-reporting.

**Architecture:** New `branch_colors` SQLite table + service + IPC. A pure resolver in `src/lib/branchColors.ts` decides each chip's color from (pins, main-folder branch, branch list). `GitBranchBadge` becomes presentational. A new `BranchColorsCard` component is mounted in the project page right column above the session list.

**Tech Stack:** Electron 28+, React 18, TypeScript, Tailwind v4, shadcn/ui, Radix Select, better-sqlite3, Vitest.

**Spec:** `docs/superpowers/specs/2026-04-29-branch-colors-design.md`

---

## File map

**Created**
- `src/components/ui/ColorSwatchGrid.tsx` — extracted reusable swatch grid
- `electron/services/branch-colors.ts` — CRUD service
- `electron/__tests__/branch-colors.test.ts` — service tests
- `electron/services/git-branches.ts` — `listBranches(projectPath)` helper
- `electron/__tests__/git-branches.test.ts` — branch-listing tests
- `src/lib/branchColors.ts` — pure resolver + palette
- `src/lib/__tests__/branchColors.test.ts` — resolver tests
- `src/components/BranchColorsCard.tsx` — project-page card UI

**Modified**
- `electron/services/database.ts` — add migration v6 for `branch_colors`
- `electron/main.ts` — construct services, register handlers
- `electron/ipc/handlers.ts` — add `Services.branchColors` and `Services.gitBranches` blocks + handler registrations
- `electron/preload.ts` — extend `ALLOWED_INVOKE_CHANNELS`
- `src/lib/api.ts` — typed wrappers for new IPC
- `electron/services/sessions/lifecycle.ts` — model id translation + diagnostic log
- `electron/__tests__/sessions.test.ts` — model translation test
- `src/components/claude-code-session/GitBranchBadge.tsx` — presentational refactor
- `src/components/ClaudeCodeSession.tsx` — use resolver, pass colors to badges
- `src/components/SessionHeader.tsx` — Opus 200K clamp (if path A)
- `src/components/TabContent.tsx` — wrap right column, mount card, fetch data
- `src/components/AccountSettings.tsx` — import from `ui/ColorSwatchGrid`; replace 6 selects
- `src/components/Settings.tsx` — replace 1 select
- `src/components/SessionPermissionsEditor.tsx` — replace 1 select
- `src/components/ProjectList.tsx` — replace 1 select

---

## Phase A — Branch colors core

### Task 1: Extract `ColorSwatchGrid` to a shared module

**Files:**
- Create: `src/components/ui/ColorSwatchGrid.tsx`
- Modify: `src/components/AccountSettings.tsx:13-57`

- [ ] **Step 1: Create the shared module**

```tsx
// src/components/ui/ColorSwatchGrid.tsx
import * as React from "react";
import { cn } from "@/lib/utils";

export const SWATCHES = [
  "#ef4444", // red
  "#f59e0b", // amber
  "#84cc16", // lime
  "#10b981", // emerald
  "#06b6d4", // cyan
  "#3b82f6", // blue
  "#a78bfa", // violet
  "#ec4899", // pink
  "#6b7280", // gray
];

export interface ColorSwatchGridProps {
  value: string;
  onChange: (color: string) => void;
}

export const ColorSwatchGrid: React.FC<ColorSwatchGridProps> = ({ value, onChange }) => {
  return (
    <div className="flex flex-wrap gap-1.5">
      {SWATCHES.map((swatch) => (
        <button
          key={swatch}
          type="button"
          onClick={() => onChange(swatch)}
          className={cn(
            "w-[22px] h-[22px] rounded cursor-pointer transition-shadow",
            value.toLowerCase() === swatch.toLowerCase()
              ? "ring-2 ring-white ring-offset-0"
              : "ring-1 ring-white/10 hover:ring-white/30",
          )}
          style={{ backgroundColor: swatch }}
          aria-label={`Select color ${swatch}`}
        />
      ))}
      <input
        type="color"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-[22px] h-[22px] rounded cursor-pointer border border-border bg-transparent"
        title="Custom color"
      />
    </div>
  );
};
```

- [ ] **Step 2: Update `AccountSettings.tsx` to import from the new module**

In `src/components/AccountSettings.tsx`, delete the local `SWATCHES` constant (lines 13-23), the `ColorSwatchGridProps` interface (lines 25-28), and the local `ColorSwatchGrid` component (lines 30-57). Add this import near the top:

```tsx
import { ColorSwatchGrid } from "@/components/ui/ColorSwatchGrid";
```

- [ ] **Step 3: Verify**

```bash
npm run check
```

Expected: PASS (no type errors).

- [ ] **Step 4: Commit**

```bash
git add src/components/ui/ColorSwatchGrid.tsx src/components/AccountSettings.tsx
git commit -m "refactor: extract ColorSwatchGrid to shared ui module"
```

---

### Task 2: Add migration v6 for `branch_colors` table

**Files:**
- Modify: `electron/services/database.ts:40-108` (append migration), `:210-...` (initSchema)
- Test: `electron/__tests__/database.test.ts`

- [ ] **Step 1: Write the failing test**

Append this test to `electron/__tests__/database.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { createDatabase } from '../services/database';

describe('database migration v6', () => {
  it('creates branch_colors table with the expected columns', () => {
    const db = createDatabase(':memory:');
    const cols = db.raw.pragma('table_info(branch_colors)') as { name: string; type: string }[];
    const names = new Set(cols.map((c) => c.name));
    expect(names.has('id')).toBe(true);
    expect(names.has('project_path')).toBe(true);
    expect(names.has('branch_name')).toBe(true);
    expect(names.has('color')).toBe(true);
    expect(names.has('sort_order')).toBe(true);
    expect(names.has('created_at')).toBe(true);
    db.close();
  });

  it('enforces unique (project_path, branch_name)', () => {
    const db = createDatabase(':memory:');
    db.raw.prepare(
      "INSERT INTO branch_colors (project_path, branch_name, color, sort_order, created_at) VALUES (?, ?, ?, ?, ?)"
    ).run('/p', 'develop', '#3b82f6', 0, Date.now());
    expect(() =>
      db.raw.prepare(
        "INSERT INTO branch_colors (project_path, branch_name, color, sort_order, created_at) VALUES (?, ?, ?, ?, ?)"
      ).run('/p', 'develop', '#84cc16', 0, Date.now())
    ).toThrow(/UNIQUE constraint/);
    db.close();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npm test -- database.test.ts
```

Expected: FAIL — `branch_colors` table doesn't exist.

- [ ] **Step 3: Add the migration**

Append to the `migrations` array in `electron/services/database.ts` (after version 5):

```ts
{
  version: 6,
  description: 'Add branch_colors table',
  up: (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS branch_colors (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_path TEXT NOT NULL,
        branch_name TEXT NOT NULL,
        color TEXT NOT NULL,
        sort_order INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        UNIQUE(project_path, branch_name)
      );
      CREATE INDEX IF NOT EXISTS idx_branch_colors_project ON branch_colors(project_path);
    `);
  },
},
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npm test -- database.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add electron/services/database.ts electron/__tests__/database.test.ts
git commit -m "feat(db): add branch_colors table (migration v6)"
```

---

### Task 3: Implement `branch-colors` service (TDD)

**Files:**
- Create: `electron/services/branch-colors.ts`
- Create: `electron/__tests__/branch-colors.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `electron/__tests__/branch-colors.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createDatabase, type Database } from '../services/database';
import { createBranchColorsService, type BranchColorsService } from '../services/branch-colors';

describe('branchColors service', () => {
  let db: Database;
  let svc: BranchColorsService;

  beforeEach(() => {
    db = createDatabase(':memory:');
    svc = createBranchColorsService(db);
  });

  afterEach(() => {
    db.close();
  });

  it('lists empty for a fresh project', () => {
    expect(svc.listForProject('/p')).toEqual([]);
  });

  it('upserts a new pin', () => {
    const created = svc.upsert({ project_path: '/p', branch_name: 'develop', color: '#3b82f6' });
    expect(created.id).toBeGreaterThan(0);
    expect(created.color).toBe('#3b82f6');
    expect(svc.listForProject('/p')).toHaveLength(1);
  });

  it('upsert replaces color when (project_path, branch_name) already exists', () => {
    svc.upsert({ project_path: '/p', branch_name: 'develop', color: '#3b82f6' });
    const updated = svc.upsert({ project_path: '/p', branch_name: 'develop', color: '#10b981' });
    expect(updated.color).toBe('#10b981');
    expect(svc.listForProject('/p')).toHaveLength(1);
  });

  it('returns rows ordered by sort_order then id', () => {
    svc.upsert({ project_path: '/p', branch_name: 'a', color: '#3b82f6' });
    svc.upsert({ project_path: '/p', branch_name: 'b', color: '#10b981' });
    svc.upsert({ project_path: '/p', branch_name: 'c', color: '#ef4444' });
    expect(svc.listForProject('/p').map((r) => r.branch_name)).toEqual(['a', 'b', 'c']);
  });

  it('deletes by id and returns true on success', () => {
    const row = svc.upsert({ project_path: '/p', branch_name: 'develop', color: '#3b82f6' });
    expect(svc.delete(row.id)).toBe(true);
    expect(svc.listForProject('/p')).toHaveLength(0);
  });

  it('delete returns false when row does not exist', () => {
    expect(svc.delete(999)).toBe(false);
  });

  it('isolates rows by project_path', () => {
    svc.upsert({ project_path: '/p1', branch_name: 'develop', color: '#3b82f6' });
    svc.upsert({ project_path: '/p2', branch_name: 'develop', color: '#10b981' });
    expect(svc.listForProject('/p1')).toHaveLength(1);
    expect(svc.listForProject('/p2')).toHaveLength(1);
    expect(svc.listForProject('/p1')[0].color).toBe('#3b82f6');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npm test -- branch-colors.test.ts
```

Expected: FAIL — service doesn't exist.

- [ ] **Step 3: Implement the service**

Create `electron/services/branch-colors.ts`:

```ts
import type { Database } from './database';

export interface BranchColor {
  id: number;
  project_path: string;
  branch_name: string;
  color: string;
  sort_order: number;
  created_at: number;
}

export interface BranchColorUpsert {
  project_path: string;
  branch_name: string;
  color: string;
}

export interface BranchColorsService {
  listForProject(projectPath: string): BranchColor[];
  upsert(input: BranchColorUpsert): BranchColor;
  delete(id: number): boolean;
}

export function createBranchColorsService(db: Database): BranchColorsService {
  const raw = db.raw;

  const listStmt = raw.prepare<[string]>(
    `SELECT id, project_path, branch_name, color, sort_order, created_at
       FROM branch_colors
      WHERE project_path = ?
      ORDER BY sort_order ASC, id ASC`,
  );

  const upsertStmt = raw.prepare<[string, string, string, number, number]>(
    `INSERT INTO branch_colors (project_path, branch_name, color, sort_order, created_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(project_path, branch_name)
     DO UPDATE SET color = excluded.color
     RETURNING id, project_path, branch_name, color, sort_order, created_at`,
  );

  const deleteStmt = raw.prepare<[number]>(`DELETE FROM branch_colors WHERE id = ?`);

  return {
    listForProject(projectPath: string): BranchColor[] {
      return listStmt.all(projectPath) as BranchColor[];
    },

    upsert(input: BranchColorUpsert): BranchColor {
      const now = Date.now();
      const nextOrderRow = raw
        .prepare(
          `SELECT COALESCE(MAX(sort_order), -1) + 1 AS next FROM branch_colors WHERE project_path = ?`,
        )
        .get(input.project_path) as { next: number };
      const row = upsertStmt.get(
        input.project_path,
        input.branch_name,
        input.color,
        nextOrderRow.next,
        now,
      ) as BranchColor;
      return row;
    },

    delete(id: number): boolean {
      const info = deleteStmt.run(id);
      return info.changes > 0;
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npm test -- branch-colors.test.ts
```

Expected: PASS — all 7 cases.

- [ ] **Step 5: Commit**

```bash
git add electron/services/branch-colors.ts electron/__tests__/branch-colors.test.ts
git commit -m "feat: add branch-colors service with CRUD"
```

---

### Task 4: Implement `git-branches` helper (TDD)

**Files:**
- Create: `electron/services/git-branches.ts`
- Create: `electron/__tests__/git-branches.test.ts`

- [ ] **Step 1: Write the failing test**

Create `electron/__tests__/git-branches.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import { listBranches } from '../services/git-branches';

describe('listBranches', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'gc-git-test-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns [] for non-git directories', async () => {
    expect(await listBranches(dir)).toEqual([]);
  });

  it('returns the local branch names sorted', async () => {
    execSync('git init -q -b main', { cwd: dir });
    execSync('git config user.email t@t', { cwd: dir });
    execSync('git config user.name t', { cwd: dir });
    execSync('git commit --allow-empty -q -m initial', { cwd: dir });
    execSync('git branch develop', { cwd: dir });
    execSync('git branch feature/x', { cwd: dir });
    expect(await listBranches(dir)).toEqual(['develop', 'feature/x', 'main']);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npm test -- git-branches.test.ts
```

Expected: FAIL — module doesn't exist.

- [ ] **Step 3: Implement the helper**

Create `electron/services/git-branches.ts`:

```ts
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/**
 * List local branch names for a git repo at `projectPath`.
 * Returns [] if the directory is not a repo or git is not installed.
 * Output is sorted alphabetically (git's default for for-each-ref refs/heads).
 */
export async function listBranches(projectPath: string): Promise<string[]> {
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['for-each-ref', 'refs/heads', '--format=%(refname:short)'],
      { cwd: projectPath },
    );
    return stdout
      .split('\n')
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
      .sort();
  } catch {
    return [];
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npm test -- git-branches.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add electron/services/git-branches.ts electron/__tests__/git-branches.test.ts
git commit -m "feat: add git-branches listBranches helper"
```

---

### Task 5: Wire IPC channels for branch colors and git branches

**Files:**
- Modify: `electron/preload.ts:5-...` (allow-list)
- Modify: `electron/ipc/handlers.ts:17-...` (Services interface + registration)
- Modify: `electron/main.ts` (construct services, pass to handlers)
- Modify: `src/lib/api.ts` (typed wrappers)

- [ ] **Step 1: Add channel names to preload allow-list**

Append to `ALLOWED_INVOKE_CHANNELS` in `electron/preload.ts`:

```ts
  // Branch colors
  'branch_colors_list',
  'branch_colors_upsert',
  'branch_colors_delete',

  // Git
  'git_list_branches',
```

- [ ] **Step 2: Add Services entries and handlers in `electron/ipc/handlers.ts`**

Add to the `Services` interface (after the existing service blocks):

```ts
  branchColors?: {
    listForProject(projectPath: string): unknown;
    upsert(input: { project_path: string; branch_name: string; color: string }): unknown;
    delete(id: number): unknown;
  };
  gitBranches?: {
    list(projectPath: string): Promise<string[]>;
  };
```

In the `registerIpcHandlers` function (the section that registers handlers), add:

```ts
  if (services.branchColors) {
    const bc = services.branchColors;
    ipcMain.handle('branch_colors_list', (_e, projectPath: string) =>
      bc.listForProject(projectPath),
    );
    ipcMain.handle('branch_colors_upsert', (_e, data: { project_path?: string; projectPath?: string; branch_name?: string; branchName?: string; color: string }) =>
      bc.upsert({
        project_path: (data.project_path ?? data.projectPath) as string,
        branch_name: (data.branch_name ?? data.branchName) as string,
        color: data.color,
      }),
    );
    ipcMain.handle('branch_colors_delete', (_e, id: number) => bc.delete(id));
  }
  if (services.gitBranches) {
    const gb = services.gitBranches;
    ipcMain.handle('git_list_branches', (_e, projectPath: string) => gb.list(projectPath));
  }
```

- [ ] **Step 3: Construct services in `electron/main.ts`**

Where the other services are built (search for `createAccountsService`), add:

```ts
import { createBranchColorsService } from './services/branch-colors';
import { listBranches } from './services/git-branches';

// ...existing service creation...
const branchColors = createBranchColorsService(db);
const gitBranches = { list: listBranches };
```

Pass them to `registerIpcHandlers({ ..., branchColors, gitBranches })`.

- [ ] **Step 4: Add typed wrappers in `src/lib/api.ts`**

Add a `BranchColor` type and four methods on the existing `api` object. Find the section that defines other CRUD wrappers (e.g. `listAccounts`) and add nearby:

```ts
export interface BranchColor {
  id: number;
  project_path: string;
  branch_name: string;
  color: string;
  sort_order: number;
  created_at: number;
}

// Inside the api wrapper definition:
async listBranchColors(projectPath: string): Promise<BranchColor[]> {
  return (await invoke('branch_colors_list', projectPath)) as BranchColor[];
},
async upsertBranchColor(input: { projectPath: string; branchName: string; color: string }): Promise<BranchColor> {
  return (await invoke('branch_colors_upsert', input)) as BranchColor;
},
async deleteBranchColor(id: number): Promise<boolean> {
  return (await invoke('branch_colors_delete', id)) as boolean;
},
async listGitBranches(projectPath: string): Promise<string[]> {
  return (await invoke('git_list_branches', projectPath)) as string[];
},
```

- [ ] **Step 5: Verify**

```bash
npm run check
npm test
```

Expected: PASS for both.

- [ ] **Step 6: Commit**

```bash
git add electron/preload.ts electron/ipc/handlers.ts electron/main.ts src/lib/api.ts
git commit -m "feat(ipc): wire branch_colors_* and git_list_branches channels"
```

---

### Task 6: Implement the pure resolver (TDD)

**Files:**
- Create: `src/lib/branchColors.ts`
- Create: `src/lib/__tests__/branchColors.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `src/lib/__tests__/branchColors.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { resolveBranchColors, BRANCH_COLORS_PALETTE } from '@/lib/branchColors';

describe('resolveBranchColors', () => {
  it('returns black trunk style for main', () => {
    const r = resolveBranchColors({ pins: {}, mainFolderBranch: 'main', branches: ['main'] });
    expect(r.trunkBlack.has('main')).toBe(true);
    expect(r.colors['main']).toBeUndefined();
  });

  it('returns black trunk style for master', () => {
    const r = resolveBranchColors({ pins: {}, mainFolderBranch: 'master', branches: ['master'] });
    expect(r.trunkBlack.has('master')).toBe(true);
  });

  it('returns blue for the main folder branch when not trunk', () => {
    const r = resolveBranchColors({ pins: {}, mainFolderBranch: 'develop', branches: ['develop'] });
    expect(r.colors['develop']).toBe('#3b82f6');
    expect(r.trunkBlack.has('develop')).toBe(false);
  });

  it('honors a user pin over auto rules (including trunk)', () => {
    const r = resolveBranchColors({
      pins: { main: '#ef4444', develop: '#10b981' },
      mainFolderBranch: 'develop',
      branches: ['main', 'develop'],
    });
    expect(r.colors['main']).toBe('#ef4444');
    expect(r.trunkBlack.has('main')).toBe(false);
    expect(r.colors['develop']).toBe('#10b981');
  });

  it('cycles worktree branches without colliding with trunk-black or main-folder blue', () => {
    const r = resolveBranchColors({
      pins: {},
      mainFolderBranch: 'develop',
      branches: ['develop', 'wt-1', 'wt-2', 'wt-3'],
    });
    expect(r.colors['develop']).toBe('#3b82f6');
    const wts = ['wt-1', 'wt-2', 'wt-3'].map((b) => r.colors[b]);
    expect(new Set(wts).size).toBe(3);
    expect(wts.includes('#3b82f6')).toBe(false);
  });

  it('skips pinned colors when assigning later branches', () => {
    const r = resolveBranchColors({
      pins: { 'wt-1': '#10b981' },
      mainFolderBranch: 'develop',
      branches: ['develop', 'wt-1', 'wt-2', 'wt-3'],
    });
    expect(r.colors['wt-1']).toBe('#10b981');
    expect([r.colors['wt-2'], r.colors['wt-3']]).not.toContain('#10b981');
    expect([r.colors['wt-2'], r.colors['wt-3']]).not.toContain('#3b82f6');
  });

  it('falls back to hash when palette is exhausted', () => {
    const branches = ['develop', ...Array.from({ length: BRANCH_COLORS_PALETTE.length + 2 }, (_, i) => `wt-${i}`)];
    const r = resolveBranchColors({ pins: {}, mainFolderBranch: 'develop', branches });
    for (const b of branches) {
      expect(r.colors[b] ?? null).not.toBe(null);
    }
  });

  it('handles null mainFolderBranch (no repo)', () => {
    const r = resolveBranchColors({ pins: {}, mainFolderBranch: null, branches: [] });
    expect(r.colors).toEqual({});
    expect(r.trunkBlack.size).toBe(0);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npm test -- branchColors.test
```

Expected: FAIL — module doesn't exist.

- [ ] **Step 3: Implement the resolver**

Create `src/lib/branchColors.ts`:

```ts
export const BRANCH_COLORS_PALETTE = [
  '#3b82f6', // blue (also the main-folder default)
  '#a78bfa', // violet
  '#10b981', // emerald
  '#f59e0b', // amber
  '#ec4899', // pink
  '#06b6d4', // cyan
  '#ef4444', // red
  '#84cc16', // lime
];

const MAIN_FOLDER_BLUE = '#3b82f6';
const TRUNK_NAMES = new Set(['main', 'master']);

export interface ResolveInput {
  pins: Record<string, string>;
  mainFolderBranch: string | null;
  branches: string[];
}

export interface ResolveOutput {
  colors: Record<string, string>;
  trunkBlack: Set<string>;
}

function hashColor(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = name.charCodeAt(i) + ((hash << 5) - hash);
  }
  return BRANCH_COLORS_PALETTE[Math.abs(hash) % BRANCH_COLORS_PALETTE.length];
}

export function resolveBranchColors(input: ResolveInput): ResolveOutput {
  const colors: Record<string, string> = {};
  const trunkBlack = new Set<string>();
  const used = new Set<string>();

  for (const branch of input.branches) {
    const pinned = input.pins[branch];
    if (pinned) {
      colors[branch] = pinned;
      used.add(pinned);
      continue;
    }
    if (TRUNK_NAMES.has(branch)) {
      trunkBlack.add(branch);
      continue;
    }
    if (input.mainFolderBranch && branch === input.mainFolderBranch) {
      colors[branch] = MAIN_FOLDER_BLUE;
      used.add(MAIN_FOLDER_BLUE);
      continue;
    }
    const next = BRANCH_COLORS_PALETTE.find((c) => !used.has(c));
    if (next) {
      colors[branch] = next;
      used.add(next);
    } else {
      colors[branch] = hashColor(branch);
    }
  }

  return { colors, trunkBlack };
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npm test -- branchColors.test
```

Expected: PASS — all 8 cases.

- [ ] **Step 5: Commit**

```bash
git add src/lib/branchColors.ts src/lib/__tests__/branchColors.test.ts
git commit -m "feat: add pure branch-color resolver"
```

---

### Task 7: Refactor `GitBranchBadge` to be presentational

**Files:**
- Modify: `src/components/claude-code-session/GitBranchBadge.tsx` (full rewrite)

- [ ] **Step 1: Replace the component**

Rewrite `src/components/claude-code-session/GitBranchBadge.tsx`:

```tsx
import * as React from 'react';
import { GitBranch, FilePen, FilePlus } from 'lucide-react';
import { cn } from '@/lib/utils';

export interface GitBranchBadgeProps {
  name: string;
  changed: number;
  untracked: number;
  /** Resolved hex color for non-trunk chips. Ignored when `isTrunk` is true. */
  color: string | null;
  /** When true, render the black trunk style (overrides `color`). */
  isTrunk: boolean;
}

export const GitBranchBadge: React.FC<GitBranchBadgeProps> = ({
  name,
  changed,
  untracked,
  color,
  isTrunk,
}) => {
  const titleParts = [`Git branch: ${name}`];
  if (changed > 0) titleParts.push(`${changed} changed`);
  if (untracked > 0) titleParts.push(`${untracked} untracked`);

  const useColor = !isTrunk && color != null;

  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 px-2 py-0.5 rounded border text-xs font-mono font-medium',
        isTrunk && 'bg-black text-white border-black',
      )}
      style={
        useColor
          ? {
              backgroundColor: `${color}33`,
              color: color!,
              borderColor: `${color}4d`,
            }
          : undefined
      }
      title={titleParts.join(' · ')}
    >
      <GitBranch className="w-3.5 h-3.5" />
      {name}
      {(changed > 0 || untracked > 0) && (
        <span aria-hidden className="h-3 w-px bg-current opacity-40 mx-0.5" />
      )}
      {changed > 0 && (
        <span className="inline-flex items-center gap-0.5 text-emerald-400">
          <FilePen className="w-3 h-3" />
          {changed}
        </span>
      )}
      {untracked > 0 && (
        <span className="inline-flex items-center gap-0.5 text-amber-300">
          <FilePlus className="w-3 h-3" />
          {untracked}
        </span>
      )}
    </span>
  );
};
```

- [ ] **Step 2: Verify build (it will fail at the call sites that don't pass the new props yet)**

```bash
npm run check
```

Expected: FAIL — `ClaudeCodeSession.tsx` doesn't yet pass `color` / `isTrunk`. That is fixed in Task 8.

(Don't commit yet — combine with Task 8 to keep main green.)

---

### Task 8: Wire resolver into `ClaudeCodeSession` chips

**Files:**
- Modify: `src/components/ClaudeCodeSession.tsx:1341-1374` (chip rendering) + add data fetch
- Modify: imports

- [ ] **Step 1: Add resolver + pin fetch**

Near the existing imports in `src/components/ClaudeCodeSession.tsx`:

```tsx
import { resolveBranchColors } from '@/lib/branchColors';
import type { BranchColor } from '@/lib/api';
```

Inside the component, near the other state declarations, add:

```tsx
const [branchPins, setBranchPins] = React.useState<Record<string, string>>({});

React.useEffect(() => {
  if (!projectPath) return;
  let cancelled = false;
  api.listBranchColors(projectPath).then((rows: BranchColor[]) => {
    if (cancelled) return;
    const map: Record<string, string> = {};
    for (const r of rows) map[r.branch_name] = r.color;
    setBranchPins(map);
  }).catch(() => {});
  return () => { cancelled = true; };
}, [projectPath]);
```

Above the JSX return, compute the resolution:

```tsx
const allBranches: string[] = [
  ...(gitStatus?.branch ? [gitStatus.branch] : []),
  ...worktreeList.map((wt) => wt.branch ?? '(detached)'),
];
const branchColorResolution = resolveBranchColors({
  pins: branchPins,
  mainFolderBranch: gitStatus?.branch ?? null,
  branches: allBranches,
});
```

- [ ] **Step 2: Update both `<GitBranchBadge>` call sites**

Replace the main-folder chip render around `:1345-1349`:

```tsx
<GitBranchBadge
  name={gitStatus.branch}
  changed={gitStatus.changed}
  untracked={gitStatus.untracked}
  color={branchColorResolution.colors[gitStatus.branch] ?? null}
  isTrunk={branchColorResolution.trunkBlack.has(gitStatus.branch)}
/>
```

Replace the worktree chip render around `:1365-1369`:

```tsx
{worktreeList.map((wt) => {
  const branchName = wt.branch ?? '(detached)';
  return (
    <div key={wt.path} title={wt.path}>
      <GitBranchBadge
        name={branchName}
        changed={wt.changed}
        untracked={wt.untracked}
        color={branchColorResolution.colors[branchName] ?? null}
        isTrunk={branchColorResolution.trunkBlack.has(branchName)}
      />
    </div>
  );
})}
```

- [ ] **Step 3: Verify**

```bash
npm run check
npm test
```

Expected: PASS for both.

- [ ] **Step 4: Commit (combine with Task 7)**

```bash
git add src/components/claude-code-session/GitBranchBadge.tsx src/components/ClaudeCodeSession.tsx
git commit -m "feat: render branch badges via central resolver"
```

---

### Task 9: Build `BranchColorsCard`

**Files:**
- Create: `src/components/BranchColorsCard.tsx`

- [ ] **Step 1: Create the component**

Create `src/components/BranchColorsCard.tsx`:

```tsx
import * as React from 'react';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { ColorSwatchGrid, SWATCHES } from '@/components/ui/ColorSwatchGrid';
import { GitBranchBadge } from '@/components/claude-code-session/GitBranchBadge';
import { resolveBranchColors } from '@/lib/branchColors';
import { Pencil, Plus, Trash2, Check, X } from 'lucide-react';
import { api, type BranchColor } from '@/lib/api';

interface BranchColorsCardProps {
  projectPath: string;
  /** Used to populate the branch dropdown in add/edit mode. */
  availableBranches: string[];
  /** Current main-folder branch, used for the chip preview only. */
  mainFolderBranch: string | null;
}

export const BranchColorsCard: React.FC<BranchColorsCardProps> = ({
  projectPath,
  availableBranches,
  mainFolderBranch,
}) => {
  const [rows, setRows] = React.useState<BranchColor[]>([]);
  const [editing, setEditing] = React.useState<{ id: number | null; branch: string; color: string } | null>(null);

  const refresh = React.useCallback(async () => {
    setRows(await api.listBranchColors(projectPath));
  }, [projectPath]);

  React.useEffect(() => { void refresh(); }, [refresh]);

  const startAdd = () => {
    const taken = new Set(rows.map((r) => r.branch_name));
    const firstFree = availableBranches.find((b) => !taken.has(b)) ?? '';
    setEditing({ id: null, branch: firstFree, color: SWATCHES[5] /* blue */ });
  };

  const startEdit = (row: BranchColor) => {
    setEditing({ id: row.id, branch: row.branch_name, color: row.color });
  };

  const cancel = () => setEditing(null);

  const save = async () => {
    if (!editing || !editing.branch) return;
    await api.upsertBranchColor({
      projectPath,
      branchName: editing.branch,
      color: editing.color,
    });
    setEditing(null);
    await refresh();
  };

  const remove = async (id: number) => {
    await api.deleteBranchColor(id);
    await refresh();
  };

  // Preview chips use the resolver in isolation per row so each row reads how
  // the chip will actually render in the session header.
  const branchesForPreview = rows.map((r) => r.branch_name);
  const preview = resolveBranchColors({
    pins: Object.fromEntries(rows.map((r) => [r.branch_name, r.color])),
    mainFolderBranch,
    branches: branchesForPreview,
  });

  return (
    <Card className="p-4">
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-sm font-semibold">Branch Colors</h2>
        {!editing && (
          <Button size="sm" variant="outline" onClick={startAdd} className="h-7 px-2 gap-1 text-xs">
            <Plus className="h-3.5 w-3.5" /> Add
          </Button>
        )}
      </div>

      {rows.length === 0 && !editing && (
        <p className="text-xs text-muted-foreground">No pinned colors yet.</p>
      )}

      <div className="space-y-2">
        {rows.map((row) => {
          const isEditingRow = editing?.id === row.id;
          if (isEditingRow) {
            return (
              <EditorRow
                key={row.id}
                editing={editing!}
                setEditing={setEditing}
                availableBranches={availableBranches}
                takenBranches={new Set(rows.filter((r) => r.id !== row.id).map((r) => r.branch_name))}
                onSave={save}
                onCancel={cancel}
              />
            );
          }
          return (
            <div key={row.id} className="flex items-center gap-2">
              <GitBranchBadge
                name={row.branch_name}
                changed={0}
                untracked={0}
                color={preview.colors[row.branch_name] ?? row.color}
                isTrunk={preview.trunkBlack.has(row.branch_name)}
              />
              <span className="text-xs text-muted-foreground flex-1 truncate">{row.branch_name}</span>
              <Button size="sm" variant="ghost" onClick={() => startEdit(row)} className="h-7 w-7 p-0">
                <Pencil className="h-3.5 w-3.5" />
              </Button>
              <Button size="sm" variant="ghost" onClick={() => remove(row.id)} className="h-7 w-7 p-0">
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </div>
          );
        })}

        {editing && editing.id === null && (
          <EditorRow
            editing={editing}
            setEditing={setEditing}
            availableBranches={availableBranches}
            takenBranches={new Set(rows.map((r) => r.branch_name))}
            onSave={save}
            onCancel={cancel}
          />
        )}
      </div>
    </Card>
  );
};

interface EditorRowProps {
  editing: { id: number | null; branch: string; color: string };
  setEditing: (e: { id: number | null; branch: string; color: string }) => void;
  availableBranches: string[];
  takenBranches: Set<string>;
  onSave: () => void;
  onCancel: () => void;
}

const EditorRow: React.FC<EditorRowProps> = ({ editing, setEditing, availableBranches, takenBranches, onSave, onCancel }) => {
  const branches = availableBranches.length > 0
    ? availableBranches.filter((b) => !takenBranches.has(b) || b === editing.branch)
    : [];

  return (
    <div className="rounded border border-border/50 p-2 space-y-2">
      {branches.length > 0 ? (
        <Select value={editing.branch} onValueChange={(v) => setEditing({ ...editing, branch: v })}>
          <SelectTrigger className="h-8 text-xs">
            <SelectValue placeholder="Choose a branch" />
          </SelectTrigger>
          <SelectContent>
            {branches.map((b) => (
              <SelectItem key={b} value={b} className="text-xs">{b}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : (
        <p className="text-xs text-muted-foreground">No branches detected — open a git repo first.</p>
      )}
      <ColorSwatchGrid value={editing.color} onChange={(color) => setEditing({ ...editing, color })} />
      <div className="flex gap-1 justify-end">
        <Button size="sm" variant="outline" onClick={onCancel} className="h-7 px-2 gap-1 text-xs">
          <X className="h-3.5 w-3.5" /> Cancel
        </Button>
        <Button size="sm" onClick={onSave} disabled={!editing.branch} className="h-7 px-2 gap-1 text-xs">
          <Check className="h-3.5 w-3.5" /> Save
        </Button>
      </div>
    </div>
  );
};
```

- [ ] **Step 2: Verify**

```bash
npm run check
```

Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/components/BranchColorsCard.tsx
git commit -m "feat: add BranchColorsCard component"
```

---

### Task 10: Mount `BranchColorsCard` in the project page

**Files:**
- Modify: `src/components/TabContent.tsx` — wrap right column, fetch git data, mount card

- [ ] **Step 1: Add fetch state for git branches and main-folder branch**

In `src/components/TabContent.tsx`, near other state hooks for the project view (around line 52), add:

```tsx
const [projectBranches, setProjectBranches] = React.useState<string[]>([]);
const [projectMainBranch, setProjectMainBranch] = React.useState<string | null>(null);

React.useEffect(() => {
  if (!selectedProject?.path) {
    setProjectBranches([]);
    setProjectMainBranch(null);
    return;
  }
  let cancelled = false;
  api.listGitBranches(selectedProject.path).then((branches) => {
    if (!cancelled) setProjectBranches(branches);
  }).catch(() => {});
  // Best-effort: pick HEAD branch via for-each-ref of HEAD; fall back to first match for main/master/develop.
  api.listGitBranches(selectedProject.path).then((branches) => {
    if (cancelled) return;
    const candidates = ['main', 'master', 'develop'];
    setProjectMainBranch(branches.find((b) => candidates.includes(b)) ?? branches[0] ?? null);
  }).catch(() => {});
  return () => { cancelled = true; };
}, [selectedProject?.path]);
```

(Note: this populates the card's preview branch from the available branches. Live `gitStatus.branch` updates remain on `ClaudeCodeSession`; the project page just needs *a* main-folder name for the preview.)

- [ ] **Step 2: Mount the card in the right column**

In the right-column wrapper (around line 258, the `<div className="flex-1 min-w-0 w-full">`), insert above the error block:

```tsx
{selectedProject && (
  <div className="mb-4">
    <BranchColorsCard
      projectPath={selectedProject.path}
      availableBranches={projectBranches}
      mainFolderBranch={projectMainBranch}
    />
  </div>
)}
```

Add the import at the top of the file:

```tsx
import { BranchColorsCard } from '@/components/BranchColorsCard';
```

- [ ] **Step 3: Verify**

```bash
npm run check
npm run build
```

Expected: PASS for both.

- [ ] **Step 4: Manual sanity check**

```bash
ELECTRON_ENABLE_LOGGING=1 npm start 2>&1 | tee /tmp/greychrist.log
```

Open a git project (e.g. `~/Repos/personal/greychrist`). Confirm:
- The Branch Colors card is visible in the project page right column above CLAUDE.md Memories.
- Top of the card aligns with the top of the New Session card on the left.
- Add → branch dropdown lists local branches → save → row appears with colored chip preview.
- Edit row → change color → save updates the preview.
- Trash → row disappears.

Stop the app once verified.

- [ ] **Step 5: Commit**

```bash
git add src/components/TabContent.tsx
git commit -m "feat: mount BranchColorsCard on project page"
```

---

## Phase B — `<select>` cleanup

### Task 11: Replace 6 `<select>` in `AccountSettings.tsx` with shadcn `<Select>`

**Files:**
- Modify: `src/components/AccountSettings.tsx:112,133,146,159,172,626`

- [ ] **Step 1: Add shadcn Select import**

At the top of `src/components/AccountSettings.tsx`:

```tsx
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
```

- [ ] **Step 2: Replace each `<select>` block**

For each of the 6 sites, swap the `<select>...<option>...` pattern for a shadcn equivalent. The exact mapping is:

```tsx
// FROM:
<select
  className="..."
  value={accountType}
  onChange={(e) => setAccountType(e.target.value)}
>
  {ACCOUNT_TYPES.map((t) => (
    <option key={t.value} value={t.value}>{t.label} ({t.desc})</option>
  ))}
</select>

// TO:
<Select value={accountType} onValueChange={setAccountType}>
  <SelectTrigger className="text-sm"><SelectValue /></SelectTrigger>
  <SelectContent>
    {ACCOUNT_TYPES.map((t) => (
      <SelectItem key={t.value} value={t.value}>{t.label} ({t.desc})</SelectItem>
    ))}
  </SelectContent>
</Select>
```

Apply the same pattern to the other 5 sites — preserving the existing classNames on the wrapping container, the value/onChange contract, and any "App default" empty-string options (use `<SelectItem value="__default__">App default</SelectItem>` and translate `__default__` ↔ `""` in the change handler, since shadcn `<SelectItem>` does not accept an empty string).

- [ ] **Step 3: Verify**

```bash
npm run check
npm run build
```

- [ ] **Step 4: Manual sanity check**

Open the Accounts editor and confirm the Type / Model / Thinking / Effort / Permissions / path-rule dropdowns work and look like the rest of the app.

- [ ] **Step 5: Commit**

```bash
git add src/components/AccountSettings.tsx
git commit -m "refactor: replace raw <select> with shadcn Select in AccountSettings"
```

---

### Task 12: Replace remaining 3 `<select>` (Settings, SessionPermissionsEditor, ProjectList)

**Files:**
- Modify: `src/components/Settings.tsx:321`
- Modify: `src/components/SessionPermissionsEditor.tsx:212`
- Modify: `src/components/ProjectList.tsx:198`

- [ ] **Step 1: Apply the same pattern as Task 11**

For each file, add the import and swap the `<select>` for `<Select>`. Preserve all existing values/handlers. Use the `__default__` workaround for any "App default"-style empty option.

- [ ] **Step 2: Verify**

```bash
npm run check
npm run build
```

- [ ] **Step 3: Commit**

```bash
git add src/components/Settings.tsx src/components/SessionPermissionsEditor.tsx src/components/ProjectList.tsx
git commit -m "refactor: replace raw <select> with shadcn Select across renderer"
```

---

## Phase C — Opus 200K context-window fix

### Task 13: Add diagnostic log + capture observed maxTokens per model id

**Files:**
- Modify: `electron/services/sessions/lifecycle.ts` (around `start()` at line 215; `listenToMessages` for getContextUsage)

- [ ] **Step 1: Add a one-shot log when getContextUsage first returns**

Find the listener that processes streamed messages in `lifecycle.ts` (search for `getContextUsage`). Add an instrumentation block that logs the first non-null `getContextUsage` snapshot per session along with the chosen model id:

```ts
// Inside the message-processing loop where contextUsage is fetched, add:
if (!handle._loggedCtxOnce) {
  const snap = await handle.query.getContextUsage().catch(() => null);
  if (snap) {
    handle._loggedCtxOnce = true;
    console.log(
      `[sessions] model=${handle.sdkOptions.model ?? '<default>'} ` +
      `maxTokens=${snap.maxTokens} totalTokens=${snap.totalTokens}`,
    );
  }
}
```

(Add `_loggedCtxOnce?: boolean;` to the `SessionHandle` type if needed.)

- [ ] **Step 2: Capture log output for the three model ids**

```bash
ELECTRON_ENABLE_LOGGING=1 npm start 2>&1 | tee /tmp/greychrist.log
```

In the running app:
1. Start a session with `Claude Opus 4.7 (1M)`. Send "hi". Note the logged `maxTokens`.
2. Stop the session. Start a session with `Claude Opus 4.7 (200K)`. Send "hi". Note `maxTokens`.
3. Stop the session. Start a session with `Claude Sonnet 4.6`. Send "hi". Note `maxTokens`.

Stop the app. Read `/tmp/greychrist.log` for the three lines.

- [ ] **Step 3: Decide the fix branch from observed values**

Three possibilities (matching the spec):

- **A. SDK reports the same `maxTokens` for `opus[1m]` and `opus`** → SDK is mis-routing. Move to Task 14A.
- **B. SDK reports `200_000` for `opus` but the UI shows 1M** → renderer bug. Move to Task 14B.
- **C. SDK exposes a beta flag for 1M and we never set it** → flag-based fix. Move to Task 14C.

(**Stop. Do not proceed to Task 14 until Step 3 has identified A, B, or C from log evidence.**)

- [ ] **Step 4: Commit the diagnostic (keep it for now)**

```bash
git add electron/services/sessions/lifecycle.ts
git commit -m "chore: log model id and SDK maxTokens at session start"
```

---

### Task 14A: Fix path A — Translate model id before passing to SDK

*(Only do this task if Task 13 Step 3 chose branch A.)*

**Files:**
- Modify: `electron/services/sessions/lifecycle.ts:215-241`
- Modify: `electron/__tests__/sessions.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `electron/__tests__/sessions.test.ts`:

```ts
import { translatePickerModelId } from '../services/sessions/lifecycle';

describe('translatePickerModelId', () => {
  it('opus[1m] resolves to claude-opus-4-7-1m', () => {
    expect(translatePickerModelId('opus[1m]')).toBe('claude-opus-4-7-1m');
  });
  it('opus resolves to claude-opus-4-7', () => {
    expect(translatePickerModelId('opus')).toBe('claude-opus-4-7');
  });
  it('sonnet passes through', () => {
    expect(translatePickerModelId('sonnet')).toBe('sonnet');
  });
  it('haiku passes through', () => {
    expect(translatePickerModelId('haiku')).toBe('haiku');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npm test -- sessions.test.ts -t translatePickerModelId
```

Expected: FAIL.

- [ ] **Step 3: Implement the translator and apply it**

In `electron/services/sessions/lifecycle.ts`, add at module scope:

```ts
export function translatePickerModelId(model: string | undefined): string | undefined {
  if (model === 'opus[1m]') return 'claude-opus-4-7-1m';
  if (model === 'opus') return 'claude-opus-4-7';
  return model;
}
```

In the `start()` function, replace `model,` in the `options` object (line 241) with:

```ts
model: translatePickerModelId(model),
```

(If Context7 lookup of `@anthropic-ai/claude-agent-sdk` reveals a different exact model id than `claude-opus-4-7` for the 200K version, use that exact id.)

- [ ] **Step 4: Run tests**

```bash
npm test
```

Expected: PASS.

- [ ] **Step 5: Manual verification**

Restart the app, start an `opus` session, confirm the context donut now reads against 200K.

- [ ] **Step 6: Commit**

```bash
git add electron/services/sessions/lifecycle.ts electron/__tests__/sessions.test.ts
git commit -m "fix: translate picker model id so opus uses 200K context"
```

---

### Task 14B: Fix path B — Renderer-side clamp

*(Only do this task if Task 13 Step 3 chose branch B.)*

**Files:**
- Modify: `src/components/SessionHeader.tsx:357-363`

- [ ] **Step 1: Replace the limit calculation**

```tsx
const useSdk = contextUsage !== undefined && contextUsage !== null;
const tokens = useSdk ? contextUsage!.totalTokens : totalTokens;
const sdkLimit = useSdk ? contextUsage!.maxTokens : null;
const expectsLargeContext = !!model?.includes('[1m]');
const limit = sdkLimit != null && (expectsLargeContext || sdkLimit <= 200_000)
  ? sdkLimit
  : expectsLargeContext
    ? 1_000_000
    : 200_000;
```

- [ ] **Step 2: Verify**

```bash
npm run check
npm test
```

- [ ] **Step 3: Manual verification**

Restart, confirm `opus` reads against 200K and `opus[1m]` against 1M.

- [ ] **Step 4: Commit**

```bash
git add src/components/SessionHeader.tsx
git commit -m "fix: clamp context-window limit to picker model when SDK over-reports"
```

---

### Task 14C: Fix path C — Use a betas flag for 1M context

*(Only do this task if Task 13 Step 3 chose branch C.)*

**Files:**
- Modify: `electron/services/sessions/lifecycle.ts:215-272`
- Modify: `electron/__tests__/sessions.test.ts`

- [ ] **Step 1: Look up the beta header name via Context7**

Run a Context7 query against `@anthropic-ai/claude-agent-sdk` for "context 1m" or "betas" to confirm the flag name (e.g. `context-1m-2025-08-07`).

- [ ] **Step 2: Apply the flag conditionally**

In `start()`, after the existing `options` declaration, add:

```ts
if (model === 'opus[1m]') {
  (options as Record<string, unknown>).betas = ['context-1m-2025-08-07'];
}
const baseModel = model === 'opus[1m]' ? 'opus' : model;
options.model = baseModel;
```

(Replace `'context-1m-2025-08-07'` with whatever Context7 reports.)

- [ ] **Step 3: Add a test that 1M sets the flag and 200K does not**

```ts
import { buildSdkOptionsForTest } from '../services/sessions/lifecycle';

describe('1M context beta flag', () => {
  it('sets the betas array for opus[1m]', () => {
    const opts = buildSdkOptionsForTest({ model: 'opus[1m]', projectPath: '/p', configDir: '/c' });
    expect((opts as any).betas).toContain('context-1m-2025-08-07');
    expect(opts.model).toBe('opus');
  });
  it('does not set betas for plain opus', () => {
    const opts = buildSdkOptionsForTest({ model: 'opus', projectPath: '/p', configDir: '/c' });
    expect((opts as any).betas).toBeUndefined();
    expect(opts.model).toBe('opus');
  });
});
```

(Extract a small `buildSdkOptionsForTest` from `start()` that returns the `options` object without actually starting the SDK query.)

- [ ] **Step 4: Verify**

```bash
npm test
```

- [ ] **Step 5: Commit**

```bash
git add electron/services/sessions/lifecycle.ts electron/__tests__/sessions.test.ts
git commit -m "fix: opt into 1M context beta only for opus[1m]"
```

---

### Task 15: Remove the diagnostic log

**Files:**
- Modify: `electron/services/sessions/lifecycle.ts`

- [ ] **Step 1: Delete the `_loggedCtxOnce` block added in Task 13**

Remove the `console.log` and the `_loggedCtxOnce` flag.

- [ ] **Step 2: Verify**

```bash
npm test
```

- [ ] **Step 3: Commit**

```bash
git add electron/services/sessions/lifecycle.ts
git commit -m "chore: remove session context diagnostic log"
```

---

## Phase D — Verification

### Task 16: Full verification gate

- [ ] **Step 1: Run the full gate**

```bash
npm run check
npm test
npm run build
npm run test:coverage
npm run rebuild:electron
```

Expected: PASS for `check`, `test`, `build`. Coverage ≥80% on new files (`branch-colors.ts`, `branchColors.ts`, `git-branches.ts`).

- [ ] **Step 2: End-to-end manual check**

```bash
ELECTRON_ENABLE_LOGGING=1 npm start 2>&1 | tee /tmp/greychrist.log
```

In the running app:
- Open `~/Repos/personal/greychrist` (single-worktree project on `main`). Chip should be black.
- Open `~/Repos/personal/WIN` (multi-worktree on `develop`). The `develop` chip should be blue; the three worktree chips should be three distinct, non-blue colors.
- On the WIN project page, add a Branch Color row pinning one of the worktree branches to a specific color. Open the session: the worktree chip uses the pinned color and the others rebalance.
- Confirm the project header (`WIN · 204 sessions`) is unchanged and the new card aligns top with the New Session card.
- Confirm Settings, AccountSettings editor, SessionPermissionsEditor, and ProjectList dropdowns now look like the rest of the app.
- Start an `opus` (200K) session, confirm the context donut reads against 200K.
- Start an `opus[1m]` session, confirm the context donut reads against 1M.

- [ ] **Step 3: Final commit (if anything outstanding)**

```bash
git status
# If clean, the branch is ready.
```

---

## Self-review — completed before this plan was saved

- **Spec coverage** — Resolution rules: Task 6. DB: Task 2. Service: Task 3. Branch listing: Task 4. IPC: Task 5. Resolver wiring: Tasks 7–8. Card: Tasks 9–10. Select cleanup: Tasks 11–12. Opus 200K: Tasks 13–15. Verification: Task 16. No spec section without a task.
- **Placeholder scan** — No "TBD" / "implement later" / "appropriate error handling" found. The Opus 200K fix branches each contain real code; only one is executed based on Task 13 Step 3.
- **Type consistency** — `BranchColor` uses snake_case across service, IPC, and `api.ts`; the renderer call signature uses camelCase (`projectPath`, `branchName`) and the IPC adapter normalizes both per the existing pattern. Resolver returns `{ colors, trunkBlack }` and is consumed under those names in `ClaudeCodeSession.tsx` and `BranchColorsCard.tsx`.
