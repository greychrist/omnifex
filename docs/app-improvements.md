# GreyChrist Architectural Assessment & Improvement Plan

**Date**: 2026-04-14
**SDK Version**: @anthropic-ai/claude-agent-sdk v0.2.108
**Electron Version**: 41.2.0

---

## Executive Summary

GreyChrist is a well-structured Electron app with **15 main-process services**, **~85 IPC channels**, **70 renderer components**, and solid integration with the Claude Agent SDK. The service layer follows consistent factory patterns with dependency injection. Session streaming is robust with auto-recovery. Multi-account routing is the strongest differentiator versus terminal Claude Code.

The codebase shows stress in three areas: **component monoliths** (4 files over 1200 lines), **state management fragmentation** (3 competing patterns with unclear ownership), and **MCP being the only major feature area that's still stubbed**.

---

## 1. Main Process: Service Architecture

### Strengths

- **Consistent factory pattern**: Every service exports `createXxxService(deps) -> XxxService` with clean DI. Services are testable with `:memory:` databases.
- **Explicit initialization order** in `main.ts`: LoggingService before SessionsService, all handlers registered before window creation.
- **Two-phase IPC**: `getHandlerMap()` (testable) is separate from `registerIpcHandlers()` (Electron-only). This enabled the 39KB IPC handler test file.
- **Session error recovery**: Stream crashes set status to `'error'` but keep the handle in the map. Next `sendMessage()` calls `restartQuery()` with `options.resume = sessionId`, preserving conversation context.
- **25+ SDK hooks**: Every tool use, permission decision, context compaction, and subagent lifecycle event is logged to the structured `app_logs` table.

### Service Inventory

| Service | File | Lines | Dependencies | Status |
|---------|------|-------|--------------|--------|
| Database | `electron/services/database.ts` | ~130 | — | Solid |
| Accounts | `electron/services/accounts.ts` | ~396 | db | Solid |
| ClaudeBinary | `electron/services/claude-binary.ts` | ~211 | db | Solid |
| Logging | `electron/services/logging.ts` | ~224 | db | Solid |
| Sessions | `electron/services/sessions.ts` | ~1500 | sendToRenderer, hooks, logging | Needs decomposition |
| Claude | `electron/services/claude.ts` | ~765 | db, accounts | Solid |
| AgentRunRegistry | `electron/services/agent-run-registry.ts` | ~79 | — | Solid |
| Agents | `electron/services/agents.ts` | ~557 | db, accounts, claudeBinary, registry, sendToRenderer | Solid |
| Checkpoints | `electron/services/checkpoints.ts` | ~400 | db, accounts | Solid |
| Usage | `electron/services/usage.ts` | ~407 | accounts | Needs caching |
| Proxy | `electron/services/proxy.ts` | ~76 | db | Solid |
| MCP | `electron/services/mcp.ts` | ~185 | configDir (string) | Partial — stubs |
| SlashCommands | `electron/services/slash-commands.ts` | ~247 | configDir (string) | Solid |
| Updater | `electron/services/updater.ts` | ~159 | appVersion, deps | Solid |
| AsyncChannel | `electron/services/async-channel.ts` | ~50 | — | Solid |

### Structural Concerns

| Concern | Impact | Location |
|---------|--------|----------|
| **SessionsService is 1500+ lines** | Hard to reason about, test, or modify safely | `electron/services/sessions.ts` |
| **MCP and SlashCommands are not account-scoped** | Created with `defaultConfigDir` only — multi-account users get global-only config | `main.ts:223-224` |
| **Permission handlers have inline fs I/O** | `session_get_permissions` and `session_update_permission` read/write settings files directly in the handler, not through a service | `handlers.ts:234-313` |
| **Storage handlers allow arbitrary SQL** | Intentional for admin, but no audit trail or access control | `handlers.ts:387-469` |
| **No migration framework** | Single inline `ALTER TABLE` check at startup; schema changes will accumulate | `database.ts:125-128` |
| **Cost model hardcoded** | Token pricing for Opus/Sonnet/Haiku is inline in UsageService | `usage.ts:96-101` |
| **UsageService scans on every call** | No caching layer for `.jsonl` file scanning across all accounts | `usage.ts:144-215` |

### SessionsService Decomposition Opportunity

The 1500-line service owns: session lifecycle, streaming loop, query restart, permission queue, auto-allow, 25+ SDK hooks, and 12+ query-method passthroughs. Natural split:

