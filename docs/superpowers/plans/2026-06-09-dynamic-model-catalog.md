# Dynamic Model Catalog Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the hardcoded model list with a SQLite-persisted catalog discovered from the Claude CLI, so Fable 5 (and future models) appear automatically in every picker, and the effort picker only offers levels the selected model supports.

**Architecture:** The existing ephemeral-engine catalog fetch (`electron/services/models.ts`) gains a `model_catalog` SQLite table with CLI-version invalidation and 24 h TTL background refresh. Live sessions write their init-time catalog through to the same table. The renderer gets one module (`src/lib/modelCatalog.tsx`) that maps CLI catalog entries to the picker shape and a `useModelCatalog(configDir)` hook used by all pre-session surfaces; the chat-bar picker prefers the live session catalog. Spec: `docs/superpowers/specs/2026-06-09-dynamic-model-catalog-design.md`.

**Tech Stack:** Electron main (better-sqlite3, vitest in `electron/__tests__/`), React 18 renderer (vitest component tests).

**Verification gate (cross-cutting):** `npm run check`, `npm run build`, `npm run test:coverage`, then `npm run rebuild:electron`.

---

### Task 1: DB migration v12 — `model_catalog` table

**Files:**
- Modify: `electron/services/database.ts` (append to `migrations` array, currently ends at `version: 11`)
- Test: `electron/__tests__/database.test.ts`

- [ ] **Step 1: Write the failing test** (in `database.test.ts`, alongside existing schema tests)

```ts
it('v12 creates the model_catalog table', () => {
  const db = createDatabase(':memory:');
  const row = db.raw
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='model_catalog'")
    .get();
  expect(row).toBeTruthy();
});
```

(Adjust `db.raw` to however existing tests reach the underlying better-sqlite3 handle — follow the file's existing pattern.)

- [ ] **Step 2: Run** `npm test -- database` — expect FAIL (table missing)
- [ ] **Step 3: Implement** — append to `migrations` in `database.ts`:

```ts
{
  version: 12,
  description:
    'model_catalog: per-config-dir cache of the CLI-reported model list, ' +
    'keyed for invalidation by the CLI version that produced it.',
  up(db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS model_catalog (
        config_dir   TEXT PRIMARY KEY,
        cli_version  TEXT NOT NULL,
        catalog_json TEXT NOT NULL,
        fetched_at   INTEGER NOT NULL
      );
    `);
  },
},
```

- [ ] **Step 4: Run** `npm test -- database` — expect PASS
- [ ] **Step 5: Commit** `feat(models): add model_catalog table (migration v12)`

---

### Task 2: DB-backed `models.ts` — `getCatalog` / `upsertCatalog`

**Files:**
- Modify: `electron/services/models.ts`
- Test: `electron/__tests__/models.test.ts` (extend; keep existing `listSupported` tests, updating construction to pass a `:memory:` db)

New service surface:

```ts
export interface ModelsService {
  listSupported(configDir: string): Promise<ModelInfo[]>; // unchanged live fetch
  getCatalog(configDir: string): Promise<ModelInfo[]>;
  upsertCatalog(configDir: string, models: ModelInfo[]): void;
}

export interface ModelsServiceOptions {
  timeoutMs?: number;
  /** TTL before a background refresh is kicked. Default 24 h. */
  ttlMs?: number;
  /** Injectable clock for tests. Default Date.now. */
  nowFn?: () => number;
  /** Injectable CLI-version probe for tests. Default: `claude --version`
   *  on the resolved binary, cached in-memory for the service lifetime.
   *  Returns null when undeterminable (cache rows then match any version). */
  cliVersionFn?: () => string | null;
}

export function createModelsService(db: Database, opts: ModelsServiceOptions = {}): ModelsService
```

- [ ] **Step 1: Write failing tests** (construction helper: `const db = createDatabase(':memory:')`; pass `cliVersionFn: () => '2.1.170'`, `nowFn`, fake engine via existing `makeFakeEngine`):
  1. **miss → live fetch → persisted:** empty DB; `getCatalog` returns fake-engine models; a `model_catalog` row now exists; engine spawned once.
  2. **hit:** pre-seed via `upsertCatalog`; `getCatalog` returns seeded models; `createClaudeCliEngine` **not** called.
  3. **version mismatch → refetch:** seed with `cliVersionFn` returning `'2.0.0'`, then construct service with `'2.1.170'`; `getCatalog` spawns and returns fresh list; row updated.
  4. **stale row → returned immediately + background refresh:** seed with `nowFn` far in the past; `getCatalog` returns seeded list synchronously-ish AND engine gets spawned (await a tick; row updated to fresh models).
  5. **live-fetch failure → stale row served:** version mismatch + engine `startReject`; returns the old row's models.
  6. **live-fetch failure, no row:** returns `[]`.
- [ ] **Step 2: Run** `npm test -- models` — expect FAIL (new methods missing)
- [ ] **Step 3: Implement** in `models.ts`:

```ts
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;

