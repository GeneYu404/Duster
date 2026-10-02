//! `#[tauri::command]` handlers – thin glue between IPC and the modules. Command names
//! match `COMMANDS` in `src/ipc/backend.ts`; argument names are camelCase on the wire.

use crate::app_model::*;
use crate::error::{AppError, AppResult};
use crate::registry_scanner::RawEntry;
use crate::{backup_manager, exporter, icon_extractor, leftover_scanner, privilege, registry_scanner, uninstaller};
use parking_lot::Mutex;
use std::collections::{BTreeMap, HashMap, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Instant;
use tauri::{AppHandle, Emitter, Manager, State};

pub const EVENT_FORCE_PROGRESS: &str = "duster://force-progress";

#[derive(serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ForceProgress {
    app_id: String,
    phase: String,
    percent: u8,
    deleted: usize,
    recycled: usize,
}

pub const EVENT_UNINSTALL_LOG: &str = "duster://uninstall-log";
pub const EVENT_SCAN_PROGRESS: &str = "duster://scan-progress";

#[derive(Default)]
pub struct AppState {
    pub apps: Mutex<Vec<InstalledApp>>,
    /// Apps that disappeared from the registry but may still be needed for leftover scans.
    pub archive: Mutex<HashMap<String, InstalledApp>>,
    pub raw: Mutex<BTreeMap<String, RawEntry>>,
    pub icons: Mutex<HashMap<String, Option<String>>>,
    pub settings: Mutex<Settings>,
    pub logs: Mutex<VecDeque<LogEntry>>,
    /// Scan results are cached so `delete_leftovers` can resolve item ids → paths.
    pub last_scans: Mutex<HashMap<String, ScanResult>>,
}

#[derive(serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct Envelope<T: serde::Serialize + Clone> {
    app_id: String,
    payload: T,
}

/* ------------------------------ paths & settings ------------------------------ */

pub fn is_portable() -> bool {
    if cfg!(feature = "portable") {
        return true;
    }
    let dir = portable_dir();
    if dir.join("portable.flag").exists() {
        return true;
    }
    std::fs::read(dir.join("settings.json"))
        .ok()
        .and_then(|bytes| serde_json::from_slice::<Settings>(&bytes).ok())
        .map(|settings| settings.portable_mode)
        .unwrap_or(false)
}

fn app_dir() -> PathBuf {
    dirs::config_dir().unwrap_or_else(|| PathBuf::from(".")).join("Duster")
}

fn portable_dir() -> PathBuf {
    std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(Path::to_path_buf))
        .unwrap_or_else(|| PathBuf::from("."))
}

pub fn data_dir() -> PathBuf {
    if is_portable() {
        portable_dir()
    } else {
        app_dir()
    }
}

pub fn load_settings() -> Settings {
    let path = data_dir().join("settings.json");
    let mut s: Settings = std::fs::read(&path).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default();
    s.portable_mode = is_portable();
    if s.backup_directory.is_empty() {
        s.backup_directory = data_dir().join("backups").display().to_string();
    }
    s
}

fn backup_dir(state: &AppState) -> PathBuf {
    PathBuf::from(&state.settings.lock().backup_directory)
}

pub fn push_log(state: &AppState, level: &str, message: impl Into<String>) {
    let mut logs = state.logs.lock();
    logs.push_back(LogEntry { ts: chrono::Local::now().to_rfc3339(), level: level.into(), message: message.into() });
    if logs.len() > 1000 {
        logs.pop_front();
    }
}

fn find_app(state: &AppState, app_id: &str) -> AppResult<InstalledApp> {
    state
        .apps
        .lock()
        .iter()
        .find(|a| a.id == app_id)
        .cloned()
        .or_else(|| state.archive.lock().get(app_id).cloned())
        .ok_or_else(|| AppError::AppNotFound(app_id.to_string()))
}

fn archive_app(state: &AppState, app_id: &str) {
    let mut apps = state.apps.lock();
    if let Some(pos) = apps.iter().position(|a| a.id == app_id) {
        let app = apps.remove(pos);
        state.archive.lock().insert(app.id.clone(), app);
    }
}

