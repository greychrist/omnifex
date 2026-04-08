#[cfg(target_os = "macos")]
use objc::{msg_send, sel, sel_impl};

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::process::Stdio;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin};
use tokio::sync::Mutex;

use tauri::{AppHandle, Emitter, Manager};

/// Global unread notification count for dock badge
static UNREAD_COUNT: AtomicUsize = AtomicUsize::new(0);

/// Update the dock badge with the current unread count
#[cfg(target_os = "macos")]
fn update_dock_badge(count: usize) {
    unsafe {
        use cocoa::foundation::NSString as NSStringTrait;
        let ns_app = cocoa::appkit::NSApp();
        let dock_tile: cocoa::base::id = msg_send![ns_app, dockTile];
        if count == 0 {
            let empty: cocoa::base::id = cocoa::base::nil;
            let _: () = msg_send![dock_tile, setBadgeLabel: empty];
        } else {
            let label = format!("{}", count);
            let badge = cocoa::foundation::NSString::alloc(cocoa::base::nil).init_str(&label);
            let _: () = msg_send![dock_tile, setBadgeLabel: badge];
        }
    }
}

#[cfg(not(target_os = "macos"))]
fn update_dock_badge(_count: usize) {}

/// Increment unread count and update badge
pub fn increment_unread() {
    let count = UNREAD_COUNT.fetch_add(1, Ordering::SeqCst) + 1;
    update_dock_badge(count);
}

/// Clear all unread notifications and badge
pub fn clear_unread() {
    UNREAD_COUNT.store(0, Ordering::SeqCst);
    update_dock_badge(0);
}

/// Represents a managed persistent Claude session
struct ManagedSession {
    stdin: Option<ChildStdin>,
    child: Option<Child>,
    session_id: Arc<std::sync::Mutex<Option<String>>>,
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
    log::info!(
        "session_start: tab_id={}, project_path={}, model={}, permission_mode={}, resume={:?}",
        tab_id,
        project_path,
        model,
        permission_mode,
        resume_session_id
    );

    // 1. Resolve account
    let account = account_state
        .0
        .resolve(&project_path)
        .map_err(|e| format!("Account resolution failed: {}", e))?;

    let config_dir = match &account {
        Some(acc) => acc.config_dir.clone(),
        None => {
            // Fall back to default ~/.claude
            let home = dirs::home_dir().ok_or("Cannot determine home directory")?;
            home.join(".claude").to_string_lossy().to_string()
        }
    };

    log::info!(
        "session_start: resolved config_dir={} (account={:?})",
        config_dir,
        account.as_ref().map(|a| &a.name)
    );

    // 2. Find claude binary — prefer account-level setting, fall back to global discovery
    let claude_path =
        if let Some(ref binary) = account.as_ref().and_then(|a| a.claude_binary.clone()) {
            if std::path::Path::new(binary).exists() {
                log::info!("session_start: using account-configured binary: {}", binary);
                binary.clone()
            } else {
                log::warn!(
                    "session_start: account binary not found at {}, falling back to discovery",
                    binary
                );
                crate::claude_binary::find_claude_binary(&app)?
            }
        } else {
            crate::claude_binary::find_claude_binary(&app)?
        };
    log::info!("session_start: using claude binary at {}", claude_path);

    // 3. Build args for persistent mode (matches VS Code extension flags)
    let mut args = vec![
        "--input-format".to_string(),
        "stream-json".to_string(),
        "--output-format".to_string(),
        "stream-json".to_string(),
        "--permission-prompt-tool".to_string(),
        "stdio".to_string(),
        "--verbose".to_string(),
        "--include-partial-messages".to_string(),
        "--replay-user-messages".to_string(),
        "--no-chrome".to_string(),
        "--model".to_string(),
        model.clone(),
        "--permission-mode".to_string(),
        permission_mode.clone(),
    ];

    if let Some(ref resume_id) = resume_session_id {
        args.push("--resume".to_string());
        args.push(resume_id.clone());
    }