export function createModelsService(db: Database, opts: ModelsServiceOptions = {}): ModelsService {
  const timeoutMs = opts.timeoutMs ?? 8000;
  const ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
  const now = opts.nowFn ?? Date.now;

  let cachedVersion: string | null | undefined;
  function cliVersion(): string | null {
    if (opts.cliVersionFn) return opts.cliVersionFn();
    if (cachedVersion !== undefined) return cachedVersion;
    const binaryPath = findSystemClaudeBinary();
    if (!binaryPath) return (cachedVersion = null);
    try {
      cachedVersion = execSync(`"${binaryPath}" --version`, { encoding: 'utf8', timeout: 5000 }).trim() || null;
    } catch {
      cachedVersion = null;
    }
    return cachedVersion;
  }

  function upsertCatalog(configDir: string, models: ModelInfo[]): void {
    if (!configDir || models.length === 0) return;
    db.raw.prepare(
      `INSERT INTO model_catalog (config_dir, cli_version, catalog_json, fetched_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(config_dir) DO UPDATE SET
         cli_version = excluded.cli_version,
         catalog_json = excluded.catalog_json,
         fetched_at = excluded.fetched_at`,
    ).run(configDir, cliVersion() ?? '', JSON.stringify(models), now());
  }

  const refreshing = new Set<string>();
  async function refresh(configDir: string): Promise<ModelInfo[]> {
    if (refreshing.has(configDir)) return [];
    refreshing.add(configDir);
    try {
      const models = await listSupported(configDir);
      if (models.length > 0) upsertCatalog(configDir, models);
      return models;
    } finally {
      refreshing.delete(configDir);
    }
  }

  async function getCatalog(configDir: string): Promise<ModelInfo[]> {
    const row = db.raw
      .prepare('SELECT cli_version, catalog_json, fetched_at FROM model_catalog WHERE config_dir = ?')
      .get(configDir) as { cli_version: string; catalog_json: string; fetched_at: number } | undefined;
    const ver = cliVersion();
    const rowParsed = row ? safeParse(row.catalog_json) : null;

    if (row && rowParsed && (ver === null || row.cli_version === ver)) {
      if (now() - row.fetched_at > ttlMs) void refresh(configDir); // fire-and-forget
      return rowParsed;
    }
    const fresh = await refresh(configDir);
    if (fresh.length > 0) return fresh;
    return rowParsed ?? []; // stale-on-error fallback
  }

  // ... listSupported unchanged ...
  return { listSupported, getCatalog, upsertCatalog };
}