fn rescan(state: &AppState, options: &ListOptions) -> Vec<InstalledApp> {
    let started = std::time::Instant::now();
    let (all, raw) = registry_scanner::scan_all(options.include_store_apps);
    let list: Vec<InstalledApp> = all
        .into_iter()
        .filter(|a| (options.include_system_components || !a.is_system_component) && (options.include_updates || !a.is_update))
        .collect();
    *state.raw.lock() = raw;
    *state.apps.lock() = list.clone();
    push_log(state, "info", format!("Enumerated {} entries in {} ms", list.len(), started.elapsed().as_millis()));
    tracing::info!(count = list.len(), ms = started.elapsed().as_millis(), "registry scan complete");
    list
}

/* ----------------------------------- commands --------------------------------- */

#[tauri::command]
pub async fn list_installed_apps(app_handle: AppHandle, options: ListOptions) -> AppResult<Vec<InstalledApp>> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app_handle.state::<AppState>();
        rescan(state.inner(), &options)
    })
    .await
    .map_err(|e| AppError::Other(format!("registry scan worker failed: {e}")))
}

#[tauri::command]
pub async fn refresh_apps(app_handle: AppHandle, options: ListOptions) -> AppResult<Vec<InstalledApp>> {
    list_installed_apps(app_handle, options).await
}

#[tauri::command]
pub async fn get_app_detail(state: State<'_, AppState>, app_id: String) -> AppResult<AppDetail> {
    let state = state.inner();
    let app = find_app(state, &app_id)?;
    let raw = state.raw.lock().get(&app_id).cloned().unwrap_or_default();
    let parsed = app.uninstall_string.as_deref().and_then(|c| uninstaller::parse_command(c, false).ok());
    let executable = app.display_icon.as_deref().and_then(leftover_scanner::exe_from_display_icon).map(|p| p.display().to_string());
    let uninstaller_exists = parsed.as_ref().map(|p| Path::new(&p.program).is_absolute() && Path::new(&p.program).is_file() || !Path::new(&p.program).is_absolute()).unwrap_or(false);
    let get = |k: &str| raw.values.get(k).cloned();
    Ok(AppDetail {
        install_location_exists: app.install_location.as_deref().map(|p| Path::new(p).is_dir()).unwrap_or(false),
        uninstaller_exists,
        parsed_command: parsed,
        executable_path: executable,
        modify_path: get("ModifyPath"),
        comments: get("Comments"),
        contact: get("Contact"),
        language: get("Language"),
        registry_values: raw.values,
        app,
    })
}

#[tauri::command]
pub async fn get_app_icon(state: State<'_, AppState>, app_id: String) -> AppResult<Option<String>> {
    let state = state.inner();
    if let Some(cached) = state.icons.lock().get(&app_id) {
        return Ok(cached.clone());
    }
    let app = find_app(state, &app_id)?;
    let icon = tauri::async_runtime::spawn_blocking(move || icon_extractor::extract_png_data_url(&app)).await.map_err(|e| AppError::Other(e.to_string()))?;
    state.icons.lock().insert(app_id, icon.clone());
    Ok(icon)
}

#[tauri::command]
pub async fn uninstall_app(app_handle: AppHandle, state: State<'_, AppState>, args: UninstallArgs) -> AppResult<UninstallResult> {
    let state = state.inner();
    let app = find_app(state, &args.app_id)?;
    if app.is_system_component || app.is_update {
        return Err(AppError::ProtectedPath(format!("refusing to uninstall system component/update {}", app.name)));
    }
    let elevated = privilege::is_elevated();
    let handle = app_handle.clone();
    let id = app.id.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        uninstaller::run(&app, args.quiet, elevated, |line| {
            let _ = handle.emit(EVENT_UNINSTALL_LOG, Envelope { app_id: id.clone(), payload: line });
        })
    })
    .await
    .map_err(|e| AppError::Other(e.to_string()))??;
    push_log(state, if result.success { "info" } else { "warn" }, format!("Uninstall {}: {} (exit {:?})", args.app_id, result.message, result.exit_code));
    if result.success {
        archive_app(state, &args.app_id);
    }
    Ok(result)
}

