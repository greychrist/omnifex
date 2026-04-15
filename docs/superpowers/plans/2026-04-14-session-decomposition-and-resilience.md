# Session Decomposition & Resilience Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Decompose the 1530-line `sessions.ts` monolith into a focused module folder and layer in session resilience (bounded channels, health checks, smarter timeouts, session resume).

**Architecture:** Extract types, hooks, permissions, and query passthroughs into separate files under `electron/services/sessions/`. The public `SessionsService` interface is unchanged — no import path changes needed. Phase 2 adds bounded AsyncChannel, a `getHealth()` method, renderer timeout improvements, and session resume on app restart.

**Tech Stack:** TypeScript, Electron IPC, @anthropic-ai/claude-agent-sdk, Vitest

---

## File Map

### Phase 1: Decomposition (pure refactor, no behavioral changes)

| Action | File | Responsibility |
|--------|------|----------------|
| Create | `electron/services/sessions/types.ts` | All shared types: SessionHandle, PermissionDecision, SessionStatus, etc. |
| Create | `electron/services/sessions/hooks.ts` | `createSessionHooks()` factory — 25+ SDK audit callbacks |
| Create | `electron/services/sessions/permissions.ts` | `createCanUseTool()`, `respondPermission()`, auto-allow |
| Create | `electron/services/sessions/queries.ts` | `createQueryPassthroughs()` — 12 Wave 2 methods |
| Create | `electron/services/sessions/lifecycle.ts` | `createSessionsService()` factory — orchestrates other modules |
| Create | `electron/services/sessions/index.ts` | Re-exports public API |
| Delete | `electron/services/sessions.ts` | Replaced by the module folder |

### Phase 2: Resilience

| Action | File | Responsibility |
|--------|------|----------------|
| Modify | `electron/services/async-channel.ts` | Add optional `maxSize` with overflow drop |
| Modify | `electron/services/sessions/types.ts` | Add `getHealth()` to SessionsService interface |
| Modify | `electron/services/sessions/lifecycle.ts` | Implement `getHealth()`, use bounded channel |
| Modify | `electron/ipc/handlers.ts` | Add `session_get_health` handler |
| Modify | `electron/preload.ts` | Add `session_get_health` to allow-list |
| Modify | `src/lib/api.ts` | Add `sessionGetHealth()` typed wrapper |
| Modify | `src/components/ClaudeCodeSession.tsx` | Smarter timeouts using health check |
| Modify | `src/components/ClaudeCodeSession.tsx` | Resume session on tab restore |
| Test | `electron/__tests__/sessions.test.ts` | New tests for bounded channel, getHealth, resume |

---

## Task 1: Create `types.ts` — extract shared types

**Files:**
- Create: `electron/services/sessions/types.ts`

- [ ] **Step 1: Create the sessions directory and types file**

```typescript
// electron/services/sessions/types.ts
//
// Shared types for the sessions module. Every other file in this directory
// imports from here to avoid circular dependencies.

import type { AsyncChannel } from '../async-channel';
import type {
  SDKUserMessage,
  Query,
  PermissionMode,
  AccountInfo,
  AgentInfo,
  ModelInfo,
  SlashCommand,
  SDKControlGetContextUsageResponse,
} from '@anthropic-ai/claude-agent-sdk';
import type { McpServerStatus } from '@anthropic-ai/claude-agent-sdk';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type SessionStatus = 'starting' | 'running' | 'waiting_permission' | 'stopped' | 'error';

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

export interface SessionsService {
  start(params: SessionStartParams): void;
  sendMessage(tabId: string, prompt: string): void;
  sendStructuredMessage(tabId: string, content: Array<Record<string, unknown>>): void;
  respondPermission(
    tabId: string,
    behavior: 'allow' | 'deny',
    updatedInput?: Record<string, unknown>,
    updatedPermissions?: PermissionDecision['updatedPermissions'],
  ): void;
  setAutoAllow(tabId: string, enabled: boolean): void;
  addAutoAllowTool(tabId: string, toolName: string): void;
  stop(tabId: string): void;
  stopAll(): void;
  getSessionId(tabId: string): string | null;
  getStatus(tabId: string): SessionStatus;
  getInfo(tabId: string): { sessionId: string | null; status: SessionStatus } | null;
  isActive(tabId: string): boolean;

  // Wave 2 — Query-method passthroughs
  interrupt(tabId: string): Promise<void>;
  setModel(tabId: string, model?: string): Promise<void>;
  setPermissionMode(tabId: string, mode: PermissionMode): Promise<void>;
  setEffort(tabId: string, level: 'low' | 'medium' | 'high' | 'max' | null): Promise<void>;
  setThinking(tabId: string, config: SessionStartParams['thinking']): Promise<void>;
  getAccountInfo(tabId: string): Promise<AccountInfo | null>;
  getContextUsage(tabId: string): Promise<SDKControlGetContextUsageResponse | null>;
  getSupportedCommands(tabId: string): Promise<SlashCommand[]>;
  getSupportedModels(tabId: string): Promise<ModelInfo[]>;
  getSupportedAgents(tabId: string): Promise<AgentInfo[]>;
  getMcpServerStatus(tabId: string): Promise<McpServerStatus[]>;
}

// ---------------------------------------------------------------------------
// Internal shared types
// ---------------------------------------------------------------------------

export type SendToRenderer = (channel: string, ...args: unknown[]) => void;

export interface NotificationHooks {
  showNotification?: (title: string, body: string, isError: boolean) => void;
  incrementUnread?: () => void;
}

export interface PermissionDecision {
  behavior: 'allow' | 'deny';
  updatedInput?: Record<string, unknown>;
  updatedPermissions?: Array<{
    type: 'addRules';
    rules: Array<{ toolName: string; ruleContent?: string }>;
    behavior: 'allow';
    destination: 'session' | 'projectSettings' | 'userSettings';
  }>;
}

export interface PendingPermission {
  requestId: string;
  resolve: (decision: PermissionDecision) => void;
  payload?: any;
}

export interface SessionHandle {
  query: Query;
  inputChannel: AsyncChannel<SDKUserMessage>;
  sessionId: string | null;
  status: SessionStatus;
  permissionResolver: ((decision: PermissionDecision) => void) | null;
  permissionQueue: PendingPermission[];
  autoAllowEnabled: boolean;
  autoAllowedTools: Set<string>;
  projectPath: string;
  configDir: string;
  sdkOptions: Record<string, unknown>;
}

// Re-export SDK types that consumers need
export type { PermissionMode, AccountInfo, AgentInfo, ModelInfo, SlashCommand, SDKControlGetContextUsageResponse, McpServerStatus, SDKUserMessage, Query, AsyncChannel };
```

