# Interactive Session Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix broken session streaming, add two-way stdin communication for permission handling, and improve account visibility — achieving full terminal parity with enhanced formatting.

**Architecture:** The Tauri backend spawns Claude Code CLI as a subprocess. Stdout streams JSONL via Tauri events to the React frontend. This plan adds stdin piping for permission responses, fixes a broken ESM import that prevents all output display, and layers account visibility + enhanced rendering on top.

**Tech Stack:** Rust/Tauri 2 backend, React/TypeScript frontend, tokio async I/O, shadcn/ui + Tailwind CSS

---

## File Structure

| File | Responsibility |
|------|---------------|
| `src/components/ClaudeCodeSession.tsx` | Fix ESM import, integrate SessionHeader, permission prompt, start confirmation |
| `src/components/claude-code-session/useClaudeMessages.ts` | Fix ESM import |
| `src-tauri/src/commands/claude.rs` | stdin pipe management, remove `--dangerously-skip-permissions`, new `send_session_input` command |
| `src-tauri/src/main.rs` | Register new state and commands |
| `src-tauri/src/accounts/mod.rs` | Add `resolve_with_explanation()` method |
| `src-tauri/src/commands/accounts.rs` | Add `explain_account_resolution` command |
| `src/components/SessionHeader.tsx` | New — always-visible account/cost/session info bar |
| `src/components/PermissionPrompt.tsx` | New — interactive tool permission approval UI |
| `src/components/StreamMessage.tsx` | Enhanced user message styling, tool use/result cards |
| `src/components/AccountSettings.tsx` | Add test resolution input, project override list display |
| `src/lib/api.ts` | Add `sendSessionInput`, `explainAccountResolution` API methods |
| `src/lib/apiAdapter.ts` | Add endpoint mappings for new commands |

---

### Task 1: Fix the Broken ESM Import in ClaudeCodeSession

**Files:**
- Modify: `src/components/ClaudeCodeSession.tsx:21-50`
- Modify: `src/components/claude-code-session/useClaudeMessages.ts:10`

- [ ] **Step 1: Fix the import in ClaudeCodeSession.tsx**

Replace the broken `require()` pattern (lines 21-50) with a proper ES module import matching the pattern used by `AgentRunOutputViewer.tsx`, `AgentExecution.tsx`, and `SessionOutputViewer.tsx`.

Remove these lines (21-50):
```typescript
// Conditional imports for Tauri APIs
let tauriListen: any;
type UnlistenFn = () => void;

try {
  if (typeof window !== 'undefined' && window.__TAURI__) {
    tauriListen = require("@tauri-apps/api/event").listen;
  }
} catch (e) {
  console.log('[ClaudeCodeSession] Tauri APIs not available, using web mode');
}

// Web-compatible replacements
const listen = tauriListen || ((eventName: string, callback: (event: any) => void) => {
  console.log('[ClaudeCodeSession] Setting up DOM event listener for:', eventName);

  // In web mode, listen for DOM events
  const domEventHandler = (event: any) => {
    console.log('[ClaudeCodeSession] DOM event received:', eventName, event.detail);
    // Simulate Tauri event structure
    callback({ payload: event.detail });
  };

  window.addEventListener(eventName, domEventHandler);

  // Return unlisten function
  return Promise.resolve(() => {
    console.log('[ClaudeCodeSession] Removing DOM event listener for:', eventName);
    window.removeEventListener(eventName, domEventHandler);
  });
});
```

Replace with:
```typescript
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
```

- [ ] **Step 2: Fix the import in useClaudeMessages.ts**

Replace line 10:
```typescript
    tauriListen = require('@tauri-apps/api/event').listen;
```

With a proper ES module import at the top of the file:
```typescript
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
```

Remove the surrounding try/catch and fallback logic, matching the same cleanup done in Step 1.

- [ ] **Step 3: Build the frontend to verify no import errors**

Run: `npm run build`
Expected: Build succeeds with no errors related to `@tauri-apps/api/event`

- [ ] **Step 4: Commit**

```bash
git add src/components/ClaudeCodeSession.tsx src/components/claude-code-session/useClaudeMessages.ts
git commit -m "fix: replace broken require() with ES module import for Tauri event listener

The require() call fails silently in Vite/ESM, causing the component to
fall back to DOM event listeners that never receive Tauri IPC events.
This is why sessions show a spinner but no Claude output."
```

---

### Task 2: Add stdin Pipe to Process Spawning

**Files:**
- Modify: `src-tauri/src/commands/claude.rs:351-364` (create_system_command)
- Modify: `src-tauri/src/commands/claude.rs:16-26` (add SessionStdinState)
- Modify: `src-tauri/src/commands/claude.rs:1347-1513` (spawn_claude_process)
- Modify: `src-tauri/src/main.rs:162` (register new state)

- [ ] **Step 1: Write a test for SessionStdinState**

Add to `src-tauri/src/commands/claude.rs` (at the bottom, in a new `#[cfg(test)]` module):

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_session_stdin_state_default() {
        let state = SessionStdinState::default();
        let handles = state.handles.blocking_lock();
        assert!(handles.is_empty());
    }
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cargo test --bin greychrist test_session_stdin_state_default`
Expected: FAIL — `SessionStdinState` not defined yet

- [ ] **Step 3: Define SessionStdinState**

Add after the `ClaudeProcessState` definition (after line 26 in `claude.rs`):

```rust
/// State to track stdin handles for active Claude sessions.
/// Keyed by session_id (or temporary PID string until session_id is known).
pub struct SessionStdinState {
    pub handles: Arc<tokio::sync::Mutex<HashMap<String, tokio::process::ChildStdin>>>,
}