function safeParse(json: string): ModelInfo[] | null {
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? (v as ModelInfo[]) : null;
  } catch {
    return null;
  }
}
```

(Adapt `db.raw` to the actual `Database` wrapper API used by other services — e.g. `accounts.ts` — and add `import { execSync } from 'node:child_process'` + the `Database` type import.)

- [ ] **Step 4:** Update the existing `listSupported` tests to the new constructor signature; **run** `npm test -- models` — expect PASS
- [ ] **Step 5: Commit** `feat(models): SQLite-persisted model catalog with TTL + version invalidation`

---

### Task 3: Route the existing IPC channel through `getCatalog`

**Files:**
- Modify: `electron/main.ts:654` (construction order — move above `createSessionsService` at `:489`), `electron/main.ts:931-932` (adapter)
- Modify: `electron/ipc/handlers.ts:160` (interface), `:451` (handler)

- [ ] **Step 1:** In `main.ts`, move `const modelsService = createModelsService(db);` above the sessions-service construction; change the adapter to

```ts
models: {
  listSupported: (configDir: string) => modelsService.getCatalog(configDir),
},
```

(Keep the adapter key `listSupported` so `handlers.ts` is untouched at the call site, or rename both sides — pick one and keep interface + adapter consistent.)

- [ ] **Step 2: Run** `npm run check` — expect PASS
- [ ] **Step 3: Commit** `feat(models): serve list_supported_models from the persisted catalog`

---

### Task 4: Write-through from live session init

**Files:**
- Modify: `electron/services/sessions/runtime.ts` (`RuntimeDeps` + `case 'init'` at `:136-143`)
- Modify: `electron/services/sessions/lifecycle.ts` (`createSessionsService` param + `runtimeDeps` at `:86-93`)
- Modify: `electron/main.ts` (pass sink)
- Test: the existing sessions runtime/lifecycle test file (locate via `rg -l "listenToMessages|case 'init'" electron/__tests__`)

- [ ] **Step 1: Write failing test:** construct the sessions service with a `modelCatalogSink` spy, emit a `system:init` whose engine `getInitData()` carries `models`, assert the spy was called with `(handle.configDir, models)`.
- [ ] **Step 2: Run** the matching test file — expect FAIL
- [ ] **Step 3: Implement:**

`runtime.ts`:

```ts
export interface RuntimeDeps {
  // ...existing fields...
  /** Optional write-through: persists the CLI init-time model catalog for
   *  this session's configDir so pre-session pickers stay warm. */
  modelCatalogSink?: ((configDir: string, models: unknown[]) => void) | null;
}

// in case 'init':
if (!handle.initData) handle.initData = engine.getInitData();
const initModels = handle.initData?.models;
if (deps.modelCatalogSink && Array.isArray(initModels) && initModels.length > 0) {
  try {
    deps.modelCatalogSink(handle.configDir, initModels);
  } catch (err) {
    console.error('[sessions] model catalog write-through failed:', err);
  }
}
break;
```

`lifecycle.ts`: add trailing optional param `modelCatalogSink: ((configDir: string, models: unknown[]) => void) | null = null` and include it in `runtimeDeps`.

`main.ts`: pass `(configDir, models) => modelsService.upsertCatalog(configDir, models as ModelInfo[])` in the corresponding position.

- [ ] **Step 4: Run** the test file — expect PASS
- [ ] **Step 5: Commit** `feat(sessions): write live init model catalog through to model_catalog`

---

### Task 5: Omit `--model` at launch when the selection is `default`

**Files:**
- Modify: `electron/services/agents/claude-cli-engine.ts:65-67`
- Test: `electron/__tests__/claude-cli-engine.test.ts` (or wherever `buildArgs`/spawn args are asserted — locate via `rg -n "'--model'" electron/__tests__`)

- [ ] **Step 1: Write failing test:** start the engine with `model: 'default'`; assert spawn args do **not** include `--model`. Companion assertion: `model: 'sonnet'` still yields `['--model', 'sonnet']`.
- [ ] **Step 2: Run** — expect FAIL
- [ ] **Step 3: Implement:**

```ts
// 'default' means "let the CLI pick" — the CLI catalog exposes it as a
// selectable entry, but as an argv value it's redundant; omit the flag.
if (p.model && p.model !== 'default') {
  args.push('--model', p.model);
}
```

- [ ] **Step 4: Run** — expect PASS
- [ ] **Step 5: Commit** `feat(sessions): treat model 'default' as omit --model at launch`

---

### Task 6: Renderer catalog module (`modelCatalog.tsx`) + retire hardcoded `MODELS`

**Files:**
- Create: `src/lib/modelCatalog.tsx`
- Test: `src/lib/__tests__/modelCatalog.test.tsx`
- Modify: `src/components/ModelPicker.tsx` (delete the `MODELS` constant; keep `Model` + picker components)

- [ ] **Step 1: Write failing tests:** `toPickerModel` maps `{value, displayName, description}` → `{id, name, description, shortName: first letter, icon, color}`; `FALLBACK_MODELS` contains ids `default`, `claude-fable-5[1m]`, `sonnet`, `haiku`; `effectiveModels([])` → fallback; `effectiveModels(raw)` → mapped.
- [ ] **Step 2: Run** `npm test -- modelCatalog` — expect FAIL
- [ ] **Step 3: Implement:**

```tsx
import React from 'react';
import { Zap } from 'lucide-react';
import { useEffect, useState } from 'react';
import { api, type SessionModelInfo } from '@/lib/api';
import type { Model } from '@/components/ModelPicker';