fn run_scan(app_handle: &AppHandle, state: &AppState, app_id: &str) -> AppResult<ScanResult> {
    let app = find_app(state, app_id)?;
    let still_registered = state.apps.lock().iter().any(|a| a.id == app_id);
    let ctx = leftover_scanner::ScanContext { app, still_registered };
    let handle = app_handle.clone();
    let id = app_id.to_string();
    let result = leftover_scanner::scan(&ctx, |p| {
        let _ = handle.emit(EVENT_SCAN_PROGRESS, Envelope { app_id: id.clone(), payload: p });
    });
    push_log(state, "info", format!("Leftover scan {}: {} items", ctx.app.name, result.items.len()));
    state.last_scans.lock().insert(app_id.to_string(), result.clone());
    Ok(result)
}

#[tauri::command]
pub async fn scan_leftovers(app_handle: AppHandle, state: State<'_, AppState>, app_id: String) -> AppResult<ScanResult> {
    let state = state.inner();
    if !state.settings.lock().enable_leftover_scan {
        return Err(AppError::Other("leftover scanning is disabled in settings".into()));
    }
    let handle = app_handle.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let state = handle.state::<AppState>();
        run_scan(&handle, state.inner(), &app_id)
    })
    .await
    .map_err(|e| AppError::Other(format!("leftover scan worker failed: {e}")))?
}

/// Force removal plan: never invoke the program's uninstaller. The dialog runs the
/// leftover scanner to enumerate the install directory, registry keys and related
/// artefacts; `delete_leftovers` then removes them directly. This preview must not
/// change anything on disk.
#[tauri::command]
pub async fn force_uninstall_app(app_handle: AppHandle, state: State<'_, AppState>, app_id: String) -> AppResult<ScanResult> {
    let app = find_app(state.inner(), &app_id)?;
    if app.is_system_component || app.is_update {
        return Err(AppError::ProtectedPath(format!("refusing force removal of {}", app.name)));
    }
    if app.install_location.is_none() && app.registry_path.is_empty() {
        return Err(AppError::Other(format!("no install directory or Uninstall key for {}", app.name)));
    }
    scan_leftovers(app_handle, state, app_id).await
}

#[derive(serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ForceRemoveResult {
    pub app_id: String,
    pub app_name: String,
    pub deleted: Vec<String>,
    pub failed: Vec<crate::app_model::FailedItem>,
    pub recycled: usize,
    pub moved_bytes: u64,
    pub duration_ms: u128,
    pub backup: Option<crate::app_model::BackupInfo>,
    pub items: Vec<crate::app_model::LeftoverItem>,
    pub locked_paths: Vec<String>,
}

fn force_progress(app: &AppHandle, app_id: &str, phase: &str, percent: u8, deleted: usize, recycled: usize) {
    let _ = app.emit(
        EVENT_FORCE_PROGRESS,
        Envelope {
            app_id: app_id.to_string(),
            payload: ForceProgress {
                app_id: app_id.to_string(),
                phase: phase.to_string(),
                percent,
                deleted,
                recycled,
            },
        },
    );
}

/// Detect whether any running process is currently using the install directory. Blocking
/// I/O — must be called from a worker thread. Returns the binary paths of lock holders, or
/// `Ok(vec![])` when the directory can be safely removed.
fn processes_using(dir: &Path) -> AppResult<Vec<String>> {
    #[cfg(not(windows))]
    {
        let _ = dir;
        Ok(Vec::new())
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        let needle = dir.to_string_lossy().replace('\'', "''");
        let script = format!(
            "$ErrorActionPreference='Stop'; Get-Process | Where-Object {{ $_.Path -and $_.Path -like '{needle}*' }} | Select-Object -ExpandProperty Path -Unique"
        );
        let out = std::process::Command::new("powershell.exe")
            .args(["-NoProfile", "-NonInteractive", "-Command", &script])
            .creation_flags(CREATE_NO_WINDOW)
            .output()
            .map_err(AppError::Io)?;
        let stdout = String::from_utf8_lossy(&out.stdout);
        let mut paths = Vec::new();
        for line in stdout.lines() {
            let trimmed = line.trim();
            if !trimmed.is_empty() {
                paths.push(trimmed.to_string());
            }
        }
        Ok(paths)
    }
}

