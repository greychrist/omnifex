# Dynamic Model Catalog (Fable 5 support)

**Date:** 2026-06-09
**Status:** Approved

## Problem

OmniFex's model pickers are hardcoded to a three-entry `MODELS` array
(`opus` / `sonnet` / `haiku`) in `src/components/ModelPicker.tsx`. The Claude
CLI now ships Fable 5, and its live catalog no longer even contains an `opus`
entry — the catalog is `default` / `claude-fable-5[1m]` / `sonnet` / `haiku`.
Every model launch forces a manual UI update, and the effort picker hardcodes
levels the CLI doesn't support per model (it offers `xhigh` on Sonnet, which
the CLI rejects, and an effort picker on Haiku, which has none).

Dynamic discovery plumbing already exists but was deliberately disconnected in
commit `9bb2553` (2026-04-27) because the then-catalog leaked a bare "Default"
label. The catalog entry is now properly labeled ("Default (recommended)" with
a description), so the original objection no longer applies.

### Existing plumbing (verified 2026-06-09, CLI 2.1.170)

- `electron/services/models.ts` — ephemeral `ClaudeCliEngine` spawn that reads
  the model catalog from the CLI `initialize` control_request for a given
  `CLAUDE_CONFIG_DIR`. Exposed over IPC as `list_supported_models`
  (allow-listed, wrapped by `api.listSupportedModels`). **No renderer caller
  today.**
- `electron/services/sessions/queries.ts:getSupportedModels(tabId)` — reads
  the same catalog from a live session's init data. Flows via
  `sessionStreamEffects` into `claudeSessionStore.supportedModels` and is
  passed to `FloatingPromptInput` as a prop — which ignores it
  (`const effectiveModels = MODELS;` at `FloatingPromptInput.tsx:391`).
- Catalog entry shape (`SessionModelInfo` in `src/lib/api.ts`): `value`,
  `displayName`, `description`, `supportsEffort?`, `supportedEffortLevels?`,
  plus extra flags (`supportsAdaptiveThinking`, `supportsFastMode`,
  `supportsAutoMode`) currently untyped.
- Model selection reaches the CLI as the catalog `value` string: launch via
  `--model <value>` (`agents/claude-cli-engine.ts:66`), mid-session via the
  `set_model` control request (`sessions/queries.ts:setModel`).

## Scope decisions

- **All picker surfaces** go dynamic: live chat-bar picker, `NewSessionForm`,
  `SessionDefaultsRow`, Account Settings.
- **Claude engine only** for now. The catalog interface stays engine-shaped so
  a Codex implementation can slot in later; no Codex work in this change.
- **Show the CLI's `default` entry** as a first-class picker option.
- **Effort picker becomes capability-aware** from the same catalog.
- **Catalog persists to SQLite** so pickers are instantly warm at app start.

## Design

### 1. Main process — catalog service & persistence

New table in `database.ts` schema init (with migration for existing DBs):

```sql
CREATE TABLE IF NOT EXISTS model_catalog (
  config_dir   TEXT PRIMARY KEY,
  cli_version  TEXT NOT NULL,
  catalog_json TEXT NOT NULL,
  fetched_at   INTEGER NOT NULL
);
```

`createModelsService(deps)` gains a `db` dependency (testable with
`createDatabase(':memory:')`) and exposes:

- `getCatalog(configDir): Promise<ModelInfo[]>`
  - Row exists and `cli_version` matches the currently resolved CLI version:
    return the persisted catalog immediately. If `fetched_at` is older than
    the TTL (24 h), kick a **background** refresh (fire-and-forget ephemeral
    fetch → upsert).
  - No row, or CLI version mismatch: run the live ephemeral-engine fetch
    (existing `listSupported` code), upsert, return.
  - Live fetch fails: return the stale row if one exists, else `[]` (renderer
    applies its hardcoded fallback).
- `upsertCatalog(configDir, models)` — write-through entry point (below).

CLI version for the invalidation key comes from the existing version-check
machinery (`claude.ts` / resolved binary path) — no extra process spawn.

**Write-through from live sessions:** when a session's `initialize` handshake
delivers the catalog (the data `sessions.getSupportedModels` already reads),
the session layer upserts it into `model_catalog` for that session's
`configDir`. Accounts in active use stay fresh with zero ephemeral spawns; the
ephemeral path only runs for cold/invalidated accounts.

IPC: the existing `list_supported_models` channel now routes to `getCatalog`.
No new channels; preload allow-list unchanged.

### 2. Renderer — one catalog module, all four surfaces

New `src/lib/modelCatalog.ts`:

- `toPickerModel(info: SessionModelInfo): Model` — maps catalog entries to the
  picker `Model` shape (id = `value`, name = `displayName`, description,
  shortName derived from displayName, Zap icon, standard color).
- `FALLBACK_MODELS: Model[]` — replaces the `MODELS` constant. Entries:
  Default (recommended), Fable 5, Sonnet, Haiku — mirroring today's real
  catalog. Used only when discovery returns nothing.
- `useModelCatalog(configDir?): { models: Model[]; raw: SessionModelInfo[]; loading: boolean }`
  — calls `api.listSupportedModels(configDir)`; falls back to
  `FALLBACK_MODELS` on empty/error/missing configDir.

Surface wiring:

- `FloatingPromptInput`: `effectiveModels` = live `supportedModels` prop
  (session init) when non-empty → else `useModelCatalog(configDir)` → else
  `FALLBACK_MODELS`. Selected-model lookup keeps the existing
  `?? effectiveModels[0]` guard so stale persisted ids (e.g. `opus`) still
  render and remain sendable (the CLI accepts them as aliases).
- `NewSessionForm`, `SessionDefaultsRow`, Account Settings surfaces use
  `useModelCatalog` with the relevant account's `configDir`.
- `AgentSession` queued-prompt label lookup uses the effective list, not a
  hardcoded constant.

### 3. Model value semantics

- Catalog `value` strings pass through unchanged to `set_model` and to
  `--model` at launch.
- Exception: when the selected value is `default`, **omit `--model` at
  launch** (equivalent by definition; robust to flag parsing). `set_model`
  with `default` is sent as-is (it is a catalog member).

### 4. Capability-aware effort picker

`ControlBar` receives the selected model's raw catalog entry:

- Effort options filtered to `supportedEffortLevels` (e.g. Sonnet: no
  `xhigh`).
- Picker hidden/disabled when `supportsEffort` is falsy (Haiku).
- No catalog data for the selected model → current hardcoded level list
  remains as fallback.

### 5. Testing & verification (TDD, tests first)

- `electron/__tests__/models.test.ts` (extend, against `:memory:` DB):
  cache hit returns persisted catalog without spawning; cache miss → live
  fetch → row persisted; stale row → returned immediately + background
  refresh; CLI version mismatch → live refetch; live-fetch failure → stale
  row served; write-through upsert visible to `getCatalog`.
- `database` migration covered by schema-init test path.
- Renderer: unit tests for `toPickerModel` / fallback behavior; update
  `NewSessionForm.test.tsx` and `SessionDefaultsRow.test.tsx` (both reference
  the old `MODELS` constant); effort-filtering tests for `ControlBar`.
- Gate (cross-cutting change): `npm run check`, `npm run build`,
  `npm run test:coverage` (80% lines backend), then `npm run rebuild:electron`
  before app restart.

## Out of scope

- Codex engine model discovery (interface accommodates it later).
- Surfacing the extra capability flags (`supportsFastMode`, etc.) in the UI.
- Any change to how persisted account/session model defaults are stored.
