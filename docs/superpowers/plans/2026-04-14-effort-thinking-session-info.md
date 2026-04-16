# Effort, Thinking, and Session Info Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the fake "thinking modes" (prompt-phrase hack) with real SDK effort + thinking controls, and surface session state (effort, permission mode, git branch) in the session header.

**Architecture:** Effort and thinking are query-time options in the Claude Agent SDK. Effort levels (auto/low/medium/high/max) map to the `effort` query option and mid-session `applyFlagSettings({ effortLevel })`. Thinking modes (adaptive/budget/disabled) map to the `thinking` query option and mid-session `setMaxThinkingTokens()`. Both controls live in the FloatingPromptInput toolbar where the old thinking-mode picker was. The SessionHeader gets three new inline badges showing effort level, permission mode, and git branch.

**Tech Stack:** TypeScript, React, Claude Agent SDK (`query()`, `applyFlagSettings`, `setMaxThinkingTokens`, `ModelInfo`), Electron IPC

---

## File Structure

### Modified files

| File | Responsibility |
|------|---------------|
| `electron/services/sessions.ts` | Add `effort` and `thinking` to `SessionStartParams`; pass them to `query()`. Add `setEffort()` and `setThinking()` service methods that call `applyFlagSettings` / `setMaxThinkingTokens`. |
| `electron/ipc/handlers.ts` | Wire `session_set_effort` and `session_set_thinking` IPC handlers. |
| `electron/preload.ts` | Add `session_set_effort` and `session_set_thinking` to the invoke allow-list. |
| `src/lib/api.ts` | Add `sessionSetEffort()` and `sessionSetThinking()` typed wrapper methods. |
| `src/components/FloatingPromptInput.tsx` | Replace `THINKING_MODES` (phrase hack) with `EFFORT_LEVELS` and `THINKING_CONFIGS`. Update picker UI. Export new types. Add `effort` and `thinkingConfig` to `onSend` callback. |
| `src/components/ClaudeCodeSession.tsx` | Pass effort + thinking to `api.startSession()`. Wire mid-session effort/thinking changes. Remove old `thinkingSeconds` / `liveThinking` / `thinkingStartRef` prompt-phrase state. Add effort, permissionMode, and gitBranch to SessionHeader props. |
| `src/components/SessionHeader.tsx` | Add effort level badge, permission mode badge, and git branch badge. |
| `electron/__tests__/sessions.test.ts` | Tests for new effort/thinking params and mid-session changes. |

---

## Task 1: Add effort and thinking to SessionStartParams and query options

**Files:**
- Modify: `electron/services/sessions.ts`
- Test: `electron/__tests__/sessions.test.ts`

- [ ] **Step 1: Write the failing test — effort passed to SDK query options**

In `electron/__tests__/sessions.test.ts`, add after the existing "passes correct options" test:

```typescript
it('passes effort and thinking options to the SDK query when provided', () => {
  const fake = installFakeQuery();
  service.start({
    tabId: 'tab-effort',
    projectPath: '/p',
    configDir: '/c',
    model: 'sonnet',
    permissionMode: 'default',
    effort: 'high',
    thinking: { type: 'adaptive' },
  });

  const options = fake.getCapturedOptions();
  expect(options.effort).toBe('high');
  expect(options.thinking).toEqual({ type: 'adaptive' });
  service.stopAll();
});

it('omits effort and thinking from SDK query when not provided (auto behavior)', () => {
  const fake = installFakeQuery();
  service.start({
    tabId: 'tab-auto',
    projectPath: '/p',
    configDir: '/c',
    model: 'sonnet',
    permissionMode: 'default',
  });

  const options = fake.getCapturedOptions();
  expect(options.effort).toBeUndefined();
  expect(options.thinking).toBeUndefined();
  service.stopAll();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- --reporter=verbose 2>&1 | grep -A 3 'effort and thinking'`
Expected: FAIL — `SessionStartParams` doesn't have `effort` or `thinking` fields yet.

- [ ] **Step 3: Add effort and thinking to SessionStartParams and wire to query options**

In `electron/services/sessions.ts`, update the `SessionStartParams` interface:

```typescript
export interface SessionStartParams {
  tabId: string;
  projectPath: string;
  configDir: string;
  model: string;
  permissionMode: string;
  resumeSessionId?: string;
  effort?: 'low' | 'medium' | 'high' | 'max';
  thinking?: { type: 'adaptive'; display?: 'summarized' | 'omitted' }
    | { type: 'enabled'; budgetTokens?: number; display?: 'summarized' | 'omitted' }
    | { type: 'disabled' };
}
```

