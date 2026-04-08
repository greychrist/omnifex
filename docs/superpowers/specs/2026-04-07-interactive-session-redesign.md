# Interactive Session Redesign — Full Terminal Parity with Rich UI

**Date**: 2026-04-07
**Branch**: multi-account
**Status**: Design approved

## Problem Statement

GreyChrist wraps Claude Code CLI as a desktop/web GUI but currently has three critical gaps:

1. **Broken streaming**: The `ClaudeCodeSession` component uses `require()` to import Tauri's event listener, which fails silently in Vite/ESM. The component falls back to DOM event listeners that never receive Tauri IPC events. Result: users see a spinner but no Claude output.

2. **No two-way communication**: The app spawns Claude with `--dangerously-skip-permissions` and never writes to stdin. Users have zero control over tool permissions — the opposite of terminal behavior.

3. **Poor account visibility**: Users can't easily see which account is active for a session, why it was selected, or verify that their path rules are working correctly.

## Design

### 1. Fix the Broken Streaming Pipeline

**Files affected**: `src/components/ClaudeCodeSession.tsx`, `src/components/claude-code-session/useClaudeMessages.ts`

**Current (broken)**:
```typescript
let tauriListen: any;
try {
  if (typeof window !== 'undefined' && window.__TAURI__) {
    tauriListen = require("@tauri-apps/api/event").listen;
  }
} catch (e) {
  console.log('[ClaudeCodeSession] Tauri APIs not available, using web mode');
}

const listen = tauriListen || ((eventName: string, callback: (event: any) => void) => {
  // DOM fallback — never receives Tauri events
  window.addEventListener(eventName, domEventHandler);
  return Promise.resolve(() => window.removeEventListener(eventName, domEventHandler));
});
```

**Fixed**:
```typescript
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
```

For web mode compatibility, the environment detection already exists in `apiAdapter.ts`. The session component should import `listen` directly and let the build environment handle the difference. The working components (`AgentRunOutputViewer.tsx`, `AgentExecution.tsx`, `SessionOutputViewer.tsx`) already use this pattern.

The same fix applies to `useClaudeMessages.ts` which has the identical `require()` pattern at line 10.

### 2. Two-Way stdin Communication

**Goal**: Remove `--dangerously-skip-permissions` and give users the same permission control they have in the terminal.

#### 2a. Backend — stdin Pipe Management

**Files affected**: `src-tauri/src/commands/claude.rs`

**New managed state**:
```rust
pub struct SessionStdinState {
    pub handles: Arc<Mutex<HashMap<String, tokio::process::ChildStdin>>>,
}
```

**Changes to `spawn_claude_process`**:
- Remove `--dangerously-skip-permissions` from `execute_claude_code`, `continue_claude_code`, and `resume_claude_code` arg lists.
- After spawning, take `child.stdin` (currently ignored) and store it in `SessionStdinState` keyed by session_id.
- The session_id isn't known until the first `system:init` message arrives, so stdin is initially stored under a temporary key (the process PID as a string), then re-keyed to the real session_id once extracted from the `system:init` message.

**New Tauri command**:
```rust
#[tauri::command]
pub async fn send_session_input(
    stdin_state: State<'_, SessionStdinState>,
    session_id: String,
    input: String,
) -> Result<(), String> {
    let mut handles = stdin_state.handles.lock().await;
    if let Some(stdin) = handles.get_mut(&session_id) {
        stdin.write_all(input.as_bytes()).await
            .map_err(|e| format!("Failed to write to stdin: {}", e))?;
        stdin.write_all(b"\n").await
            .map_err(|e| format!("Failed to write newline: {}", e))?;
        stdin.flush().await
            .map_err(|e| format!("Failed to flush stdin: {}", e))?;
        Ok(())
    } else {
        Err(format!("No stdin handle for session: {}", session_id))
    }
}
```

**Cleanup**: When a session completes (in the process-wait task), remove its stdin handle from the map.

#### 2b. Frontend — Permission Prompt UI