export function toPickerModel(info: SessionModelInfo): Model {
  const name = info.displayName || info.value;
  return {
    id: info.value,
    name,
    description: info.description ?? '',
    icon: <Zap className="h-3.5 w-3.5" />,
    shortName: (name[0] ?? '?').toUpperCase(),
    color: 'text-primary',
  };
}

/** Static fallback used when no catalog is available (CLI missing,
 *  discovery failed, tests). Mirrors the real CLI catalog of 2026-06. */
export const FALLBACK_MODELS: Model[] = [
  { id: 'default', name: 'Default (recommended)', description: "The CLI's recommended model", icon: <Zap className="h-3.5 w-3.5" />, shortName: 'D', color: 'text-primary' },
  { id: 'claude-fable-5[1m]', name: 'Fable 5', description: 'Most capable for your hardest and longest-running tasks', icon: <Zap className="h-3.5 w-3.5" />, shortName: 'F', color: 'text-primary' },
  { id: 'sonnet', name: 'Sonnet', description: 'Efficient for routine tasks', icon: <Zap className="h-3.5 w-3.5" />, shortName: 'S', color: 'text-primary' },
  { id: 'haiku', name: 'Haiku', description: 'Fastest for quick answers', icon: <Zap className="h-3.5 w-3.5" />, shortName: 'H', color: 'text-primary' },
];

export function effectiveModels(raw: SessionModelInfo[] | undefined | null): Model[] {
  return raw && raw.length > 0 ? raw.map(toPickerModel) : FALLBACK_MODELS;
}

/** Display name for a model id across raw catalog + fallback. */
export function modelDisplayName(id: string, raw?: SessionModelInfo[] | null): string {
  return raw?.find((m) => m.value === id)?.displayName
    ?? FALLBACK_MODELS.find((m) => m.id === id)?.name
    ?? id;
}

