# Claude Agent SDK Integration — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the broken Rust CLI spawn (`session_manager.rs`) with the `@anthropic-ai/claude-agent-sdk` TypeScript library running directly in the frontend, giving us proper permission handling, typed messages, and session coherence.

**Architecture:** The SDK runs in the React frontend. A new `sessionManager.ts` singleton wraps `query()` from the SDK, managing one `SessionHandle` per tab. Each handle owns a `Query` async generator and an input channel for multi-turn conversations. Permission requests come through SDK hooks and are rendered by the existing `PermissionPrompt` component. The Rust backend retains account resolution, logging, storage, and usage — it just stops managing Claude processes.

**Tech Stack:** `@anthropic-ai/claude-agent-sdk` (TypeScript), Tauri 2, React

**Spec:** `docs/superpowers/specs/2026-04-09-sdk-integration-design.md`

---

## Task 1: Install SDK and Create Async Input Channel Utility

**Files:**
- Modify: `package.json`
- Create: `src/lib/asyncChannel.ts`

- [ ] **Step 1: Install the SDK**

```bash
npm install @anthropic-ai/claude-agent-sdk@0.2.97
```

- [ ] **Step 2: Verify installation**

```bash
npx tsc --noEmit
```

Expected: PASS (SDK types available)

- [ ] **Step 3: Create the async channel utility**

Create `src/lib/asyncChannel.ts` — a simple push/pull async iterable used to feed messages to the SDK's `query()`:

```typescript
export interface AsyncChannel<T> {
  push(value: T): void;
  close(): void;
  [Symbol.asyncIterator](): AsyncIterator<T>;
}

export function createAsyncChannel<T>(): AsyncChannel<T> {
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

- [ ] **Step 4: Verify TypeScript compiles**

```bash
npx tsc --noEmit
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json src/lib/asyncChannel.ts
git commit -m "feat: install claude agent SDK and add async channel utility"
```

---

## Task 2: Create Session Manager

**Files:**
- Create: `src/lib/sessionManager.ts`

- [ ] **Step 1: Create `src/lib/sessionManager.ts`**

```typescript
import { query, type SDKMessage, type SDKUserMessage, type Query } from '@anthropic-ai/claude-agent-sdk';
import type { PermissionMode, HookEvent, HookCallbackMatcher } from '@anthropic-ai/claude-agent-sdk';
import { createAsyncChannel, type AsyncChannel } from './asyncChannel';

export type SessionStatus = 'starting' | 'running' | 'waiting_permission' | 'stopped' | 'error';

export interface PermissionRequest {
  toolName: string;
  toolInput: Record<string, unknown>;
}

export interface SessionCallbacks {
  onMessage: (message: SDKMessage) => void;
  onPermissionRequest: (request: PermissionRequest) => void;
  onStatusChange: (status: SessionStatus) => void;
  onError: (error: string) => void;
}

interface SessionHandle {
  query: Query;
  inputChannel: AsyncChannel<SDKUserMessage>;
  sessionId: string | null;
  status: SessionStatus;
  callbacks: SessionCallbacks;
  permissionResolver: ((decision: { behavior: 'allow' | 'deny'; updatedInput?: Record<string, unknown> }) => void) | null;
  autoAllowEnabled: boolean;
  autoAllowedTools: Set<string>;
}

class SessionManager {
  private static instance: SessionManager;
  private sessions = new Map<string, SessionHandle>();

  static getInstance(): SessionManager {
    if (!SessionManager.instance) {
      SessionManager.instance = new SessionManager();
    }
    return SessionManager.instance;
  }

