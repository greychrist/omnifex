# Session Decomposition & Resilience Design

**Date**: 2026-04-14
**Approach**: Module folder decomposition (Approach C), then resilience layered on clean structure

---

## Problem

`electron/services/sessions.ts` is 1530 lines containing five distinct concerns in a single closure:

1. **Session lifecycle** — start, stop, handle map, streaming loop, restart on error
2. **SDK hooks** — 25+ audit/logging callbacks (lines 354-1038, ~700 lines)
3. **Permission handling** — canUseTool callback, permission queue, auto-allow (lines 1047-1318, ~270 lines)
4. **Query passthroughs** — 12 Wave 2 SDK method forwards (lines 1370-1498, ~130 lines)
5. **Types** — interfaces shared across all concerns (lines 32-135)

Additionally, the session layer has reliability gaps:

- **AsyncChannel is unbounded** — no backpressure if renderer stalls
- **Renderer timeouts are too aggressive** — they destroy the session (`persistentSessionRef = false`) without checking if the main process session is actually dead
- **No health check** — renderer can't verify if a session handle is alive
- **No session resume on app restart** — tab persistence saves UI state but not `sessionId`, so sessions can't resume via the SDK's `resume` mode

---

## Phase 1: Module Decomposition

### New Structure

```
electron/services/sessions/
  index.ts          — re-exports createSessionsService + public types
  types.ts          — all shared types
  lifecycle.ts      — createSessionsService factory, handle map, streaming
  hooks.ts          — SDK hooks factory
  permissions.ts    — canUseTool, permission queue, auto-allow
  queries.ts        — Wave 2 query passthroughs
```

The old `electron/services/sessions.ts` file is deleted. Import paths resolve via `sessions/index.ts`.

### `types.ts` (~50 lines)

All types that are shared across two or more modules:

```typescript
export type SessionStatus = 'starting' | 'running' | 'waiting_permission' | 'stopped' | 'error';
export type SendToRenderer = (channel: string, ...args: unknown[]) => void;

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

// Full public interface — unchanged from current sessions.ts
export interface SessionsService {
  start(params: SessionStartParams): void;
  sendMessage(tabId: string, prompt: string): void;
  sendStructuredMessage(tabId: string, content: Array<Record<string, unknown>>): void;
  respondPermission(tabId: string, behavior: 'allow' | 'deny', updatedInput?: Record<string, unknown>, updatedPermissions?: PermissionDecision['updatedPermissions']): void;
  setAutoAllow(tabId: string, enabled: boolean): void;
  addAutoAllowTool(tabId: string, toolName: string): void;
  stop(tabId: string): void;
  stopAll(): void;
  getSessionId(tabId: string): string | null;
  getStatus(tabId: string): SessionStatus;
  getInfo(tabId: string): { sessionId: string | null; status: SessionStatus } | null;
  isActive(tabId: string): boolean;
  // getHealth() added in Phase 2 — not part of the initial decomposition

  // Wave 2 query passthroughs
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
```

### `hooks.ts` (~750 lines)

Single factory function. Pure lift from `sessions.ts` lines 343-1039.

```typescript
import type { LoggingService } from '../logging';
import type { SendToRenderer, NotificationHooks } from './types';

export function createSessionHooks(
  tabId: string,
  logging: LoggingService | null,
  sendToRenderer: SendToRenderer,
  notificationHooks: NotificationHooks,
): Record<string, any>
```

- Moves `stringifyCapped()` and `METADATA_CAP` into this file as module-level helpers
- Returns the hooks object (`{ PreToolUse, PostToolUse, ..., InstructionsLoaded }`)
- No behavioral changes — identical callbacks

### `permissions.ts` (~300 lines)

Extracted from `sessions.ts` lines 1047-1318.