In the `start()` function, after the existing options construction (~line 240), add:

```typescript
if (params.effort) {
  options.effort = params.effort;
}
if (params.thinking) {
  options.thinking = params.thinking;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- --reporter=verbose 2>&1 | grep -E '(effort|thinking|PASS|FAIL)'`
Expected: Both new tests PASS.

- [ ] **Step 5: Commit**

```
feat: pass effort and thinking options through to SDK query
```

---

## Task 2: Add mid-session setEffort and setThinking service methods

**Files:**
- Modify: `electron/services/sessions.ts`
- Test: `electron/__tests__/sessions.test.ts`

- [ ] **Step 1: Write the failing test — setEffort calls applyFlagSettings**

```typescript
it('setEffort calls applyFlagSettings with effortLevel', async () => {
  const fake = installFakeQuery();
  service.start({
    tabId: 'tab-set-effort',
    projectPath: '/p',
    configDir: '/c',
    model: 'sonnet',
    permissionMode: 'default',
  });

  // Add applyFlagSettings mock to the fake query
  fake.query.applyFlagSettings = vi.fn().mockResolvedValue(undefined);

  await service.setEffort('tab-set-effort', 'max');
  expect(fake.query.applyFlagSettings).toHaveBeenCalledWith({ effortLevel: 'max' });

  service.stopAll();
});

it('setEffort with null clears effortLevel', async () => {
  const fake = installFakeQuery();
  service.start({
    tabId: 'tab-clear-effort',
    projectPath: '/p',
    configDir: '/c',
    model: 'sonnet',
    permissionMode: 'default',
  });

  fake.query.applyFlagSettings = vi.fn().mockResolvedValue(undefined);

  await service.setEffort('tab-clear-effort', null);
  expect(fake.query.applyFlagSettings).toHaveBeenCalledWith({ effortLevel: undefined });

  service.stopAll();
});
```

- [ ] **Step 2: Write the failing test — setThinking calls setMaxThinkingTokens / applyFlagSettings**

```typescript
it('setThinking("disabled") calls setMaxThinkingTokens(0)', async () => {
  const fake = installFakeQuery();
  service.start({
    tabId: 'tab-think-off',
    projectPath: '/p',
    configDir: '/c',
    model: 'sonnet',
    permissionMode: 'default',
  });

  await service.setThinking('tab-think-off', { type: 'disabled' });
  expect(fake.query.setMaxThinkingTokens).toHaveBeenCalledWith(0);

  service.stopAll();
});

it('setThinking("adaptive") calls setMaxThinkingTokens(null)', async () => {
  const fake = installFakeQuery();
  service.start({
    tabId: 'tab-think-adapt',
    projectPath: '/p',
    configDir: '/c',
    model: 'sonnet',
    permissionMode: 'default',
  });

  await service.setThinking('tab-think-adapt', { type: 'adaptive' });
  expect(fake.query.setMaxThinkingTokens).toHaveBeenCalledWith(null);

  service.stopAll();
});

it('setThinking("enabled", budget) calls setMaxThinkingTokens(budget)', async () => {
  const fake = installFakeQuery();
  service.start({
    tabId: 'tab-think-budget',
    projectPath: '/p',
    configDir: '/c',
    model: 'sonnet',
    permissionMode: 'default',
  });

  await service.setThinking('tab-think-budget', { type: 'enabled', budgetTokens: 10000 });
  expect(fake.query.setMaxThinkingTokens).toHaveBeenCalledWith(10000);

  service.stopAll();
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npm test 2>&1 | tail -5`
Expected: FAIL — `setEffort` and `setThinking` don't exist on the service.

- [ ] **Step 4: Implement setEffort and setThinking in the sessions service**

Add to `SessionsService` interface:

```typescript
/** Change effort level mid-session. null = auto (clear setting). */
setEffort(tabId: string, level: 'low' | 'medium' | 'high' | 'max' | null): Promise<void>;
/** Change thinking mode mid-session. */
setThinking(tabId: string, config: SessionStartParams['thinking']): Promise<void>;
```

Add implementations (next to `setModel` and `setPermissionMode`):

