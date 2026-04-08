use crate::accounts::{Account, AccountManagerState, PathRule, ProjectOverride};
use tauri::State;

#[tauri::command]
pub async fn list_accounts(state: State<'_, AccountManagerState>) -> Result<Vec<Account>, String> {
    state.0.list_accounts().map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn create_account(
    state: State<'_, AccountManagerState>,
    name: String,
    config_dir: String,
    is_default: bool,
    account_type: Option<String>,
) -> Result<Account, String> {
    let acct_type = account_type.as_deref().unwrap_or("pro");
    state
        .0
        .create_account(&name, &config_dir, is_default, acct_type)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn update_account(
    state: State<'_, AccountManagerState>,
    id: i64,
    name: String,
    config_dir: String,
    account_type: Option<String>,
    claude_binary: Option<String>,
) -> Result<(), String> {
    let acct_type = account_type.as_deref().unwrap_or("pro");
    state
        .0
        .update_account(id, &name, &config_dir, acct_type, claude_binary.as_deref())
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn delete_account(state: State<'_, AccountManagerState>, id: i64) -> Result<(), String> {
    state.0.delete_account(id).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn set_default_account(
    state: State<'_, AccountManagerState>,
    id: i64,
) -> Result<(), String> {
    state.0.set_default(id).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn list_path_rules(
    state: State<'_, AccountManagerState>,
) -> Result<Vec<PathRule>, String> {
    state.0.list_path_rules().map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn add_path_rule(
    state: State<'_, AccountManagerState>,
    account_id: i64,
    path_prefix: String,
    priority: i32,
) -> Result<(), String> {
    state
        .0
        .add_path_rule(account_id, &path_prefix, priority)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn remove_path_rule(
    state: State<'_, AccountManagerState>,
    rule_id: i64,
) -> Result<(), String> {
    state.0.remove_path_rule(rule_id).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn resolve_account_for_project(
    state: State<'_, AccountManagerState>,
    project_path: String,
) -> Result<Option<Account>, String> {
    // First try standard resolution (overrides → path rules → default)
    let resolved = state.0.resolve(&project_path).map_err(|e| e.to_string())?;

    // If resolved via override or path rule, use that
    // But if it fell through to default, verify by checking which config dir
    // actually contains this project's data
    if let Some(ref account) = resolved {
        // Check if this account actually has the project
        let project_id = project_path.replace('/', "-");
        let has_project = std::path::Path::new(&account.config_dir)
            .join("projects")
            .join(&project_id)
            .exists();
        if has_project {
            return Ok(resolved);
        }
    }

    // Search all accounts for which one actually contains this project
    let accounts = state.0.list_accounts().map_err(|e| e.to_string())?;
    let project_id = project_path.replace('/', "-");
    for account in &accounts {
        let candidate = std::path::Path::new(&account.config_dir)
            .join("projects")
            .join(&project_id);
        if candidate.exists() {
            return Ok(Some(account.clone()));
        }
    }

    // Fall back to standard resolution result
    Ok(resolved)
}

#[tauri::command]
pub async fn set_project_account_override(
    state: State<'_, AccountManagerState>,
    project_path: String,
    account_id: i64,
) -> Result<(), String> {
    state
        .0
        .set_project_override(&project_path, account_id)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn list_project_overrides(
    state: State<'_, AccountManagerState>,
) -> Result<Vec<ProjectOverride>, String> {
    state.0.list_project_overrides().map_err(|e| e.to_string())
}

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

#[tauri::command]
pub async fn discover_accounts() -> Result<Vec<(String, String)>, String> {
    let discovered = crate::accounts::AccountManager::discover_accounts();
    Ok(discovered
        .into_iter()
        .map(|(name, path)| (name, path.to_string_lossy().to_string()))
        .collect())
}