/// Build the list of registry keys that belong to `app`. Used by `force_remove_app` so it
/// can wipe everything related to the program without relying on its uninstaller.
fn force_remove_keys(app: &InstalledApp) -> Vec<String> {
    use crate::leftover_scanner::{base_name, vendor_name};
    let mut keys = Vec::new();
    if !app.registry_path.is_empty() {
        keys.push(app.registry_path.clone());
    }
    let name = base_name(&app.name);
    let vendor = vendor_name(app.publisher.as_deref());
    if let Some(v) = vendor {
        keys.push(format!(r"HKCU\Software\{v}\{name}"));
        keys.push(format!(r"HKLM\SOFTWARE\{v}\{name}"));
        keys.push(format!(r"HKLM\SOFTWARE\WOW6432Node\{v}\{name}"));
    } else {
        keys.push(format!(r"HKCU\Software\{name}"));
    }
    if let Some(display_icon) = &app.display_icon {
        if let Some(stem) = std::path::Path::new(display_icon).file_stem().map(|s| s.to_string_lossy().to_string()) {
            if !stem.is_empty() {
                keys.push(format!(r"HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\{stem}.exe"));
                keys.push(format!(r"HKLM\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\App Paths\{stem}.exe"));
                keys.push(format!(r"HKCU\Software\Classes\Applications\{stem}.exe"));
            }
        }
    }
    if let Some(code) = &app.msi_product_code {
        let packed = crate::leftover_scanner::pack_guid(code);
        keys.push(format!(r"HKLM\SOFTWARE\Classes\Installer\Products\{packed}"));
    }
    keys
}