    // 4. Create and configure command
    let mut cmd = crate::commands::claude::create_command_with_env(&claude_path);
    cmd.args(&args)
        .current_dir(&project_path)
        .env("CLAUDE_CONFIG_DIR", &config_dir)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    // 5. Spawn
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Failed to spawn Claude: {}", e))?;

    let pid = child.id().unwrap_or(0);
    log::info!("session_start: spawned Claude process PID={}", pid);

    let stdout = child.stdout.take().ok_or("Failed to take stdout")?;
    let stderr = child.stderr.take().ok_or("Failed to take stderr")?;
    let stdin = child.stdin.take().ok_or("Failed to take stdin")?;

    let session_id_holder: Arc<std::sync::Mutex<Option<String>>> =
        Arc::new(std::sync::Mutex::new(None));

    // 6. Kill any existing session for this tab_id
    {
        let mut sessions = manager.0.sessions.lock().await;
        if let Some(mut old) = sessions.remove(&tab_id) {
            log::warn!(
                "session_start: killing existing session for tab_id={}",
                tab_id
            );
            if let Some(ref mut old_child) = old.child {
                let _ = old_child.kill().await;
            }
        }
    }

    // 7. Store in ManagedSession
    {
        let mut sessions = manager.0.sessions.lock().await;
        sessions.insert(
            tab_id.clone(),
            ManagedSession {
                stdin: Some(stdin),
                child: Some(child),
                session_id: session_id_holder.clone(),
                project_path: project_path.clone(),
                model: model.clone(),
                permission_mode: permission_mode.clone(),
                config_dir: config_dir.clone(),
                started_at: std::time::Instant::now(),
            },
        );
    }

    // 8. Spawn stdout reader task
    let app_stdout = app.clone();
    let tab_id_stdout = tab_id.clone();
    let session_id_stdout = session_id_holder.clone();
    let manager_arc = manager.0.clone();
    let project_path_reg = project_path.clone();
    let model_reg = model.clone();
    let registry = app.state::<crate::process::ProcessRegistryState>();
    let registry_clone = registry.0.clone();