```typescript
async function setEffort(tabId: string, level: 'low' | 'medium' | 'high' | 'max' | null): Promise<void> {
  const handle = sessions.get(tabId);
  if (!handle) return;
  try {
    await handle.query.applyFlagSettings({ effortLevel: level ?? undefined } as any);
  } catch (err) {
    console.error(`[sessions] setEffort failed for tab ${tabId}:`, err);
  }
}

async function setThinking(tabId: string, config: SessionStartParams['thinking']): Promise<void> {
  const handle = sessions.get(tabId);
  if (!handle) return;
  try {
    if (!config || config.type === 'disabled') {
      await handle.query.setMaxThinkingTokens(0);
    } else if (config.type === 'adaptive') {
      await handle.query.setMaxThinkingTokens(null);
    } else if (config.type === 'enabled') {
      await handle.query.setMaxThinkingTokens(config.budgetTokens ?? null);
    }
  } catch (err) {
    console.error(`[sessions] setThinking failed for tab ${tabId}:`, err);
  }
}
```

Add both to the return object alongside `setModel` and `setPermissionMode`.

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm test 2>&1 | tail -5`
Expected: All tests PASS.

- [ ] **Step 6: Commit**

```
feat: add setEffort and setThinking mid-session controls
```

---

## Task 3: Wire IPC handlers and preload

**Files:**
- Modify: `electron/ipc/handlers.ts`
- Modify: `electron/preload.ts`
- Modify: `src/lib/api.ts`

- [ ] **Step 1: Add IPC handlers**

In `electron/ipc/handlers.ts`, add next to `session_set_model` and `session_set_permission_mode`:

```typescript
session_set_effort: wrapWith((p: Record<string, unknown>) => sessions?.setEffort((p?.tabId ?? p?.session_id) as string, (p?.level ?? p?.effort) as any) ?? null),
session_set_thinking: wrapWith((p: Record<string, unknown>) => sessions?.setThinking((p?.tabId ?? p?.session_id) as string, (p?.config ?? p?.thinking) as any) ?? null),
```

- [ ] **Step 2: Add to preload allow-list**

In `electron/preload.ts`, find the invoke allow-list array and add:

```typescript
'session_set_effort',
'session_set_thinking',
```

- [ ] **Step 3: Add typed API wrappers**

In `src/lib/api.ts`, add alongside the existing `sessionSetModel`:

```typescript
async sessionSetEffort(tabId: string, level: 'low' | 'medium' | 'high' | 'max' | null): Promise<void> {
  return apiCall("session_set_effort", { tabId, level });
},

async sessionSetThinking(tabId: string, config: { type: 'adaptive' } | { type: 'enabled'; budgetTokens?: number } | { type: 'disabled' } | null): Promise<void> {
  return apiCall("session_set_thinking", { tabId, config });
},
```

Also update `startSession` to accept the new params:

```typescript
async startSession(tabId: string, projectPath: string, model: string, permissionMode: string, resumeSessionId?: string, configDir?: string, effort?: string, thinking?: Record<string, unknown>): Promise<void> {
  return apiCall("session_start", { tabId, projectPath, model, permissionMode, resumeSessionId, configDir, effort, thinking });
},
```

- [ ] **Step 4: Run type check and tests**

Run: `npm run check && npm test`
Expected: PASS — no runtime behavior change yet, just wiring.

- [ ] **Step 5: Commit**

```
feat: wire effort and thinking IPC channels and API surface
```

---

## Task 4: Replace FloatingPromptInput thinking modes with real effort + thinking controls

**Files:**
- Modify: `src/components/FloatingPromptInput.tsx`

- [ ] **Step 1: Replace THINKING_MODES with EFFORT_LEVELS**

Remove the `ThinkingMode` type, `ThinkingModeConfig` type, `THINKING_MODES` array, and `ThinkingModeIndicator` component.

Add:

```typescript
export type EffortLevel = 'auto' | 'low' | 'medium' | 'high' | 'max';

export const EFFORT_LEVELS: { id: EffortLevel; name: string; description: string; shortName: string; color: string }[] = [
  { id: 'auto', name: 'Auto', description: 'Let the model decide (default)', shortName: 'A', color: 'text-muted-foreground' },
  { id: 'low', name: 'Low', description: 'Minimal thinking, fastest responses', shortName: 'Lo', color: 'text-green-500' },
  { id: 'medium', name: 'Medium', description: 'Moderate thinking', shortName: 'Med', color: 'text-yellow-500' },
  { id: 'high', name: 'High', description: 'Deep reasoning', shortName: 'Hi', color: 'text-orange-500' },
  { id: 'max', name: 'Max', description: 'Maximum effort (Opus only)', shortName: 'Max', color: 'text-red-500' },
];