/// Force remove: scan only once, then on confirm directly delete the install folder and
/// related registry keys. The program's own uninstaller is never invoked.
#[tauri::command]
pub async fn force_remove_app(app_handle: AppHandle, app_id: String) -> AppResult<ForceRemoveResult> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app_handle.state::<AppState>();
        let state = state.inner();
        let app = find_app(state, &app_id)?;
        if app.is_system_component || app.is_update {
            return Err(AppError::ProtectedPath(format!("refusing force removal of {}", app.name)));
        }
        let settings = state.settings.lock().clone();
        let backup_dir_path = backup_dir(state);
        let started = Instant::now();
        let handle = app_handle.clone();
        let id = app.id.clone();
        let report = move |phase: &'static str, percent: u8, deleted: usize, recycled: usize| {
            force_progress(&handle, &id, phase, percent, deleted, recycled);
        };

        // 1. Run the leftover scan first so the user sees exactly what will be touched.
        report("scanning", 0, 0, 0);
        let scan_ctx = leftover_scanner::ScanContext { app: app.clone(), still_registered: true };
        let scan = leftover_scanner::scan(&scan_ctx, |_| {});
        let items = scan.items.clone();
        report("scanned", 100, 0, 0);

        // 2. Refuse early if the install directory is still locked.
        let mut locked_paths = Vec::new();
        if let Some(loc) = app.install_location.as_deref() {
            let path = std::path::PathBuf::from(loc);
            if path.is_dir() {
                match processes_using(&path) {
                    Ok(procs) if !procs.is_empty() => locked_paths.extend(procs),
                    Err(error) => {
                        tracing::warn!(%error, "could not enumerate processes using {}", path.display());
                    }
                    _ => {}
                }
            }
        }
        if !locked_paths.is_empty() {
            return Err(AppError::Other(format!(
                "the install directory is still in use: {}",
                locked_paths.join(", ")
            )));
        }

        // 3. Always export a registry backup before mutating anything.
        let keys = force_remove_keys(&app);
        let backup = if keys.is_empty() {
            None
        } else {
            Some(backup_manager::backup_keys(&backup_dir_path, &app.id, &app.name, crate::app_model::BackupKind::Leftovers, &keys)?)
        };

        // 4. Delete registry keys, services and scheduled tasks (these never need the installer).
        let mut deleted: Vec<String> = Vec::new();
        let mut failed: Vec<crate::app_model::FailedItem> = Vec::new();
        let mut deleted_count = 0usize;
        let total_keys = keys.len();
        for (index, key) in keys.iter().enumerate() {
            let pct = 10 + ((index * 10) / total_keys.max(1)) as u8;
            report("registry", pct, deleted_count, 0);
            match backup_manager::delete_key(key) {
                Ok(()) => {
                    deleted.push(key.clone());
                    deleted_count += 1;
                }
                Err(error) => failed.push(crate::app_model::FailedItem {
                    id: format!("{}#{}", app.id, index),
                    path: key.clone(),
                    reason: error.to_string(),
                }),
            }
        }

        // 5. Delete the install folder itself.
        if let Some(loc) = app.install_location.as_deref() {
            let path = std::path::PathBuf::from(loc);
            if path.is_dir() {
                report("installFolder", 30, deleted_count, 0);
                match backup_manager::delete_path(&path, settings.use_recycle_bin) {
                    Ok(recycled) => {
                        if recycled {
                            deleted.push(path.display().to_string());
                            deleted_count += 1;
                        } else {
                            deleted.push(path.display().to_string());
                            deleted_count += 1;
                        }
                    }
                    Err(error) => failed.push(crate::app_model::FailedItem {
                        id: format!("{}#install", app.id),
                        path: path.display().to_string(),
                        reason: error.to_string(),
                    }),
                }
            }
        }

        // 6. User-data folders, services, tasks and shortcuts the scanner already enumerated.
        let ordered: Vec<&crate::app_model::LeftoverItem> = items.iter().collect();
        let scanned_items_count = ordered.len();
        let total_steps = scanned_items_count.max(1);
        let counter = AtomicUsize::new(0);
        for item in &ordered {
            let progress_idx = counter.fetch_add(1, Ordering::Relaxed);
            let pct = 40 + ((progress_idx * 50) / total_steps) as u8;
            report("leftovers", pct, deleted_count, 0);
            let result = match item.category {
                crate::app_model::LeftoverCategory::Registry => backup_manager::delete_key(&item.path).map(|_| false),
                crate::app_model::LeftoverCategory::Service => backup_manager::delete_service(&item.path),
                crate::app_model::LeftoverCategory::Task => backup_manager::delete_task(&item.path),
                _ => backup_manager::delete_path(std::path::Path::new(&item.path), settings.use_recycle_bin),
            };
            match result {
                Ok(_recycled) => {
                    deleted.push(item.path.clone());
                    deleted_count += 1;
                }
                Err(error) => failed.push(crate::app_model::FailedItem {
                    id: item.id.clone(),
                    path: item.path.clone(),
                    reason: error.to_string(),
                }),
            }
        }

        // 7. Drop the app from the local list only if everything important succeeded.
        let registry_removed = deleted.iter().any(|p| p.eq_ignore_ascii_case(&app.registry_path));
        let folder_removed = app
            .install_location
            .as_deref()
            .map(|loc| deleted.iter().any(|p| p.eq_ignore_ascii_case(loc)))
            .unwrap_or(false);
        if registry_removed || folder_removed || failed.is_empty() {
            archive_app(state, &app.id);
        }

        let recycled = 0; // currently every successful path lands in the recycle bin only when explicitly enabled.
        let moved_bytes = 0;
        report("done", 100, deleted_count, recycled);
        push_log(
            state,
            "warn",
            format!(
                "Force removed {}: {} items deleted, {} failed",
                app.name,
                deleted_count,
                failed.len()
            ),
        );

        Ok(ForceRemoveResult {
            app_id: app.id.clone(),
            app_name: app.name.clone(),
            deleted,
            failed,
            recycled,
            moved_bytes,
            duration_ms: started.elapsed().as_millis(),
            backup,
            items,
            locked_paths,
        })
    })
    .await
    .map_err(|e| AppError::Other(format!("force-remove worker failed: {e}")))?
}

