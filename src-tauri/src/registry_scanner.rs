//! Enumerates installed software from the registry Uninstall keys.
//!
//! Sources (all read, then de-duplicated):
//!   * HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall            (KEY_WOW64_64KEY)
//!   * HKLM\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall (via KEY_WOW64_32KEY)
//!   * HKCU\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall
//!   * optional: AppX / MSIX packages (Microsoft Store) through PowerShell `Get-AppxPackage`
//!
//! Only reading happens here; deletion lives in `backup_manager`.

use crate::app_model::*;
use regex::Regex;
use std::collections::BTreeMap;
use std::sync::OnceLock;

#[cfg(windows)]
use winreg::enums::*;
#[cfg(windows)]
use winreg::{RegKey, RegValue, HKEY};

pub const UNINSTALL_SUBKEY: &str = r"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall";
pub const UNINSTALL_SUBKEY_WOW: &str = r"SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall";

fn guid_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"\{[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}\}").unwrap())
}

/// Raw values of one Uninstall sub-key, kept as strings for the detail view.
#[derive(Debug, Default, Clone)]
pub struct RawEntry {
    pub values: BTreeMap<String, String>,
}

impl RawEntry {
    fn get(&self, name: &str) -> Option<String> {
        self.values.get(name).map(|s| s.trim().to_string()).filter(|s| !s.is_empty())
    }
    fn dword(&self, name: &str) -> Option<u32> {
        self.values.get(name).and_then(|s| s.parse::<u32>().ok())
    }
}

/// Scan every source and return a de-duplicated list, plus raw values keyed by app id
/// (cached by the command layer for `get_app_detail`).
pub fn scan_all(include_store: bool) -> (Vec<InstalledApp>, BTreeMap<String, RawEntry>) {
    let mut apps: Vec<InstalledApp> = Vec::new();
    let mut raw: BTreeMap<String, RawEntry> = BTreeMap::new();

    #[cfg(windows)]
    {
        let sources: [(HKEY, u32, RegistryView, Hive, &str); 4] = [
            (HKEY_LOCAL_MACHINE, KEY_WOW64_64KEY, RegistryView::X64, Hive::Hklm, UNINSTALL_SUBKEY),
            (HKEY_LOCAL_MACHINE, KEY_WOW64_32KEY, RegistryView::X86, Hive::Hklm, UNINSTALL_SUBKEY_WOW),
            (HKEY_CURRENT_USER, KEY_WOW64_64KEY, RegistryView::X64, Hive::Hkcu, UNINSTALL_SUBKEY),
            (HKEY_CURRENT_USER, KEY_WOW64_32KEY, RegistryView::X86, Hive::Hkcu, UNINSTALL_SUBKEY_WOW),
        ];
        for (hive, flag, view, hive_kind, display_path) in sources {
            // Open the base key and let the WOW64 flag choose the registry view.
            let Ok(root) = RegKey::predef(hive).open_subkey_with_flags(UNINSTALL_SUBKEY, KEY_READ | flag) else {
                continue;
            };
            let hive_name = match hive_kind {
                Hive::Hklm => "HKLM",
                Hive::Hkcu => "HKCU",
            };
            for key_name in root.enum_keys().flatten() {
                let Ok(sub) = root.open_subkey_with_flags(&key_name, KEY_READ | flag) else { continue };
                let entry = read_entry(&sub);
                let registry_path = format!(r"{hive_name}\{display_path}\{key_name}");
                if let Some(app) = build_app(&key_name, &registry_path, hive_kind, view, &entry) {
                    raw.insert(app.id.clone(), entry);
                    apps.push(app);
                }
            }
        }
    }

    if include_store {
        for app in scan_store_apps() {
            apps.push(app);
        }
    }

    (dedupe(apps), raw)
}

#[cfg(windows)]
fn read_entry(key: &RegKey) -> RawEntry {
    let mut values = BTreeMap::new();
    for (name, value) in key.enum_values().flatten() {
        if let Some(s) = reg_value_to_string(&value) {
            values.insert(if name.is_empty() { "(Default)".into() } else { name }, s);
        }
    }
    RawEntry { values }
}

#[cfg(windows)]
fn reg_value_to_string(v: &RegValue) -> Option<String> {
    match v.vtype {
        REG_SZ | REG_EXPAND_SZ | REG_MULTI_SZ => {
            let wide: Vec<u16> = v.bytes.chunks_exact(2).map(|c| u16::from_le_bytes([c[0], c[1]])).collect();
            let s = String::from_utf16_lossy(&wide);
            Some(s.trim_end_matches('\0').replace('\0', " | "))
        }
        REG_DWORD => v.bytes.get(..4).map(|b| u32::from_le_bytes([b[0], b[1], b[2], b[3]]).to_string()),
        REG_QWORD => v.bytes.get(..8).map(|b| u64::from_le_bytes(b.try_into().unwrap()).to_string()),
        REG_BINARY => Some(v.bytes.iter().take(32).map(|b| format!("{b:02x}")).collect::<Vec<_>>().join(" ")),
        _ => None,
    }
}