- [ ] **Step 2: Verify the file compiles**

Run: `npx tsc --noEmit electron/services/sessions/types.ts 2>&1 | head -20`

Expected: No errors (or only errors about missing tsconfig resolution — the full `npm run check` will verify later).

---

## Task 2: Create `hooks.ts` — extract SDK hooks factory

**Files:**
- Create: `electron/services/sessions/hooks.ts`

- [ ] **Step 1: Create hooks.ts**

Lift lines 343-1039 from `sessions.ts` verbatim into a factory function. The `stringifyCapped` helper and `METADATA_CAP` constant move here as module-level helpers.

```typescript
// electron/services/sessions/hooks.ts
//
// SDK lifecycle hooks for session auditing and logging. Each hook writes
// a structured log entry and optionally forwards events to the renderer.
// All hooks return {} and catch their own errors — they never interrupt
// the session.

import type { LoggingService } from '../logging';
import type { SendToRenderer, NotificationHooks } from './types';

const METADATA_CAP = 4000;

function stringifyCapped(obj: unknown): string {
  try {
    const s = JSON.stringify(obj);
    if (s.length <= METADATA_CAP) return s;
    return s.slice(0, METADATA_CAP - 20) + '…[truncated]';
  } catch {
    return '"[unserializable]"';
  }
}

/**
 * Build the SDK hooks object for a session. Returns the value to assign
 * to `options.hooks` when calling `query()`.
 */
export function createSessionHooks(
  tabId: string,
  logging: LoggingService | null,
  sendToRenderer: SendToRenderer,
  notificationHooks: NotificationHooks,
): Record<string, any> {
  if (!logging) return {};

  return {
    // --- Paste the ENTIRE hooks object from sessions.ts lines 355-1038 here ---
    // PreToolUse, PostToolUse, PostToolUseFailure, SubagentStart, SubagentStop,
    // PreCompact, Notification, FileChanged, SessionStart, SessionEnd, Stop,
    // StopFailure, PostCompact, PermissionDenied, UserPromptSubmit, Setup,
    // TaskCreated, TaskCompleted, Elicitation, ElicitationResult, ConfigChange,
    // InstructionsLoaded
    //
    // Each callback references `tabId`, `logging`, `sendToRenderer`, and
    // `notificationHooks` via closure — same as the current code.
    // The only change is that these variables come from function parameters
    // instead of the outer createSessionsService closure.
  };
}
```

The actual implementation is a verbatim copy of the hooks object from `sessions.ts` lines 354-1039. Every callback body is unchanged — only the surrounding structure changes (function params instead of closure vars).

- [ ] **Step 2: Verify no syntax errors**

Run: `npx tsc --noEmit electron/services/sessions/hooks.ts 2>&1 | head -20`

---

## Task 3: Create `permissions.ts` — extract permission handling

**Files:**
- Create: `electron/services/sessions/permissions.ts`

- [ ] **Step 1: Create permissions.ts**

Lift the `canUseTool` callback (lines 1047-1174), `respondPermission` (lines 1269-1302), `setAutoAllow` (lines 1308-1312), and `addAutoAllowTool` (lines 1314-1318) from `sessions.ts`.

