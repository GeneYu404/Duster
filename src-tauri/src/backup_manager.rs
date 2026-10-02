//! Backups before any destructive operation, plus the actual delete/restore primitives.
//!
//! * Registry keys are exported recursively to a JSON document (lossless: raw bytes + type)
//!   and additionally as a human readable `.reg` file.
//! * Files / folders go to the Recycle Bin through the `trash` crate (unless disabled).
//! * `restore()` re-creates keys from the JSON snapshot.

use crate::app_model::{BackupInfo, BackupKind, DeleteLeftoversResult, FailedItem, LeftoverCategory, LeftoverItem};
use crate::error::{AppError, AppResult};
use crate::leftover_scanner::is_protected;
use crate::privilege;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

#[cfg(windows)]
use winreg::enums::*;
#[cfg(windows)]
use winreg::{RegKey, RegValue, HKEY};

#[derive(Debug, Serialize, Deserialize)]
pub struct KeySnapshot {
    pub path: String,
    pub values: Vec<ValueSnapshot>,
    pub subkeys: Vec<KeySnapshot>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ValueSnapshot {
    pub name: String,
    pub vtype: u32,
    pub data: Vec<u8>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct BackupFile {
    pub info: BackupInfo,
    pub keys: Vec<KeySnapshot>,
}

#[cfg(windows)]
fn split_path(path: &str) -> AppResult<(HKEY, &'static str, String, u32)> {
    let (hive, rest) = path.split_once('\\').ok_or_else(|| AppError::Registry(format!("bad key path {path}")))?;
    let (hkey, name) = match hive.to_uppercase().as_str() {
        "HKLM" | "HKEY_LOCAL_MACHINE" => (HKEY_LOCAL_MACHINE, "HKEY_LOCAL_MACHINE"),
        "HKCU" | "HKEY_CURRENT_USER" => (HKEY_CURRENT_USER, "HKEY_CURRENT_USER"),
        "HKCR" | "HKEY_CLASSES_ROOT" => (HKEY_CLASSES_ROOT, "HKEY_CLASSES_ROOT"),
        other => return Err(AppError::Registry(format!("unsupported hive {other}"))),
    };
    // WOW6432Node in the display path means "32-bit view of the un-redirected path".
    let lower_rest = rest.to_ascii_lowercase();
    let (sub, flag) = match lower_rest.find("wow6432node\\") {
        Some(i) => (format!("{}{}", &rest[..i], &rest[i + "WOW6432Node\\".len()..]), KEY_WOW64_32KEY),
        _ => (rest.to_string(), KEY_WOW64_64KEY),
    };
    Ok((hkey, name, sub, flag))
}

/// Keys we never delete, regardless of what a scanner suggests.
pub fn is_protected_key(path: &str) -> bool {
    let p = path.to_lowercase();
    let sub = p.split_once('\\').map(|x| x.1).unwrap_or("");
    let depth = sub.split('\\').filter(|s| !s.is_empty()).count();
    depth < 3
        || sub == r"software\microsoft\windows\currentversion\uninstall"
        || sub == r"software\wow6432node\microsoft\windows\currentversion\uninstall"
        || sub.starts_with(r"software\microsoft\windows nt")
        || sub.starts_with(r"system\currentcontrolset\control")
        || sub == r"software\microsoft"
        || sub == r"software\classes"
}

#[cfg(windows)]
pub fn snapshot_key(path: &str) -> AppResult<KeySnapshot> {
    let (hkey, _, sub, flag) = split_path(path)?;
    let key = RegKey::predef(hkey).open_subkey_with_flags(&sub, KEY_READ | flag).map_err(|e| AppError::Registry(format!("{path}: {e}")))?;
    snapshot_rec(&key, path, flag)
}

#[cfg(windows)]
fn snapshot_rec(key: &RegKey, path: &str, flag: u32) -> AppResult<KeySnapshot> {
    // winreg ≥0.53 hands out `Cow<[u8]>`; snapshots own their bytes so they stay serde-friendly.
    let values = key.enum_values().flatten().map(|(name, v)| ValueSnapshot { name, vtype: v.vtype as u32, data: v.bytes.into_owned() }).collect();
    let mut subkeys = Vec::new();
    for name in key.enum_keys().flatten() {
        if let Ok(sub) = key.open_subkey_with_flags(&name, KEY_READ | flag) {
            subkeys.push(snapshot_rec(&sub, &format!("{path}\\{name}"), flag)?);
        }
    }
    Ok(KeySnapshot { path: path.to_string(), values, subkeys })
}

fn reg_text(snap: &KeySnapshot, out: &mut String) {
    let full = snap
        .path
        .replacen("HKLM\\", "HKEY_LOCAL_MACHINE\\", 1)
        .replacen("HKCU\\", "HKEY_CURRENT_USER\\", 1)
        .replacen("HKCR\\", "HKEY_CLASSES_ROOT\\", 1);
    out.push_str(&format!("\r\n[{full}]\r\n"));
    for v in &snap.values {
        let name = if v.name.is_empty() { "@".to_string() } else { format!("\"{}\"", v.name.replace('\\', "\\\\").replace('"', "\\\"")) };
        match v.vtype {
            1 => {
                let wide: Vec<u16> = v.data.chunks_exact(2).map(|b| u16::from_le_bytes([b[0], b[1]])).collect();
                let s = String::from_utf16_lossy(&wide).trim_end_matches('\0').replace('\\', "\\\\").replace('"', "\\\"");
                out.push_str(&format!("{name}=\"{s}\"\r\n"));
            }
            4 if v.data.len() >= 4 => out.push_str(&format!("{name}=dword:{:08x}\r\n", u32::from_le_bytes([v.data[0], v.data[1], v.data[2], v.data[3]]))),
            t => {
                let hex: Vec<String> = v.data.iter().map(|b| format!("{b:02x}")).collect();
                out.push_str(&format!("{name}=hex({t:x}):{}\r\n", hex.join(",")));
            }
        }
    }
    for s in &snap.subkeys {
        reg_text(s, out);
    }
}

fn backup_file_name(dir: &Path, app_id: &str, ext: &str) -> PathBuf {
    dir.join(format!("{}_{}.{}", chrono::Local::now().format("%Y%m%d-%H%M%S"), app_id, ext))
}

fn quote_windows_arg(value: &str) -> String {
    if !value.chars().any(|c| c.is_whitespace() || c == '"') {
        return value.to_string();
    }
    let mut out = String::from("\"");
    let mut slashes = 0usize;
    for c in value.chars() {
        if c == '\\' {
            slashes += 1;
        } else if c == '"' {
            out.push_str(&"\\".repeat(slashes * 2 + 1));
            out.push('"');
            slashes = 0;
        } else {
            out.push_str(&"\\".repeat(slashes));
            out.push(c);
            slashes = 0;
        }
    }
    out.push_str(&"\\".repeat(slashes * 2));
    out.push('"');
    out
}

fn write_reg_file(path: &Path, keys: &[KeySnapshot]) -> AppResult<()> {
    let mut reg = String::from("Windows Registry Editor Version 5.00\r\n");
    for key in keys {
        reg_text(key, &mut reg);
    }
    let mut bytes = vec![0xFF, 0xFE];
    for code_unit in reg.encode_utf16() {
        bytes.extend_from_slice(&code_unit.to_le_bytes());
    }
    std::fs::write(path, bytes)?;
    Ok(())
}

/// Export `keys` to `<backup_dir>/<timestamp>_<app>.json` (+ `.reg`). Keys that do not exist are skipped.
pub fn backup_keys(backup_dir: &Path, app_id: &str, app_name: &str, kind: BackupKind, keys: &[String]) -> AppResult<BackupInfo> {
    std::fs::create_dir_all(backup_dir)?;
    let mut snapshots = Vec::new();
    #[cfg(windows)]
    for k in keys {
        snapshots.push(snapshot_key(k)?);
    }
    #[cfg(not(windows))]
    if !keys.is_empty() {
        return Err(AppError::Other("registry backups are only supported on Windows".into()));
    }
    let json_path = backup_file_name(backup_dir, app_id, "json");
    let info = BackupInfo {
        id: json_path.file_stem().unwrap_or_default().to_string_lossy().to_string(),
        created_at: chrono::Local::now().to_rfc3339(),
        app_id: app_id.to_string(),
        app_name: app_name.to_string(),
        kind,
        path: json_path.display().to_string(),
        keys: snapshots.iter().map(|s| s.path.clone()).collect(),
        restorable: !snapshots.is_empty(),
    };
    let file = BackupFile { info: info.clone(), keys: snapshots };
    std::fs::write(&json_path, serde_json::to_vec_pretty(&file)?)?;
    write_reg_file(&json_path.with_extension("reg"), &file.keys)?;
    tracing::info!(path = %info.path, keys = info.keys.len(), "backup written");
    Ok(info)
}

pub fn list_backups(backup_dir: &Path) -> Vec<BackupInfo> {
    let mut out = Vec::new();
    if let Ok(rd) = std::fs::read_dir(backup_dir) {
        for e in rd.flatten() {
            let p = e.path();
            if p.extension().map(|x| x == "json").unwrap_or(false) {
                if let Ok(file) = std::fs::read(&p).map_err(|_| ()).and_then(|b| serde_json::from_slice::<BackupFile>(&b).map_err(|_| ())) {
                    out.push(file.info);
                }
            }
        }
    }
    out.sort_by(|a, b| b.created_at.cmp(&a.created_at));
    out
}

pub fn restore(backup_dir: &Path, backup_id: &str) -> AppResult<()> {
    if backup_id.is_empty() || !backup_id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
        return Err(AppError::BackupNotFound(backup_id.into()));
    }
    let path = backup_dir.join(format!("{backup_id}.json"));
    let file: BackupFile = serde_json::from_slice(&std::fs::read(&path).map_err(|_| AppError::BackupNotFound(backup_id.into()))?)?;
    #[cfg(windows)]
    for snap in &file.keys {
        restore_snapshot(snap)?;
    }
    tracing::info!(backup = backup_id, keys = file.keys.len(), "backup restored");
    Ok(())
}

#[cfg(windows)]
fn restore_rec(snap: &KeySnapshot) -> AppResult<()> {
    let (hkey, _, sub, flag) = split_path(&snap.path)?;
    let (key, _) = RegKey::predef(hkey).create_subkey_with_flags(&sub, KEY_ALL_ACCESS | flag).map_err(|e| AppError::Registry(format!("{}: {e}", snap.path)))?;
    for v in &snap.values {
        let vtype = reg_type_from_u32(v.vtype)?;
        // RegValue wants a Cow; the snapshot owns its bytes, so move a clone in.
        let value = RegValue { bytes: std::borrow::Cow::Owned(v.data.clone()), vtype };
        key.set_raw_value(&v.name, &value).map_err(|e| AppError::Registry(format!("{}\\{}: {e}", snap.path, v.name)))?;
    }
    for s in &snap.subkeys {
        restore_rec(s)?;
    }
    Ok(())
}

#[cfg(windows)]
fn restore_snapshot(snap: &KeySnapshot) -> AppResult<()> {
    let (hive, _, _, _) = split_path(&snap.path)?;
    if hive != HKEY_LOCAL_MACHINE || privilege::is_elevated() {
        return restore_rec(snap);
    }

    // Import one key tree at a time so HKCU data is never accidentally written to
    // another administrator account when a standard user supplies UAC credentials.
    let temp = std::env::temp_dir().join(format!(
        "duster-restore-{}-{}.reg",
        std::process::id(),
        chrono::Local::now().timestamp_nanos_opt().unwrap_or_default()
    ));
    write_reg_file(&temp, std::slice::from_ref(snap))?;
    let args = format!("import {}", quote_windows_arg(&temp.to_string_lossy()));
    let result = privilege::run_elevated_process("reg.exe", &args);
    let _ = std::fs::remove_file(&temp);
    let code = result?;
    if code != 0 {
        return Err(AppError::Registry(format!("reg.exe import exited with {code}")));
    }
    Ok(())
}

#[cfg(windows)]
fn reg_type_from_u32(raw: u32) -> AppResult<RegType> {
    let value = match raw {
        0 => REG_NONE,
        1 => REG_SZ,
        2 => REG_EXPAND_SZ,
        3 => REG_BINARY,
        4 => REG_DWORD,
        5 => REG_DWORD_BIG_ENDIAN,
        6 => REG_LINK,
        7 => REG_MULTI_SZ,
        8 => REG_RESOURCE_LIST,
        9 => REG_FULL_RESOURCE_DESCRIPTOR,
        10 => REG_RESOURCE_REQUIREMENTS_LIST,
        11 => REG_QWORD,
        _ => return Err(AppError::Backup(format!("unsupported registry value type {raw}"))),
    };
    Ok(value)
}

/// Delete a registry key tree. Refuses protected keys.
pub fn delete_key(path: &str) -> AppResult<()> {
    if is_protected_key(path) {
        return Err(AppError::ProtectedPath(path.into()));
    }
    #[cfg(windows)]
    {
        let (hkey, _, sub, flag) = split_path(path)?;
        if hkey == HKEY_LOCAL_MACHINE && !privilege::is_elevated() {
            let hive_name = "HKLM";
            let key_path = format!("{hive_name}\\{sub}");
            let view = if flag == KEY_WOW64_32KEY { " /reg:32" } else { " /reg:64" };
            let args = format!("delete {} /f{view}", quote_windows_arg(&key_path));
            let code = privilege::run_elevated_process("reg.exe", &args)?;
            if code != 0 {
                return Err(AppError::Registry(format!("reg.exe delete exited with {code}: {path}")));
            }
            tracing::warn!(key = path, "registry key deleted by elevated reg.exe");
            return Ok(());
        }
        let (parent, leaf) = sub.rsplit_once('\\').ok_or_else(|| AppError::ProtectedPath(path.into()))?;
        let parent_key = RegKey::predef(hkey).open_subkey_with_flags(parent, KEY_ALL_ACCESS | flag).map_err(|e| AppError::Registry(format!("{path}: {e}")))?;
        parent_key.delete_subkey_all(leaf).map_err(|e| AppError::Registry(format!("{path}: {e}")))?;
    }
    #[cfg(not(windows))]
    return Err(AppError::Other("registry deletion is only supported on Windows".into()));
    tracing::warn!(key = path, "registry key deleted");
    Ok(())
}

/// Delete a file or directory, preferring the Recycle Bin. Refuses protected roots.
pub fn delete_path(path: &Path, use_recycle_bin: bool) -> AppResult<bool> {
    let meta = std::fs::symlink_metadata(path).map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            AppError::PathNotFound(path.display().to_string())
        } else {
            AppError::Io(e)
        }
    })?;
    if meta.file_type().is_symlink() {
        return Err(AppError::ProtectedPath(format!("refusing to remove a reparse point: {}", path.display())));
    }
    if is_protected(path) || path.canonicalize().map(|p| is_protected(&p)).unwrap_or(true) {
        return Err(AppError::ProtectedPath(path.display().to_string()));
    }
    if use_recycle_bin {
        match trash::delete(path) {
            Ok(()) => {
                tracing::warn!(path = %path.display(), "moved to recycle bin");
                return Ok(true);
            }
            Err(error) if !privilege::is_elevated() => {
                if !path.exists() {
                    return Ok(true);
                }
                let path_text = path.to_string_lossy().replace('\'', "''");
                let operation = if meta.is_dir() { "DeleteDirectory" } else { "DeleteFile" };
                let script = format!(
                    "Add-Type -AssemblyName Microsoft.VisualBasic; [Microsoft.VisualBasic.FileIO.FileSystem]::{operation}('{path_text}', [Microsoft.VisualBasic.FileIO.UIOption]::OnlyErrorDialogs, [Microsoft.VisualBasic.FileIO.RecycleOption]::SendToRecycleBin)"
                );
                let args = format!("-NoProfile -NonInteractive -Command {}", quote_windows_arg(&script));
                let code = privilege::run_elevated_process("powershell.exe", &args).map_err(|e| AppError::Other(format!("recycle failed ({error}); elevation failed: {e}")))?;
                if code != 0 {
                    return Err(AppError::Other(format!("elevated recycle helper exited with {code}: {}", path.display())));
                }
                tracing::warn!(path = %path.display(), "moved to recycle bin by elevated helper");
                Ok(true)
            }
            Err(error) => Err(AppError::Other(format!("recycle failed: {error}"))),
        }
    } else if meta.is_dir() {
        match std::fs::remove_dir_all(path) {
            Ok(()) => Ok(false),
            Err(error) if error.kind() == std::io::ErrorKind::PermissionDenied && !privilege::is_elevated() => {
                elevated_remove_path(path, true)
            }
            Err(error) => Err(AppError::Io(error)),
        }
    } else {
        match std::fs::remove_file(path) {
            Ok(()) => Ok(false),
            Err(error) if error.kind() == std::io::ErrorKind::PermissionDenied && !privilege::is_elevated() => {
                elevated_remove_path(path, false)
            }
            Err(error) => Err(AppError::Io(error)),
        }
    }
}

