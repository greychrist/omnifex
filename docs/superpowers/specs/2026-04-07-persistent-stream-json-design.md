# Persistent Stream-JSON Session Design

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace the one-shot `-p` process-per-turn model with a persistent bidirectional stream-json process per tab, achieving terminal parity with Claude Code CLI.

**Architecture:** Each interactive chat tab owns a long-lived Claude Code subprocess communicating via NDJSON over stdin/stdout. A new `SessionProcessManager` in Tauri state manages process lifecycles. Agent runs (fire-and-forget) remain on `-p` mode.

**Protocol:** `--input-format stream-json --output-format stream-json` — the same protocol the VS Code extension uses.

---

## 1. Backend: `SessionProcessManager`

### 1.1 State Structure

New file: `src-tauri/src/session_manager.rs`

A Tauri-managed state (`SessionProcessManagerState`) holding a `HashMap<String, ManagedSession>` keyed by tab ID.

```rust
struct ManagedSession {
    child: tokio::process::Child,
    stdin: tokio::process::ChildStdin,
    session_id: Option<String>,  // Populated from system/init response
    project_path: String,
    model: String,
    permission_mode: String,
    config_dir: String,
    started_at: std::time::Instant,
    // stdout/stderr reader tasks are spawned and hold their own references
}
```

### 1.2 Commands

All commands take `tab_id: String` as the primary key.

**`session_start(tab_id, project_path, model, permission_mode, resume_session_id?)`**

1. Resolve account from `project_path` via `AccountManager`.
2. Build args: `--input-format stream-json --output-format stream-json --permission-prompt-tool stdio --verbose --include-partial-messages --replay-user-messages --model <model> --permission-mode <mode>`. If `resume_session_id` is provided, add `--resume <id>`.
3. Set `CLAUDE_CONFIG_DIR` from resolved account.
4. Spawn with `stdin(Stdio::piped())`, `stdout(Stdio::piped())`, `stderr(Stdio::piped())`.
5. Take stdin handle, store in `ManagedSession`.
6. Spawn tokio task for stdout: readline loop parsing NDJSON, emitting `claude-output:<tab_id>` Tauri events. On `system/init`, extract `session_id` and store it in the `ManagedSession`. On `result` messages, also emit `claude-notification` event.
7. Spawn tokio task for stderr: emit `claude-error:<tab_id>` for non-ignorable messages.
8. On process exit (detected by stdout EOF or child.wait()), emit `claude-complete:<tab_id>` with exit status.
9. Register process in `ProcessRegistry` for kill tracking.

**`session_send_message(tab_id, prompt)`**

1. Look up `ManagedSession` by `tab_id`.
2. Build NDJSON message: `{ "type": "user", "message": { "role": "user", "content": "<prompt>" }, "session_id": "<sid>", "parent_tool_use_id": null }`.
3. Write to stdin + newline.
4. Return Ok.

**`session_respond_permission(tab_id, request_id, behavior, updated_input)`**

1. Look up session.
2. Build: `{ "type": "control_response", "response": { "subtype": "success", "request_id": "<id>", "response": { "behavior": "<allow|deny>", "updatedInput": <input> } } }`.
3. Write to stdin.

**`session_stop(tab_id)`**

1. Look up session.
2. Drop the stdin handle (signals EOF to Claude, which finishes gracefully).
3. Wait up to 5 seconds for process exit.
4. If still running, kill the child process.
5. Remove from `HashMap`.
6. Deregister from `ProcessRegistry`.

**`session_get_info(tab_id)`**

Returns session metadata: `session_id`, `project_path`, `model`, `permission_mode`, uptime, whether the process is alive.

### 1.3 Crash Recovery

If the stdout reader detects EOF (process exited unexpectedly):
- Emit `claude-complete:<tab_id>` with `success: false`.
- Clean up the `ManagedSession` entry.
- Frontend shows an error with "Restart Session" action.
- Restart uses `session_start` with `resume_session_id` set to the previous `session_id` — Claude Code persists session history to disk, so the conversation resumes.

### 1.4 Keep-Alive

The stdout reader task sends `{ "type": "keep_alive" }` on stdin every 30 seconds to prevent timeout. Claude Code CLI also sends `keep_alive` messages on stdout which the reader acknowledges/ignores.

## 2. Frontend Changes

### 2.1 `ClaudeCodeSession.tsx`

The component simplifies from "spawn process per prompt" to "manage a single persistent connection."

**Session start flow:**
1. User clicks "Start Session" (or types first prompt).
2. Call `api.startSession(tabId, projectPath, model, permissionMode)`.
3. Set up Tauri event listeners for `claude-output:<tabId>`, `claude-error:<tabId>`, `claude-complete:<tabId>` — done once, not per prompt.
4. Wait for `system/init` to arrive via the event listener.