```typescript
// electron/services/sessions/permissions.ts
//
// Permission handling for sessions. Manages the canUseTool callback,
// the permission request queue, and auto-allow state.

import fs from 'node:fs';
import path from 'node:path';
import type { SessionHandle, PermissionDecision, PendingPermission, SendToRenderer, NotificationHooks } from './types';

/**
 * Build the `canUseTool` callback for SDK options. Called by the SDK before
 * each tool execution. Requests are queued and shown one at a time so the
 * user isn't overwhelmed.
 */
export function createCanUseTool(
  handle: SessionHandle,
  tabId: string,
  sendToRenderer: SendToRenderer,
  notificationHooks: NotificationHooks,
): (toolName: string, toolInput: Record<string, unknown>, toolOptions: any) => Promise<any> {
  return async (
    toolName: string,
    toolInput: Record<string, unknown>,
    toolOptions: {
      signal: AbortSignal;
      suggestions?: any[];
      blockedPath?: string;
      decisionReason?: string;
      title?: string;
      displayName?: string;
      description?: string;
      toolUseID: string;
      agentID?: string;
    },
  ): Promise<any> => {
    // --- Paste the ENTIRE canUseTool body from sessions.ts lines 1062-1173 here ---
    // The only change: `handle`, `tabId`, `sendToRenderer`, `notificationHooks`
    // come from the outer function params / closure instead of the
    // createSessionsService closure.
  };
}

/**
 * Resolve the front of the permission queue and show the next request if any.
 */
export function respondPermission(
  handle: SessionHandle,
  tabId: string,
  sendToRenderer: SendToRenderer,
  notificationHooks: NotificationHooks,
  behavior: 'allow' | 'deny',
  updatedInput?: Record<string, unknown>,
  updatedPermissions?: PermissionDecision['updatedPermissions'],
): void {
  if (handle.permissionQueue.length === 0) return;

  // --- Paste the body from sessions.ts lines 1279-1301 here ---
}

export function setAutoAllow(handle: SessionHandle, enabled: boolean): void {
  handle.autoAllowEnabled = enabled;
}

export function addAutoAllowTool(handle: SessionHandle, toolName: string): void {
  handle.autoAllowedTools.add(toolName);
}
```

- [ ] **Step 2: Verify no syntax errors**

Run: `npx tsc --noEmit electron/services/sessions/permissions.ts 2>&1 | head -20`

---

## Task 4: Create `queries.ts` — extract Wave 2 passthroughs

**Files:**
- Create: `electron/services/sessions/queries.ts`

- [ ] **Step 1: Create queries.ts**

Lift lines 1370-1498 from `sessions.ts`.

```typescript
// electron/services/sessions/queries.ts
//
// Wave 2 query-method passthroughs. Each method looks up the session handle
// and forwards to the corresponding SDK Query method. Unknown tabs return
// null or []. SDK errors are swallowed so a misbehaving subprocess can't
// crash the IPC layer.

import type { SessionHandle, SessionsService } from './types';
import type { PermissionMode } from '@anthropic-ai/claude-agent-sdk';
import type { SessionStartParams } from './types';

type QueryMethods = Pick<SessionsService,
  'interrupt' | 'setModel' | 'setPermissionMode' | 'setEffort' | 'setThinking' |
  'getAccountInfo' | 'getContextUsage' | 'getSupportedCommands' |
  'getSupportedModels' | 'getSupportedAgents' | 'getMcpServerStatus'
>;

export function createQueryPassthroughs(
  sessions: Map<string, SessionHandle>,
): QueryMethods {
  async function interrupt(tabId: string): Promise<void> {
    const handle = sessions.get(tabId);
    if (!handle) return;
    try {
      await handle.query.interrupt();
    } catch (err) {
      console.error(`[sessions] interrupt failed for tab ${tabId}:`, err);
    }
  }

  async function setModel(tabId: string, model?: string): Promise<void> {
    const handle = sessions.get(tabId);
    if (!handle) return;
    try {
      await handle.query.setModel(model);
    } catch (err) {
      console.error(`[sessions] setModel failed for tab ${tabId}:`, err);
    }
  }

  async function setPermissionMode(tabId: string, mode: PermissionMode): Promise<void> {
    const handle = sessions.get(tabId);
    if (!handle) return;
    try {
      await handle.query.setPermissionMode(mode);
    } catch (err) {
      console.error(`[sessions] setPermissionMode failed for tab ${tabId}:`, err);
    }
  }

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

  async function getAccountInfo(tabId: string) {
    const handle = sessions.get(tabId);
    if (!handle) return null;
    try {
      return await handle.query.accountInfo();
    } catch (err) {
      console.error(`[sessions] accountInfo failed for tab ${tabId}:`, err);
      return null;
    }
  }

  async function getContextUsage(tabId: string) {
    const handle = sessions.get(tabId);
    if (!handle) return null;
    try {
      return await handle.query.getContextUsage();
    } catch (err) {
      console.error(`[sessions] getContextUsage failed for tab ${tabId}:`, err);
      return null;
    }
  }

  async function getSupportedCommands(tabId: string) {
    const handle = sessions.get(tabId);
    if (!handle) return [];
    try {
      return await handle.query.supportedCommands();
    } catch (err) {
      console.error(`[sessions] supportedCommands failed for tab ${tabId}:`, err);
      return [];
    }
  }

  async function getSupportedModels(tabId: string) {
    const handle = sessions.get(tabId);
    if (!handle) return [];
    try {
      return await handle.query.supportedModels();
    } catch (err) {
      console.error(`[sessions] supportedModels failed for tab ${tabId}:`, err);
      return [];
    }
  }

  async function getSupportedAgents(tabId: string) {
    const handle = sessions.get(tabId);
    if (!handle) return [];
    try {
      return await handle.query.supportedAgents();
    } catch (err) {
      console.error(`[sessions] supportedAgents failed for tab ${tabId}:`, err);
      return [];
    }
  }

  async function getMcpServerStatus(tabId: string) {
    const handle = sessions.get(tabId);
    if (!handle) return [];
    try {
      const result = await Promise.race([
        handle.query.mcpServerStatus(),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 3000)),
      ]);
      if (result && result.length > 0) return result;
    } catch { /* SDK not ready */ }
    return [];
  }

  return {
    interrupt,
    setModel,
    setPermissionMode,
    setEffort,
    setThinking,
    getAccountInfo,
    getContextUsage,
    getSupportedCommands,
    getSupportedModels,
    getSupportedAgents,
    getMcpServerStatus,
  };
}
```

