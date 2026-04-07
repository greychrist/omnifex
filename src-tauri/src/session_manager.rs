use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Arc;
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
