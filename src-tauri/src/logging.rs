use log::{Level, Log, Metadata, Record};
use std::sync::OnceLock;
use tauri::{AppHandle, Emitter, Manager};

static APP_HANDLE: OnceLock<AppHandle> = OnceLock::new();

pub fn set_app_handle(handle: AppHandle) {
    let _ = APP_HANDLE.set(handle);
}

pub struct TauriLogBridge;

impl Log for TauriLogBridge {
    fn enabled(&self, metadata: &Metadata) -> bool {
        let verbose = std::env::var("GREYCHRIST_VERBOSE_LOG").unwrap_or_default() == "1";
        match metadata.level() {
            Level::Error | Level::Warn => true,
            Level::Info | Level::Debug => verbose,
            Level::Trace => false,
        }
    }

    fn log(&self, record: &Record) {
        if !self.enabled(record.metadata()) {
            return;
        }

        // Always print to stderr
        eprintln!(
            "[{}] [{}] {}",
            record.level(),
            record.target(),
            record.args()
        );

        // Emit to frontend via Tauri event
        if let Some(handle) = APP_HANDLE.get() {
            let payload = serde_json::json!({
                "level": record.level().to_string().to_lowercase(),
                "category": record.target(),
                "message": record.args().to_string(),
                "timestamp": chrono::Utc::now().to_rfc3339(),
            });
            let _ = handle.emit("backend-log", payload);
        }
    }

    fn flush(&self) {}
}

static LOGGER: TauriLogBridge = TauriLogBridge;

pub fn init_logger() {
    let level = std::env::var("RUST_LOG")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(log::LevelFilter::Info);

    log::set_logger(&LOGGER)
        .map(|()| log::set_max_level(level))
        .expect("Failed to set logger");
}
