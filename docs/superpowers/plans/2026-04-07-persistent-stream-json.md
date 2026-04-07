# Persistent Stream-JSON Session Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace one-shot `-p` process-per-turn with persistent bidirectional stream-json processes per tab, plus OS notifications on completion.

**Architecture:** New `SessionProcessManager` owns long-lived Claude subprocesses keyed by tab ID. Frontend calls `session_start` once, then `session_send_message` for each prompt. Notifications fire via `tauri-plugin-notification` when a non-active tab completes.

**Tech Stack:** Rust/Tokio (backend), React/TypeScript (frontend), Tauri IPC events, `@tauri-apps/plugin-notification`

---

## File Structure

### New Files
- `src-tauri/src/session_manager.rs` — `SessionProcessManager`, `ManagedSession`, all session lifecycle logic
- `src/hooks/useNotifications.ts` — Top-level hook for listening to completion events and firing OS notifications

### Modified Files
- `src-tauri/src/main.rs` — Register `SessionProcessManagerState`, notification plugin, new commands
- `src-tauri/src/commands/mod.rs` — Add `pub mod session;` (or expose from session_manager)
- `src/lib/api.ts` — Add `startSession`, `sendMessage`, `respondPermission`, `stopSession`, `getSessionInfo`
- `src/lib/apiAdapter.ts` — No changes needed (uses generic `apiCall`)
- `src/components/ClaudeCodeSession.tsx` — Rewrite prompt flow: start once, send messages via stdin, simplified listener setup
- `src/App.tsx` — Mount `useNotifications` hook

### Untouched
- `src-tauri/src/commands/agents.rs` — Agents keep `-p` mode
- `src/components/StreamMessage.tsx` — Same message types, same rendering
- `src/components/AgentExecution.tsx` — Unchanged

---

### Task 1: Create `SessionProcessManager` Backend

**Files:**
- Create: `src-tauri/src/session_manager.rs`
- Modify: `src-tauri/src/main.rs:4` (add `mod session_manager;`)

- [ ] **Step 1: Create the session manager module with types**

Create `src-tauri/src/session_manager.rs`:

```rust
use log::{debug, error, info, warn};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Arc;
use tokio::io::AsyncWriteExt;
use tokio::process::{Child, ChildStdin};
use tokio::sync::Mutex;

/// Represents a managed persistent Claude session
struct ManagedSession {
    stdin: ChildStdin,
    child: Child,
    session_id: Arc<Mutex<Option<String>>>,
    project_path: String,
    model: String,
    permission_mode: String,
    config_dir: String,
    started_at: std::time::Instant,
}

/// Thread-safe session process manager
pub struct SessionProcessManager {
    sessions: Mutex<HashMap<String, ManagedSession>>,
}

impl SessionProcessManager {
    pub fn new() -> Self {
        Self {
            sessions: Mutex::new(HashMap::new()),
        }
    }
}

/// Tauri-managed state wrapper
pub struct SessionProcessManagerState(pub Arc<SessionProcessManager>);

impl Default for SessionProcessManagerState {
    fn default() -> Self {
        Self(Arc::new(SessionProcessManager::new()))
    }
}

/// Info returned to the frontend about a session
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionInfo {
    pub tab_id: String,
    pub session_id: Option<String>,
    pub project_path: String,
    pub model: String,
    pub permission_mode: String,
    pub config_dir: String,
    pub alive: bool,
    pub uptime_secs: u64,
}
```

- [ ] **Step 2: Add module declaration to main.rs**

In `src-tauri/src/main.rs`, add after line 8 (`mod process;`):

```rust
mod session_manager;
```

- [ ] **Step 3: Verify it compiles**

Run: `~/.cargo/bin/cargo check` from `src-tauri/`
Expected: Compiles with warnings about unused code (expected at this stage)

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/session_manager.rs src-tauri/src/main.rs
git commit -m "feat: add SessionProcessManager skeleton"
```

---

### Task 2: Implement `session_start` Command

**Files:**
- Modify: `src-tauri/src/session_manager.rs`
- Modify: `src-tauri/src/main.rs`

- [ ] **Step 1: Add the `session_start` Tauri command**

Append to `src-tauri/src/session_manager.rs`:

```rust
use tauri::{AppHandle, Manager};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;
use std::process::Stdio;

