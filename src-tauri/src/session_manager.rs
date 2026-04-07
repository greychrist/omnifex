use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::process::Stdio;
use std::sync::Arc;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::{Child, ChildStdin};
use tokio::sync::Mutex;

use tauri::{AppHandle, Emitter, Manager};

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

    // 2. Find claude binary
    let claude_path = crate::claude_binary::find_claude_binary(&app)?;
    log::info!("session_start: using claude binary at {}", claude_path);

    // 3. Build args for persistent mode
    let mut args = vec![
        "--input-format".to_string(),
        "stream-json".to_string(),
        "--output-format".to_string(),
        "stream-json".to_string(),
        "--verbose".to_string(),
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
                    let title = if is_error {
                        "Claude Error".to_string()
                    } else {
                        "Claude Complete".to_string()
                    };

                    #[derive(Clone, Serialize)]
                    struct ClaudeNotification {
                        tab_id: String,
                        title: String,
                        body: String,
                        is_error: bool,
                    }

                    let notification = ClaudeNotification {
                        tab_id: tab_id_stdout.clone(),
                        title,
                        body,
                        is_error,
                    };
                    let _ = app_stdout.emit("claude-notification", &notification);
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