export type ThinkingConfig = 'adaptive' | 'budget' | 'disabled';

export const THINKING_CONFIGS: { id: ThinkingConfig; name: string; description: string }[] = [
  { id: 'adaptive', name: 'Adaptive', description: 'Claude decides when and how much to think' },
  { id: 'budget', name: 'Budget', description: 'Fixed thinking token budget' },
  { id: 'disabled', name: 'Off', description: 'No extended thinking' },
];
```

- [ ] **Step 2: Update the FloatingPromptInput props and state**

Replace `defaultThinkingMode`/`onThinkingModeChange` props with:

```typescript
effort: EffortLevel;
onEffortChange: (level: EffortLevel) => void;
thinkingConfig: ThinkingConfig;
onThinkingConfigChange: (config: ThinkingConfig) => void;
thinkingBudget?: number;
onThinkingBudgetChange?: (budget: number) => void;
```

Remove the `selectedThinkingMode` state and the prompt-phrase append logic in `handleSend` (the line that does `finalPrompt = \`${finalPrompt}.\n\n${thinkingMode.phrase}.\``).

- [ ] **Step 3: Replace the thinking-mode picker UI with effort picker**

Replace the thinking mode popover/button with an effort level picker that follows the same pattern as the permission mode picker. Use the `EFFORT_LEVELS` array. The thinking config picker can be a smaller secondary control.

- [ ] **Step 4: Remove the `THINKING_MODES` export**

Update `ClaudeCodeSession.tsx` to stop importing `THINKING_MODES` and `ThinkingMode`. Fix all compilation errors.

- [ ] **Step 5: Run type check**

Run: `npm run check`
Expected: PASS (may have errors in ClaudeCodeSession — fix in next task).

- [ ] **Step 6: Commit**

```
feat: replace prompt-phrase thinking hack with real effort and thinking controls
```

---

## Task 5: Wire effort and thinking in ClaudeCodeSession

**Files:**
- Modify: `src/components/ClaudeCodeSession.tsx`

- [ ] **Step 1: Add effort and thinking state**

Replace the old `thinkingMode` state with:

```typescript
const [effort, setEffort] = useState<EffortLevel>('auto');
const [thinkingConfig, setThinkingConfig] = useState<ThinkingConfig>('adaptive');
const [thinkingBudget, setThinkingBudget] = useState<number>(10000);
```

Remove `thinkingSeconds`, `liveThinking`, and `thinkingStartRef` state — the thinking *display* in StreamMessage still works (it renders `thinking` blocks from the SDK stream), but the duration tracking was tied to the old prompt-phrase approach and added no value.

- [ ] **Step 2: Pass effort and thinking to startSession**

In the session start logic, build the SDK thinking config object from the component state:

```typescript
const sdkThinking = thinkingConfig === 'adaptive'
  ? { type: 'adaptive' as const }
  : thinkingConfig === 'disabled'
  ? { type: 'disabled' as const }
  : { type: 'enabled' as const, budgetTokens: thinkingBudget };

const sdkEffort = effort === 'auto' ? undefined : effort;

api.startSession(tabId, projectPath, selectedModel, mode, resumeSessionId, configDir, sdkEffort, sdkThinking);
```

- [ ] **Step 3: Wire mid-session effort/thinking changes**

When the user changes effort mid-session (session is active):

```typescript
const handleEffortChange = (level: EffortLevel) => {
  setEffort(level);
  if (service.isActive(tabId)) {
    api.sessionSetEffort(tabId, level === 'auto' ? null : level);
  }
};
```

Same pattern for thinking config changes.

- [ ] **Step 4: Pass props to FloatingPromptInput**

Wire the new `effort`, `onEffortChange`, `thinkingConfig`, `onThinkingConfigChange` props to FloatingPromptInput.

- [ ] **Step 5: Remove the old thinking duration display from the status bar**

In the loading indicator text, remove the `thinkingSeconds > 0 ? \` · thought for ${thinkingSeconds}s\` : ''` fragment. The thinking blocks themselves are still rendered by StreamMessage — this was just a duration counter for the prompt-phrase approach.