- **SessionLifecycle**: `start()`, `stop()`, `stopAll()`, handle map management
- **SessionStreaming**: `listenToMessages()`, `restartQuery()`, `sendMessage()`
- **SessionPermissions**: `canUseTool()`, `respondPermission()`, permission queue, auto-allow
- **SessionHooks**: The 25+ hook callbacks (already a discrete block at lines 354-1038)
- **SessionQueries**: The 12 passthrough methods (`interrupt`, `setModel`, `getContextUsage`, etc.)

---

## 2. Renderer: Component & State Architecture

### Strengths

- **Clean IPC boundary**: All main-process calls go through `src/lib/api.ts`. No direct `window.electronAPI.invoke()` in components.
- **Tab-centric navigation**: `TabContext` owns the tab array with persistence to localStorage. Tabs survive app reload.
- **Typed API surface**: ~1900 lines of type definitions in `api.ts` give compile-time safety across the IPC boundary.
- **Lazy loading**: `TabContent` lazy-loads heavy components (ClaudeCodeSession, AgentExecution, Settings).
- **Provider composition**: ThemeProvider > OutputCacheProvider > AccountsProvider > TabProvider is clean and testable.

### Component Monoliths

| Component | Lines | What it shouldn't own |
|-----------|-------|-----------------------|
| **ToolWidgets** | 2600 | Renders every tool type inline; should be a registry of small tool-specific components |
| **ClaudeCodeSession** | 2100 | Streaming logic, UI rendering, timeline, permissions, tools, MCP status — all in one file |
| **FloatingPromptInput** | 1200 | Input layout, model picker, file picker, slash commands, permission controls, image handling |
| **Settings** | 1200 | 6 tab panels (general, accounts, permissions, logs, MCP, hooks) in one switch statement |

### State Management Fragmentation

The renderer uses **three competing state patterns** without clear ownership boundaries:

```
React Context (TabProvider, AccountsProvider, ThemeProvider)
     +
Zustand stores (agentStore, sessionStore)
     +
Local useState in large components (ClaudeCodeSession.messages, TabContent.selectedProject)
```

**Specific conflicts**:
- Project list is fetched in both `TabContent` and `useSessionStore`
- Session messages live in `ClaudeCodeSession` local state, but `Tab.sessionData` also holds session data for persistence — unclear source of truth on restore
- `selectedModel` can be set from FloatingPromptInput, from `api.sessionSetModel()`, or from the SDK's `system:init` message — three sources, no single owner

**Recommended ownership model**:
- `TabContext` owns tab UI state (title, order, active, status)
- `SessionStore` owns session data keyed by sessionId (messages, context usage, model)
- `AgentStore` owns agent runs keyed by runId
- `AccountsContext` owns account list (read-only, fetched once)
- Components own only ephemeral UI state (open/closed panels, input text)

---

## 3. Session & SDK Integration

### Strengths

- **AsyncChannel pattern**: Custom async iterator bridges renderer prompts to SDK's `query()` async iteration cleanly
- **Fire-and-forget streaming**: `listenToMessages()` doesn't await renderer acknowledgment, so SDK never blocks on a slow UI
- **Auto-restart**: Stream errors keep the handle alive; next prompt triggers `restartQuery()` with `resume` mode
- **Permission queueing**: Queue model prevents concurrent permission dialogs from overwhelming the user
- **Hook isolation**: Every hook returns `{}` and catches its own errors — hook failures never interrupt the session
- **Account pinning**: `CLAUDE_CONFIG_DIR` is injected per-session from the resolved account

### Session Architecture Detail

**Session Handle (in-memory state per tab)**:
```typescript
interface SessionHandle {
  query: Query;                           // SDK Query iterator
  inputChannel: AsyncChannel<SDKUserMessage>; // Input promise-based channel
  sessionId: string | null;               // Initialized from first system message
  status: SessionStatus;                  // 'starting' | 'running' | 'waiting_permission' | 'stopped' | 'error'
  permissionResolver: ((decision) => void) | null;
  permissionQueue: PendingPermission[];   // Queue for permission race conditions
  autoAllowEnabled: boolean;
  autoAllowedTools: Set<string>;
  projectPath: string;
  configDir: string;
  sdkOptions: Record<string, unknown>;    // Saved for query restart on error
}

const sessions = new Map<string, SessionHandle>(); // tabId -> SessionHandle
```

