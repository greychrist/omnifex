# Agent Step Progress Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Real `done/total` step bars for each agent (and the main turn), fed by a bundled mod whose `progress` tool the model calls.

**Architecture:** A bundled mod (`omnifex-mod/`) registers `mcp__omnifex__progress` and tells subagents and the main session to call it. The app installs a writable copy under the state dir and spawns every session with `--plugin-dir`. The renderer reads the tool_use blocks it already receives and draws determinate bars.

**Tech Stack:** Claude Code mods (2.1.295 API), Electron main + daemon (TypeScript), React 19 renderer, Vitest.

**Spec:** `docs/superpowers/specs/2026-10-09-agent-step-progress-design.md`

## Global Constraints

- Tool name: `mcp__omnifex__progress`; input `{ done: number, total: number, note?: string }`.
- Setting key `sessions.progressMod.enabled`; on unless the stored value is `'false'`.
- Installed mod dir: `join(defaultStateDir(), 'mod', 'omnifex')`.
- Source dir resolution mirrors `electron/remote/webroot.ts` (`../..` dev, `../../..` packaged, from the bundle dir).
- The daemon must never import `electron`. Behaviour shared by main and daemon lives in a module both import.
- Nothing here may stop a session from starting: every failure yields `[]` plugin dirs.

## Review Focus