- [ ] **Step 2: Verify no syntax errors**

Run: `npx tsc --noEmit electron/services/sessions/queries.ts 2>&1 | head -20`

---

## Task 5: Create `lifecycle.ts` — the orchestrator

**Files:**
- Create: `electron/services/sessions/lifecycle.ts`

- [ ] **Step 1: Create lifecycle.ts**

This contains what remains of `sessions.ts` after extracting the other three blocks. It imports from the sibling modules and composes them.

```typescript
// electron/services/sessions/lifecycle.ts
//
// Session lifecycle management — the orchestrator. Creates and manages
// session handles, drives the SDK streaming loop, and delegates hooks,
// permissions, and query passthroughs to their respective modules.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createAsyncChannel } from '../async-channel';
import type { LoggingService } from '../logging';
import { query } from '@anthropic-ai/claude-agent-sdk';
import type { SDKUserMessage, PermissionMode } from '@anthropic-ai/claude-agent-sdk';

import { createSessionHooks } from './hooks';
import { createCanUseTool, respondPermission as respondPerm, setAutoAllow as setAA, addAutoAllowTool as addAAT } from './permissions';
import { createQueryPassthroughs } from './queries';
import type {
  SessionsService,
  SessionStartParams,
  SessionHandle,
  SessionStatus,
  SendToRenderer,
  NotificationHooks,
  PermissionDecision,
} from './types';

function findSystemClaudeBinary(): string | null {
  const candidates = [
    `${os.homedir()}/.local/bin/claude`,
    '/usr/local/bin/claude',
    '/opt/homebrew/bin/claude',
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

export function createSessionsService(
  sendToRenderer: SendToRenderer,
  notificationHooks: NotificationHooks = {},
  logging: LoggingService | null = null,
): SessionsService {
  const sessions = new Map<string, SessionHandle>();

  // --- listenToMessages: verbatim from sessions.ts lines 165-228 ---
  async function listenToMessages(tabId: string, handle: SessionHandle): Promise<void> {
    // ... (paste lines 165-228 unchanged)
  }

  // --- restartQuery: verbatim from sessions.ts lines 234-253 ---
  function restartQuery(tabId: string, handle: SessionHandle): void {
    // ... (paste lines 234-253 unchanged, using createAsyncChannel import)
  }

  // --- start: sessions.ts lines 259-1214, BUT with hooks/permissions extracted ---
  function start(params: SessionStartParams): void {
    const { tabId, projectPath, configDir, model, permissionMode, resumeSessionId, effort, thinking } = params;

    // Close any existing session for this tab
    const existing = sessions.get(tabId);
    if (existing) {
      existing.inputChannel.close();
      existing.query.close();
      sessions.delete(tabId);
    }

    const inputChannel = createAsyncChannel<SDKUserMessage>();

    // Build SDK options (lines 282-309 from sessions.ts)
    const options: Record<string, unknown> = {
      cwd: projectPath,
      model,
      permissionMode: permissionMode as PermissionMode,
      env: { ...process.env, CLAUDE_CONFIG_DIR: configDir },
      settingSources: ['user', 'project', 'local'],
      settings: { enableAllProjectMcpServers: true },
      onElicitation: async () => ({ action: 'accept' as const }),
    };

    if (effort) options.effort = effort;
    if (thinking) options.thinking = thinking;

    // Stderr logging (lines 314-327)
    if (logging) {
      options.stderr = (data: string) => {
        const isError = /^error[:\s]|Error in hook callback|stream closed|FATAL|panic/i.test(data);
        logging.writeBatch([{
          timestamp: new Date().toISOString(),
          level: isError ? 'error' : 'debug',
          source: 'claude-sdk',
          category: `session:${tabId}`,
          message: data,
        }]);
      };
    }

    // Create handle first so permission handler can reference it
    const handle: SessionHandle = {
      query: null as any,
      inputChannel,
      sessionId: null,
      status: 'starting',
      permissionResolver: null,
      permissionQueue: [],
      autoAllowEnabled: false,
      autoAllowedTools: new Set(),
      projectPath,
      configDir: configDir || path.join(os.homedir(), '.claude'),
      sdkOptions: options,
    };

    // Delegate to extracted modules
    options.hooks = createSessionHooks(tabId, logging, sendToRenderer, notificationHooks);
    options.canUseTool = createCanUseTool(handle, tabId, sendToRenderer, notificationHooks);

    // Binary path
    const binaryPath = findSystemClaudeBinary();
    if (binaryPath) options.pathToClaudeCodeExecutable = binaryPath;

    if (resumeSessionId) options.resume = resumeSessionId;

    // Start the SDK query
    const q = query({ prompt: inputChannel, options: options as any });
    handle.query = q;
    sessions.set(tabId, handle);

    listenToMessages(tabId, handle).catch((err) => {
      console.error(`[sessions] Unhandled error in listenToMessages for tab ${tabId}:`, err);
    });
  }

  // --- sendMessage / sendStructuredMessage: verbatim ---
  function sendMessage(tabId: string, prompt: string): void {
    // ... (paste lines 1220-1238 unchanged)
  }

  function sendStructuredMessage(tabId: string, content: Array<Record<string, unknown>>): void {
    // ... (paste lines 1241-1263 unchanged)
  }

  // --- stop / stopAll: verbatim ---
  function stop(tabId: string): void {
    const handle = sessions.get(tabId);
    if (!handle) return;
    handle.inputChannel.close();
    handle.query.close();
    sessions.delete(tabId);
  }

  function stopAll(): void {
    for (const tabId of sessions.keys()) {
      stop(tabId);
    }
  }

  // --- Query helpers ---
  function getSessionId(tabId: string): string | null {
    return sessions.get(tabId)?.sessionId ?? null;
  }

  function getStatus(tabId: string): SessionStatus {
    return sessions.get(tabId)?.status ?? 'stopped';
  }

  function getInfo(tabId: string) {
    const handle = sessions.get(tabId);
    if (!handle) return null;
    return { sessionId: handle.sessionId, status: handle.status };
  }

  function isActive(tabId: string): boolean {
    return sessions.has(tabId);
  }

  // Spread query passthroughs from the extracted module
  const queryMethods = createQueryPassthroughs(sessions);

  return {
    start,
    sendMessage,
    sendStructuredMessage,
    respondPermission: (tabId, behavior, updatedInput?, updatedPermissions?) => {
      const handle = sessions.get(tabId);
      if (!handle) return;
      respondPerm(handle, tabId, sendToRenderer, notificationHooks, behavior, updatedInput, updatedPermissions);
    },
    setAutoAllow: (tabId, enabled) => {
      const handle = sessions.get(tabId);
      if (handle) setAA(handle, enabled);
    },
    addAutoAllowTool: (tabId, toolName) => {
      const handle = sessions.get(tabId);
      if (handle) addAAT(handle, toolName);
    },
    stop,
    stopAll,
    getSessionId,
    getStatus,
    getInfo,
    isActive,
    ...queryMethods,
  };
}
```