**Message flow**:
```
FloatingPromptInput (user types)
  -> api.sendMessage(tabId, prompt)
  -> IPC invoke("session_send_message")
  -> sessions.sendMessage(tabId, prompt)
  -> handle.inputChannel.push({type:'user', message:{...}})
  -> SDK query: for await (const message of handle.query)
  -> SDK subprocess processes, emits response
  -> listenToMessages() loop receives: assistant, tool_use, result
  -> sendToRenderer(`claude-output:${tabId}`, message)
  -> Renderer IPC event: claude-output:${tabId}
  -> ClaudeCodeSession handleStreamMessage() updates state
  -> StreamMessage components re-render with latest content
```

**Error recovery flow**:
```
Stream error caught in listenToMessages()
  -> handle.status = 'error'
  -> Session stays in map (NOT deleted)
  -> User sends next prompt
  -> sendMessage() detects status='error'
  -> restartQuery() called:
     - New AsyncChannel created
     - New Query with options.resume = handle.sessionId
     - listenToMessages() restarted in background
     - Conversation history preserved via SDK resume mode
```

### Session Concerns

| Concern | Risk | Detail |
|---------|------|--------|
| **Sessions are ephemeral** | Data loss on app close | No auto-checkpoint before quit. `app.on('before-quit')` calls `stopAll()` but doesn't save conversation state. |
| **AsyncChannel is unbounded** | Memory growth if renderer stalls | No max queue size. In practice the `for await` loop is tight, but a renderer freeze could cause unbounded buffering. |
| **60s inactivity timeout** | False positives | If the SDK subprocess takes >60s on a complex tool (large file diff, long build), the renderer assumes it hung and resets `persistentSessionRef`. |
| **No subprocess reaper** | Orphaned processes | If `query.close()` fails or the app crashes, Claude subprocesses can linger indefinitely. |
| **Agent runs have no timeout** | Hung agents | One-shot agents run until completion with no configurable timeout. A stuck agent stays in `'running'` forever. |
| **No process health check** | Silent failures | If the subprocess dies silently (no stream error emitted), the renderer tab hangs with no recovery path. |

### Session Lifecycle Gap

```
Current:  start() -> streaming -> [crash -> auto-restart] -> stop()
                                                              ^ data lost

Needed:   start() -> streaming -> [periodic checkpoint] -> [crash -> auto-restart from checkpoint]
                                                            -> stop() -> [final checkpoint]
```

The checkpoint infrastructure exists (`CheckpointsService`) but isn't wired into the session lifecycle automatically.

---

## 4. Feature Completeness vs Claude Code Terminal

### At Parity or Exceeding

| Feature | Status | Notes |
|---------|--------|-------|
| Interactive sessions | Complete | Streaming, multi-turn, model switching, effort/thinking controls |
| Multi-account routing | Complete (exceeds terminal) | Path rules, project overrides, account badges, resolution explainer |
| Agent execution | Complete | CRUD, one-shot runs, GitHub import, output streaming |
| Usage analytics | Complete (exceeds terminal) | Dashboard with model/date/project breakdown, cost tracking |
| Slash commands | Complete | User + project scope, YAML frontmatter, CRUD UI |
| Hooks config | Complete | Pre/Post tool use, notification, stop, subagent events |
| Checkpoints | Complete | Create, restore, fork, timeline, diff |
| Project management | Complete | List, create, session history, account badges |
| Claude settings | Complete | Read/write settings.json, CLAUDE.md discovery/editing |
| Permissions | Complete | Dialog, queue, auto-allow, mode switching, settings persistence |
| Context usage | Complete | Real-time token tracking from SDK |
| Logging | Complete | Structured DB logging, query/filter/prune UI |
| App auto-update | Complete | GitHub release check, download with progress |

### Gaps

| Feature | Status | Notes |
|---------|--------|-------|
| MCP server management | **Partial** | Config CRUD works. `serve()`, `testConnection()`, `getServerStatus()` are stubs. Not account-scoped. |
| MCP Claude Desktop import | **Stub** | Returns placeholder message |
| Session auto-save | **Missing** | Sessions lost on app close/crash |
| Subprocess health monitoring | **Missing** | No heartbeat or reaper for orphaned Claude processes |
| Renderer component tests | **Missing** | No React Testing Library setup |

---

## 5. Test Coverage