- `total` of 0, negative, NaN or a string from a confused model → ignored, no bar change, no crash.
- `done > total` (model overshoots) → bar clamps to full, text shows `total/total`.
- A progress call from a nested subagent (frame's `parent_tool_use_id` names a tool_use the main stream never saw) → keyed by `agent_id` as a fallback so the synthesised nested row gets it.
- Mod source missing (dev build before checkout has it, or packaging dropped it) → `[]`, session starts normally.
- Setting flipped off → next spawn has no `--plugin-dir`; existing sessions unaffected.

---

### Task 1: Bundled mod (done)

**Files:** `omnifex-mod/.claude-plugin/plugin.json`, `omnifex-mod/hooks/hooks.json`, `omnifex-mod/hooks/register.ts`, `omnifex-mod/tests/progress.test.ts`, `.gitignore`

- [x] Tests first (`claude plugin test omnifex-mod`: 5 fail, 1 pass), then implementation; 6/6 pass; `claude plugin validate` passes.
- [ ] Commit: `feat(mod): bundled omnifex mod with a progress tool`

### Task 2: `--plugin-dir` in the engine argv

**Files:** Modify `electron/services/agents/types.ts` (AgentStartParams), `electron/services/agents/claude-cli-engine.ts` (`buildArgs`). Test: `electron/__tests__/agents/claude-cli-engine.test.ts`.

**Produces:** `AgentStartParams.pluginDirs?: string[]`.

- [ ] Failing test: start with `pluginDirs: ['/a', '/b']` → argv contains `--plugin-dir /a --plugin-dir /b`; without it, no `--plugin-dir`.
- [ ] Implement in `buildArgs`: `for (const dir of p.pluginDirs ?? []) args.push('--plugin-dir', dir);`
- [ ] Run, pass, commit.

### Task 3: Sessions service threads plugin dirs (spawn + restart)

**Files:** Modify `electron/services/sessions/lifecycle.ts` (new last param `pluginDirs: (() => string[]) | null = null`; pass to `engine.start`; store in `startParams`), `electron/services/sessions/types.ts` (`startParams.pluginDirs?: string[]`), `electron/services/sessions/runtime.ts` (restart passes `handle.startParams.pluginDirs`). Test: new `electron/__tests__/sessions-plugin-dirs.test.ts` modelled on `sessions-start-effort.test.ts`.

**Consumes:** Task 2. **Produces:** `createSessionsService(..., autoRecapPolicy, pluginDirs)`.

- [ ] Failing tests: (a) `engine.start` receives `pluginDirs` from the closure; (b) closure throwing → `pluginDirs: []`, session still starts; (c) restart after stream death passes the same dirs.
- [ ] Implement: `const dirs = safePluginDirs()` where `safePluginDirs = () => { try { return pluginDirs?.() ?? []; } catch { return []; } }`.
- [ ] Run, pass, commit.

### Task 4: Shared bundled-mod module

**Files:** Create `electron/services/bundled-mod.ts`; test `electron/__tests__/bundled-mod.test.ts`. Create `src/lib/progressModSettings.ts` (key + `progressModEnabled(stored)`), shared with the renderer like `autoRecapSettings.ts`.

**Produces:**
```ts
export const BUNDLED_MOD_FILES = ['.claude-plugin/plugin.json', 'hooks/hooks.json', 'hooks/register.ts'];
export function resolveBundledModSource(bundleDir: string, exists?: (p: string) => boolean): string | null;
export function installBundledMod(src: string, dest: string): void; // throws on failure
export function createBundledModPluginDirs(opts: {
  getSetting: (key: string) => string | null;
  bundleDir: string;
  stateDir: string;
  warn?: (msg: string, err: unknown) => void;
}): () => string[];
```

- [ ] Failing tests (tmp dirs): source resolves for a dev layout (`<repo>/.vite/build` → `<repo>/omnifex-mod`) and a packaged layout (`Resources/app.asar/.vite/build` → `Resources/omnifex-mod`), null when absent; install copies all three files; second install with identical content leaves mtimes unchanged; changed source overwrites; closure returns `[dest]`, returns `[]` when setting `'false'`, returns `[]` (and warns) when the source is missing; installs once per process.
- [ ] Implement; temp-file + `renameSync` per file.
- [ ] Run, pass, commit.

### Task 5: Wire both composition roots + packaging

**Files:** Modify `electron/main.ts` and `electron/remote/daemon.ts` (pass `createBundledModPluginDirs({ getSetting: (k) => db.getSetting(k), bundleDir: __dirname, stateDir: defaultStateDir() })` as the new last argument), `forge.config.ts` (`extraResource` += `'./omnifex-mod'`).

- [ ] `npm run check`; `npm test` for the sessions/daemon suites; commit.

### Task 6: Renderer step-progress parsing

**Files:** Create `src/lib/stepProgress.ts`; test `src/lib/__tests__/stepProgress.test.ts`.

**Produces:**
```ts
export const PROGRESS_TOOL = 'mcp__omnifex__progress';
export interface StepProgress { done: number; total: number; note?: string }
export function parseProgressInput(input: unknown): StepProgress | null;
export function latestSubagentProgress(messages: JsonlNode[]): { byToolUseId: Record<string, StepProgress>; byAgentId: Record<string, StepProgress> };
export function latestMainProgress(messages: JsonlNode[]): StepProgress | null;
export function withStepProgress(subs: Subagent[], p: ReturnType<typeof latestSubagentProgress>): Subagent[];
```

- [ ] Failing tests: parse rejects missing/zero/negative/NaN/string totals; clamps `done`; trims empty note away. Subagent: forwarded frames with two calls → last wins; keyed by parent_tool_use_id and agent_id. Main: ignores forwarded frames; only calls after the last `userKind === 'prompt'` count; null when none. `withStepProgress` sets `stepProgress` by toolUseId, falls back to taskId → byAgentId, returns same object identity when nothing changes.
- [ ] Implement; run; commit.

### Task 7: Determinate bar + step line in SubagentRow

**Files:** Modify `src/lib/subagentStreams.ts` (`Subagent.stepProgress?: StepProgress`), `src/components/BackgroundWorkRows.tsx`, `src/components/AgentSession.tsx` (wrap `subagents` memo with `withStepProgress`). Test: `src/components/__tests__/BackgroundWorkRows.test.tsx`.

- [ ] Failing tests: running row with `stepProgress {done:2,total:5,note:'Read x'}` → `[data-subagent-bar] > span` has `style.width === '40%'`, no `brain-indeterminate-bar` class; `[data-subagent-step]` text `2/5 · Read x`. Running row without it → indeterminate as before. Completed row with it → full green bar, no step line.
- [ ] Implement; run; commit.

### Task 8: Main-session progress (status bar + transcript widget)

**Files:** Modify `src/components/ChatStatusBar.tsx` (new optional prop `mainProgress?: StepProgress | null`; turn readout appends `· 2/5` while running, `title` includes the note), `src/components/AgentSession.tsx` (compute `latestMainProgress(messages)` memo, pass it), create `src/components/claude/tools/ProgressWidget.tsx`, export from `index.ts`, route `PROGRESS_TOOL` before the MCP branch in `StreamMessage.tsx`. Tests: `ChatStatusBar.test.tsx`, `src/components/claude/tools/__tests__/ProgressWidget.test.tsx` (or the existing tools test dir).

- [ ] Failing tests: status bar shows `2/5` only while running; widget renders `Progress 2/5` and the note; StreamMessage routes the tool to it.
- [ ] Implement; run; commit.

### Task 9: Settings switch

**Files:** Create `src/components/settings-panels/ProgressModSettings.tsx` mirroring `AutoRecapSettings.tsx`; mount beside `AutoRecapSettings`. Test beside `AutoRecapSettings.test.tsx`.

- [ ] Failing test: loads stored `'false'` as off; toggling saves `'true'`/`'false'` under `sessions.progressMod.enabled`.
- [ ] Implement; run; commit.

### Task 10: Verify + docs

- [ ] README feature bullet, CHANGELOG line.
- [ ] `/verify` (check, build, test:coverage, rebuild:electron). `npm run package` and confirm `out/OmniFex-darwin-arm64/OmniFex.app/Contents/Resources/omnifex-mod/hooks/register.ts` exists.
- [ ] One fresh reviewer over the whole branch; fix findings.
