use crate::accounts::{Account, AccountManagerState, PathRule, ProjectOverride};
use tauri::State;

#[tauri::command]
pub async fn list_accounts(
    state: State<'_, AccountManagerState>,
) -> Result<Vec<Account>, String> {
    state.0.list_accounts().map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn create_account(
    state: State<'_, AccountManagerState>,
    name: String,
    config_dir: String,
    is_default: bool,
) -> Result<Account, String> {
    state
        .0
        .create_account(&name, &config_dir, is_default)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn update_account(
    state: State<'_, AccountManagerState>,
    id: i64,
    name: String,
    config_dir: String,
) -> Result<(), String> {
    state
        .0
        .update_account(id, &name, &config_dir)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn delete_account(
    state: State<'_, AccountManagerState>,
    id: i64,
) -> Result<(), String> {
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
    state
        .0
        .remove_path_rule(rule_id)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn resolve_account_for_project(
    state: State<'_, AccountManagerState>,
    project_path: String,
) -> Result<Option<Account>, String> {
    state.0.resolve(&project_path).map_err(|e| e.to_string())
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
    state
        .0
        .list_project_overrides()
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