    tokio::spawn(async move {
        let reader = BufReader::new(stdout);
        let mut lines = reader.lines();

        while let Ok(Some(line)) = lines.next_line().await {
            log::debug!("session[{}] stdout: {}", tab_id_stdout, line);

            // Parse JSON to detect init and result messages
            if let Ok(msg) = serde_json::from_str::<serde_json::Value>(&line) {
                // Extract session_id from system/init
                if msg["type"] == "system" && msg["subtype"] == "init" {
                    if let Some(sid) = msg["session_id"].as_str() {
                        let sid_string = sid.to_string();
                        let is_new;
                        {
                            let mut guard = session_id_stdout.lock().unwrap();
                            is_new = guard.is_none();
                            if is_new {
                                *guard = Some(sid_string.clone());
                            }
                        }
                        if is_new {
                            log::info!("session[{}] got session_id={}", tab_id_stdout, sid_string);
                            // Also update the ManagedSession's session_id
                            // (already shared via Arc, so it's updated)

                            // Register in ProcessRegistry
                            match registry_clone.register_claude_session(
                                sid_string.clone(),
                                pid,
                                project_path_reg.clone(),
                                String::new(), // no initial task for persistent sessions
                                model_reg.clone(),
                            ) {
                                Ok(run_id) => {
                                    log::info!(
                                        "session[{}] registered in ProcessRegistry run_id={}",
                                        tab_id_stdout,
                                        run_id
                                    );
                                }
                                Err(e) => {
                                    log::error!(
                                        "session[{}] failed to register in ProcessRegistry: {}",
                                        tab_id_stdout,
                                        e
                                    );
                                }
                            }
                        }
                    }
                }

                // Detect result messages for notifications
                if msg["type"] == "result" {
                    let is_error = msg["is_error"].as_bool().unwrap_or(false);
                    let body = msg["result"]
                        .as_str()
                        .or_else(|| msg["error"].as_str())
                        .unwrap_or("Task complete")
                        .to_string();
                    let project_name = std::path::Path::new(&project_path_reg)
                        .file_name()
                        .map(|n| n.to_string_lossy().to_string())
                        .unwrap_or_else(|| project_path_reg.clone());
                    let title = if is_error {
                        format!("GreyChrist - {}", project_name)
                    } else {
                        format!("GreyChrist - {}", project_name)
                    };

                    log::info!(
                        "session[{}] result detected, sending notification: {}",
                        tab_id_stdout,
                        title
                    );

                    #[derive(Clone, Serialize)]
                    struct ClaudeNotification {
                        tab_id: String,
                        title: String,
                        body: String,
                        is_error: bool,
                    }

                    let notification = ClaudeNotification {
                        tab_id: tab_id_stdout.clone(),
                        title: title.clone(),
                        body: body.clone(),
                        is_error,
                    };
                    let _ = app_stdout.emit("claude-notification", &notification);

                    // Send native macOS notification under GreyChrist identity
                    #[cfg(target_os = "macos")]
                    {
                        let truncated_body: String = body.chars().take(200).collect();
                        let subtitle = if is_error {
                            "Task Failed"
                        } else {
                            "Task Complete"
                        };
                        let _ = mac_notification_sys::set_application("greychrist.asterisk.so");
                        let mut notif_opts = mac_notification_sys::Notification::new();
                        notif_opts.default_sound();
                        if let Err(e) = mac_notification_sys::send_notification(
                            &title,
                            Some(subtitle),
                            &truncated_body,
                            Some(&notif_opts),
                        ) {
                            log::warn!("Failed to send notification: {:?}", e);
                        }
                    }

                    // Increment unread count and update dock badge
                    increment_unread();
                }
            }

            // Emit every line to tab-specific event
            let _ = app_stdout.emit(&format!("claude-output:{}", tab_id_stdout), &line);
        }

        log::info!("session[{}] stdout EOF", tab_id_stdout);

        // Wait for child to exit
        {
            let mut sessions = manager_arc.sessions.lock().await;
            if let Some(session) = sessions.get_mut(&tab_id_stdout) {
                if let Some(mut child) = session.child.take() {
                    match child.wait().await {
                        Ok(status) => {
                            log::info!(
                                "session[{}] process exited with status={}",
                                tab_id_stdout,
                                status
                            );
                        }
                        Err(e) => {
                            log::error!(
                                "session[{}] failed to wait on child: {}",
                                tab_id_stdout,
                                e
                            );
                        }
                    }
                }
            }
        }

        // Emit completion
        let _ = app_stdout.emit(&format!("claude-complete:{}", tab_id_stdout), true);
    });

    // 9. Spawn stderr reader task
    let app_stderr = app.clone();
    let tab_id_stderr = tab_id.clone();

    tokio::spawn(async move {
        let reader = BufReader::new(stderr);
        let mut lines = reader.lines();

        while let Ok(Some(line)) = lines.next_line().await {
            // Skip the common "no stdin data received" noise
            if line.contains("no stdin data received") {
                continue;
            }
            log::warn!("session[{}] stderr: {}", tab_id_stderr, line);
            let _ = app_stderr.emit(&format!("claude-error:{}", tab_id_stderr), &line);
        }
    });

    log::info!("session_start: complete for tab_id={}, pid={}", tab_id, pid);
    Ok(())
}

#[tauri::command]
pub async fn session_send_message(
    manager: tauri::State<'_, SessionProcessManagerState>,
    tab_id: String,
    prompt: String,
) -> Result<(), String> {
    log::info!(
        "session_send_message: tab_id={}, prompt_len={}",
        tab_id,
        prompt.len()
    );

    let mut sessions = manager.0.sessions.lock().await;
    let session = sessions
        .get_mut(&tab_id)
        .ok_or_else(|| format!("No session found for tab_id={}", tab_id))?;

    let session_id = {
        let guard = session.session_id.lock().unwrap();
        guard.clone().unwrap_or_default()
    };

    let msg = serde_json::json!({
        "type": "user",
        "message": {
            "role": "user",
            "content": prompt
        },
        "session_id": session_id,
        "parent_tool_use_id": null
    });

    let line = format!(
        "{}\n",
        serde_json::to_string(&msg).map_err(|e| e.to_string())?
    );

    let stdin = session
        .stdin
        .as_mut()
        .ok_or_else(|| format!("stdin not available for tab_id={}", tab_id))?;

    stdin
        .write_all(line.as_bytes())
        .await
        .map_err(|e| format!("Failed to write to stdin: {}", e))?;
    stdin
        .flush()
        .await
        .map_err(|e| format!("Failed to flush stdin: {}", e))?;

    log::info!("session_send_message: sent to tab_id={}", tab_id);
    Ok(())
}