**Sending prompts:**
1. Add user message to `messages` state immediately.
2. Call `api.sendMessage(tabId, prompt)`.
3. That's it. No listener teardown/rebuild. No process spawn.

**Permission flow:**
1. `control_request` messages arrive via `claude-output:<tabId>`.
2. Render the `PermissionPrompt` component with tool name, input, and `request_id`.
3. On allow/deny, call `api.respondPermission(tabId, requestId, behavior, updatedInput)`.

**Model changes:**
- Call `api.stopSession(tabId)`, then `api.startSession(tabId, ..., newModel, ..., resumeSessionId)`.

**Tab close / unmount:**
- Call `api.stopSession(tabId)`.

**What's removed from `handleSendPrompt`:**
- `isListeningRef` / listener setup/teardown dance
- `spawn_claude_process` / `execute_claude_code` / `continue_claude_code` / `resume_claude_code` calls
- `SessionStdinState` usage
- Duplicate `system:init` filtering (only one init per process lifetime)

### 2.2 `src/lib/api.ts`

New methods:
- `startSession(tabId, projectPath, model, permissionMode, resumeSessionId?)` → invokes `session_start`
- `sendMessage(tabId, prompt)` → invokes `session_send_message`
- `respondPermission(tabId, requestId, behavior, updatedInput)` → invokes `session_respond_permission`
- `stopSession(tabId)` → invokes `session_stop`
- `getSessionInfo(tabId)` → invokes `session_get_info`

Old methods to deprecate (keep for agent runs):
- `executeClaudeCode`, `continueClaudeCode`, `resumeClaudeCode` — still used by `AgentExecution` but no longer by `ClaudeCodeSession`.

## 3. Notifications

### 3.1 Backend

When the stdout reader parses a `result` message:
- Emit `claude-notification` Tauri event with payload: `{ tab_id, title: "Execution Complete" | "Execution Failed", body: <result text truncated to 200 chars>, is_error: bool }`.

### 3.2 Frontend

A top-level listener in `App.tsx` (or a dedicated `useNotifications` hook):
1. Listen for `claude-notification` events.
2. If the `tab_id` is NOT the currently active tab, fire an OS notification via `@tauri-apps/plugin-notification`.
3. On notification click, call `setActiveTab(tab_id)` and bring window to front via `appWindow.setFocus()`.
4. If the tab IS active, skip the notification (user is already looking at it).

### 3.3 Dependency

Add `@tauri-apps/plugin-notification` to the project. Register the plugin in `src-tauri/src/main.rs` and `src-tauri/capabilities/`.

## 4. What Stays the Same

- **Agent execution** (`agents.rs`): Keeps `-p` mode. Fire-and-forget, no multi-turn.
- **StreamMessage rendering** (`StreamMessage.tsx`): No changes. Same message types arrive via same Tauri events.
- **Tauri event channels**: Same pattern `claude-output:<id>`, `claude-error:<id>`, `claude-complete:<id>`. Just the producer changes from `spawn_claude_process` to `SessionProcessManager`.
- **Account resolution**: Untouched. `SessionProcessManager.start_session` resolves the account the same way `execute_claude_code` does today.
- **Slash commands, settings, usage tracking**: Untouched.
- **Checkpoint system**: Untouched. Claude Code manages checkpoints internally.

## 5. What Gets Removed

- `spawn_claude_process` function — replaced by `SessionProcessManager`.
- `SessionStdinState` — absorbed into `ManagedSession`.
- `execute_claude_code`, `continue_claude_code`, `resume_claude_code` — no longer called from frontend chat sessions. Keep as `#[allow(dead_code)]` temporarily for agent backward compat, then remove once agents are verified unaffected.
- The listener teardown/rebuild dance in `handleSendPrompt` — listeners set up once on session start.
- `pendingUserMessageRef` — already removed.
- Duplicate `system:init` dedup logic — only one init per persistent process.
- `isListeningRef` — no longer needed since listeners are stable.

## 6. Migration Path

1. Build `SessionProcessManager` alongside existing code.
2. Wire new `session_*` Tauri commands.
3. Update `ClaudeCodeSession.tsx` to use new commands.
4. Add notification plugin and listener.
5. Verify agent execution still works on old `-p` path.
6. Remove dead code.

## 7. Testing

- Start a session, send multiple prompts — verify context carries across turns without resume overhead.
- Close a tab mid-execution — verify process is killed.
- Process crashes — verify error shown, restart with resume works.
- Permission flow — verify `control_request`/`control_response` works for tool approvals.
- Multiple tabs — verify independent processes with correct accounts.
- Notifications — verify OS notification on non-active tab completion, click switches to correct tab.
- Model switch mid-session — verify process restarts with new model and resumes conversation.