/// Start a persistent Claude session for a tab
#[tauri::command]
pub async fn session_start(
    app: AppHandle,
    manager: tauri::State<'_, SessionProcessManagerState>,
    account_state: tauri::State<'_, crate::accounts::AccountManagerState>,
    tab_id: String,
    project_path: String,
    model: String,
    permission_mode: String,
    resume_session_id: Option<String>,
) -> Result<(), String> {
    info!("Starting persistent session for tab: {}", tab_id);

    // Resolve account
    let account = account_state
        .0
        .resolve(&project_path)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| {
            "No account configured for this project. Assign one in Settings > Accounts.".to_string()
        })?;

    // Find claude binary
    let claude_path = crate::claude_binary::find_claude_binary(&app)
        .map_err(|e| format!("Failed to find Claude binary: {}", e))?;

    // Build args for persistent bidirectional mode
    let mut args = vec![
        "--input-format".to_string(), "stream-json".to_string(),
        "--output-format".to_string(), "stream-json".to_string(),
        "--permission-prompt-tool".to_string(), "stdio".to_string(),
        "--verbose".to_string(),
        "--include-partial-messages".to_string(),
        "--replay-user-messages".to_string(),
        "--model".to_string(), model.clone(),
        "--permission-mode".to_string(), permission_mode.clone(),
        "--no-chrome".to_string(),
    ];

    if let Some(ref resume_id) = resume_session_id {
        args.push("--resume".to_string());
        args.push(resume_id.clone());
    }

    // Use the existing command builder for env setup
    let mut cmd = crate::commands::claude::create_command_with_env(&claude_path);
    cmd.args(&args);
    cmd.current_dir(&project_path);
    cmd.env("CLAUDE_CONFIG_DIR", &account.config_dir);
    cmd.stdin(Stdio::piped());
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());

    // Spawn
    let mut child = cmd.spawn().map_err(|e| format!("Failed to spawn Claude: {}", e))?;

    let stdout = child.stdout.take().ok_or("Failed to get stdout")?;
    let stderr = child.stderr.take().ok_or("Failed to get stderr")?;
    let stdin = child.stdin.take().ok_or("Failed to get stdin")?;

    let pid = child.id().unwrap_or(0);
    info!("Spawned persistent Claude process PID={} for tab={}", pid, tab_id);

    let session_id_holder: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));

    // Store the session
    {
        let mut sessions = manager.0.sessions.lock().await;

        // Kill existing session for this tab if any
        if let Some(mut old) = sessions.remove(&tab_id) {
            warn!("Killing existing session for tab {} before starting new one", tab_id);
            let _ = old.child.kill().await;
        }

        sessions.insert(tab_id.clone(), ManagedSession {
            stdin,
            child,
            session_id: session_id_holder.clone(),
            project_path: project_path.clone(),
            model: model.clone(),
            permission_mode: permission_mode.clone(),
            config_dir: account.config_dir.clone(),
            started_at: std::time::Instant::now(),
        });
    }

    // Register in ProcessRegistry
    let registry = app.state::<crate::process::ProcessRegistryState>();
    let registry_clone = registry.0.clone();

    // Spawn stdout reader task
    let app_stdout = app.clone();
    let tab_id_stdout = tab_id.clone();
    let session_id_stdout = session_id_holder.clone();
    let project_path_clone = project_path.clone();
    let model_clone = model.clone();
    tokio::spawn(async move {
        let mut lines = BufReader::new(stdout).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            debug!("[tab:{}] stdout: {}", tab_id_stdout, &line[..line.len().min(200)]);

            // Parse for session_id extraction and notification
            if let Ok(msg) = serde_json::from_str::<serde_json::Value>(&line) {
                // Extract session_id from system/init
                if msg["type"] == "system" && msg["subtype"] == "init" {
                    if let Some(sid) = msg["session_id"].as_str() {
                        let mut holder = session_id_stdout.lock().await;
                        if holder.is_none() {
                            *holder = Some(sid.to_string());
                            info!("[tab:{}] Session ID: {}", tab_id_stdout, sid);

                            // Register with ProcessRegistry
                            if let Err(e) = registry_clone.register_claude_session(
                                sid.to_string(), pid,
                                project_path_clone.clone(),
                                "persistent session".to_string(),
                                model_clone.clone(),
                            ) {
                                error!("Failed to register session: {}", e);
                            }
                        }
                    }
                }

                // Emit notification event on result messages
                if msg["type"] == "result" {
                    let is_error = msg["is_error"].as_bool().unwrap_or(false)
                        || msg.get("subtype").and_then(|s| s.as_str()).map_or(false, |s| s.contains("error"));
                    let body = msg["result"].as_str().unwrap_or("").chars().take(200).collect::<String>();
                    let title = if is_error { "Execution Failed" } else { "Execution Complete" };
                    let _ = app_stdout.emit("claude-notification", serde_json::json!({
                        "tab_id": tab_id_stdout,
                        "title": title,
                        "body": body,
                        "is_error": is_error,
                    }));
                }
            }

            // Emit to frontend — tab-scoped channel
            let _ = app_stdout.emit(&format!("claude-output:{}", tab_id_stdout), &line);
            // Also emit session-scoped if we have the session_id
            if let Some(ref sid) = *session_id_stdout.lock().await {
                let _ = app_stdout.emit(&format!("claude-output:{}", sid), &line);
            }
        }

        info!("[tab:{}] stdout reader ended (process exited)", tab_id_stdout);
        // Emit completion
        let _ = app_stdout.emit(&format!("claude-complete:{}", tab_id_stdout), false);
    });

    // Spawn stderr reader task
    let app_stderr = app.clone();
    let tab_id_stderr = tab_id.clone();
    tokio::spawn(async move {
        let mut lines = BufReader::new(stderr).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            // Skip ignorable messages
            if line.contains("no stdin data received") {
                continue;
            }
            debug!("[tab:{}] stderr: {}", tab_id_stderr, line);
            let _ = app_stderr.emit(&format!("claude-error:{}", tab_id_stderr), &line);
        }
    });

    Ok(())
}
```

- [ ] **Step 2: Make `create_command_with_env` public**

In `src-tauri/src/commands/claude.rs`, find the function signature (around line 311):

```rust
fn create_command_with_env(program: &str) -> Command {
```

Change to:

```rust
pub fn create_command_with_env(program: &str) -> Command {
```

- [ ] **Step 3: Register state and command in main.rs**

In `src-tauri/src/main.rs`, add the state after `SessionStdinState` (around line 165):

```rust
app.manage(session_manager::SessionProcessManagerState::default());
```

Add to the `invoke_handler` list (after the slash commands section, around line 306):

```rust
// Persistent Sessions
session_manager::session_start,
```

- [ ] **Step 4: Verify it compiles**

Run: `~/.cargo/bin/cargo check` from `src-tauri/`
Expected: Compiles (warnings about unused session commands are fine)

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/session_manager.rs src-tauri/src/commands/claude.rs src-tauri/src/main.rs
git commit -m "feat: implement session_start with persistent process spawning"
```

---

### Task 3: Implement `session_send_message`, `session_respond_permission`, `session_stop`, `session_get_info`

**Files:**
- Modify: `src-tauri/src/session_manager.rs`
- Modify: `src-tauri/src/main.rs`

- [ ] **Step 1: Add the remaining commands to session_manager.rs**

Append to `src-tauri/src/session_manager.rs`:

```rust
/// Send a user message to a persistent session
#[tauri::command]
pub async fn session_send_message(
    manager: tauri::State<'_, SessionProcessManagerState>,
    tab_id: String,
    prompt: String,
) -> Result<(), String> {
    info!("[tab:{}] Sending message: {}...", tab_id, &prompt[..prompt.len().min(80)]);

    let mut sessions = manager.0.sessions.lock().await;
    let session = sessions.get_mut(&tab_id)
        .ok_or_else(|| format!("No active session for tab {}", tab_id))?;

    let session_id = session.session_id.lock().await.clone().unwrap_or_default();

    let msg = serde_json::json!({
        "type": "user",
        "message": {
            "role": "user",
            "content": prompt
        },
        "session_id": session_id,
        "parent_tool_use_id": null
    });

    let line = format!("{}\n", serde_json::to_string(&msg).map_err(|e| e.to_string())?);
    session.stdin.write_all(line.as_bytes()).await.map_err(|e| format!("Failed to write to stdin: {}", e))?;
    session.stdin.flush().await.map_err(|e| format!("Failed to flush stdin: {}", e))?;

    Ok(())
}

/// Respond to a permission request in a persistent session
#[tauri::command]
pub async fn session_respond_permission(
    manager: tauri::State<'_, SessionProcessManagerState>,
    tab_id: String,
    request_id: String,
    behavior: String,
    updated_input: Option<serde_json::Value>,
) -> Result<(), String> {
    info!("[tab:{}] Permission response: {} for request {}", tab_id, behavior, request_id);

    let mut sessions = manager.0.sessions.lock().await;
    let session = sessions.get_mut(&tab_id)
        .ok_or_else(|| format!("No active session for tab {}", tab_id))?;

    let msg = serde_json::json!({
        "type": "control_response",
        "response": {
            "subtype": "success",
            "request_id": request_id,
            "response": {
                "behavior": behavior,
                "updatedInput": updated_input.unwrap_or(serde_json::Value::Null)
            }
        }
    });

    let line = format!("{}\n", serde_json::to_string(&msg).map_err(|e| e.to_string())?);
    session.stdin.write_all(line.as_bytes()).await.map_err(|e| format!("Failed to write to stdin: {}", e))?;
    session.stdin.flush().await.map_err(|e| format!("Failed to flush stdin: {}", e))?;

    Ok(())
}

/// Stop a persistent session
#[tauri::command]
pub async fn session_stop(
    manager: tauri::State<'_, SessionProcessManagerState>,
    tab_id: String,
) -> Result<(), String> {
    info!("[tab:{}] Stopping session", tab_id);

    let mut sessions = manager.0.sessions.lock().await;
    if let Some(mut session) = sessions.remove(&tab_id) {
        // Drop stdin to signal EOF
        drop(session.stdin);

        // Give the process a few seconds to exit gracefully
        let kill_result = tokio::time::timeout(
            tokio::time::Duration::from_secs(5),
            session.child.wait()
        ).await;

        match kill_result {
            Ok(Ok(status)) => {
                info!("[tab:{}] Process exited gracefully: {}", tab_id, status);
            }
            _ => {
                warn!("[tab:{}] Process did not exit in time, killing", tab_id);
                let _ = session.child.kill().await;
            }
        }
        Ok(())
    } else {
        debug!("[tab:{}] No active session to stop", tab_id);
        Ok(()) // Not an error — tab may not have started a session
    }
}

/// Get info about a persistent session
#[tauri::command]
pub async fn session_get_info(
    manager: tauri::State<'_, SessionProcessManagerState>,
    tab_id: String,
) -> Result<Option<SessionInfo>, String> {
    let sessions = manager.0.sessions.lock().await;
    if let Some(session) = sessions.get(&tab_id) {
        let session_id = session.session_id.lock().await.clone();
        Ok(Some(SessionInfo {
            tab_id: tab_id.clone(),
            session_id,
            project_path: session.project_path.clone(),
            model: session.model.clone(),
            permission_mode: session.permission_mode.clone(),
            config_dir: session.config_dir.clone(),
            alive: true, // If it's in the map, the process was alive when stored
            uptime_secs: session.started_at.elapsed().as_secs(),
        }))
    } else {
        Ok(None)
    }
}
```

- [ ] **Step 2: Register all new commands in main.rs**

Replace the `// Persistent Sessions` line in `invoke_handler` with:

```rust
// Persistent Sessions
session_manager::session_start,
session_manager::session_send_message,
session_manager::session_respond_permission,
session_manager::session_stop,
session_manager::session_get_info,
```

- [ ] **Step 3: Verify it compiles**

Run: `~/.cargo/bin/cargo check` from `src-tauri/`
Expected: Compiles

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/session_manager.rs src-tauri/src/main.rs
git commit -m "feat: add session_send_message, session_respond_permission, session_stop, session_get_info"
```

---

### Task 4: Add Frontend API Methods

**Files:**
- Modify: `src/lib/api.ts`

- [ ] **Step 1: Add the new session API methods**

Add after the `sendSessionInput` method (around line 1110) in `src/lib/api.ts`:

```typescript
  // ─── Persistent Session API ───────────────────────────────────────

  /**
   * Start a persistent Claude session for a tab
   */
  async startSession(tabId: string, projectPath: string, model: string, permissionMode: string, resumeSessionId?: string): Promise<void> {
    return apiCall("session_start", { tabId, projectPath, model, permissionMode, resumeSessionId });
  },

  /**
   * Send a user message to a persistent session
   */
  async sendMessage(tabId: string, prompt: string): Promise<void> {
    return apiCall("session_send_message", { tabId, prompt });
  },

  /**
   * Respond to a permission request in a persistent session
   */
  async respondPermission(tabId: string, requestId: string, behavior: string, updatedInput?: any): Promise<void> {
    return apiCall("session_respond_permission", { tabId, requestId, behavior, updatedInput });
  },

  /**
   * Stop a persistent session (kills the process)
   */
  async stopSession(tabId: string): Promise<void> {
    return apiCall("session_stop", { tabId });
  },

  /**
   * Get info about a persistent session
   */
  async getSessionInfo(tabId: string): Promise<any | null> {
    return apiCall("session_get_info", { tabId });
  },
```

- [ ] **Step 2: Verify frontend compiles**

Run: `npm run build`
Expected: Build succeeds

- [ ] **Step 3: Commit**

```bash
git add src/lib/api.ts
git commit -m "feat: add persistent session API methods to frontend"
```

---

### Task 5: Register Notification Plugin

**Files:**
- Modify: `src-tauri/src/main.rs`

- [ ] **Step 1: Add notification plugin to Tauri builder**

In `src-tauri/src/main.rs`, find the `.plugin(tauri_plugin_shell::init())` line (around line 61) and add after it:

```rust
        .plugin(tauri_plugin_notification::init())
```

- [ ] **Step 2: Verify it compiles**

Run: `~/.cargo/bin/cargo check` from `src-tauri/`
Expected: Compiles

- [ ] **Step 3: Commit**

```bash
git add src-tauri/src/main.rs
git commit -m "feat: register tauri notification plugin"
```

---

### Task 6: Create `useNotifications` Hook

**Files:**
- Create: `src/hooks/useNotifications.ts`
- Modify: `src/App.tsx`

- [ ] **Step 1: Create the notifications hook**

Create `src/hooks/useNotifications.ts`:

```typescript
import { useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification";
import { getCurrentWindow } from "@tauri-apps/api/window";

interface NotificationPayload {
  tab_id: string;
  title: string;
  body: string;
  is_error: boolean;
}

/**
 * Listens for claude-notification events and fires OS notifications
 * when the completed tab is not the currently active tab.
 */
export function useNotifications(
  activeTabId: string | null,
  setActiveTabId: (id: string) => void
) {
  useEffect(() => {
    let unlisten: (() => void) | null = null;

    async function setup() {
      // Request permission if not granted
      let granted = await isPermissionGranted();
      if (!granted) {
        const result = await requestPermission();
        granted = result === "granted";
      }
      if (!granted) return;

      unlisten = await listen<NotificationPayload>("claude-notification", (event) => {
        const { tab_id, title, body } = event.payload;

        // Only notify for non-active tabs
        if (tab_id === activeTabId) return;

        sendNotification({ title, body });

        // Note: Tauri notifications don't support click callbacks directly.
        // Instead, when the user clicks the notification the app window comes to front.
        // We'll also switch to that tab proactively since the notification just fired.
        // A small delay ensures the window focus event completes first.
        setTimeout(() => {
          setActiveTabId(tab_id);
          getCurrentWindow().setFocus().catch(() => {});
        }, 100);
      });
    }

    setup().catch(console.error);

    return () => {
      if (unlisten) unlisten();
    };
  }, [activeTabId, setActiveTabId]);
}
```

- [ ] **Step 2: Install the notification JS package**

Run: `npm install @tauri-apps/plugin-notification`

- [ ] **Step 3: Mount the hook in App.tsx**

Find where the `TabProvider` renders content in `src/App.tsx`. Inside the component that has access to `activeTabId` and `setActiveTabId` from `TabContext`, add:

```typescript
import { useNotifications } from "@/hooks/useNotifications";

// Inside the component body:
useNotifications(activeTabId, setActiveTabId);
```

If `App.tsx` doesn't directly access tab context, create a small wrapper component inside it:

```typescript
function NotificationBridge() {
  const { activeTabId, setActiveTabId } = useTabContext();
  useNotifications(activeTabId, setActiveTabId);
  return null;
}
```

And render `<NotificationBridge />` inside the `<TabProvider>`.

- [ ] **Step 4: Verify frontend compiles**

Run: `npm run build`
Expected: Build succeeds

- [ ] **Step 5: Commit**

```bash
git add src/hooks/useNotifications.ts src/App.tsx package.json package-lock.json
git commit -m "feat: add OS notifications for session completion on non-active tabs"
```

---

### Task 7: Rewrite `ClaudeCodeSession.tsx` to Use Persistent Sessions

This is the largest task. The component switches from spawning a process per prompt to managing a single persistent connection.

**Files:**
- Modify: `src/components/ClaudeCodeSession.tsx`

- [ ] **Step 1: Replace the `handleSendPrompt` function**

The current function (~line 496-935) contains listener setup, process spawning, checkpoint logic, and metric tracking on every prompt. Replace it with a two-phase approach:

**Phase A — Session start (runs once, on first prompt or "Start Session" click):**

Replace the `if (!isListeningRef.current)` block and everything inside it. The new flow:

```typescript
const startPersistentSession = async (resumeId?: string) => {
  if (hasActiveSessionRef.current) return;

  const tabId = tabIdRef.current;
  if (!tabId || !projectPath) return;

  try {
    hasActiveSessionRef.current = true;

    // Set up event listeners ONCE for this tab
    const outputUnlisten = await listen(`claude-output:${tabId}`, (evt: any) => {
      handleStreamMessage(evt.payload);
    });

    const errorUnlisten = await listen(`claude-error:${tabId}`, (evt: any) => {
      console.error('[ClaudeCodeSession] stderr:', evt.payload);
      setError(evt.payload);
    });

    const completeUnlisten = await listen(`claude-complete:${tabId}`, (_evt: any) => {
      console.log('[ClaudeCodeSession] Process exited for tab:', tabId);
      setIsLoading(false);
      hasActiveSessionRef.current = false;
    });

    unlistenRefs.current = [outputUnlisten, errorUnlisten, completeUnlisten];

    // Start persistent process
    const skip = permissionMode === "skip";
    const mode = skip ? "bypassPermissions" : "default";
    await api.startSession(tabId, projectPath, selectedModel, mode, resumeId);
  } catch (err) {
    console.error("Failed to start session:", err);
    setError(String(err));
    hasActiveSessionRef.current = false;
  }
};
```

**Phase B — Sending messages (runs on each prompt):**

```typescript
const handleSendPrompt = async (prompt: string, model: "sonnet" | "opus") => {
  if (!projectPath) {
    setError("Please select a project directory first");
    return;
  }

  const tabId = tabIdRef.current;
  if (!tabId) return;

  // If model changed, restart session with new model
  if (hasActiveSessionRef.current && model !== selectedModel) {
    await api.stopSession(tabId);
    hasActiveSessionRef.current = false;
    unlistenRefs.current.forEach(u => u());
    unlistenRefs.current = [];
    setSelectedModel(model);
  }

  // Start session if not running
  if (!hasActiveSessionRef.current) {
    const resumeId = effectiveSession?.id || claudeSessionId || undefined;
    setSelectedModel(model);
    await startPersistentSession(resumeId);
  }

  // Add user message to UI immediately
  const userMessage: ClaudeStreamMessage = {
    type: "user",
    message: { content: [{ type: "text", text: prompt }] }
  };
  setMessages(prev => [...prev, userMessage]);
  setIsLoading(true);

  // Send to the persistent process
  try {
    await api.sendMessage(tabId, prompt);
    sessionMetrics.current.promptsSent += 1;
  } catch (err) {
    console.error("Failed to send message:", err);
    setError(String(err));
    setIsLoading(false);
  }
};
```

- [ ] **Step 2: Add a `tabIdRef`**

The component needs to know its tab ID. Add near the other refs:

```typescript
const tabIdRef = useRef<string>(tabId);
```

Where `tabId` comes from the component props. Check the component's props interface — if `tabId` isn't passed in, it needs to be added. The `TabContent.tsx` already knows the tab ID when rendering `ClaudeCodeSession`, so pass it through.

- [ ] **Step 3: Update the unmount cleanup**

Replace the current unmount logic with:

```typescript
useEffect(() => {
  isMountedRef.current = true;
  return () => {
    isMountedRef.current = false;
    // Kill the persistent process when tab closes
    const tid = tabIdRef.current;
    if (tid && hasActiveSessionRef.current) {
      api.stopSession(tid).catch(err => {
        console.error("Failed to stop session on unmount:", err);
      });
    }
    unlistenRefs.current.forEach(u => u());
    unlistenRefs.current = [];
  };
}, []);
```

- [ ] **Step 4: Update permission handling in `handleStreamMessage`**

Replace the current permission detection (`stop_reason === 'tool_use'` hack) with proper `control_request` handling:

```typescript
// Inside handleStreamMessage, after parsing the message:
if (message.type === 'control_request') {
  const toolName = message.tool_name || message.tool?.name || 'unknown';
  const toolInput = message.tool_input || message.tool?.input || {};
  const requestId = message.request_id;
  setPendingToolUse({ name: toolName, input: toolInput, requestId });
  setWaitingForPermission(true);
  return; // Don't add control_request to visible messages
}
```

Update the permission response handler to use the new API:

```typescript
const handlePermissionResponse = async (behavior: 'allow' | 'deny') => {
  if (!pendingToolUse || !tabIdRef.current) return;
  setWaitingForPermission(false);
  const updatedInput = behavior === 'allow' ? pendingToolUse.input : undefined;
  await api.respondPermission(tabIdRef.current, pendingToolUse.requestId, behavior, updatedInput);
  setPendingToolUse(null);
};
```

- [ ] **Step 5: Remove the `isListeningRef` and listener rebuild logic**

Delete `isListeningRef` declaration and all references. Listeners are now set up once in `startPersistentSession` and torn down on unmount.

- [ ] **Step 6: Remove calls to old API methods**

Remove all calls to `api.executeClaudeCode`, `api.continueClaudeCode`, `api.resumeClaudeCode` from this component. Also remove `api.cancelClaudeExecution` — replace with `api.stopSession(tabIdRef.current)` in the cancel handler.

- [ ] **Step 7: Update `handleStreamMessage` for `result` detection**

When a `result` message arrives, set `isLoading(false)` — the process is still alive, just waiting for the next prompt:

```typescript
if (message.type === 'result') {
  setIsLoading(false);
}
```

Do NOT set `hasActiveSessionRef.current = false` on result — the process persists.

- [ ] **Step 8: Pass `tabId` prop from `TabContent.tsx`**

In `src/components/TabContent.tsx`, find where `ClaudeCodeSession` is rendered and add:

```typescript
tabId={tab.id}
```

Update the `ClaudeCodeSession` props interface to accept `tabId: string`.

- [ ] **Step 9: Verify frontend compiles**

Run: `npm run build`
Expected: Build succeeds

- [ ] **Step 10: Commit**

```bash
git add src/components/ClaudeCodeSession.tsx src/components/TabContent.tsx
git commit -m "feat: rewrite ClaudeCodeSession to use persistent stream-json sessions"
```

---

### Task 8: End-to-End Testing

**Files:** None (manual testing)

- [ ] **Step 1: Build the full app**

Run: `npm run build` then `~/.cargo/bin/cargo build` from `src-tauri/`

- [ ] **Step 2: Test new session flow**

1. Open the app, select a project, click "Start Session"
2. Send a prompt — verify response streams in
3. Send a follow-up prompt — verify context carries over (no fresh system:init)
4. Check Activity Monitor — should see one `claude` process for the tab

- [ ] **Step 3: Test tab close kills process**

1. Start a session in a tab
2. Note the `claude` PID in Activity Monitor
3. Close the tab
4. Verify the PID is gone from Activity Monitor

- [ ] **Step 4: Test notifications**

1. Open two chat tabs, start sessions in both
2. Send a prompt in Tab B
3. Switch to Tab A while Tab B is processing
4. Verify OS notification appears when Tab B completes
5. Click notification — verify Tab B becomes active

- [ ] **Step 5: Test permission flow**

1. Start a session without bypass permissions
2. Send a prompt that triggers a tool use (e.g., "edit this file")
3. Verify permission prompt appears with tool name
4. Click Allow — verify tool executes
5. Test Deny — verify tool is denied gracefully

- [ ] **Step 6: Test model switch mid-session**

1. Start a session with Opus
2. Send a message
3. Switch to Sonnet in the prompt bar
4. Send another message — verify process restarts and conversation resumes

- [ ] **Step 7: Commit any fixes from testing**

```bash
git add -A
git commit -m "fix: address issues found during persistent session testing"
```