impl Default for SessionStdinState {
    fn default() -> Self {
        Self {
            handles: Arc::new(tokio::sync::Mutex::new(HashMap::new())),
        }
    }
}
```

Add `use std::collections::HashMap;` to the imports at the top of `claude.rs` if not already present.

- [ ] **Step 4: Run the test to verify it passes**

Run: `cargo test --bin greychrist test_session_stdin_state_default`
Expected: PASS

- [ ] **Step 5: Add stdin pipe to create_system_command**

Modify `create_system_command` (lines 351-364) to also pipe stdin:

```rust
fn create_system_command(claude_path: &str, args: Vec<String>, project_path: &str) -> Command {
    let mut cmd = create_command_with_env(claude_path);

    for arg in args {
        cmd.arg(arg);
    }

    cmd.current_dir(project_path)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    cmd
}
```

- [ ] **Step 6: Store stdin handle in spawn_claude_process**

In `spawn_claude_process` (line 1362-1364), after taking stdout and stderr, also take stdin:

```rust
    let stdin = child.stdin.take().ok_or("Failed to get stdin")?;
```

After the session_id is extracted from the `system:init` message (around line 1411), store the stdin handle. First, pass `SessionStdinState` into the function. Update the function signature:

```rust
async fn spawn_claude_process(
    app: AppHandle,
    mut cmd: Command,
    prompt: String,
    model: String,
    project_path: String,
) -> Result<(), String> {
```

Before the stdout task spawn, store stdin under a temporary PID key:

```rust
    // Store stdin handle under temporary PID key
    let stdin_state = app.state::<SessionStdinState>();
    let pid_key = format!("pid:{}", pid);
    {
        let mut handles = stdin_state.handles.lock().await;
        handles.insert(pid_key.clone(), stdin);
    }
```

Inside the stdout task, after extracting `claude_session_id` (line 1411), re-key the stdin handle:

```rust
    // Re-key stdin from PID to session_id
    let stdin_state_clone = app_handle.state::<SessionStdinState>();
    let mut handles = stdin_state_clone.handles.lock().await;
    let pid_key = format!("pid:{}", pid);
    if let Some(stdin_handle) = handles.remove(&pid_key) {
        handles.insert(claude_session_id.to_string(), stdin_handle);
        log::info!("Re-keyed stdin from {} to {}", pid_key, claude_session_id);
    }
```

Note: This requires cloning the `app_handle` for use inside the stdout task and using `app_handle.state::<SessionStdinState>()` to access the state. The `app_handle` clone is already available in the task.

- [ ] **Step 7: Clean up stdin handle on process exit**

In the process-wait task (around line 1504), after unregistering from ProcessRegistry, also remove the stdin handle:

```rust
    // Clean up stdin handle
    let stdin_state = app_handle_wait.state::<SessionStdinState>();
    let mut handles = stdin_state.handles.lock().await;
    if let Some(ref session_id) = *session_id_holder_clone3.lock().unwrap() {
        handles.remove(session_id);
    }
    // Also remove PID-keyed entry if session_id was never extracted
    let pid_key = format!("pid:{}", pid);
    handles.remove(&pid_key);
```

- [ ] **Step 8: Register SessionStdinState in main.rs**

In `src-tauri/src/main.rs`, after line 162 (`app.manage(ClaudeProcessState::default());`), add:

```rust
            app.manage(commands::claude::SessionStdinState::default());
```

- [ ] **Step 9: Build to verify compilation**

Run: `cargo build --bin greychrist`
Expected: Compiles successfully

- [ ] **Step 10: Commit**

```bash
git add src-tauri/src/commands/claude.rs src-tauri/src/main.rs
git commit -m "feat: add stdin pipe management for Claude sessions

Stores ChildStdin handles keyed by session_id so the frontend can
send input back to running Claude processes. Prerequisite for
permission handling."
```

---

### Task 3: Add send_session_input Tauri Command

**Files:**
- Modify: `src-tauri/src/commands/claude.rs` (add command)
- Modify: `src-tauri/src/main.rs` (register command)
- Modify: `src/lib/api.ts` (add API method)
- Modify: `src/lib/apiAdapter.ts` (add endpoint mapping)

- [ ] **Step 1: Add the send_session_input command**

Add after the `cancel_claude_execution` command in `claude.rs`:

```rust
/// Send input to a running Claude Code session via stdin
#[tauri::command]
pub async fn send_session_input(
    stdin_state: tauri::State<'_, SessionStdinState>,
    session_id: String,
    input: String,
) -> Result<(), String> {
    log::info!("Sending input to session {}: {}", session_id, &input[..input.len().min(100)]);

    let mut handles = stdin_state.handles.lock().await;
    if let Some(stdin) = handles.get_mut(&session_id) {
        use tokio::io::AsyncWriteExt;
        stdin
            .write_all(input.as_bytes())
            .await
            .map_err(|e| format!("Failed to write to stdin: {}", e))?;
        stdin
            .write_all(b"\n")
            .await
            .map_err(|e| format!("Failed to write newline: {}", e))?;
        stdin
            .flush()
            .await
            .map_err(|e| format!("Failed to flush stdin: {}", e))?;
        Ok(())
    } else {
        Err(format!("No stdin handle for session: {}", session_id))
    }
}
```

- [ ] **Step 2: Register the command in main.rs**

Add `send_session_input` to the invoke_handler list, after `cancel_claude_execution` (line 219):

```rust
            send_session_input,
```

- [ ] **Step 3: Add the API method in api.ts**

Add after `cancelClaudeExecution` in the api object:

```typescript
  /**
   * Send input to a running Claude Code session via stdin
   */
  async sendSessionInput(sessionId: string, input: string): Promise<void> {
    return apiCall("send_session_input", { sessionId, input });
  },
```

- [ ] **Step 4: Add endpoint mapping in apiAdapter.ts**

Add to the `commandToEndpoint` map:

```typescript
    'send_session_input': '/api/sessions/{sessionId}/input',
```

- [ ] **Step 5: Build to verify**

Run: `cargo build --bin greychrist && npm run build`
Expected: Both compile successfully

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/commands/claude.rs src-tauri/src/main.rs src/lib/api.ts src/lib/apiAdapter.ts
git commit -m "feat: add send_session_input command for two-way Claude communication

Allows the frontend to write to a running Claude process's stdin,
enabling permission responses and interactive input."
```

---

### Task 4: Remove --dangerously-skip-permissions

**Files:**
- Modify: `src-tauri/src/commands/claude.rs:1087-1096, 1128-1138, 1172-1183`

- [ ] **Step 1: Remove the flag from execute_claude_code**

In `execute_claude_code` (line 1095), remove the `--dangerously-skip-permissions` line from the args vec:

```rust
    let args = vec![
        "-p".to_string(),
        prompt.clone(),
        "--model".to_string(),
        model.clone(),
        "--output-format".to_string(),
        "stream-json".to_string(),
        "--verbose".to_string(),
    ];
```

- [ ] **Step 2: Remove the flag from continue_claude_code**

In `continue_claude_code` (line 1138), remove `--dangerously-skip-permissions`:

```rust
    let args = vec![
        "-c".to_string(),
        "-p".to_string(),
        prompt.clone(),
        "--model".to_string(),
        model.clone(),
        "--output-format".to_string(),
        "stream-json".to_string(),
        "--verbose".to_string(),
    ];
```

- [ ] **Step 3: Remove the flag from resume_claude_code**

In `resume_claude_code` (line 1183), remove `--dangerously-skip-permissions`:

```rust
    let args = vec![
        "--resume".to_string(),
        session_id.clone(),
        "-p".to_string(),
        prompt.clone(),
        "--model".to_string(),
        model.clone(),
        "--output-format".to_string(),
        "stream-json".to_string(),
        "--verbose".to_string(),
    ];
```

- [ ] **Step 4: Build to verify**

Run: `cargo build --bin greychrist`
Expected: Compiles successfully

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/commands/claude.rs
git commit -m "fix: remove --dangerously-skip-permissions from Claude sessions

Users now get the same permission control as the terminal. The
frontend will handle permission prompts via the stdin pipe."
```

---

### Task 5: Add PermissionPrompt Component

**Files:**
- Create: `src/components/PermissionPrompt.tsx`
- Modify: `src/components/ClaudeCodeSession.tsx` (integrate component)

- [ ] **Step 1: Create the PermissionPrompt component**

Create `src/components/PermissionPrompt.tsx`:

```typescript
import React, { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  ChevronDown,
  ChevronUp,
  Shield,
  ShieldCheck,
  ShieldX,
  Terminal,
  FileEdit,
  FolderOpen,
  Search,
  Eye,
} from "lucide-react";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";

const TOOL_ICONS: Record<string, React.ElementType> = {
  Bash: Terminal,
  Edit: FileEdit,
  MultiEdit: FileEdit,
  Write: FileEdit,
  Read: Eye,
  Glob: FolderOpen,
  Grep: Search,
};

interface PermissionPromptProps {
  sessionId: string;
  toolName: string;
  toolInput: Record<string, any>;
  autoAllowedTools: Set<string>;
  onAutoAllow: (toolName: string) => void;
  onResponded: () => void;
}

export function PermissionPrompt({
  sessionId,
  toolName,
  toolInput,
  autoAllowedTools,
  onAutoAllow,
  onResponded,
}: PermissionPromptProps) {
  const [expanded, setExpanded] = useState(true);
  const [responding, setResponding] = useState(false);
  const [textInput, setTextInput] = useState("");

  const Icon = TOOL_ICONS[toolName] || Shield;

  const sendResponse = async (response: string) => {
    setResponding(true);
    try {
      await api.sendSessionInput(sessionId, response);
      onResponded();
    } catch (err) {
      console.error("Failed to send permission response:", err);
    } finally {
      setResponding(false);
    }
  };

  const handleAllow = () => sendResponse("y");
  const handleDeny = () => sendResponse("n");
  const handleAlwaysAllow = () => {
    onAutoAllow(toolName);
    sendResponse("y");
  };
  const handleTextSubmit = () => {
    if (textInput.trim()) {
      sendResponse(textInput.trim());
      setTextInput("");
    }
  };

  // Format tool arguments for display
  const formatArgs = () => {
    if (toolInput.command) return toolInput.command;
    if (toolInput.file_path) return toolInput.file_path;
    if (toolInput.pattern) return toolInput.pattern;
    return JSON.stringify(toolInput, null, 2);
  };

  return (
    <div className="border border-yellow-500/30 bg-yellow-500/5 rounded-lg p-4 my-2">
      <div className="flex items-center gap-2 mb-2">
        <Shield className="w-4 h-4 text-yellow-500" />
        <span className="text-sm font-medium text-yellow-500">Permission Required</span>
      </div>

      <div className="flex items-center gap-2 mb-3">
        <Icon className="w-5 h-5 text-foreground/70" />
        <span className="font-mono text-sm font-semibold">{toolName}</span>
        <button
          onClick={() => setExpanded(!expanded)}
          className="ml-auto text-foreground/50 hover:text-foreground/80"
        >
          {expanded ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
        </button>
      </div>

      {expanded && (
        <pre className="text-xs font-mono bg-black/20 rounded p-3 mb-3 overflow-x-auto max-h-60 overflow-y-auto whitespace-pre-wrap break-all">
          {formatArgs()}
        </pre>
      )}

      <div className="flex items-center gap-2">
        <Button
          size="sm"
          variant="default"
          onClick={handleAllow}
          disabled={responding}
          className="bg-green-600 hover:bg-green-700 text-white"
        >
          <ShieldCheck className="w-3 h-3 mr-1" />
          Allow
        </Button>
        <Button
          size="sm"
          variant="destructive"
          onClick={handleDeny}
          disabled={responding}
        >
          <ShieldX className="w-3 h-3 mr-1" />
          Deny
        </Button>
        {!autoAllowedTools.has(toolName) && (
          <Button
            size="sm"
            variant="outline"
            onClick={handleAlwaysAllow}
            disabled={responding}
            className="text-xs"
          >
            Always Allow ({toolName})
          </Button>
        )}
      </div>

      {/* Text input fallback for non-permission prompts */}
      <div className="flex items-center gap-2 mt-2">
        <Input
          value={textInput}
          onChange={(e) => setTextInput(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && handleTextSubmit()}
          placeholder="Or type a response..."
          className="text-sm h-8"
          disabled={responding}
        />
        <Button
          size="sm"
          variant="outline"
          onClick={handleTextSubmit}
          disabled={responding || !textInput.trim()}
          className="h-8"
        >
          Send
        </Button>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Integrate PermissionPrompt into ClaudeCodeSession**

In `ClaudeCodeSession.tsx`, add import:

```typescript
import { PermissionPrompt } from "./PermissionPrompt";
```

Add state for permission tracking (near other state declarations):

```typescript
const [waitingForPermission, setWaitingForPermission] = useState(false);
const [pendingToolUse, setPendingToolUse] = useState<{ name: string; input: Record<string, any> } | null>(null);
const [autoAllowedTools, setAutoAllowedTools] = useState<Set<string>>(new Set());
```

In `handleStreamMessage`, after parsing the message, add permission detection:

```typescript
    // Detect permission prompt (tool_use with stop_reason)
    if (message.type === 'assistant' && message.stop_reason === 'tool_use') {
      const toolUses = message.message?.content?.filter((c: any) => c.type === 'tool_use') || [];
      if (toolUses.length > 0) {
        const lastTool = toolUses[toolUses.length - 1];
        // Check auto-allow
        if (autoAllowedTools.has(lastTool.name)) {
          // Auto-approve
          if (claudeSessionId) {
            api.sendSessionInput(claudeSessionId, 'y').catch(console.error);
          }
        } else {
          setPendingToolUse({ name: lastTool.name, input: lastTool.input || {} });
          setWaitingForPermission(true);
        }
      }
    }
```

In the JSX, render the PermissionPrompt at the bottom of the message list (above the prompt input):

```typescript
{waitingForPermission && pendingToolUse && claudeSessionId && (
  <PermissionPrompt
    sessionId={claudeSessionId}
    toolName={pendingToolUse.name}
    toolInput={pendingToolUse.input}
    autoAllowedTools={autoAllowedTools}
    onAutoAllow={(tool) => setAutoAllowedTools(prev => new Set([...prev, tool]))}
    onResponded={() => {
      setWaitingForPermission(false);
      setPendingToolUse(null);
    }}
  />
)}
```

- [ ] **Step 3: Build to verify**

Run: `npm run build`
Expected: Compiles successfully

- [ ] **Step 4: Commit**

```bash
git add src/components/PermissionPrompt.tsx src/components/ClaudeCodeSession.tsx
git commit -m "feat: add interactive permission prompt for tool use approval

Detects tool_use messages in the stream and renders approve/deny
buttons. Supports auto-allow per tool per session."
```

---

### Task 6: Add Account Resolution Explanation

**Files:**
- Modify: `src-tauri/src/accounts/mod.rs`
- Modify: `src-tauri/src/commands/accounts.rs`
- Modify: `src-tauri/src/main.rs`
- Modify: `src/lib/api.ts`
- Modify: `src/lib/apiAdapter.ts`

- [ ] **Step 1: Write a test for resolve_with_explanation**

Add to the existing test module in `src-tauri/src/accounts/mod.rs`:

```rust
    #[test]
    fn test_resolve_with_explanation_path_rule() {
        let conn = setup_test_db();
        let mgr = AccountManager::new(conn);

        let personal = mgr
            .create_account("personal", "/home/user/.claude-personal", false, "pro")
            .unwrap();
        mgr.add_path_rule(personal.id, "/home/user/repos/personal/", 0)
            .unwrap();

        let (account, match_type, match_detail) = mgr
            .resolve_with_explanation("/home/user/repos/personal/my-project")
            .unwrap()
            .unwrap();
        assert_eq!(account.name, "personal");
        assert_eq!(match_type, "path_rule");
        assert!(match_detail.contains("/home/user/repos/personal/"));
    }

    #[test]
    fn test_resolve_with_explanation_override() {
        let conn = setup_test_db();
        let mgr = AccountManager::new(conn);

        let work = mgr
            .create_account("work", "/home/user/.claude-work", false, "enterprise")
            .unwrap();
        mgr.set_project_override("/home/user/special", work.id)
            .unwrap();

        let (account, match_type, _detail) = mgr
            .resolve_with_explanation("/home/user/special")
            .unwrap()
            .unwrap();
        assert_eq!(account.name, "work");
        assert_eq!(match_type, "project_override");
    }

    #[test]
    fn test_resolve_with_explanation_default() {
        let conn = setup_test_db();
        let mgr = AccountManager::new(conn);

        let _personal = mgr
            .create_account("personal", "/home/user/.claude-personal", true, "pro")
            .unwrap();

        let (account, match_type, _detail) = mgr
            .resolve_with_explanation("/some/random/path")
            .unwrap()
            .unwrap();
        assert_eq!(account.name, "personal");
        assert_eq!(match_type, "default");
    }
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test --bin greychrist resolve_with_explanation`
Expected: FAIL — method not defined

- [ ] **Step 3: Implement resolve_with_explanation**

Add after the `resolve` method in `src-tauri/src/accounts/mod.rs`:

```rust
    /// Resolve which account a project path belongs to, with explanation.
    /// Returns (Account, match_type, match_detail) or None if no match.
    pub fn resolve_with_explanation(
        &self,
        project_path: &str,
    ) -> Result<Option<(Account, String, String)>> {
        let conn = self.db.lock().map_err(|e| anyhow::anyhow!("{}", e))?;

        // 1. Check explicit project override
        let override_result: Option<Account> = conn
            .query_row(
                "SELECT a.id, a.name, a.config_dir, a.is_default, a.account_type, a.created_at, a.updated_at
                 FROM project_account_overrides o
                 JOIN accounts a ON a.id = o.account_id
                 WHERE o.project_path = ?1",
                params![project_path],
                |row| {
                    Ok(Account {
                        id: row.get(0)?,
                        name: row.get(1)?,
                        config_dir: row.get(2)?,
                        is_default: row.get(3)?,
                        account_type: row.get(4)?,
                        created_at: row.get(5)?,
                        updated_at: row.get(6)?,
                    })
                },
            )
            .ok();

        if let Some(account) = override_result {
            let detail = format!("Explicit override for {}", project_path);
            return Ok(Some((account, "project_override".to_string(), detail)));
        }

        // 2. Check path prefix rules
        let mut stmt = conn.prepare(
            "SELECT a.id, a.name, a.config_dir, a.is_default, a.account_type, a.created_at, a.updated_at, r.path_prefix
             FROM account_path_rules r
             JOIN accounts a ON a.id = r.account_id
             ORDER BY LENGTH(r.path_prefix) DESC, r.priority DESC",
        )?;

        let accounts: Vec<(Account, String)> = stmt
            .query_map([], |row| {
                Ok((
                    Account {
                        id: row.get(0)?,
                        name: row.get(1)?,
                        config_dir: row.get(2)?,
                        is_default: row.get(3)?,
                        account_type: row.get(4)?,
                        created_at: row.get(5)?,
                        updated_at: row.get(6)?,
                    },
                    row.get::<_, String>(7)?,
                ))
            })?
            .filter_map(|r| r.ok())
            .collect();

        for (account, prefix) in accounts {
            if project_path.starts_with(&prefix) {
                let detail = format!("{} -> {}", prefix, account.name);
                return Ok(Some((account, "path_rule".to_string(), detail)));
            }
        }

        // 3. Check default account
        let default_result: Option<Account> = conn
            .query_row(
                "SELECT id, name, config_dir, is_default, account_type, created_at, updated_at
                 FROM accounts WHERE is_default = 1 LIMIT 1",
                [],
                |row| {
                    Ok(Account {
                        id: row.get(0)?,
                        name: row.get(1)?,
                        config_dir: row.get(2)?,
                        is_default: row.get(3)?,
                        account_type: row.get(4)?,
                        created_at: row.get(5)?,
                        updated_at: row.get(6)?,
                    })
                },
            )
            .ok();

        if let Some(account) = default_result {
            let detail = format!("Default account: {}", account.name);
            return Ok(Some((account, "default".to_string(), detail)));
        }

        Ok(None)
    }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cargo test --bin greychrist resolve_with_explanation`
Expected: All 3 tests PASS

- [ ] **Step 5: Add the Tauri command**

Add to `src-tauri/src/commands/accounts.rs`:

```rust
#[derive(serde::Serialize)]
pub struct AccountResolution {
    pub account: crate::accounts::Account,
    pub match_type: String,
    pub match_detail: String,
}

#[tauri::command]
pub async fn explain_account_resolution(
    account_state: tauri::State<'_, crate::accounts::AccountManagerState>,
    project_path: String,
) -> Result<Option<AccountResolution>, String> {
    account_state
        .0
        .resolve_with_explanation(&project_path)
        .map(|opt| {
            opt.map(|(account, match_type, match_detail)| AccountResolution {
                account,
                match_type,
                match_detail,
            })
        })
        .map_err(|e| e.to_string())
}
```

- [ ] **Step 6: Register the command in main.rs**

Add `commands::accounts::explain_account_resolution` to the invoke_handler list, after `discover_accounts` (line 318).

- [ ] **Step 7: Add the API method and endpoint mapping**

In `src/lib/api.ts`, add after `discoverAccounts`:

```typescript
  /**
   * Resolve account for a project path with explanation of why it matched
   */
  async explainAccountResolution(projectPath: string): Promise<{
    account: Account;
    match_type: string;
    match_detail: string;
  } | null> {
    return apiCall("explain_account_resolution", { projectPath });
  },
```

In `src/lib/apiAdapter.ts`, add to the endpoint map:

```typescript
    'explain_account_resolution': '/api/accounts/resolve/explain',
```

- [ ] **Step 8: Build and test**

Run: `cargo test --bin greychrist && cargo build --bin greychrist && npm run build`
Expected: All pass

- [ ] **Step 9: Commit**

```bash
git add src-tauri/src/accounts/mod.rs src-tauri/src/commands/accounts.rs src-tauri/src/main.rs src/lib/api.ts src/lib/apiAdapter.ts
git commit -m "feat: add explain_account_resolution for account match transparency

Returns the matched account plus how it was matched (project_override,
path_rule, or default) and the specific rule detail."
```

---

### Task 7: Add SessionHeader Component

**Files:**
- Create: `src/components/SessionHeader.tsx`
- Modify: `src/components/ClaudeCodeSession.tsx`

- [ ] **Step 1: Create SessionHeader component**

Create `src/components/SessionHeader.tsx`:

```typescript
import React from "react";
import { AccountBadge } from "./AccountBadge";
import { Copy, MapPin, Info } from "lucide-react";
import { cn } from "@/lib/utils";

interface SessionHeaderProps {
  accountName: string;
  accountType: string;
  configDir: string;
  matchType: string;
  matchDetail: string;
  sessionId: string | null;
  cost: number;
  className?: string;
}

export function SessionHeader({
  accountName,
  accountType,
  configDir,
  matchType,
  matchDetail,
  sessionId,
  cost,
  className,
}: SessionHeaderProps) {
  const copySessionId = () => {
    if (sessionId) {
      navigator.clipboard.writeText(sessionId);
    }
  };

  const matchLabel = matchType === "path_rule"
    ? "path rule"
    : matchType === "project_override"
    ? "project override"
    : "default";

  const showCost = accountType !== "max";

  return (
    <div className={cn(
      "flex items-center gap-3 px-4 py-2 border-b border-border/50 bg-background/50 text-xs shrink-0",
      className
    )}>
      <AccountBadge name={accountName} />
      <span className="text-foreground/50 uppercase tracking-wide">{accountType}</span>

      <div className="flex items-center gap-1 text-foreground/40" title={configDir}>
        <MapPin className="w-3 h-3" />
        <span className="truncate max-w-[200px] font-mono">{configDir.replace(/^\/Users\/[^/]+/, '~')}</span>
      </div>

      <div className="flex items-center gap-1 text-foreground/40" title={matchDetail}>
        <Info className="w-3 h-3" />
        <span>Matched by: {matchLabel}</span>
      </div>

      <div className="ml-auto flex items-center gap-3">
        {showCost && (
          <span className="text-foreground/50 font-mono">
            ${cost.toFixed(4)}
          </span>
        )}
        {sessionId && (
          <button
            onClick={copySessionId}
            className="flex items-center gap-1 text-foreground/30 hover:text-foreground/60 transition-colors"
            title="Copy session ID"
          >
            <span className="font-mono truncate max-w-[80px]">{sessionId.slice(0, 8)}</span>
            <Copy className="w-3 h-3" />
          </button>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Integrate SessionHeader into ClaudeCodeSession**

Add import:
```typescript
import { SessionHeader } from "./SessionHeader";
```

Add state for account resolution:
```typescript
const [accountResolution, setAccountResolution] = useState<{
  account: { name: string; account_type: string; config_dir: string };
  match_type: string;
  match_detail: string;
} | null>(null);
const [sessionCost, setSessionCost] = useState(0);
```

Add an effect to resolve the account when the component mounts:
```typescript
useEffect(() => {
  if (projectPath) {
    api.explainAccountResolution(projectPath).then((result) => {
      if (result) {
        setAccountResolution(result);
      }
    }).catch(console.error);
  }
}, [projectPath]);
```

Track cost from usage messages in `handleStreamMessage`:
```typescript
    // Track cost from usage data
    if (message.usage || message.message?.usage) {
      const usage = message.usage || message.message?.usage;
      if (usage) {
        // Approximate cost: $3/M input, $15/M output for Sonnet; $15/M input, $75/M output for Opus
        const inputCost = (usage.input_tokens || 0) * 0.000003;
        const outputCost = (usage.output_tokens || 0) * 0.000015;
        setSessionCost(prev => prev + inputCost + outputCost);
      }
    }
```

Render the header at the top of the session layout (before the messages list):
```typescript
{accountResolution && (
  <SessionHeader
    accountName={accountResolution.account.name}
    accountType={accountResolution.account.account_type}
    configDir={accountResolution.account.config_dir}
    matchType={accountResolution.match_type}
    matchDetail={accountResolution.match_detail}
    sessionId={claudeSessionId}
    cost={sessionCost}
  />
)}
```

- [ ] **Step 3: Build to verify**

Run: `npm run build`
Expected: Compiles successfully

- [ ] **Step 4: Commit**

```bash
git add src/components/SessionHeader.tsx src/components/ClaudeCodeSession.tsx
git commit -m "feat: add always-visible session header with account info and cost

Shows account name, type, config directory, match reason, live cost,
and copyable session ID at the top of every session."
```

---

### Task 8: Add Session Start Confirmation

**Files:**
- Modify: `src/components/ClaudeCodeSession.tsx`

- [ ] **Step 1: Add confirmation state**

Add state variables near other session state:

```typescript
const [showStartConfirmation, setShowStartConfirmation] = useState(false);
const [startConfirmationResolved, setStartConfirmationResolved] = useState(false);
```

- [ ] **Step 2: Add confirmation check before spawning**

In `handleSendPrompt`, before the `execute_claude_code` call (around line 893), add a confirmation gate for the first prompt in a new session:

```typescript
        // Show confirmation for first prompt in a new session
        if (!effectiveSession && isFirstPrompt && !startConfirmationResolved) {
          setShowStartConfirmation(true);
          return; // Don't spawn yet — wait for user confirmation
        }
```

- [ ] **Step 3: Add confirmation UI**

Add JSX before the message list:

```typescript
{showStartConfirmation && accountResolution && (
  <div className="border border-border/50 rounded-lg p-4 m-4 bg-background/80">
    <h3 className="text-sm font-medium mb-2">Confirm Session</h3>
    <div className="space-y-1 text-sm text-foreground/70 mb-3">
      <div className="flex items-center gap-2">
        <span className="text-foreground/40 w-20">Project:</span>
        <span className="font-mono text-xs">{projectPath}</span>
      </div>
      <div className="flex items-center gap-2">
        <span className="text-foreground/40 w-20">Account:</span>
        <AccountBadge name={accountResolution.account.name} />
        <span className="text-foreground/50 text-xs">({accountResolution.account.account_type})</span>
      </div>
      <div className="flex items-center gap-2">
        <span className="text-foreground/40 w-20">Config:</span>
        <span className="font-mono text-xs text-foreground/50">{accountResolution.account.config_dir}</span>
      </div>
      <div className="flex items-center gap-2">
        <span className="text-foreground/40 w-20">Matched by:</span>
        <span className="text-xs">{accountResolution.match_type === 'path_rule' ? 'Path rule' : accountResolution.match_type === 'project_override' ? 'Project override' : 'Default account'} — {accountResolution.match_detail}</span>
      </div>
    </div>
    <div className="flex items-center gap-2">
      <Button
        size="sm"
        onClick={() => {
          setShowStartConfirmation(false);
          setStartConfirmationResolved(true);
          // Re-trigger the prompt send
          handleSendPrompt(messages[messages.length - 1]?.message?.content?.[0]?.text || '', 'sonnet');
        }}
      >
        Start Session
      </Button>
      <Button size="sm" variant="outline" onClick={() => {
        setShowStartConfirmation(false);
        setIsLoading(false);
      }}>
        Cancel
      </Button>
    </div>
  </div>
)}
```

- [ ] **Step 4: Build to verify**

Run: `npm run build`
Expected: Compiles successfully

- [ ] **Step 5: Commit**

```bash
git add src/components/ClaudeCodeSession.tsx
git commit -m "feat: add session start confirmation showing account and match reason

Before spawning a new session, shows which account was resolved,
how it was matched, and the config directory for verification."
```

---

### Task 9: Enhance User Message Styling

**Files:**
- Modify: `src/components/StreamMessage.tsx`

- [ ] **Step 1: Read the current StreamMessage component to find user message rendering**

Read the StreamMessage component fully to identify where user messages are rendered and what the current structure looks like. Look for conditions on `message.type === 'user'` or the user message rendering section.

- [ ] **Step 2: Add distinct user message styling**

Find the section that renders user messages and wrap it with a distinct visual container. The exact change depends on the current structure, but the pattern should be:

```typescript
// For user messages (non-tool-result content)
{message.type === 'user' && hasTextContent && (
  <div className="border-l-2 border-blue-500/50 bg-blue-500/5 rounded-r-lg pl-4 pr-3 py-3 my-3">
    <div className="flex items-center gap-2 mb-1">
      <span className="text-xs font-medium text-blue-400/80">You</span>
      {/* Model tag if available */}
    </div>
    {/* existing text content rendering */}
  </div>
)}
```

The key visual changes:
- Left accent border in a distinct color (blue)
- Subtle background tint
- "You" label at the top
- Padding and margin that creates visual separation from assistant content

- [ ] **Step 3: Build to verify**

Run: `npm run build`
Expected: Compiles successfully

- [ ] **Step 4: Commit**

```bash
git add src/components/StreamMessage.tsx
git commit -m "feat: add distinct visual styling for user messages

User messages now have a colored left border, 'You' label, and
subtle background tint to serve as visual landmarks in the session."
```

---

### Task 10: Add Test Resolution and Overrides to AccountSettings

**Files:**
- Modify: `src/components/AccountSettings.tsx`

- [ ] **Step 1: Read current AccountSettings component**

Read `src/components/AccountSettings.tsx` fully to understand the current layout and where to add the test resolution input.

- [ ] **Step 2: Add test resolution section**

Add a new section at the bottom of the AccountSettings component:

```typescript
// State for test resolution
const [testPath, setTestPath] = useState("");
const [testResult, setTestResult] = useState<{
  account: Account;
  match_type: string;
  match_detail: string;
} | null>(null);
const [testError, setTestError] = useState<string | null>(null);

const handleTestResolution = async () => {
  if (!testPath.trim()) return;
  setTestError(null);
  setTestResult(null);
  try {
    const result = await api.explainAccountResolution(testPath.trim());
    if (result) {
      setTestResult(result);
    } else {
      setTestError("No account would be resolved for this path");
    }
  } catch (err) {
    setTestError(String(err));
  }
};
```

Add the JSX section after the existing path rules section:

```typescript
<div className="mt-6">
  <h3 className="text-sm font-medium mb-2">Test Account Resolution</h3>
  <p className="text-xs text-foreground/50 mb-2">
    Enter any path to see which account would be used and why.
  </p>
  <div className="flex gap-2">
    <Input
      value={testPath}
      onChange={(e) => setTestPath(e.target.value)}
      onKeyDown={(e) => e.key === "Enter" && handleTestResolution()}
      placeholder="/Users/you/Repos/project-name"
      className="font-mono text-sm"
    />
    <Button onClick={handleTestResolution} size="sm" variant="outline">
      Test
    </Button>
  </div>
  {testResult && (
    <div className="mt-2 p-3 rounded border border-green-500/30 bg-green-500/5 text-sm">
      <div className="flex items-center gap-2">
        <AccountBadge name={testResult.account.name} />
        <span className="text-foreground/50">({testResult.account.account_type})</span>
      </div>
      <div className="text-xs text-foreground/50 mt-1">
        Matched by: <strong>{testResult.match_type}</strong> — {testResult.match_detail}
      </div>
      <div className="text-xs font-mono text-foreground/40 mt-1">
        Config: {testResult.account.config_dir}
      </div>
    </div>
  )}
  {testError && (
    <div className="mt-2 p-3 rounded border border-red-500/30 bg-red-500/5 text-sm text-red-400">
      {testError}
    </div>
  )}
</div>
```

- [ ] **Step 3: Add project overrides display**

Add a section showing existing project overrides (after path rules, before test resolution):

```typescript
// In the component, add state and data loading
const [overrides, setOverrides] = useState<ProjectOverride[]>([]);

// Load overrides alongside existing data
useEffect(() => {
  api.listProjectOverrides().then(setOverrides).catch(console.error);
}, []);

// Add JSX section
<div className="mt-4">
  <h3 className="text-sm font-medium mb-2">Project Overrides</h3>
  {overrides.length === 0 ? (
    <p className="text-xs text-foreground/50">No project overrides set.</p>
  ) : (
    <div className="space-y-1">
      {overrides.map((override) => (
        <div key={override.project_path} className="flex items-center justify-between text-sm py-1 px-2 rounded hover:bg-foreground/5">
          <span className="font-mono text-xs truncate max-w-[300px]">{override.project_path}</span>
          <div className="flex items-center gap-2">
            <AccountBadge name={override.account_name} />
            <Button
              size="sm"
              variant="ghost"
              className="h-6 w-6 p-0 text-red-400 hover:text-red-300"
              onClick={async () => {
                // Remove override by setting it to the current account (or add a delete command)
                setOverrides(prev => prev.filter(o => o.project_path !== override.project_path));
              }}
            >
              <X className="w-3 h-3" />
            </Button>
          </div>
        </div>
      ))}
    </div>
  )}
</div>
```

- [ ] **Step 4: Build to verify**

Run: `npm run build`
Expected: Compiles successfully

- [ ] **Step 5: Commit**

```bash
git add src/components/AccountSettings.tsx
git commit -m "feat: add test resolution tool and project override list to account settings

Users can now type any path and see which account would be resolved
and why. Also shows all explicit project-to-account overrides."
```

---

### Task 11: Integration Build and Smoke Test

**Files:** None (verification only)

- [ ] **Step 1: Run full Rust test suite**

Run: `cargo test --bin greychrist`
Expected: All tests pass, including new `resolve_with_explanation` tests

- [ ] **Step 2: Run full frontend build**

Run: `npm run build`
Expected: Clean build, no TypeScript errors

- [ ] **Step 3: Run cargo clippy**

Run: `cargo clippy --bin greychrist`
Expected: No warnings or errors

- [ ] **Step 4: Run cargo fmt**

Run: `cargo fmt --check`
Expected: All formatted correctly (run `cargo fmt` if needed)

- [ ] **Step 5: Manual smoke test**

Start the app with `cargo run --bin greychrist` and verify:
1. Session starts and output streams (the ESM import fix works)
2. Account badge appears in session header
3. Permission prompts appear when Claude wants to use a tool
4. Account Settings shows test resolution and project overrides
5. User messages have distinct styling

- [ ] **Step 6: Final commit with any fixups**

If any issues found during smoke testing, fix and commit. Otherwise:

```bash
git add -A
git commit -m "chore: format and fix integration issues from session redesign"
```
