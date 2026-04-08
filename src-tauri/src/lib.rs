// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/

// Declare modules
pub mod accounts;
pub mod checkpoint;
pub mod claude_binary;
pub mod commands;
pub mod logging;
pub mod process;
pub mod session_manager;
pub mod web_server;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