- [ ] **Step 2: Verify no syntax errors**

Run: `npx tsc --noEmit electron/services/sessions/lifecycle.ts 2>&1 | head -20`

---

## Task 6: Create `index.ts` and delete the old file

**Files:**
- Create: `electron/services/sessions/index.ts`
- Delete: `electron/services/sessions.ts`

- [ ] **Step 1: Create index.ts**

```typescript
// electron/services/sessions/index.ts
export { createSessionsService } from './lifecycle';
export type { SessionsService, SessionStartParams, SessionStatus } from './types';
```

- [ ] **Step 2: Delete the old monolith**

```bash
rm electron/services/sessions.ts
```

- [ ] **Step 3: Run full check and tests**

Run: `npm run check && npm test`

Expected: All type checks pass, all existing tests pass. Import paths `'./services/sessions'` and `'../services/sessions'` resolve to `sessions/index.ts` automatically.

- [ ] **Step 4: Commit the decomposition**

```bash
git add electron/services/sessions/ electron/services/sessions.ts
git commit -m "refactor: decompose sessions.ts into module folder

Split the 1530-line sessions.ts monolith into:
- sessions/types.ts — shared types
- sessions/hooks.ts — 25+ SDK audit callbacks
- sessions/permissions.ts — canUseTool, permission queue, auto-allow
- sessions/queries.ts — 12 Wave 2 query passthroughs
- sessions/lifecycle.ts — orchestrator (start, stop, streaming)
- sessions/index.ts — re-exports

Public interface unchanged. No behavioral changes."
```

---

## Task 7: Bounded AsyncChannel

**Files:**
- Modify: `electron/services/async-channel.ts`
- Test: `electron/__tests__/sessions.test.ts` (async channel tests are here)

- [ ] **Step 1: Write the failing test**

Add to the `describe('async channel', ...)` block in `electron/__tests__/sessions.test.ts`:

```typescript
it('drops oldest item when maxSize is exceeded', async () => {
  const ch = createAsyncChannel<number>(3);
  ch.push(1);
  ch.push(2);
  ch.push(3);
  ch.push(4); // should drop 1
  ch.close();

  const values: number[] = [];
  for await (const v of ch) {
    values.push(v);
  }
  expect(values).toEqual([2, 3, 4]);
});

it('works normally without maxSize', async () => {
  const ch = createAsyncChannel<number>();
  ch.push(1);
  ch.push(2);
  ch.push(3);
  ch.push(4);
  ch.close();

  const values: number[] = [];
  for await (const v of ch) {
    values.push(v);
  }
  expect(values).toEqual([1, 2, 3, 4]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run electron/__tests__/sessions.test.ts -t "drops oldest" 2>&1 | tail -5`

Expected: FAIL — `createAsyncChannel` doesn't accept a parameter yet.

- [ ] **Step 3: Implement bounded channel**

In `electron/services/async-channel.ts`, change:

```typescript
export function createAsyncChannel<T>(maxSize?: number): AsyncChannel<T> {
  const queue: T[] = [];
  let resolve: ((result: IteratorResult<T>) => void) | null = null;
  let closed = false;

  return {
    push(value: T) {
      if (closed) return;
      if (resolve) {
        const r = resolve;
        resolve = null;
        r({ value, done: false });
      } else {
        if (maxSize != null && queue.length >= maxSize) {
          console.warn(`[async-channel] Queue full (${maxSize}), dropping oldest item`);
          queue.shift();
        }
        queue.push(value);
      }
    },

    close() {
      closed = true;
      if (resolve) {
        const r = resolve;
        resolve = null;
        r({ value: undefined as any, done: true });
      }
    },

    [Symbol.asyncIterator]() {
      return {
        next(): Promise<IteratorResult<T>> {
          if (queue.length > 0) {
            return Promise.resolve({ value: queue.shift()!, done: false });
          }
          if (closed) {
            return Promise.resolve({ value: undefined as any, done: true });
          }
          return new Promise<IteratorResult<T>>((r) => {
            resolve = r;
          });
        },
      };
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run electron/__tests__/sessions.test.ts -t "drops oldest" 2>&1 | tail -5`

Expected: PASS

- [ ] **Step 5: Use bounded channel in lifecycle.ts**

In `electron/services/sessions/lifecycle.ts`, change the `start()` function's channel creation from:

```typescript
const inputChannel = createAsyncChannel<SDKUserMessage>();
```

to:

```typescript
const inputChannel = createAsyncChannel<SDKUserMessage>(1000);
```

- [ ] **Step 6: Run all tests**

Run: `npm test`

Expected: All pass.

- [ ] **Step 7: Commit**

```bash
git add electron/services/async-channel.ts electron/services/sessions/lifecycle.ts electron/__tests__/sessions.test.ts
git commit -m "feat: add bounded queue to AsyncChannel

Add optional maxSize parameter to createAsyncChannel. When set,
push() drops the oldest item if the queue is full and logs a
warning. Sessions use maxSize=1000 as a safety valve."
```

---

## Task 8: Session health check — backend

**Files:**
- Modify: `electron/services/sessions/types.ts`
- Modify: `electron/services/sessions/lifecycle.ts`
- Modify: `electron/ipc/handlers.ts`
- Modify: `electron/preload.ts`
- Test: `electron/__tests__/sessions.test.ts`

- [ ] **Step 1: Write the failing test**

Add to the sessions service test block in `electron/__tests__/sessions.test.ts`:

```typescript
describe('getHealth', () => {
  it('returns alive=true for active session', async () => {
    const fq = installFakeQuery();
    const service = createSessionsService(sendToRenderer);
    service.start({ tabId: 'h1', projectPath: '/tmp', configDir: '/tmp/.claude', model: 'sonnet', permissionMode: 'acceptEdits' });
    await flush();

    const health = service.getHealth('h1');
    expect(health.alive).toBe(true);
    expect(health.status).toBe('starting');

    service.stop('h1');
  });

  it('returns alive=false for unknown tab', () => {
    const service = createSessionsService(sendToRenderer);
    const health = service.getHealth('nonexistent');
    expect(health).toEqual({ alive: false, status: 'stopped', sessionId: null });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run electron/__tests__/sessions.test.ts -t "getHealth" 2>&1 | tail -5`

Expected: FAIL — `getHealth` does not exist on `SessionsService`.

- [ ] **Step 3: Add getHealth to types.ts**

In `electron/services/sessions/types.ts`, add to the `SessionsService` interface after `isActive`:

```typescript
  getHealth(tabId: string): { alive: boolean; status: SessionStatus; sessionId: string | null };
```

- [ ] **Step 4: Implement getHealth in lifecycle.ts**

Add before the `return` statement:

```typescript
  function getHealth(tabId: string): { alive: boolean; status: SessionStatus; sessionId: string | null } {
    const handle = sessions.get(tabId);
    if (!handle) return { alive: false, status: 'stopped', sessionId: null };
    return { alive: true, status: handle.status, sessionId: handle.sessionId };
  }
```

Add `getHealth` to the return object.

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run electron/__tests__/sessions.test.ts -t "getHealth" 2>&1 | tail -5`

Expected: PASS

- [ ] **Step 6: Wire IPC handler**

In `electron/ipc/handlers.ts`, add after the `session_get_info` handler:

```typescript
    session_get_health: wrapWith((p: Record<string, unknown>) => sessions?.getHealth((p?.tabId ?? p?.session_id) as string) ?? { alive: false, status: 'stopped', sessionId: null }),
```

- [ ] **Step 7: Add to preload allow-list**

In `electron/preload.ts`, add `'session_get_health'` to the `ALLOWED_INVOKE_CHANNELS` set, after `'session_get_info'`.

- [ ] **Step 8: Run check and tests**

Run: `npm run check && npm test`

Expected: All pass.

- [ ] **Step 9: Commit**

```bash
git add electron/services/sessions/types.ts electron/services/sessions/lifecycle.ts electron/ipc/handlers.ts electron/preload.ts electron/__tests__/sessions.test.ts
git commit -m "feat: add session health check endpoint

