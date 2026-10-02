//! Duster 拂尘 – installed software manager / uninstaller / leftover cleaner.
//!
//! Module map (see docs/ARCHITECTURE.md):
//!   registry_scanner  – enumerate Uninstall keys (x64 + WOW6432Node + HKCU) and Store apps
//!   app_model         – serde data model shared with the TypeScript UI
//!   uninstaller       – parse UninstallString / msiexec normalisation / run with UAC
//!   leftover_scanner  – validated file-system, registry, shortcut, service and task leftovers
//!   backup_manager    – registry snapshots (.json/.reg), Recycle-Bin deletion, restore
//!   icon_extractor    – HICON → PNG data URL
//!   privilege         – elevation detection and relaunch via `runas`
//!   exporter          – CSV / JSON / HTML
//!   commands          – `#[tauri::command]` handlers and in-memory state

pub mod app_model;
pub mod backup_manager;
pub mod commands;
pub mod error;
pub mod exporter;
pub mod icon_extractor;
pub mod leftover_scanner;
pub mod privilege;
pub mod registry_scanner;
pub mod uninstaller;

use commands::AppState;
use tauri::Manager;

fn init_tracing(settings: &app_model::Settings) {
    use tracing_subscriber::{fmt, layer::SubscriberExt, util::SubscriberInitExt, EnvFilter};
    let log_dir = commands::data_dir().join("logs");
    let _ = std::fs::create_dir_all(&log_dir);
    let file_appender = tracing_appender::rolling::daily(log_dir, "duster.log");
    let (writer, guard) = tracing_appender::non_blocking(file_appender);
    // Keep the guard alive for the lifetime of the process.
    Box::leak(Box::new(guard));
    let filter = EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new(format!("duster_lib={},tauri=warn", settings.log_level)));
    tracing_subscriber::registry()
        .with(filter)
        .with(fmt::layer().with_writer(writer).with_ansi(false))
        .with(fmt::layer().with_writer(std::io::stderr))
        .init();
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let settings = commands::load_settings();
    init_tracing(&settings);
    tracing::info!(portable = settings.portable_mode, elevated = privilege::is_elevated(), "starting Duster");

    let state = AppState { settings: parking_lot::Mutex::new(settings), ..Default::default() };

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(state)
        .setup(|app| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.set_title(if privilege::is_elevated() { "Duster 拂尘 (Administrator)" } else { "Duster 拂尘" });
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::list_installed_apps,
            commands::refresh_apps,
            commands::get_app_detail,
            commands::get_app_icon,
            commands::uninstall_app,
            commands::force_uninstall_app,
            commands::delete_app_entry,
            commands::scan_leftovers,
            commands::delete_leftovers,
            commands::open_install_location,
            commands::reveal_path,
            commands::open_registry_key,
            commands::open_external,
            commands::export_apps,
            commands::is_admin,
            commands::request_elevation,
            commands::get_settings,
            commands::save_settings,
            commands::list_backups,
            commands::restore_backup,
            commands::get_logs,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Duster");
}