#[tauri::command]
pub async fn delete_leftovers(app_handle: AppHandle, args: DeleteLeftoversArgs) -> AppResult<DeleteLeftoversResult> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app_handle.state::<AppState>();
        let state = state.inner();
        let app = find_app(state, &args.app_id)?;
        if app.is_system_component || app.is_update {
            return Err(AppError::ProtectedPath(format!("refusing to delete leftovers of system component/update {}", app.name)));
        }
        let scan = state
            .last_scans
            .lock()
            .get(&args.app_id)
            .cloned()
            .ok_or_else(|| AppError::Other("no scan result cached; run a scan first".into()))?;
        // Only item ids from the cached scan are accepted; UI-provided paths are never trusted.
        let items: Vec<LeftoverItem> = scan
            .items
            .into_iter()
            .filter(|i| args.item_ids.contains(&i.id) && i.risk != Risk::Protected)
            .collect();
        let use_bin = state.settings.lock().use_recycle_bin;
        let result = backup_manager::delete_leftovers(&backup_dir(state), &app.id, &app.name, &items, use_bin)?;
        if items.iter().any(|i| i.path.eq_ignore_ascii_case(&app.registry_path) && result.deleted.contains(&i.id)) {
            archive_app(state, &app.id);
        }
        push_log(state, "warn", format!("Deleted {} leftovers of {} ({} failed, {} recycled)", result.deleted.len(), app.name, result.failed.len(), result.recycled));
        Ok(result)
    })
    .await
    .map_err(|e| AppError::Other(format!("cleanup worker failed: {e}")))?
}

/// Remove only the Uninstall registry key (the entry disappears from the list; files stay).
#[tauri::command]
pub async fn delete_app_entry(app_handle: AppHandle, app_id: String) -> AppResult<BackupInfo> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app_handle.state::<AppState>();
        let state = state.inner();
        let app = find_app(state, &app_id)?;
        if app.kind == AppKind::Store || app.is_system_component || app.is_update {
            return Err(AppError::ProtectedPath(format!("refusing to remove the installed-list entry for {}", app.name)));
        }
        // Abort before deleting if a complete registry backup cannot be produced.
        let backup = backup_manager::backup_keys(&backup_dir(state), &app.id, &app.name, BackupKind::Registry, std::slice::from_ref(&app.registry_path))?;
        backup_manager::delete_key(&app.registry_path)?;
        archive_app(state, &app_id);
        push_log(state, "warn", format!("Deleted registry entry {} (backup {})", app.registry_path, backup.path));
        Ok(backup)
    })
    .await
    .map_err(|e| AppError::Other(format!("registry operation worker failed: {e}")))?
}

#[tauri::command]
pub async fn open_install_location(state: State<'_, AppState>, app_id: String) -> AppResult<()> {
    let app = find_app(state.inner(), &app_id)?;
    let loc = app.install_location.ok_or_else(|| AppError::PathNotFound("no install location".into()))?;
    if !Path::new(&loc).is_dir() {
        return Err(AppError::PathNotFound(loc));
    }
    std::process::Command::new("explorer.exe").arg(&loc).spawn()?;
    Ok(())
}

#[tauri::command]
pub async fn reveal_path(path: String) -> AppResult<()> {
    if !Path::new(&path).exists() {
        return Err(AppError::PathNotFound(path));
    }
    std::process::Command::new("explorer.exe").arg(format!("/select,{path}")).spawn()?;
    Ok(())
}

/// Opens regedit at the given key by priming its `LastKey` value.
#[tauri::command]
pub async fn open_registry_key(path: String) -> AppResult<()> {
    #[cfg(windows)]
    {
        use winreg::enums::*;
        use winreg::RegKey;
        let full = path.replacen("HKLM\\", "HKEY_LOCAL_MACHINE\\", 1).replacen("HKCU\\", "HKEY_CURRENT_USER\\", 1);
        let (key, _) = RegKey::predef(HKEY_CURRENT_USER).create_subkey(r"Software\Microsoft\Windows\CurrentVersion\Applets\Regedit").map_err(|e| AppError::Registry(e.to_string()))?;
        key.set_value("LastKey", &full).map_err(|e| AppError::Registry(e.to_string()))?;
    }
    std::process::Command::new("regedit.exe").arg("/m").spawn()?;
    Ok(())
}