| Area | Status | File Size | Notes |
|------|--------|-----------|-------|
| Sessions | Excellent | 89KB | Query, streaming, permissions covered |
| IPC Handlers | Good | 40KB | Handler registration, channel mapping |
| Agents | Very Good | 35KB | Execution, output streaming |
| Claude service | Good | 24KB | Projects, sessions, settings, CLAUDE.md |
| Usage | Good | 23KB | Aggregation, date filtering, cost model |
| Checkpoints | Good | 17KB | Create, restore, timeline |
| Logging | Good | 9KB | Batch write, query, prune |
| Updater | Good | 9KB | Version check, download |
| Accounts | Good | 8KB | Resolution logic, path rules, discovery |
| MCP | Basic | 6KB | Only basic add/remove |
| Slash Commands | Good | 4KB | CRUD, frontmatter parsing |
| **Renderer** | **None** | — | No React Testing Library setup |

Backend coverage is estimated at ~70-80% lines. Renderer has zero unit tests.

---

## 6. Architecture Diagram

```
+-----------------------------------------------------+
|                    RENDERER                          |
|                                                      |
|  Providers: Theme, Accounts, OutputCache, Tab        |
|  Stores:    agentStore (Zustand), sessionStore       |
|                                                      |
|  +----------------+  +----------------------+       |
|  |  TabManager     |  |  TabContent           |       |
|  |  (tab strip)    |  |  +- ClaudeCodeSession |       |
|  |                 |  |  +- Agents            |       |
|  |                 |  |  +- Settings          |       |
|  |                 |  |  +- UsageDashboard    |       |
|  |                 |  |  +- ...               |       |
|  +----------------+  +----------+-----------+       |
|                                  |                    |
|              src/lib/api.ts  (typed surface)          |
|              src/lib/apiAdapter.ts  (IPC call)        |
+---------------------------+--------------------------+
|         PRELOAD           |    allow-list (~85)      |
+---------------------------+--------------------------+
|                    MAIN PROCESS                      |
|                                                      |
|  electron/ipc/handlers.ts  (channel -> service map)  |
|                                                      |
|  +-------------+ +--------------+ +--------------+  |
|  | Sessions     | | Agents       | | Claude       |  |
|  | (1500 lines) | | (CRUD+exec)  | | (settings)   |  |
|  +------+------+ +------+-------+ +--------------+  |
|         |               |                            |
|  +------+------+ +------+-------+ +--------------+  |
|  | AsyncChannel | | RunRegistry  | | Accounts     |  |
|  +-------------+ +--------------+ | (resolve)    |  |
|                                    +------+-------+  |
|  +-------------+ +--------------+         |          |
|  | Checkpoints  | | Usage        |<-------+          |
|  +-------------+ +--------------+                    |
|  +-------------+ +--------------+ +--------------+  |
|  | MCP (stubs)  | | SlashCmds    | | Logging      |  |
|  +-------------+ +--------------+ +--------------+  |
|  +-------------+ +--------------+ +--------------+  |
|  | Database     | | Proxy        | | Updater      |  |
|  | (SQLite)     | |              | | (GitHub)     |  |
|  +-------------+ +--------------+ +--------------+  |
|                                                      |
|         @anthropic-ai/claude-agent-sdk v0.2.108      |
|              query() -> Claude CLI subprocess        |
+-----------------------------------------------------+
```

---

## 7. Prioritized Improvement Plan

### Tier 1: Structural Integrity (before adding features)

#### 1.1 Decompose SessionsService
- **What**: Split the 1500-line service into lifecycle, streaming, permissions, hooks, and query modules
- **Why**: Highest-risk file in the codebase. Every session-related change touches this file.
- **Approach**: Extract natural boundaries. The hooks block (lines 354-1038) is already isolated. Permission logic (canUseTool, respondPermission, queue, auto-allow) is self-contained. Query passthroughs are mechanical.

#### 1.2 Make MCP and SlashCommands Account-Aware
- **What**: Pass resolved `configDir` through service calls instead of using `defaultConfigDir` at construction
- **Why**: Multi-account users currently get global-only MCP config. This is a correctness bug.
- **Approach**: Change service factories to accept `configDir` per-call (like `ClaudeService` does), not per-construction.

#### 1.3 Define Renderer State Ownership
- **What**: Establish which layer owns session messages, model state, and project lists
- **Why**: Duplicate fetching and unclear source of truth cause bugs on session restore
- **Approach**: TabContext owns UI state. SessionStore owns session data keyed by sessionId. Components own only ephemeral UI state.

### Tier 2: Reliability (before shipping to more users)

#### 2.1 Auto-Checkpoint Active Sessions
- **What**: Wire CheckpointsService into session lifecycle with periodic and on-quit checkpointing
- **Why**: App close or crash currently loses all conversation state
- **Approach**: Add `autoCheckpoint()` call in the streaming loop (e.g., after every `result` message) and in `app.on('before-quit')`.