  start(
    tabId: string,
    projectPath: string,
    configDir: string,
    model: string,
    permissionMode: string,
    callbacks: SessionCallbacks,
    claudeBinaryPath?: string,
    resumeSessionId?: string,
  ): void {
    // Stop existing session for this tab if any
    this.stop(tabId);

    const inputChannel = createAsyncChannel<SDKUserMessage>();
    const autoAllowedTools = new Set<string>();

    const handle: SessionHandle = {
      query: null as any, // set below
      inputChannel,
      sessionId: null,
      status: 'starting',
      callbacks,
      permissionResolver: null,
      autoAllowEnabled: false,
      autoAllowedTools,
    };

    this.sessions.set(tabId, handle);

    const permissionHook = async (input: any): Promise<any> => {
      const toolName = input.tool_name || 'Unknown';
      const toolInput = input.tool_input || {};

      // Auto-allow if enabled and tool is in the set
      if (handle.autoAllowEnabled && handle.autoAllowedTools.has(toolName)) {
        return {
          hookSpecificOutput: {
            hookEventName: 'PermissionRequest',
            decision: { behavior: 'allow' },
          },
        };
      }

      handle.status = 'waiting_permission';
      callbacks.onStatusChange('waiting_permission');
      callbacks.onPermissionRequest({ toolName, toolInput: toolInput as Record<string, unknown> });

      return new Promise((resolve) => {
        handle.permissionResolver = (decision) => {
          handle.permissionResolver = null;
          handle.status = 'running';
          callbacks.onStatusChange('running');
          resolve({
            hookSpecificOutput: {
              hookEventName: 'PermissionRequest',
              decision,
            },
          });
        };
      });
    };

    const hooks: Partial<Record<HookEvent, HookCallbackMatcher[]>> = {
      PermissionRequest: [{ hooks: [permissionHook] }],
    };

    const options: any = {
      cwd: projectPath,
      model,
      permissionMode: permissionMode as PermissionMode,
      env: { CLAUDE_CONFIG_DIR: configDir },
      hooks,
      settingSources: ['user', 'project'],
    };

    if (claudeBinaryPath) {
      options.pathToClaudeCodeExecutable = claudeBinaryPath;
    }

    if (resumeSessionId) {
      options.resume = resumeSessionId;
    }

    const q = query({
      prompt: inputChannel,
      options,
    });

    handle.query = q;

    // Start the listener loop
    this.listenToMessages(tabId, handle);
  }

