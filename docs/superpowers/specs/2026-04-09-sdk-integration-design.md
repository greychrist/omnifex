# Claude Agent SDK Integration

**Date:** 2026-04-09
**Status:** Approved

## Overview

Replace the raw CLI process spawn in `session_manager.rs` with the `@anthropic-ai/claude-agent-sdk` TypeScript library. The SDK runs directly in the frontend, providing typed messages, proper permission handling via hooks, and session coherence without manual stdin/stdout protocol hacking.

## Problem

The current architecture spawns the `claude` CLI as a background process from Rust, pipes JSON via stdin/stdout, and uses `--permission-prompt-tool stdio` to handle permissions. This flag doesn't work reliably in Claude Code 2.1.97 — permission requests cause sessions to hang because the expected JSON protocol never fires. The SDK solves this with a proper `PermissionRequest` hook callback.

---

## Architecture

### Before

```
Frontend (React) → Tauri events/commands → session_manager.rs (Rust)
                                            ↓
                                    spawns claude CLI process
                                    pipes stdin/stdout JSON
                                    emits Tauri events back to frontend
```

### After

```
Frontend (React) → @anthropic-ai/claude-agent-sdk (TypeScript)
                    ↓
            SDK spawns claude CLI process internally
            SDK emits typed messages via async generator
            Permission hooks call React setState directly

Frontend (React) → Tauri commands → Rust backend
                                     (accounts, logging, storage, usage only)
```

### What stays in Rust

Account resolution, SQLite logging, storage tab, usage tracking, MCP config, proxy settings, slash commands, agent CRUD. Everything that isn't session management.

### What moves to TypeScript

Session lifecycle (start, message, stop, resume), permission handling, message streaming, session info.

---

## Session Management (`src/lib/sessionManager.ts`)

A singleton service that wraps the SDK's `query()` function and manages active sessions per tab.

### SessionHandle

Each tab gets its own `SessionHandle`:

- `query: Query` — SDK async generator
- `sessionId: string` — from `system/init` message
- `status: "starting" | "running" | "waiting_permission" | "stopped"`
- `permissionResolver` — Promise resolver for pending permission callback

### Methods

- `start(projectPath, configDir, model, permissionMode, claudeBinaryPath?)` — creates an async input channel, calls `query()` with it as the prompt, starts a listener loop
- `sendMessage(prompt)` — pushes an `SDKUserMessage` into the input channel
- `respondPermission(behavior, updatedInput?)` — resolves the pending permission Promise
- `stop()` — calls `query.close()` to terminate the CLI subprocess
- `resume(sessionId)` — calls `query()` with `options: { resume: sessionId }`

### Multi-turn sessions

`start()` creates an async push/pull queue. The SDK's `query()` receives this queue as its `prompt` parameter (`AsyncIterable<SDKUserMessage>`). When the user types a new message, `sendMessage()` pushes into the queue. The SDK reads it and continues the conversation — same process, same context, full coherence.

### Permission flow

The `PermissionRequest` hook callback:
1. Sets `status = "waiting_permission"`
2. Stores `toolName` and `toolInput`
3. Emits a permission event to the UI
4. Returns a Promise that blocks the SDK

When the user clicks Allow/Deny:
1. `respondPermission()` resolves the Promise with `{ behavior: "allow" }` or `{ behavior: "deny" }`
2. The SDK continues execution

### Message flow to UI

The `Query` async generator yields `SDKMessage` objects. A listener loop in `SessionHandle` iterates them and dispatches to a callback registered by `ClaudeCodeSession.tsx`. Messages are typed — `SDKAssistantMessage`, `SDKResultMessage`, `SDKSystemMessage`, etc.

---

## Changes to ClaudeCodeSession.tsx

### Before

- Listens for `claude-output:{tabId}` Tauri events
- Parses raw JSONL strings with `JSON.parse()`
- Manually detects `permission_request` message type
- Calls `api.respondPermission()` Tauri command

### After