fn elevated_remove_path(path: &Path, recursive: bool) -> AppResult<bool> {
    let path_text = path.to_string_lossy().replace('\'', "''");
    let recursive_arg = if recursive { " -Recurse" } else { "" };
    let script = format!("$ErrorActionPreference='Stop'; Remove-Item -LiteralPath '{path_text}'{recursive_arg} -Force");
    let args = format!("-NoProfile -NonInteractive -Command {}", quote_windows_arg(&script));
    let code = privilege::run_elevated_process("powershell.exe", &args)?;
    if code != 0 {
        return Err(AppError::Other(format!("elevated delete helper exited with {code}: {}", path.display())));
    }
    tracing::warn!(path = %path.display(), "deleted permanently by elevated helper");
    Ok(false)
}

pub fn delete_service(path: &str) -> AppResult<bool> {
    let prefix = r"HKLM\SYSTEM\CurrentControlSet\Services\";
    let Some(name) = path.strip_prefix(prefix) else {
        return Err(AppError::ProtectedPath(path.into()));
    };
    if name.is_empty() || name.contains('\\') || name.chars().any(|c| !(c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '.'))) {
        return Err(AppError::ProtectedPath(path.into()));
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        if privilege::is_elevated() {
            // SCM marks running services for deletion; it is safer than stopping them abruptly.
            let status = std::process::Command::new("sc.exe")
                .args(["delete", name])
                .creation_flags(CREATE_NO_WINDOW)
                .status()
                .map_err(AppError::Io)?;
            if !status.success() {
                return Err(AppError::Process(format!("sc.exe delete {name} exited with {:?}", status.code())));
            }
        } else {
            let code = privilege::run_elevated_process("sc.exe", &format!("delete {}", quote_windows_arg(name)))?;
            if code != 0 {
                return Err(AppError::Process(format!("elevated sc.exe delete {name} exited with {code}")));
            }
        }
        Ok(false)
    }
    #[cfg(not(windows))]
    {
        Err(AppError::Other("service deletion is only supported on Windows".into()))
    }
}