  private async listenToMessages(tabId: string, handle: SessionHandle): Promise<void> {
    try {
      handle.status = 'running';
      handle.callbacks.onStatusChange('running');

      for await (const message of handle.query) {
        // Extract session ID from init message
        if (message.type === 'system' && 'subtype' in message && message.subtype === 'init') {
          handle.sessionId = (message as any).session_id || null;
        }

        handle.callbacks.onMessage(message);
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      handle.callbacks.onError(errorMsg);
    } finally {
      handle.status = 'stopped';
      handle.callbacks.onStatusChange('stopped');
      this.sessions.delete(tabId);
    }
  }

  sendMessage(tabId: string, prompt: string): void {
    const handle = this.sessions.get(tabId);
    if (!handle) return;

    const userMessage: SDKUserMessage = {
      type: 'user',
      message: { role: 'user', content: prompt },
      parent_tool_use_id: null,
    };

    handle.inputChannel.push(userMessage);
  }

  respondPermission(tabId: string, behavior: 'allow' | 'deny', updatedInput?: Record<string, unknown>): void {
    const handle = this.sessions.get(tabId);
    if (!handle?.permissionResolver) return;
    handle.permissionResolver({ behavior, updatedInput });
  }

  setAutoAllow(tabId: string, enabled: boolean): void {
    const handle = this.sessions.get(tabId);
    if (!handle) return;
    handle.autoAllowEnabled = enabled;
    if (!enabled) {
      handle.autoAllowedTools.clear();
    }
  }

  addAutoAllowTool(tabId: string, toolName: string): void {
    const handle = this.sessions.get(tabId);
    if (!handle) return;
    handle.autoAllowedTools.add(toolName);
  }

  stop(tabId: string): void {
    const handle = this.sessions.get(tabId);
    if (!handle) return;
    handle.inputChannel.close();
    try {
      handle.query.close();
    } catch {
      // Already closed
    }
    this.sessions.delete(tabId);
  }

  getSessionId(tabId: string): string | null {
    return this.sessions.get(tabId)?.sessionId ?? null;
  }

  getStatus(tabId: string): SessionStatus {
    return this.sessions.get(tabId)?.status ?? 'stopped';
  }

  isActive(tabId: string): boolean {
    return this.sessions.has(tabId);
  }

  stopAll(): void {
    for (const tabId of this.sessions.keys()) {
      this.stop(tabId);
    }
  }
}

export const sessionManager = SessionManager.getInstance();
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
npx tsc --noEmit
```

Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/lib/sessionManager.ts
git commit -m "feat: add session manager wrapping Claude Agent SDK"
```

---

## Task 3: Update ClaudeCodeSession to Use Session Manager

**Files:**
- Modify: `src/components/ClaudeCodeSession.tsx`

This is the largest task. The component needs to:
1. Replace Tauri event listeners with session manager callbacks
2. Replace `api.startSession()` / `api.sendMessage()` with session manager calls
3. Adapt message handling from raw JSONL to SDK `SDKMessage` types
4. Route permission requests through the session manager

- [ ] **Step 1: Replace imports**

At the top of ClaudeCodeSession.tsx, remove:
```typescript
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
```

Add:
```typescript
import { sessionManager, type SessionStatus, type PermissionRequest as PermReq } from '@/lib/sessionManager';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
```

Keep the `api` import — it's still used for `resolveAccountForProject`, `explainAccountResolution`, `getProjectSessions`, etc.

- [ ] **Step 2: Remove Tauri event listener refs and unused state**

Remove:
```typescript
const unlistenRefs = useRef<UnlistenFn[]>([]);
const persistentSessionRef = useRef(false);
```

Remove `pendingRequestId` state (the session manager handles request IDs internally).

- [ ] **Step 3: Create SDK message handler**

Replace the existing `handleStreamMessage` callback with one that handles typed `SDKMessage` objects. The key mapping:

- `SDKAssistantMessage` (`type: 'assistant'`) → has `message.content[]` with `text`, `tool_use`, `thinking` blocks — same structure the renderer already expects
- `SDKUserMessage` / `SDKUserMessageReplay` (`type: 'user'`) → user messages
- `SDKResultMessage` (`type: 'result'`) → session complete
- `SDKSystemMessage` (`type: 'system'`, `subtype: 'init'`) → extract session_id, tools, model
- `SDKPartialAssistantMessage` → partial streaming updates

The existing `displayableMessages` filter and message renderer work on `{ type, message, ... }` objects. SDK messages have the same shape. Create a thin adapter:

```typescript
const handleSDKMessage = useCallback((sdkMessage: SDKMessage) => {
  // Map SDK messages to the shape the renderer expects
  const message = sdkMessage as any; // SDK messages are a superset of what we need

  if (message.type === 'system' && message.subtype === 'init') {
    setClaudeSessionId(message.session_id);
    setTools(message.tools || []);
  }

  if (message.type === 'result') {
    setIsLoading(false);
    // Process queued prompts if any
    processNextQueuedPrompt();
  }

  // Track cost from usage
  if (message.type === 'assistant' && message.message?.usage) {
    const usage = message.message.usage;
    if (usage) {
      const inputCost = (usage.input_tokens || 0) * 0.000003;
      const outputCost = (usage.output_tokens || 0) * 0.000015;
      setSessionCost(prev => prev + inputCost + outputCost);
    }
  }

  // Add to messages array for rendering
  setMessages(prev => [...prev, message]);
}, []);
```

- [ ] **Step 4: Replace `startPersistentSession` function**

Replace the entire `startPersistentSession` function (which sets up Tauri event listeners and calls `api.startSession()`) with:

```typescript
const startSession = async (resumeId?: string) => {
  const tid = tabIdRef.current;

  // Resolve account for this project
  let configDir = '';
  let binaryPath: string | undefined;
  try {
    const account = await api.resolveAccountForProject(projectPath);
    if (account) {
      configDir = account.config_dir;
      binaryPath = account.claude_binary || undefined;
    }
  } catch {
    // Fall back — the SDK will use default discovery
  }

  if (!configDir) {
    // Try to get default account dir
    try {
      const defaultDir = await api.getDefaultAccountDir();
      configDir = defaultDir;
    } catch (err) {
      setError('No account configured. Set up accounts in Settings > Accounts.');
      return;
    }
  }

  const mode = permissionMode === "skip" ? "bypassPermissions" : "default";

  sessionManager.start(
    tid,
    projectPath,
    configDir,
    selectedModel,
    mode,
    {
      onMessage: handleSDKMessage,
      onPermissionRequest: (req) => {
        setPendingToolUse({ name: req.toolName, input: req.toolInput as Record<string, any> });
        setWaitingForPermission(true);
      },
      onStatusChange: (status) => {
        if (status === 'running') setIsLoading(true);
        if (status === 'stopped') setIsLoading(false);
      },
      onError: (error) => {
        console.error('Session error:', error);
        setError(error);
        setIsLoading(false);
      },
    },
    binaryPath,
    resumeId,
  );

  setIsLoading(true);
};
```

- [ ] **Step 5: Replace `handleSendPrompt`**

Change the core of `handleSendPrompt` to use the session manager. Replace the section that calls `api.sendMessage(tid, prompt)` with:

```typescript
sessionManager.sendMessage(tabIdRef.current, prompt);
```

Keep the queued prompts logic, the user message optimistic rendering, and the isLoading state management.

- [ ] **Step 6: Update permission response flow**

Remove `pendingRequestId` from state. Update the `PermissionPrompt` render to call:

```typescript
<PermissionPrompt
  tabId={tabIdRef.current}
  toolName={pendingToolUse.name}
  toolInput={pendingToolUse.input}
  autoAllowEnabled={autoAllowEnabled}
  autoAllowedTools={autoAllowedTools}
  onAutoAllow={(tool) => {
    setAutoAllowedTools(prev => new Set([...prev, tool]));
    sessionManager.addAutoAllowTool(tabIdRef.current, tool);
  }}
  onResponded={() => {
    setWaitingForPermission(false);
    setPendingToolUse(null);
  }}
/>
```

Update the render condition — remove `pendingRequestId` from the guard:
```typescript
{waitingForPermission && pendingToolUse && (
```

- [ ] **Step 7: Update auto-allow toggle**

In the session bar's auto-allow toggle, sync with session manager:

```typescript
onClick={() => {
  setAutoAllowEnabled(prev => {
    const next = !prev;
    if (!next) setAutoAllowedTools(new Set());
    sessionManager.setAutoAllow(tabIdRef.current, next);
    return next;
  });
}}
```

- [ ] **Step 8: Update cleanup on unmount**

Replace the Tauri unlisten cleanup with:

```typescript
useEffect(() => {
  return () => {
    sessionManager.stop(tabIdRef.current);
  };
}, []);
```

- [ ] **Step 9: Remove old permission detection from handleStreamMessage**

Delete the entire block that checks `message.type === 'permission_request'` — the SDK's hook handles this now.

- [ ] **Step 10: Verify TypeScript compiles**

```bash
npx tsc --noEmit
```

Expected: May have type errors from the `ClaudeStreamMessage` → `SDKMessage` transition. Fix by updating the `messages` state type and the `displayableMessages` filter to work with the broader `SDKMessage` type. Use `as any` for the renderer if needed — the message shapes are compatible.

- [ ] **Step 11: Commit**

```bash
git add src/components/ClaudeCodeSession.tsx
git commit -m "feat: replace Tauri session events with Claude Agent SDK"
```

---

## Task 4: Update PermissionPrompt to Use Session Manager

**Files:**
- Modify: `src/components/PermissionPrompt.tsx`

- [ ] **Step 1: Replace API call with session manager call**

Change the imports — remove `api` import, add session manager:

```typescript
import { sessionManager } from '@/lib/sessionManager';
```

Replace the `respond` function:

```typescript
const respond = async (behavior: 'allow' | 'deny') => {
  setResponding(true);
  try {
    sessionManager.respondPermission(tabId, behavior);
    onResponded();
  } catch (err) {
    console.error("Failed to send permission response:", err);
  } finally {
    setResponding(false);
  }
};
```

Remove `requestId` from props since the session manager tracks it internally:

```typescript
interface PermissionPromptProps {
  tabId: string;
  toolName: string;
  toolInput: Record<string, any>;
  autoAllowEnabled: boolean;
  autoAllowedTools: Set<string>;
  onAutoAllow: (toolName: string) => void;
  onResponded: () => void;
}
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
npx tsc --noEmit
```

Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/components/PermissionPrompt.tsx
git commit -m "feat: update PermissionPrompt to use session manager"
```

---

## Task 5: Remove Rust Session Manager

**Files:**
- Delete: `src-tauri/src/session_manager.rs`
- Modify: `src-tauri/src/main.rs`
- Modify: `src-tauri/src/lib.rs`

- [ ] **Step 1: Delete session_manager.rs**

```bash
rm src-tauri/src/session_manager.rs
```

- [ ] **Step 2: Remove module declaration from `lib.rs`**

Remove the line:
```rust
pub mod session_manager;
```

- [ ] **Step 3: Remove from `main.rs`**

Remove:
- `mod session_manager;`
- `use session_manager::SessionProcessManagerState;` (if present)
- The `SessionProcessManagerState` managed state setup (around `app.manage(SessionProcessManagerState::new())`)
- All `session_manager::*` entries from `tauri::generate_handler![]`:
  - `session_manager::session_start`
  - `session_manager::session_send_message`
  - `session_manager::session_respond_permission`
  - `session_manager::session_stop`
  - `session_manager::session_get_info`

Also check for and remove `SessionStdinState` managed state and the `send_session_input` command from `commands::claude` if still present in the handler list.

- [ ] **Step 4: Verify Rust compiles**

```bash
cd src-tauri && ~/.cargo/bin/cargo check
```

Expected: PASS (with warnings about unused code that was only used by session_manager)

- [ ] **Step 5: Commit**

```bash
git add -A src-tauri/
git commit -m "chore: remove Rust session manager (replaced by Agent SDK)"
```

---

## Task 6: Remove Dead Frontend API Methods

**Files:**
- Modify: `src/lib/api.ts`

- [ ] **Step 1: Remove session API methods**

Remove these methods from the `api` object:

```typescript
async startSession(tabId, projectPath, model, permissionMode, resumeSessionId?)
async sendMessage(tabId, prompt)
async respondPermission(tabId, requestId, behavior, updatedInput?)
async stopSession(tabId)
async getSessionInfo(tabId)
async sendSessionInput(sessionId, input)
```

Also remove the `// ─── Persistent Session API ───` section comment.

Keep `cancelClaudeExecution` if it's used elsewhere (check first).

- [ ] **Step 2: Add `getDefaultAccountDir` if not present**

The `startSession` function in ClaudeCodeSession now needs to get the default account dir as a fallback. Check if `api.getDefaultAccountDir()` exists. If not, add it:

```typescript
async getDefaultAccountDir(): Promise<string> {
  return apiCall("get_default_account_dir");
},
```

And verify the corresponding Rust command exists (it's `get_default_account_dir` in `commands/claude.rs`). If it's not registered as a Tauri command, register it.

- [ ] **Step 3: Verify TypeScript compiles**

```bash
npx tsc --noEmit
```

Expected: May have errors from other components that import removed methods. Fix any remaining references.

- [ ] **Step 4: Commit**

```bash
git add src/lib/api.ts
git commit -m "chore: remove dead session API methods (replaced by Agent SDK)"
```

---

## Task 7: Clean Up Types

**Files:**
- Modify: `src/components/AgentExecution.tsx`
- Modify: `src/components/SessionOutputViewer.tsx`
- Modify: `src/lib/outputCache.tsx`

- [ ] **Step 1: Update ClaudeStreamMessage type**

The `ClaudeStreamMessage` type is defined in three files. It's still used by `AgentExecution.tsx` and `SessionOutputViewer.tsx` for non-SDK message display (agent runs, session output viewing). Keep the type but add `[key: string]: any` to make it flexible enough for SDK messages too, or keep it as-is since those components don't use the SDK directly.

Check each file to see if it still compiles. If `ClaudeCodeSession.tsx` no longer imports `ClaudeStreamMessage`, no changes needed in the type definition files.

- [ ] **Step 2: Remove `listen` import from ClaudeCodeSession if still present**

Verify `@tauri-apps/api/event` is no longer imported in `ClaudeCodeSession.tsx`. If it is, remove it.

- [ ] **Step 3: Verify full build**

```bash
npx tsc --noEmit
npm run build
```

Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add -A src/
git commit -m "chore: clean up types after SDK migration"
```

---

## Task 8: Full Verification

- [ ] **Step 1: TypeScript check**

```bash
npx tsc --noEmit
```

Expected: PASS

- [ ] **Step 2: Frontend build**

```bash
npm run build
```

Expected: PASS

- [ ] **Step 3: Rust check**

```bash
cd src-tauri && ~/.cargo/bin/cargo check
```

Expected: PASS

- [ ] **Step 4: Rust tests**

```bash
cd src-tauri && ~/.cargo/bin/cargo test
```

Expected: All tests PASS (session_manager had no tests, so no test loss)

- [ ] **Step 5: Verify no dead session references**

```bash
rg "session_manager\|startSession\|sendMessage.*tabId\|respondPermission\|session_start\|session_send_message\|session_respond_permission\|claude-output:" --type ts --type rust -g '!node_modules' -g '!target' -g '!docs/' -g '!*.md' -l
```

Review results — should only show `sessionManager.ts` and `api.ts` (for non-session uses of similar method names).

- [ ] **Step 6: Cargo fmt**

```bash
cd src-tauri && ~/.cargo/bin/cargo fmt
```

- [ ] **Step 7: Commit formatting if needed**

```bash
cd src-tauri && git add -A && git diff --cached --quiet || git commit -m "style: cargo fmt"
```