- Imports `sessionManager`, calls `sessionManager.start()` on mount
- Receives typed `SDKMessage` objects via callback
- Permission events come from `SessionHandle`, component shows dialog
- Allow/Deny calls `sessionManager.respondPermission(tabId, behavior)`

### What stays the same

UI components (message bubbles, tool use display, code blocks, session metrics), the auto-allow toggle, the model picker, the thinking mode selector. Those are UI-level — they don't care where messages come from.

---

## Changes to PermissionPrompt.tsx

Simplified. No longer needs `tabId`, `requestId`, or direct API calls. Receives `toolName` and `toolInput` as props, and calls `sessionManager.respondPermission(tabId, behavior)` on Allow/Deny. The `autoAllowEnabled` toggle and "Always Allow" button continue to work — the auto-allow logic moves to the `PermissionRequest` hook callback in `SessionHandle`.

---

## Account Resolution

Stays in Rust. The flow:

1. User picks a project folder
2. Frontend calls `api.resolveAccountForProject(path)` → Rust resolves account → returns `{ config_dir, claude_binary, ... }`
3. Frontend passes `env: { CLAUDE_CONFIG_DIR: configDir }` and `pathToClaudeCodeExecutable: binaryPath` to the SDK's `query()` options

No changes to the account system.

---

## Code Removed

### Rust

- `src-tauri/src/session_manager.rs` — entire file (~600 lines)
- `session_manager` module declaration from `main.rs` and `lib.rs`
- All `session_*` commands from `tauri::generate_handler![]`: `session_start`, `session_send_message`, `session_respond_permission`, `session_stop`, `session_get_info`
- `SessionProcessManagerState` managed state from `main.rs`
- `send_session_input` legacy command and `SessionStdinState` from `commands/claude.rs`

### Frontend

- `api.startSession()`, `api.sendMessage()`, `api.respondPermission()`, `api.stopSession()`, `api.getSessionInfo()`, `api.sendSessionInput()` from `api.ts`
- `claude-output:{tabId}` Tauri event listeners in `ClaudeCodeSession.tsx`
- `ClaudeStreamMessage` type definitions from `AgentExecution.tsx`, `SessionOutputViewer.tsx`, `outputCache.tsx` — replaced by SDK's `SDKMessage` types

### Dependencies

- Add: `@anthropic-ai/claude-agent-sdk` (pinned to `0.2.97`)
- Remove: nothing

---

## Error Handling

- **SDK process crash:** Async generator throws or completes. `SessionHandle` catches, sets `status = "stopped"`, emits error to UI. User sees "Session ended unexpectedly" with resume option.
- **Permission timeout:** Session waits indefinitely — same as the terminal. No artificial timeout.
- **Account resolution failure:** Same as today — `AccountPickerDialog` shows before SDK is involved.
- **Multiple tabs:** Each tab gets its own `SessionHandle` with its own `Query` — independent processes, no shared state.
- **Session resume:** `sessionManager.resume(tabId, sessionId)` → SDK's `query({ options: { resume: sessionId } })`.
- **App/tab close:** `SessionHandle.stop()` calls `query.close()`. On app close, iterate all active sessions and stop them.
- **Logging:** `SessionHandle` listener loop forwards errors/warnings to LogService for the Log tab.

---

## Migration Strategy

One pass — the boundary between session plumbing and everything else is clean.

1. Install SDK package
2. Create `src/lib/sessionManager.ts`
3. Update `ClaudeCodeSession.tsx` to use session manager
4. Update `PermissionPrompt.tsx` to use session manager
5. Remove Rust session code
6. Remove dead frontend API methods
7. Clean up types
8. Verify: `npm run check`, `cargo check`, `cargo test`, `npm run build`

---

## Risk

The SDK is version 0.2.97 (pre-1.0). API may change. Mitigation: pin version in `package.json`, test before upgrading.

---

## Out of Scope

- AgentExecution.tsx SDK migration (separate component, can be migrated later)
- Web mode session support (desktop only for now)
- SDK subagent features (available but not needed yet)
- Version compatibility checking (noted as a future feature the user requested separately)