/// Delete the selected leftover items after writing a backup of every registry key involved.
pub fn delete_leftovers(backup_dir: &Path, app_id: &str, app_name: &str, items: &[LeftoverItem], use_recycle_bin: bool) -> AppResult<DeleteLeftoversResult> {
    let reg_keys: Vec<String> = items.iter().filter(|i| matches!(i.category, LeftoverCategory::Registry | LeftoverCategory::Service)).map(|i| i.path.clone()).collect();
    let backup = if reg_keys.is_empty() { None } else { Some(backup_keys(backup_dir, app_id, app_name, BackupKind::Leftovers, &reg_keys)?) };

    let mut deleted = Vec::new();
    let mut failed = Vec::new();
    let mut recycled = 0usize;
    // Files first (deepest paths first so children go before parents), then registry.
    let mut ordered: Vec<&LeftoverItem> = items.iter().collect();
    ordered.sort_by_key(|i| std::cmp::Reverse(i.path.len()));
    for item in ordered {
        let result = match item.category {
            LeftoverCategory::Registry => delete_key(&item.path).map(|_| false),
            LeftoverCategory::Service => delete_service(&item.path),
            LeftoverCategory::Task => {
                delete_task(&item.path)
            }
            _ => delete_path(Path::new(&item.path), use_recycle_bin),
        };
        match result {
            Ok(was_recycled) => {
                if was_recycled {
                    recycled += 1;
                }
                deleted.push(item.id.clone());
            }
            Err(e) => failed.push(FailedItem { id: item.id.clone(), path: item.path.clone(), reason: e.to_string() }),
        }
    }
    Ok(DeleteLeftoversResult { deleted, failed, recycled, backup })
}