#[tauri::command]
pub async fn session_respond_permission(
    manager: tauri::State<'_, SessionProcessManagerState>,
    tab_id: String,
    request_id: String,
    behavior: String,
    updated_input: Option<serde_json::Value>,
) -> Result<(), String> {
    log::info!(
        "session_respond_permission: tab_id={}, request_id={}, behavior={}",
        tab_id,
        request_id,
        behavior
    );

    let mut sessions = manager.0.sessions.lock().await;
    let session = sessions
        .get_mut(&tab_id)
        .ok_or_else(|| format!("No session found for tab_id={}", tab_id))?;

    let msg = serde_json::json!({
        "type": "control_response",
        "response": {
            "subtype": "success",
            "request_id": request_id,
            "response": {
                "behavior": behavior,
                "updatedInput": updated_input
            }
        }
    });

    let line = format!(
        "{}\n",
        serde_json::to_string(&msg).map_err(|e| e.to_string())?
    );

    let stdin = session
        .stdin
        .as_mut()
        .ok_or_else(|| format!("stdin not available for tab_id={}", tab_id))?;

    stdin
        .write_all(line.as_bytes())
        .await
        .map_err(|e| format!("Failed to write to stdin: {}", e))?;
    stdin
        .flush()
        .await
        .map_err(|e| format!("Failed to flush stdin: {}", e))?;

    log::info!("session_respond_permission: sent to tab_id={}", tab_id);
    Ok(())
}

#[tauri::command]
pub async fn session_stop(
    manager: tauri::State<'_, SessionProcessManagerState>,
    tab_id: String,
) -> Result<(), String> {
    log::info!("session_stop: tab_id={}", tab_id);

    let mut sessions = manager.0.sessions.lock().await;
    let removed = sessions.remove(&tab_id);

    if let Some(mut session) = removed {
        // Drop stdin to signal EOF to the child process
        session.stdin.take();

        if let Some(mut child) = session.child.take() {
            // Wait up to 5 seconds for graceful exit, then kill
            match tokio::time::timeout(std::time::Duration::from_secs(5), child.wait()).await {
                Ok(Ok(status)) => {
                    log::info!(
                        "session_stop: tab_id={} exited with status={}",
                        tab_id,
                        status
                    );
                }
                Ok(Err(e)) => {
                    log::error!("session_stop: tab_id={} wait error: {}", tab_id, e);
                }
                Err(_) => {
                    log::warn!(
                        "session_stop: tab_id={} did not exit in 5s, killing",
                        tab_id
                    );
                    let _ = child.kill().await;
                }
            }
        }
    } else {
        log::info!(
            "session_stop: no session found for tab_id={}, nothing to do",
            tab_id
        );
    }

    Ok(())
}

#[tauri::command]
pub async fn session_get_info(
    manager: tauri::State<'_, SessionProcessManagerState>,
    tab_id: String,
) -> Result<Option<SessionInfo>, String> {
    let sessions = manager.0.sessions.lock().await;

    let info = sessions.get(&tab_id).map(|session| {
        let session_id = {
            let guard = session.session_id.lock().unwrap();
            guard.clone()
        };

        SessionInfo {
            tab_id: tab_id.clone(),
            session_id,
            project_path: session.project_path.clone(),
            model: session.model.clone(),
            permission_mode: session.permission_mode.clone(),
            config_dir: session.config_dir.clone(),
            alive: session.child.is_some(),
            uptime_secs: session.started_at.elapsed().as_secs(),
        }
    });

    Ok(info)
}