Add getHealth() to SessionsService — synchronous check on the
handle map. Returns alive/status/sessionId. Wire through IPC as
session_get_health for renderer timeout improvements."
```

---

## Task 9: Session health check — renderer API

**Files:**
- Modify: `src/lib/api.ts`

- [ ] **Step 1: Add typed wrapper**

In `src/lib/api.ts`, add after the `sessionGetInfo` method:

```typescript
  async sessionGetHealth(tabId: string): Promise<{ alive: boolean; status: string; sessionId: string | null }> {
    return apiCall("session_get_health", { tabId });
  },
```

- [ ] **Step 2: Run check**

Run: `npm run check`

Expected: Pass.

- [ ] **Step 3: Commit**

```bash
git add src/lib/api.ts
git commit -m "feat: add sessionGetHealth to renderer API surface"
```

---

## Task 10: Smarter renderer timeouts

**Files:**
- Modify: `src/components/ClaudeCodeSession.tsx`

- [ ] **Step 1: Change RESPONSE_TIMEOUT_MS**

Change line 106:

```typescript
// Old:
const RESPONSE_TIMEOUT_MS = 60_000;
// New:
const RESPONSE_TIMEOUT_MS = 30_000;
```

- [ ] **Step 2: Update the response timeout handler to check health**

Replace the timeout callback in the `useEffect` (around lines 370-380). Change from:

```typescript
      const timeout = setTimeout(() => {
        // Find the last user message index
        const lastUserIdx = [...messages].reverse().findIndex(m => m.type === 'user' && !m.isMeta);
        if (lastUserIdx !== -1) {
          setTimedOutMessageIndex(messages.length - 1 - lastUserIdx);
        }
        setIsLoading(false);
        setError(null); // Don't show the generic error bar
        // Reset persistent session so a retry starts a fresh one
        persistentSessionRef.current = false;
      }, RESPONSE_TIMEOUT_MS);
```

To:

```typescript
      const timeout = setTimeout(async () => {
        // Check if the main process session is still alive before killing
        try {
          const health = await api.sessionGetHealth(tabIdRef.current);
          if (health.alive && health.status !== 'error') {
            // Session is alive — show warning but don't kill it
            setMessages((prev) => [...prev, {
              type: 'system' as const,
              subtype: 'notification',
              notification_type: 'warn',
              title: 'Slow Response',
              message: 'Session is still active but no response yet. Waiting...',
            } as any]);
            return;
          }
        } catch { /* health check failed — treat as dead */ }

        // Session is dead or errored — reset
        const lastUserIdx = [...messages].reverse().findIndex(m => m.type === 'user' && !m.isMeta);
        if (lastUserIdx !== -1) {
          setTimedOutMessageIndex(messages.length - 1 - lastUserIdx);
        }
        setIsLoading(false);
        setError(null);
        persistentSessionRef.current = false;
      }, RESPONSE_TIMEOUT_MS);
```

- [ ] **Step 3: Update the inactivity timeout handler to check health**

Replace the inactivity check callback (around lines 392-406). Change from:

```typescript
    const check = setInterval(() => {
      const idle = Date.now() - lastMessageTimeRef.current;
      if (idle >= INACTIVITY_TIMEOUT_MS && !waitingForPermission) {
        setIsLoading(false);
        persistentSessionRef.current = false;
        setMessages((prev) => [...prev, {
          type: 'system' as const,
          subtype: 'notification',
          notification_type: 'warn',
          title: 'Session Inactive',
          message: 'No response received. Send a message to restart the session.',
        } as any]);
      }
    }, 3000);
```

To:

```typescript
    const check = setInterval(async () => {
      const idle = Date.now() - lastMessageTimeRef.current;
      if (idle >= INACTIVITY_TIMEOUT_MS && !waitingForPermission) {
        // Check health before killing
        try {
          const health = await api.sessionGetHealth(tabIdRef.current);
          if (health.alive && health.status !== 'error') {
            // Session is alive — show warning but keep waiting
            setMessages((prev) => {
              // Don't spam warnings
              const lastMsg = prev[prev.length - 1];
              if (lastMsg?.title === 'Session May Be Unresponsive') return prev;
              return [...prev, {
                type: 'system' as const,
                subtype: 'notification',
                notification_type: 'warn',
                title: 'Session May Be Unresponsive',
                message: 'No messages received recently, but session is still alive.',
              } as any];
            });
            return;
          }
        } catch { /* health check failed — treat as dead */ }

        // Session is dead — reset
        setIsLoading(false);
        persistentSessionRef.current = false;
        setMessages((prev) => [...prev, {
          type: 'system' as const,
          subtype: 'notification',
          notification_type: 'warn',
          title: 'Session Lost',
          message: 'Session is no longer active. Send a message to restart.',
        } as any]);
      }
    }, 3000);
```

- [ ] **Step 4: Run check and build**

Run: `npm run check && npm run build`

Expected: Pass.

- [ ] **Step 5: Commit**

```bash
git add src/components/ClaudeCodeSession.tsx
git commit -m "fix: check session health before killing on timeout