/// Build the typed model from raw values. Returns `None` for keys without a DisplayName
/// (these are never shown by Control Panel either).
pub fn build_app(key_name: &str, registry_path: &str, hive: Hive, view: RegistryView, e: &RawEntry) -> Option<InstalledApp> {
    let name = e.get("DisplayName")?;

    let is_system_component = e.dword("SystemComponent") == Some(1);
    let release_type = e.get("ReleaseType").unwrap_or_default().to_lowercase();
    let is_update = e.get("ParentKeyName").is_some()
        || release_type.contains("update")
        || release_type.contains("hotfix")
        || key_name.to_uppercase().starts_with("KB")
        || name.contains("(KB");

    let uninstall_string = e.get("UninstallString").map(|s| crate::uninstaller::expand_environment(&s));
    let quiet = e.get("QuietUninstallString").map(|s| crate::uninstaller::expand_environment(&s));
    let is_msi = e.dword("WindowsInstaller") == Some(1)
        || uninstall_string.as_deref().map(|s| s.to_lowercase().contains("msiexec")).unwrap_or(false);

    let msi_product_code = guid_re()
        .find(key_name)
        .map(|m| m.as_str().to_uppercase())
        .or_else(|| uninstall_string.as_deref().and_then(|s| guid_re().find(s)).map(|m| m.as_str().to_uppercase()))
        .filter(|_| is_msi || guid_re().is_match(key_name));

    let kind = if is_update {
        AppKind::Update
    } else if is_system_component {
        AppKind::System
    } else if key_name.starts_with("Steam App ") {
        AppKind::Game
    } else if is_msi {
        AppKind::Msi
    } else {
        AppKind::Program
    };

    let architecture = match view {
        RegistryView::X86 => Architecture::X86,
        RegistryView::X64 => {
            if cfg!(target_arch = "aarch64") {
                Architecture::Arm64
            } else {
                Architecture::X64
            }
        }
    };

    let source = if key_name.starts_with("Steam App ") {
        AppSource::Steam
    } else if is_msi {
        AppSource::Msi
    } else {
        AppSource::Registry
    };

    Some(InstalledApp {
        id: stable_id(registry_path),
        name,
        version: e.get("DisplayVersion"),
        publisher: e.get("Publisher"),
        install_date: e.get("InstallDate").and_then(normalise_install_date),
        estimated_size_kb: e.dword("EstimatedSize").filter(|v| *v > 0),
        install_location: e
            .get("InstallLocation")
            .map(|s| crate::uninstaller::expand_environment(&s))
            .map(|s| s.trim_matches('"').trim_end_matches('\\').to_string())
            .filter(|s| !s.is_empty()),
        uninstall_string,
        quiet_uninstall_string: quiet,
        display_icon: e.get("DisplayIcon").map(|s| crate::uninstaller::expand_environment(&s)),
        registry_path: registry_path.to_string(),
        hive,
        registry_view: view,
        architecture,
        kind,
        is_msi,
        is_system_component,
        is_update,
        msi_product_code,
        help_link: e.get("HelpLink"),
        about_url: e.get("URLInfoAbout"),
        update_info_url: e.get("URLUpdateInfo"),
        package_full_name: None,
        source,
    })
}

/// `20240517` → `2024-05-17`; also accepts already-dashed values and `YYYY/MM/DD`.
fn normalise_install_date(raw: String) -> Option<String> {
    let digits: String = raw.chars().filter(|c| c.is_ascii_digit()).collect();
    if digits.len() == 8 {
        Some(format!("{}-{}-{}", &digits[0..4], &digits[4..6], &digits[6..8]))
    } else {
        None
    }
}

/// The same product can appear in several views (e.g. a 32-bit MSI listed under both
/// WOW6432Node and the parent key through registry reflection). Prefer the richer entry.
fn dedupe(apps: Vec<InstalledApp>) -> Vec<InstalledApp> {
    let mut seen: BTreeMap<String, InstalledApp> = BTreeMap::new();
    for app in apps {
        let key = format!(
            "{}|{}|{}",
            app.name.to_lowercase(),
            app.version.clone().unwrap_or_default().to_lowercase(),
            app.msi_product_code.clone().unwrap_or_else(|| app.registry_path.to_lowercase())
        );
        match seen.get(&key) {
            Some(existing) if richness(existing) >= richness(&app) => {}
            _ => {
                seen.insert(key, app);
            }
        }
    }
    let mut out: Vec<InstalledApp> = seen.into_values().collect();
    out.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    out
}