pub fn delete_task(path: &str) -> AppResult<bool> {
    let lower = path.to_ascii_lowercase();
    let marker = "\\tasks\\";
    let Some(offset) = lower.find(marker) else {
        return Err(AppError::ProtectedPath(path.into()));
    };
    let relative = &path[offset + marker.len()..];
    if relative.is_empty() || relative.split(|c| c == '\\' || c == '/').any(|part| part == "..") {
        return Err(AppError::ProtectedPath(path.into()));
    }
    let task_name = format!("\\{}", relative.replace('/', "\\"));
    let parameters = format!("/Delete /TN {} /F", quote_windows_arg(&task_name));
    #[cfg(windows)]
    {
        if privilege::is_elevated() {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            let status = std::process::Command::new("schtasks.exe")
                .args(["/Delete", "/TN", task_name.as_str(), "/F"])
                .creation_flags(CREATE_NO_WINDOW)
                .status()
                .map_err(AppError::Io)?;
            if !status.success() {
                return Err(AppError::Process(format!("schtasks exited with {:?}", status.code())));
            }
        } else {
            let code = privilege::run_elevated_process("schtasks.exe", &parameters)?;
            if code != 0 {
                return Err(AppError::Process(format!("elevated schtasks exited with {code}")));
            }
        }
        Ok(false)
    }
    #[cfg(not(windows))]
    {
        let _ = parameters;
        Err(AppError::Other("scheduled task deletion is only supported on Windows".into()))
    }
}