#### 2.2 Add Subprocess Reaper
- **What**: Periodically scan for orphaned Claude processes
- **Why**: If `query.close()` fails or the app crashes, Claude subprocesses linger indefinitely
- **Approach**: Track spawned PIDs. On app start and on a 5-minute interval, scan for Claude processes with no matching session handle.

#### 2.3 Cap AsyncChannel Queue
- **What**: Add max queue size (e.g., 1000 messages) with warning log
- **Why**: A renderer freeze could cause unbounded memory growth
- **Approach**: Add `maxSize` option to `createAsyncChannel()`. Log warning and drop oldest on overflow.

#### 2.4 Make Inactivity Timeout Configurable
- **What**: Raise default from 60s to 120s+ and allow user override
- **Why**: Complex tool operations (large diffs, long builds) can legitimately take minutes
- **Approach**: Store in app_settings. Pass to ClaudeCodeSession as prop or read from api.

#### 2.5 Add Process Health Check
- **What**: Monitor if subprocess is still alive; gracefully fail if not
- **Why**: If subprocess dies silently (no stream error), the renderer tab hangs
- **Approach**: Periodic heartbeat via SDK query method. If unresponsive for N seconds, set handle to error state.

### Tier 3: Code Quality (as you touch these areas)

#### 3.1 Split Component Monoliths
- **What**: Decompose ToolWidgets (2600), ClaudeCodeSession (2100), FloatingPromptInput (1200), Settings (1200)
- **Why**: Large files are hard to navigate, review, and test
- **Approach**: Extract by responsibility. ClaudeCodeSession -> SessionStreamingManager + SessionUI + ToolRenderer + TimelinePanel + PermissionsPanel.

#### 3.2 Add Renderer Component Tests
- **What**: Set up Vitest + React Testing Library for core flows
- **Why**: Zero renderer tests means UI refactors carry regression risk
- **Approach**: Start with ClaudeCodeSession (message rendering), PermissionDialog (approve/deny), TabManager (create/close/switch).

#### 3.3 Implement MCP Process Management
- **What**: Implement `serve()`, `testConnection()`, `getServerStatus()` stubs
- **Why**: Terminal Claude Code has live server status and process lifecycle; GreyChrist is config-only
- **Approach**: Use child_process.spawn for server processes. Track PID + status in a registry similar to AgentRunRegistry.

#### 3.4 Add Schema Migration Framework
- **What**: Implement numbered migrations with a `schema_version` table
- **Why**: Current inline `ALTER TABLE` check doesn't scale
- **Approach**: Simple `migrations/` directory with numbered SQL files. Run on startup.

#### 3.5 Type the MCP Service
- **What**: Replace `any` return types with proper TypeScript interfaces
- **Why**: Loose typing defeats the purpose of TypeScript and allows runtime errors
- **Approach**: Define `MCPServerConfig`, `MCPServerStatus`, `MCPTestResult` interfaces.

#### 3.6 Clean Up Permission Handler I/O
- **What**: Extract settings file read/write from IPC handlers into a PermissionsService
- **Why**: Inline fs I/O in handlers breaks the service pattern and is hard to test
- **Approach**: Create `createPermissionsService(accountsService)` that handles settings file operations.

---

## 8. Dependency Risk

| Dependency | Risk | Mitigation |
|------------|------|------------|
| `@anthropic-ai/claude-agent-sdk` v0.2.108 | Pre-1.0, API may break | Pin version, test after each upgrade |
| `better-sqlite3` v12.8.0 | Native module, requires ABI rebuild | Existing pretest/forge hooks handle this |
| `electron` v41.2.0 | Major version updates may break | Standard Electron upgrade path |
| Hardcoded cost model | Prices change, new models added | Move to config or fetch from API |

---

## 9. Summary

The foundation is solid — factory DI, typed IPC boundary, robust session streaming with auto-recovery, and multi-account routing that exceeds terminal Claude Code. The main risks are:

1. **SessionsService monolith** (highest-risk file at 1500 lines)
2. **MCP account scoping** (correctness bug for multi-account)
3. **Ephemeral session state** (data loss on crash/close)
4. **Component monoliths** in the renderer (4 files over 1200 lines)
5. **State management fragmentation** (3 patterns, no clear ownership)

Addressing tiers 1-2 will make the app production-ready for broader use. Tier 3 items are ongoing code quality improvements to tackle as those areas are modified.