#[tauri::command]
pub async fn open_external(url: String) -> AppResult<()> {
    let trimmed = url.trim();
    let lower = trimmed.to_ascii_lowercase();
    let allowed = ["https://", "http://", "mailto:", "tel:", "ms-windows-store://"];
    if trimmed.is_empty()
        || trimmed.len() > 4096
        || trimmed.chars().any(char::is_control)
        || !allowed.iter().any(|scheme| lower.starts_with(scheme))
    {
        return Err(AppError::InvalidCommand("unsupported external URL scheme".into()));
    }
    tauri_plugin_opener::open_url(trimmed, None::<&str>).map_err(|e| AppError::Other(format!("could not open URL: {e}")))
}

#[tauri::command]
pub async fn export_apps(state: State<'_, AppState>, request: ExportRequest) -> AppResult<ExportResult> {
    let state = state.inner();
    let apps = state.apps.lock();
    let selected: Vec<InstalledApp> = match &request.app_ids {
        Some(ids) => apps.iter().filter(|a| ids.contains(&a.id)).cloned().collect(),
        None => apps.clone(),
    };
    drop(apps);
    let content = exporter::build(&selected, request.format, &request.fields, request.labels.as_ref());
    let file_name = format!("installed-software-{}.{}", chrono::Local::now().format("%Y%m%d-%H%M%S"), exporter::extension(request.format));
    let (path, inline) = match &request.path {
        Some(p) => {
            std::fs::write(p, &content)?;
            (Some(p.clone()), None)
        }
        None => (None, Some(content)),
    };
    push_log(state, "info", format!("Exported {} entries", selected.len()));
    Ok(ExportResult { file_name, path, content: inline, mime_type: exporter::mime(request.format).into(), count: selected.len() })
}

#[tauri::command]
pub async fn is_admin() -> AppResult<PrivilegeInfo> {
    Ok(privilege::info())
}

#[tauri::command]
pub async fn request_elevation() -> AppResult<bool> {
    if privilege::is_elevated() {
        return Ok(true);
    }
    privilege::relaunch_elevated()
}

#[tauri::command]
pub async fn get_settings(state: State<'_, AppState>) -> AppResult<Settings> {
    Ok(state.inner().settings.lock().clone())
}

#[tauri::command]
pub async fn save_settings(state: State<'_, AppState>, mut settings: Settings) -> AppResult<()> {
    let state = state.inner();
    let previous = state.settings.lock().clone();
    settings.portable_mode = cfg!(feature = "portable") || settings.portable_mode;
    let old_default_backup = previous.backup_directory == data_dir().join("backups").display().to_string();
    let dir = if settings.portable_mode { portable_dir() } else { app_dir() };
    if old_default_backup {
        settings.backup_directory = dir.join("backups").display().to_string();
    }
    std::fs::create_dir_all(&dir)?;
    std::fs::write(dir.join("settings.json"), serde_json::to_vec_pretty(&settings)?)?;
    if !settings.portable_mode && !cfg!(feature = "portable") {
        let portable_settings = portable_dir().join("settings.json");
        if portable_settings != dir.join("settings.json") {
            let _ = std::fs::remove_file(portable_settings);
        }
    }
    *state.settings.lock() = settings;
    Ok(())
}

#[tauri::command]
pub async fn list_backups(state: State<'_, AppState>) -> AppResult<Vec<BackupInfo>> {
    Ok(backup_manager::list_backups(&backup_dir(state.inner())))
}

#[tauri::command]
pub async fn restore_backup(app_handle: AppHandle, backup_id: String) -> AppResult<()> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app_handle.state::<AppState>();
        let state = state.inner();
        backup_manager::restore(&backup_dir(state), &backup_id)?;
        push_log(state, "info", format!("Restored backup {backup_id}"));
        Ok(())
    })
    .await
    .map_err(|e| AppError::Other(format!("backup restore worker failed: {e}")))?
}

#[tauri::command]
pub async fn get_logs(state: State<'_, AppState>) -> AppResult<Vec<LogEntry>> {
    Ok(state.inner().logs.lock().iter().cloned().collect())
}