fn richness(a: &InstalledApp) -> u8 {
    let mut n = 0;
    if a.install_location.is_some() {
        n += 1;
    }
    if a.estimated_size_kb.is_some() {
        n += 1;
    }
    if a.display_icon.is_some() {
        n += 1;
    }
    if a.quiet_uninstall_string.is_some() {
        n += 1;
    }
    n
}

/// Microsoft Store / UWP apps via PowerShell (no WinRT projection needed). Errors are
/// swallowed on purpose: the feature is optional and must never break the main list.
pub fn scan_store_apps() -> Vec<InstalledApp> {
    #[cfg(not(windows))]
    {
        return Vec::new();
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        let script = "Get-AppxPackage | Where-Object { -not $_.IsFramework -and -not $_.NonRemovable -and $_.SignatureKind -ne 'System' } | \
                      Select-Object Name, PackageFullName, PackageFamilyName, Publisher, Version, InstallLocation, Architecture | ConvertTo-Json -Compress";
        let output = std::process::Command::new("powershell.exe")
            .args(["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script])
            .creation_flags(CREATE_NO_WINDOW)
            .output();
        let Ok(output) = output else { return Vec::new() };
        let Ok(json) = serde_json::from_slice::<serde_json::Value>(&output.stdout) else { return Vec::new() };
        let items: Vec<serde_json::Value> = match json {
            serde_json::Value::Array(a) => a,
            v @ serde_json::Value::Object(_) => vec![v],
            _ => Vec::new(),
        };
        items
            .into_iter()
            .filter_map(|v| {
                let s = |k: &str| v.get(k).and_then(|x| x.as_str()).map(|x| x.to_string()).filter(|x| !x.is_empty());
                let full = s("PackageFullName")?;
                let family = s("PackageFamilyName").unwrap_or_default();
                let registry_path = format!(r"HKCU\SOFTWARE\Classes\Local Settings\Software\Microsoft\Windows\CurrentVersion\AppModel\Repository\Packages\{full}");
                let location = s("InstallLocation");
                let publisher = s("Publisher").map(|p| p.split(',').find_map(|part| part.trim().strip_prefix("CN=").map(|x| x.to_string())).unwrap_or(p));
                Some(InstalledApp {
                    id: stable_id(&registry_path),
                    name: s("Name").unwrap_or_else(|| full.clone()),
                    version: s("Version"),
                    publisher,
                    install_date: None,
                    // Walking every WindowsApps package on the initial list can take minutes;
                    // leave the optional estimate blank and keep enumeration responsive.
                    estimated_size_kb: None,
                    install_location: location,
                    uninstall_string: Some(format!("powershell.exe -NoProfile -Command \"Remove-AppxPackage -Package '{full}'\"")),
                    quiet_uninstall_string: Some(format!("powershell.exe -NoProfile -NonInteractive -Command \"Remove-AppxPackage -Package '{full}'\"")),
                    display_icon: None,
                    registry_path,
                    hive: Hive::Hkcu,
                    registry_view: RegistryView::X64,
                    architecture: match s("Architecture").as_deref() {
                        Some("X86") | Some("0") => Architecture::X86,
                        Some("Arm64") | Some("12") => Architecture::Arm64,
                        _ => Architecture::X64,
                    },
                    kind: AppKind::Store,
                    is_msi: false,
                    is_system_component: false,
                    is_update: false,
                    msi_product_code: None,
                    help_link: None,
                    about_url: Some(format!("ms-windows-store://pdp/?PFN={family}")),
                    update_info_url: None,
                    package_full_name: Some(full),
                    source: AppSource::Store,
                })
            })
            .collect()
    }
}

/// Recursive directory size (bounded; used for Store apps and leftover sizes).
pub fn dir_size(path: &std::path::Path) -> std::io::Result<u64> {
    let mut total = 0u64;
    let mut stack = vec![path.to_path_buf()];
    let mut visited = 0usize;
    while let Some(dir) = stack.pop() {
        for entry in std::fs::read_dir(&dir)?.flatten() {
            visited += 1;
            if visited > 200_000 {
                return Ok(total);
            }
            let file_type = match entry.file_type() {
                Ok(t) => t,
                Err(_) => continue,
            };
            // Do not follow junctions/symlinks while estimating a size.
            if file_type.is_symlink() {
                continue;
            }
            let meta = match entry.metadata() {
                Ok(m) => m,
                Err(_) => continue,
            };
            if file_type.is_dir() {
                stack.push(entry.path());
            } else {
                total += meta.len();
            }
        }
    }
    Ok(total)
}