**Files affected**: `src/components/ClaudeCodeSession.tsx`, new component `src/components/PermissionPrompt.tsx`

**Detection**: In `handleStreamMessage`, when a message has `stop_reason: "tool_use"`, the session is waiting for permission input. The component transitions to a "waiting for input" state.

**PermissionPrompt component** renders:
- Tool name with icon (Bash, Read, Write, Edit, Grep, Glob, etc.)
- Collapsible argument preview (the command string, file path, content being written)
- Three action buttons:
  - **Allow** — sends acceptance to stdin
  - **Deny** — sends denial to stdin
  - **Always Allow (this session)** — sends acceptance and stores the tool name in a per-session allowlist so future uses of that tool auto-approve
- For text input scenarios (Claude asking a question), renders a text input field instead of approve/deny buttons

**Session-level permission preferences**:
- Stored in component state (not persisted — fresh each session, matching terminal behavior)
- A small indicator in the session header shows which tools have been auto-approved
- User can revoke auto-approvals mid-session

**Note on stdin protocol**: The exact format for permission responses in `stream-json` mode needs to be verified by testing. If Claude Code expects raw text (`y`/`n`), we send that. If it expects JSON, we send JSON. This will be determined during implementation by testing with `--output-format stream-json` without `--dangerously-skip-permissions` and observing the protocol.

### 3. Account Visibility and Control

#### 3a. Session Header — Always-Visible Account Info

**Files affected**: `src/components/ClaudeCodeSession.tsx`, new component `src/components/SessionHeader.tsx`

Every active session displays a persistent header bar containing:
- **Account badge** — colored badge with account name (uses existing `AccountBadge` component, made more prominent)
- **Account type** — label showing max/pro/enterprise/free
- **Config directory** — the resolved `CLAUDE_CONFIG_DIR` path, truncated with tooltip for full path
- **Match reason** — how the account was selected: "path rule", "project override", or "default"
- **Live cost** — running cost accumulator for the session (shows $0.00 for "max" account type)
- **Session ID** — small, copyable session identifier

The header is a fixed element at the top of the session panel, not part of the scrolling message stream.

#### 3b. Session Start Confirmation

**Files affected**: `src/components/ClaudeCodeSession.tsx`

Before spawning the Claude process, the UI shows a brief confirmation:
- Project path
- Resolved account name and config directory
- How the account was matched (path rule with the matching prefix, project override, or default fallback)
- A "Start" button to confirm, or "Change Account" to pick a different one

This confirmation can be dismissed instantly (click Start or press Enter) — it's not a modal blocker, it's a verification step. If the user has auto-start enabled, it shows for 1-2 seconds then proceeds automatically.

**Backend support**: The `resolve_account_for_project` command already returns the account. Add a new field to the response (or a new command `explain_account_resolution`) that returns the match reason:
```rust
pub struct AccountResolution {
    pub account: Account,
    pub match_type: String,      // "path_rule", "project_override", "default"
    pub match_detail: String,    // e.g., "~/Repos/personal/ → personal" or "explicit override"
}
```

#### 3c. Account Management Improvements

**Files affected**: `src/components/AccountSettings.tsx`

**Visual account map**: The path rules section becomes a visual tree showing folder-to-account mappings:
```
~/Repos/
  personal/     → personal (path rule)
    greychrist/     → personal (inherited)
  work/         → work (path rule)
    project-x/  → work-special (project override)
```

**Test resolution input**: A text field at the bottom of the account settings where you type any path and see:
- Which account would be resolved
- Why (which rule matched, or default fallback)
- The full `CLAUDE_CONFIG_DIR` that would be set

This calls `explain_account_resolution` on the backend and displays the result inline.

**Project override list**: Shows all explicit project-to-account bindings with clear/delete buttons. Currently this data exists but isn't surfaced in the UI.

### 4. Enhanced Session Rendering

**Files affected**: `src/components/StreamMessage.tsx`, new components as needed