/** Catalog for pre-session surfaces. Inert when configDir is undefined. */
export function useModelCatalog(configDir?: string): {
  models: Model[]; raw: SessionModelInfo[]; loading: boolean;
} {
  const [raw, setRaw] = useState<SessionModelInfo[]>([]);
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    if (!configDir) { setRaw([]); return; }
    let cancelled = false;
    setLoading(true);
    api.listSupportedModels(configDir)
      .then((models) => { if (!cancelled) setRaw(models ?? []); })
      .catch(() => { if (!cancelled) setRaw([]); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [configDir]);
  return { models: effectiveModels(raw), raw, loading };
}
```

Then delete `MODELS` from `ModelPicker.tsx` and fix every importer (`FloatingPromptInput`, `NewSessionForm`, `SessionDefaultsRow`, `AgentSession`, tests) — Tasks 7–8 finish the semantic switch; in this task just repoint imports to `FALLBACK_MODELS` so the build stays green.

- [ ] **Step 4: Run** `npm test -- modelCatalog` and `npm run check` — expect PASS
- [ ] **Step 5: Commit** `feat(ui): model catalog module with CLI-derived pickers + fallback`

---

### Task 7: Dynamic chat-bar picker + capability-aware effort picker

**Files:**
- Modify: `src/components/FloatingPromptInput.tsx` (destructure the currently-unused `supportedModels` prop; `:391`)
- Modify: `src/components/ControlBar.tsx` (`EffortPicker` gains `levels?: EffortLevel[]`)
- Test: extend `src/components/__tests__/` coverage for effort filtering (new `ControlBar` test or extend an existing suite)

- [ ] **Step 1: Write failing test:** `EffortPicker` with `levels={['low','medium','high','max']}` renders no `xhigh` option when opened; with `levels` undefined renders all five.
- [ ] **Step 2: Run** — expect FAIL
- [ ] **Step 3: Implement:**

`ControlBar.tsx` — thread `levels` into `EffortPickerDropdown`:

```tsx
function EffortPickerDropdown({ effort, onSelect, levels }: { effort: EffortLevel; onSelect: (level: EffortLevel) => void; levels?: EffortLevel[] }) {
  const visible = levels ? EFFORT_LEVELS.filter((l) => levels.includes(l.id)) : EFFORT_LEVELS;
  // ...map over `visible` instead of EFFORT_LEVELS...
}
```

`EffortPicker` accepts and forwards `levels` in all three variants.

`FloatingPromptInput.tsx`:

```tsx
// -- Derived data --
const rawCatalog = supportedModels && supportedModels.length > 0 ? supportedModels : hookRaw;
const effectiveModelList = effectiveModels(rawCatalog);
const selectedModelData = effectiveModelList.find((m) => m.id === selectedModel) || effectiveModelList[0];
const selectedRaw = rawCatalog.find((m) => m.value === selectedModel);
const effortLevels = selectedRaw?.supportedEffortLevels;
const effortSupported = selectedRaw ? selectedRaw.supportsEffort === true : true;
```

where `hookRaw` comes from `const { raw: hookRaw } = useModelCatalog(configDir);`. Pass `levels={effortLevels}` to both `EffortPicker` instances and hide (don't render) them when `!effortSupported`.

- [ ] **Step 4: Run** tests + `npm run check` — expect PASS
- [ ] **Step 5: Commit** `feat(ui): dynamic model list + capability-aware effort picker in chat bar`

---

### Task 8: Pre-session surfaces — `NewSessionForm`, `SessionDefaultsRow`, `AgentSession` label

**Files:**
- Modify: `src/components/NewSessionForm.tsx` (`:178`, `:256`, effort list `:295`)
- Modify: `src/components/shared/SessionDefaultsRow.tsx` (add `configDir?: string` prop; `:87-99`)
- Modify: `src/components/AccountDialog.tsx:322` (pass the dialog's config-dir value)
- Modify: `src/components/AgentSession.tsx:2137` (queued-prompt label)
- Tests: update `src/components/__tests__/NewSessionForm.test.tsx`, `src/components/shared/__tests__/SessionDefaultsRow.test.tsx`

- [ ] **Step 1:** Update/extend the two component test suites: with no catalog (api mock returns `[]`), pickers render the four `FALLBACK_MODELS` names (assert "Fable 5" present); with a mocked catalog, rendered options come from it.
- [ ] **Step 2: Run** — expect FAIL (Fable 5 missing today)
- [ ] **Step 3: Implement:**
  - `NewSessionForm`: `const { models, raw } = useModelCatalog(agent === 'claude' ? resolvePair[agent]?.account.config_dir : undefined);` — replace `MODELS` usages; filter the effort dropdown rows by the selected model's `supportedEffortLevels` (same pattern as Task 7).
  - `SessionDefaultsRow`: new optional `configDir` prop → `useModelCatalog(engine === 'claude' ? configDir : undefined)`; replace `MODELS`; pass `levels` to `EffortPicker`.
  - `AccountDialog`: pass its current config-dir form value as `configDir`.
  - `AgentSession`: replace the `MODELS.find(...)` queued-prompt lookup with `modelDisplayName(queuedPrompt.model, supportedModels)`.
- [ ] **Step 4: Run** `npm test` (renderer suites) + `npm run check` — expect PASS
- [ ] **Step 5: Commit** `feat(ui): dynamic model catalog on pre-session surfaces`

---

### Task 9: Full verification gate

- [ ] **Step 1:** `npm run check` — expect clean
- [ ] **Step 2:** `npm run build` — expect clean
- [ ] **Step 3:** `npm run test:coverage` — all green, backend lines ≥ 80%
- [ ] **Step 4:** `npm run rebuild:electron` (native module back to Electron ABI before Greg restarts the app)
- [ ] **Step 5:** Manual smoke (optional but recommended): launch app, open a project, confirm the picker shows **Default (recommended) / Fable 5 / Sonnet / Haiku**, pick Fable 5, start a session, switch model mid-session, confirm Haiku hides the effort picker.
- [ ] **Step 6: Commit** any straggler fixes; report results.

---

## Self-review notes

- Spec §1 → Tasks 1–3; §1 write-through → Task 4; §3 → Task 5; §2 → Tasks 6–8; §4 → Tasks 7–8; §5 → per-task TDD + Task 9. No gaps found.
- `db.raw` placeholder flagged in Tasks 1–2: executor must match the actual `Database` wrapper API (check `electron/services/accounts.ts` usage) — intentional instruction, not an unknown.
- Type consistency: `ModelInfo` (main) vs `SessionModelInfo` (renderer) are the same wire shape; renderer keeps its existing `api.ts` type.