```typescript
import type { SessionHandle, PermissionDecision, SendToRenderer, NotificationHooks } from './types';

// Returns the canUseTool callback for SDK options
export function createCanUseTool(
  handle: SessionHandle,
  tabId: string,
  sendToRenderer: SendToRenderer,
  notificationHooks: NotificationHooks,
): (toolName: string, toolInput: Record<string, unknown>, toolOptions: any) => Promise<any>

// Operates on the handle's permission queue
export function respondPermission(
  handle: SessionHandle,
  tabId: string,
  sendToRenderer: SendToRenderer,
  notificationHooks: NotificationHooks,
  behavior: 'allow' | 'deny',
  updatedInput?: Record<string, unknown>,
  updatedPermissions?: PermissionDecision['updatedPermissions'],
): void

export function setAutoAllow(handle: SessionHandle, enabled: boolean): void
export function addAutoAllowTool(handle: SessionHandle, toolName: string): void
```

- `findSystemClaudeBinary()` stays in `lifecycle.ts` (used during `start()`)
- Debug logging to `/tmp/gc-perm-debug.log` and permission-verify-after-save move here unchanged

### `queries.ts` (~150 lines)

Extracted from `sessions.ts` lines 1370-1498.

```typescript
import type { SessionHandle, SessionsService } from './types';

type QueryMethods = Pick<SessionsService,
  'interrupt' | 'setModel' | 'setPermissionMode' | 'setEffort' | 'setThinking' |
  'getAccountInfo' | 'getContextUsage' | 'getSupportedCommands' |
  'getSupportedModels' | 'getSupportedAgents' | 'getMcpServerStatus'
>;

export function createQueryPassthroughs(
  sessions: Map<string, SessionHandle>,
): QueryMethods
```

- Each method: look up handle, call SDK method, catch and log, return null/[]
- No behavioral changes

### `lifecycle.ts` (~350 lines)

The orchestrator. Contains what remains after the other three blocks are extracted.

```typescript
import { createSessionHooks } from './hooks';
import { createCanUseTool, respondPermission, setAutoAllow, addAutoAllowTool } from './permissions';
import { createQueryPassthroughs } from './queries';
import type { SessionsService, SessionStartParams, SessionHandle, SendToRenderer, NotificationHooks } from './types';

export function createSessionsService(
  sendToRenderer: SendToRenderer,
  notificationHooks: NotificationHooks,
  logging: LoggingService | null,
): SessionsService
```

Contains:
- `sessions` Map (handle registry)
- `findSystemClaudeBinary()`
- `listenToMessages(tabId, handle)` — the async streaming loop
- `restartQuery(tabId, handle)` — resume after stream error
- `start(params)` — builds SDK options, calls `createSessionHooks()` and `createCanUseTool()`, creates Query
- `sendMessage(tabId, prompt)` / `sendStructuredMessage()`
- `stop(tabId)` / `stopAll()`
- `getSessionId()` / `getStatus()` / `getInfo()` / `isActive()` / `getHealth()`
- Return object: spreads `createQueryPassthroughs(sessions)` + delegates permission methods

### `index.ts` (~10 lines)

```typescript
export { createSessionsService } from './lifecycle';
export type { SessionsService, SessionStartParams, SessionStatus } from './types';
```

### Import Migration

Files that import from `sessions`:
- `electron/main.ts` — `import { createSessionsService } from './services/sessions'` (resolves to `sessions/index.ts` automatically)
- `electron/ipc/handlers.ts` — imports `SessionsService` type
- `electron/__tests__/sessions.test.ts` — imports `createSessionsService`

Node/TypeScript resolves `./sessions` to `./sessions/index.ts` when the directory exists, so **no import path changes are needed** as long as the old `sessions.ts` file is deleted.

---

## Phase 2: Resilience Improvements

Built on the clean module structure from Phase 1.

### 2a. Bounded AsyncChannel

**File**: `electron/services/async-channel.ts`

Add optional `maxSize` parameter to `createAsyncChannel`:

```typescript
export function createAsyncChannel<T>(maxSize?: number): AsyncChannel<T>
```

Behavior when `maxSize` is set:
- If queue reaches `maxSize`, `push()` drops the oldest item and logs a console warning
- Default (no `maxSize`): unchanged behavior, no breaking changes

Usage in `lifecycle.ts`:
```typescript
const inputChannel = createAsyncChannel<SDKUserMessage>(1000);
```

### 2b. Session Health Check

**File**: `electron/services/sessions/lifecycle.ts`

New method on `SessionsService`:

```typescript
getHealth(tabId: string): { alive: boolean; status: SessionStatus; sessionId: string | null }
```