#### Tool Use Cards
Tool use messages render as interactive cards:
- **Header**: Tool icon + name (e.g., "Bash", "Edit", "Write")
- **Body**: Collapsible argument preview with syntax highlighting
  - Bash commands: syntax-highlighted shell
  - File paths: clickable/copyable
  - Code content: language-detected syntax highlighting
- **State indicator**: pending (waiting for permission), running (spinner), completed (green check), failed (red X)

#### Tool Result Cards
- Default **collapsed** for successful results — shows one-line summary ("Read 45 lines from src/App.tsx")
- Default **expanded** for errors — shows full error output
- File contents get syntax highlighting based on file extension
- Bash output renders in monospace with terminal-style dark background

#### System Messages
- Rendered as subtle inline status updates, not full message blocks
- Session init, cost updates, model info — small, non-intrusive

### 5. User Message Styling

**Files affected**: `src/components/StreamMessage.tsx` or equivalent

User messages get distinct visual treatment to serve as **session landmarks**:
- Colored left accent bar (distinct from assistant messages)
- "You" label at the top of the message block
- Subtle background tint — different shade from the rest of the session
- Model tag showing which model was selected for that prompt (e.g., "opus", "sonnet")
- Creates visual rhythm: user messages divide the session into prompt-response sections

### 6. Communication Efficiency

**No architectural changes needed** — the current approach is sound:
- `--output-format stream-json` is the optimal format for a GUI wrapper
- Line-by-line JSONL via tokio `BufReader` has minimal latency
- Tauri IPC events are low-overhead

**Minor improvements**:
- Evaluate whether `--verbose` flag adds useful data or noise — test with and without
- Once session-specific listeners are attached, ensure generic listeners are fully removed (current code does this but has a brief race window)
- Clean up the dual-listener strategy: since we now store session_id in `SessionStdinState` on the backend, we could emit the session_id as a return value from `execute_claude_code` rather than extracting it from the first message. However, the session_id comes from Claude's init message (not known at spawn time), so the current approach of extracting from the stream is correct.
- Investigate `--input-format stream-json` for structured stdin communication once basic stdin is working

## Files Changed Summary

| File | Change |
|------|--------|
| `src/components/ClaudeCodeSession.tsx` | Fix import, add stdin integration, add session header, add start confirmation |
| `src/components/claude-code-session/useClaudeMessages.ts` | Fix `require()` import |
| `src-tauri/src/commands/claude.rs` | Remove `--dangerously-skip-permissions`, add stdin management, add `send_session_input` command |
| `src-tauri/src/main.rs` | Register `SessionStdinState`, register new commands |
| `src-tauri/src/commands/accounts.rs` | Add `explain_account_resolution` command |
| `src-tauri/src/accounts/mod.rs` | Add `resolve_with_explanation()` method returning match reason |
| `src/components/PermissionPrompt.tsx` | New — interactive permission approval UI |
| `src/components/SessionHeader.tsx` | New — always-visible account/cost/session info bar |
| `src/components/StreamMessage.tsx` | Enhanced rendering for tool uses, tool results, user messages |
| `src/components/AccountSettings.tsx` | Visual account map, test resolution, project override list |
| `src/lib/api.ts` | Add `sendSessionInput`, `explainAccountResolution` API methods |
| `src/lib/apiAdapter.ts` | Add endpoint mappings for new commands |

## Out of Scope

- Per-account permission presets (always allow certain tools for certain accounts) — future enhancement
- MCP server management changes — existing system is separate and working
- Agent execution changes — agents have their own spawn path; this design focuses on interactive sessions
- Web mode stdin handling — web mode uses WebSocket which would need its own stdin relay; addressed separately

## Open Questions

1. **stdin protocol format**: The exact format Claude Code expects for permission responses in `stream-json` mode needs testing. Design assumes simple text (`y`/`n` or JSON) but this must be verified.
2. **`--verbose` flag**: Need to test whether removing it loses useful information or reduces noise.
3. **Auto-start preference**: Should the session start confirmation default to auto-proceed or require explicit click? Recommend: auto-proceed with 1s delay, configurable in settings.