- [ ] **Step 6: Run type check and build**

Run: `npm run check && npm run build`
Expected: PASS.

- [ ] **Step 7: Commit**

```
feat: wire real SDK effort and thinking controls in session UI
```

---

## Task 6: Add session info badges to SessionHeader

**Files:**
- Modify: `src/components/SessionHeader.tsx`
- Modify: `src/components/ClaudeCodeSession.tsx`

- [ ] **Step 1: Add new props to SessionHeader**

```typescript
interface SessionHeaderProps {
  // ... existing props ...
  effortLevel?: string;
  permissionMode?: string;
  gitBranch?: string;
}
```

- [ ] **Step 2: Add the badges to the header layout**

In `SessionHeader`, between the account badge area and the context-usage area, add three small inline badges:

```tsx
{/* Session state badges */}
{permissionMode && (
  <span className="px-1.5 py-0.5 rounded text-[10px] font-mono uppercase tracking-wide bg-foreground/5 text-foreground/60">
    {permissionMode === 'default' ? 'ask' : permissionMode === 'acceptEdits' ? 'auto-edit' : permissionMode === 'plan' ? 'plan' : permissionMode === 'bypassPermissions' ? 'yolo' : permissionMode}
  </span>
)}
{effortLevel && (
  <span className="px-1.5 py-0.5 rounded text-[10px] font-mono uppercase tracking-wide bg-foreground/5 text-foreground/60">
    effort: {effortLevel}
  </span>
)}
{gitBranch && (
  <span className="px-1.5 py-0.5 rounded text-[10px] font-mono bg-foreground/5 text-foreground/60 flex items-center gap-1">
    <GitBranch className="w-3 h-3" />
    {gitBranch}
  </span>
)}
```

- [ ] **Step 3: Pass the new props from ClaudeCodeSession**

For `permissionMode` and `effortLevel`, pass the current state.

For `gitBranch`, read it at session start using a simple `git rev-parse --abbrev-ref HEAD` call. Add a new IPC call or reuse an existing mechanism. The simplest approach: run it client-side via an existing IPC that takes a shell command, or add a lightweight service method. Since `projectPath` is known, the most direct approach is a new API method:

In `src/lib/api.ts`:
```typescript
async getGitBranch(projectPath: string): Promise<string | null> {
  return apiCall("get_git_branch", { projectPath });
},
```

In `electron/ipc/handlers.ts`:
```typescript
get_git_branch: wrapWith(async (p: Record<string, unknown>) => {
  const projectPath = (p?.projectPath ?? p?.project_path) as string;
  if (!projectPath) return null;
  try {
    const { execFileSync } = require('node:child_process') as typeof import('node:child_process');
    return execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: projectPath, encoding: 'utf8' }).trim();
  } catch { return null; }
}),
```

Add `get_git_branch` to the preload allow-list.

In `ClaudeCodeSession.tsx`, fetch at session start and on focus:
```typescript
const [gitBranch, setGitBranch] = useState<string | null>(null);

useEffect(() => {
  if (projectPath) {
    api.getGitBranch(projectPath).then(setGitBranch).catch(() => setGitBranch(null));
  }
}, [projectPath]);
```

- [ ] **Step 4: Run type check and build**

Run: `npm run check && npm run build`
Expected: PASS.

- [ ] **Step 5: Commit**

```
feat: show effort, permission mode, and git branch in session header
```

---

## Task 7: Final integration test and cleanup

- [ ] **Step 1: Run full verification gate**

Run: `npm run check && npm run build && npm run test:coverage`
Expected: All pass, coverage >= 80%.

- [ ] **Step 2: Manual smoke test**

Run: `npm start`

Verify:
1. Effort picker shows Auto/Low/Medium/High/Max
2. Thinking picker shows Adaptive/Budget/Off
3. Changing effort mid-session works (check SDK debug logs)
4. Session header shows permission mode, effort level, and git branch
5. The old "think"/"think hard"/"ultrathink" phrase appending is gone
6. Thinking blocks in the stream still render (ThinkingWidget in StreamMessage.tsx is unchanged)

- [ ] **Step 3: Commit and rebuild for Electron**

```
npm run rebuild:electron
```

- [ ] **Step 4: Final commit**

```
feat: real SDK effort/thinking controls, session info header badges
```