Synchronous check on the handle map. Returns `{ alive: false, status: 'stopped', sessionId: null }` if no handle exists. No SDK call, no async overhead.

**IPC wiring**:
- Handler: `session_get_health` in `electron/ipc/handlers.ts`
- Preload: add `session_get_health` to the allow-list in `electron/preload.ts`
- API: `sessionGetHealth(tabId)` in `src/lib/api.ts`

### 2c. Smarter Renderer Timeouts

**File**: `src/components/ClaudeCodeSession.tsx`

Current behavior:
- `RESPONSE_TIMEOUT_MS = 60_000` — fires if no messages arrive within 60s of sending a prompt
- `INACTIVITY_TIMEOUT_MS = 15_000` — fires if messages stop flowing for 15s during active response
- Both set `persistentSessionRef.current = false` → forces cold restart on next prompt

New behavior:
- `RESPONSE_TIMEOUT_MS = 30_000` — 30s is plenty; the SDK streams feedback immediately
- `INACTIVITY_TIMEOUT_MS = 15_000` — unchanged; 15s of silence during streaming is a real signal
- When either fires, **check health before killing**:
  1. Call `api.sessionGetHealth(tabId)`
  2. If `alive && status !== 'error'` → show "Session may be unresponsive" warning but **don't reset** `persistentSessionRef`
  3. If `!alive || status === 'error'` → reset `persistentSessionRef`, show "Session lost — send a message to restart"
  
This preserves fast detection while eliminating false kills.

### 2d. Session Resume on App Restart

**File**: `src/contexts/TabContext.tsx` (persistence) + `src/components/ClaudeCodeSession.tsx` (restore)

When persisting tab state to localStorage, include:
```typescript
{
  ...existingTabFields,
  lastSessionId: string | null,    // from claudeSessionId state
  lastConfigDir: string | null,    // from accountResolution
}
```

On tab restore, `ClaudeCodeSession` detects `lastSessionId` and calls:
```typescript
startPersistentSession(lastSessionId)  // passes as resumeSessionId
```

This flows through `SessionStartParams.resumeSessionId` → `options.resume` in the SDK, which replays context from the session JSONL file on disk. No custom checkpoint logic needed — the SDK's built-in resume handles it.

If the resume fails (session file deleted, SDK rejects), fall back to a fresh session silently.

---

## Testing Strategy

### Phase 1 Tests

Each extraction is verified by running the existing test suite (`electron/__tests__/sessions.test.ts`, 89KB) after each step. No new tests needed for Phase 1 — it's a pure refactor with an identical public interface.

Verification after each extraction:
```bash
npm run check && npm test
```

### Phase 2 Tests

New tests in `electron/__tests__/sessions.test.ts`:

- **Bounded AsyncChannel**: push beyond maxSize, verify oldest dropped, verify warning logged
- **getHealth()**: returns correct status for active/errored/missing sessions
- **Resume**: start with `resumeSessionId`, verify `options.resume` is set on the SDK query

Renderer timeout changes are behavioral — verify by running the app and testing:
- Send prompt, kill subprocess manually → should show "Session lost" within 30s
- Send prompt during normal operation → no false timeout

---

## Execution Order

1. Create `electron/services/sessions/` directory
2. Write `types.ts` — extract all interfaces and type aliases
3. Write `hooks.ts` — lift the hooks block verbatim
4. Write `permissions.ts` — lift canUseTool, respondPermission, auto-allow
5. Write `queries.ts` — lift the 12 Wave 2 passthroughs
6. Write `lifecycle.ts` — remaining logic, imports the other modules
7. Write `index.ts` — re-exports
8. Delete `electron/services/sessions.ts`
9. Run `npm run check && npm test` — verify no regressions
10. Implement bounded AsyncChannel
11. Add `getHealth()` to lifecycle.ts + IPC wiring
12. Update renderer timeouts to use health check
13. Add session resume persistence to TabContext + ClaudeCodeSession
14. Run full verification: `npm run check && npm run build && npm run test:coverage`

---

## Out of Scope

- Subprocess reaper (separate follow-up)
- MCP account scoping (separate issue)
- Component monolith decomposition (renderer refactor, separate effort)
- Agent timeout support (separate feature)