Reduce RESPONSE_TIMEOUT from 60s to 30s. Both timeout handlers
now call sessionGetHealth() before resetting the session. If the
main process session is still alive, show a warning instead of
destroying the session."
```

---

## Task 11: Session resume on app restart

**Files:**
- Modify: `src/components/ClaudeCodeSession.tsx`

- [ ] **Step 1: Persist claudeSessionId to SessionPersistenceService**

In `ClaudeCodeSession.tsx`, find where `claudeSessionId` gets set from the SDK (the `handleStreamMessage` callback, around where `system:init` is processed). After `setClaudeSessionId(...)`, add a persistence call.

Find the block that processes `system:init` messages and sets `claudeSessionId`. After the `setClaudeSessionId` call, add:

```typescript
        // Persist session ID for resume on app restart
        if (projectPath && extractedSessionInfo?.projectId) {
          SessionPersistenceService.saveSession(
            sessionId,
            extractedSessionInfo.projectId,
            projectPath,
            messages.length
          );
        }
```

- [ ] **Step 2: Use sessionId for auto-resume on tab restore**

In `handleSendPrompt`, around line 910 where `resumeId` is built:

The existing code is:
```typescript
const resumeId = effectiveSession?.id || claudeSessionId || undefined;
```

This already works — if `effectiveSession` was restored from `SessionPersistenceService` via `TabContext`, its `.id` will be the sessionId, and `startPersistentSession(resumeId)` passes it as `resumeSessionId` to the SDK. The flow is:

1. Tab closes → `TabPersistenceService.saveTabs()` saves `sessionId` in the serialized tab
2. Tab restores → `TabContext.loadTabs()` calls `SessionPersistenceService.loadSession(sessionId)`
3. `SessionPersistenceService.createSessionFromRestoreData()` creates a `Session` with `.id = sessionId`
4. `ClaudeCodeSession` receives this as `session` prop → sets `effectiveSession`
5. On first prompt, `resumeId = effectiveSession.id` → `startPersistentSession(resumeId)` → SDK's `options.resume`

The key missing piece is that `TabPersistenceService.saveTabs()` already saves `sessionId` (line 75 of `tabPersistence.ts`), BUT `claudeSessionId` (from the SDK's `system:init`) might differ from `tab.sessionId` (which comes from the old session metadata). We need to make sure the tab's `sessionId` is updated when the SDK reports the real session ID.

In `ClaudeCodeSession.tsx`, in the `handleStreamMessage` callback, after setting `claudeSessionId`, update the tab:

Find where `setClaudeSessionId` is called with the session ID from `system:init`. After that line, add:

```typescript
        // Update the tab's sessionId so it persists for resume
        if (tabId) {
          try {
            const { updateTab } = useTabContext();
            // This is in a callback, so we need to use the API directly
          } catch { /* not critical */ }
        }
```

Actually, a simpler approach: the `onStreamingChange` callback already reports `claudeSessionId` to the parent. The parent (`TabContent.tsx`) should update the tab's `sessionId` when it changes. Let me check if this already happens.

The `onStreamingChange` prop signature is: `(isStreaming: boolean, sessionId: string | null) => void`. The parent should call `updateTab(tabId, { sessionId })` when this fires. If it doesn't already, add it in `TabContent.tsx`.

- [ ] **Step 3: Ensure TabContent updates tab sessionId**

In `src/components/TabContent.tsx`, find where `onStreamingChange` is handled for chat tabs. It should call `updateTab` to persist the sessionId on the tab. If it doesn't, add:

```typescript
onStreamingChange={(isStreaming, sessionId) => {
  if (sessionId) {
    updateTab(tab.id, { sessionId, status: isStreaming ? 'running' : 'idle' });
  } else {
    updateTab(tab.id, { status: isStreaming ? 'running' : 'idle' });
  }
}}
```

- [ ] **Step 4: Run check and build**

Run: `npm run check && npm run build`

Expected: Pass.

- [ ] **Step 5: Manual verification**

1. Start the app, open a chat tab, send a prompt, get a response
2. Check that the tab's `sessionId` is set (visible in localStorage under `greychrist_tabs_v2`)
3. Close and reopen the app
4. The chat tab should restore. Send a new prompt — it should resume the previous session context rather than starting fresh

- [ ] **Step 6: Commit**

```bash
git add src/components/ClaudeCodeSession.tsx src/components/TabContent.tsx
git commit -m "feat: resume sessions on app restart

Update tab sessionId from SDK system:init so TabPersistenceService
saves it. On restore, the sessionId flows through as resumeSessionId
to the SDK's resume mode, preserving conversation context."
```

---

## Task 12: Final verification

**Files:**
- No new files

- [ ] **Step 1: Run full verification gate**

Run: `npm run check && npm run build && npm run test:coverage`

Expected: All pass. Coverage should remain at or above 80% for backend.

- [ ] **Step 2: Verify the app runs**

Run: `npm start`

Verify:
- Can start a new session and send prompts
- Session streaming works normally
- Permission dialogs appear when tools need approval
- Closing and reopening the app resumes the previous session
- No console errors about missing modules or failed imports

- [ ] **Step 3: Commit any fixes, then tag completion**

If any fixes were needed, commit them individually. Then:

```bash
git log --oneline -10
```

Verify the commit history shows the logical progression:
1. refactor: decompose sessions.ts into module folder
2. feat: add bounded queue to AsyncChannel
3. feat: add session health check endpoint
4. feat: add sessionGetHealth to renderer API surface
5. fix: check session health before killing on timeout
6. feat: resume sessions on app restart
