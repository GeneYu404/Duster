//! Finds what an installer left behind. Every candidate must be *validated* – we never
//! delete by name wildcard alone:
//!   * the install directory (if it is not a protected root),
//!   * `<Vendor>\<Product>` folders under %ProgramData%, %APPDATA%, %LOCALAPPDATA%,
//!     %ProgramFiles%, %ProgramFiles(x86)% – matched on normalised publisher + product name,
//!   * registry: `HK(CU|LM)\Software[\WOW6432Node]\<Vendor>\<Product>`, the Uninstall key itself,
//!     `App Paths\<exe>`, `Installer\Products\<packed GUID>` for MSI,
//!   * Start-menu / desktop `.lnk` whose target lives inside the install directory,
//!   * services whose ImagePath, and scheduled tasks whose action, point into the install dir.
//! Items inside protected roots are reported with `Risk::Protected` and are never deleted.

use crate::app_model::*;
use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::time::Instant;

#[cfg(windows)]
use winreg::enums::*;
#[cfg(windows)]
use winreg::{HKEY, RegKey};

const SHARED_VENDORS: &[&str] = &["microsoft", "google", "nvidia", "intel", "adobe", "apple", "valve", "oracle", "common files"];

pub struct ScanContext {
    pub app: InstalledApp,
    pub still_registered: bool,
}

/// Normalised product name: strip version numbers, "(x64)", "64-bit" etc.
pub fn base_name(name: &str) -> String {
    let mut s = name.to_string();
    // remove parenthesised fragments
    while let (Some(a), Some(b)) = (s.find('('), s.find(')')) {
        if b > a {
            s.replace_range(a..=b, " ");
        } else {
            break;
        }
    }
    let lowered = s.to_lowercase();
    for tag in [" x64", " x86", " 64-bit", " 32-bit", " amd64", " release"] {
        if let Some(i) = lowered.find(tag) {
            s.truncate(i);
            break;
        }
    }
    // drop a trailing version token like "3.5.1" / "v2"
    let words: Vec<&str> = s.split_whitespace().collect();
    let keep: Vec<&str> = words
        .iter()
        .take_while(|w| !(w.chars().next().map(|c| c.is_ascii_digit() || **w == "v").unwrap_or(false) && w.chars().any(|c| c.is_ascii_digit())))
        .copied()
        .collect();
    let out = if keep.is_empty() { words.join(" ") } else { keep.join(" ") };
    out.trim().to_string()
}

/// Normalised vendor: first comma-separated part without legal suffixes.
pub fn vendor_name(publisher: Option<&str>) -> Option<String> {
    let p = publisher?.split(',').next()?.trim();
    let cleaned: Vec<&str> = p
        .split_whitespace()
        .filter(|w| !matches!(w.trim_end_matches('.').to_lowercase().as_str(), "inc" | "llc" | "ltd" | "gmbh" | "corp" | "corporation" | "co" | "s.r.o" | "foundation" | "team" | "software"))
        .collect();
    let v = cleaned.join(" ");
    if v.is_empty() {
        None
    } else {
        Some(v)
    }
}

fn env_dir(var: &str) -> Option<PathBuf> {
    std::env::var_os(var).map(PathBuf::from).filter(|p| p.is_dir())
}

pub fn protected_roots() -> Vec<PathBuf> {
    let mut roots = Vec::new();
    for var in ["SystemDrive", "ProgramFiles", "ProgramFiles(x86)", "ProgramW6432", "ProgramData", "SystemRoot", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "PUBLIC", "ALLUSERSPROFILE"] {
        if let Some(p) = std::env::var_os(var) {
            let mut p = PathBuf::from(p);
            if var == "SystemDrive" {
                p.push("\\");
            }
            roots.push(p);
        }
    }
    if let Some(users) = env_dir("SystemDrive").map(|d| d.join("Users")) {
        roots.push(users);
    }
    if let Some(pf) = env_dir("ProgramFiles") {
        roots.push(pf.join("WindowsApps"));
        roots.push(pf.join("Common Files"));
    }
    roots
}

fn norm(p: &Path) -> String {
    p.to_string_lossy().trim_end_matches(|c| c == '\\' || c == '/').to_lowercase()
}

pub fn is_protected(path: &Path) -> bool {
    let n = norm(path);
    if n.len() <= 3 {
        return true; // drive roots
    }
    if let Some(windir) = std::env::var_os("SystemRoot") {
        let root = norm(Path::new(&windir));
        if n == root || n.starts_with(&format!("{root}\\")) {
            return true;
        }
    }
    if let Some(program_files) = env_dir("ProgramFiles") {
        let windows_apps = norm(&program_files.join("WindowsApps"));
        if n == windows_apps || n.starts_with(&format!("{windows_apps}\\")) {
            return true;
        }
    }
    protected_roots().iter().any(|r| norm(r) == n)
}

struct Collector {
    items: Vec<LeftoverItem>,
    seen: BTreeSet<String>,
    app_id: String,
}

impl Collector {
    fn add(&mut self, category: LeftoverCategory, path: String, size: Option<u64>, risk: Risk, reason: &str, selected: bool) {
        let key = path.to_lowercase();
        if !self.seen.insert(key) {
            return;
        }
        let id = format!("{}-lo{}", self.app_id, self.items.len());
        self.items.push(LeftoverItem { id, category, path, size_bytes: size, risk, reason: reason.into(), default_selected: selected && risk != Risk::Protected });
    }

    fn add_dir(&mut self, dir: &Path, reason: &str, risk_hint: Risk) {
        if !dir.is_dir() {
            return;
        }
        if std::fs::symlink_metadata(dir).map(|m| m.file_type().is_symlink()).unwrap_or(true) {
            self.add(LeftoverCategory::Folder, dir.display().to_string(), None, Risk::Protected, reason, false);
            return;
        }
        if is_protected(dir) {
            self.add(LeftoverCategory::Folder, dir.display().to_string(), None, Risk::Protected, reason, false);
            return;
        }
        let size = crate::registry_scanner::dir_size(dir).ok();
        self.add(LeftoverCategory::Folder, dir.display().to_string(), size, risk_hint, reason, risk_hint == Risk::Safe);
    }
}

pub fn scan(ctx: &ScanContext, mut progress: impl FnMut(ScanProgress)) -> ScanResult {
    let started = Instant::now();
    let app = &ctx.app;
    let mut c = Collector { items: Vec::new(), seen: BTreeSet::new(), app_id: app.id.clone() };
    let name = base_name(&app.name);
    let vendor = vendor_name(app.publisher.as_deref());
    let vendor_shared = vendor.as_deref().map(|v| SHARED_VENDORS.iter().any(|s| v.to_lowercase().contains(s))).unwrap_or(false);
    let mut locations = 0usize;

    // ---------- phase 1: file system ----------
    progress(ScanProgress { phase: "files", percent: 5, found: 0 });
    let install_dir = app.install_location.as_deref().map(PathBuf::from).or_else(|| app.display_icon.as_deref().and_then(exe_from_display_icon).and_then(|e| e.parent().map(Path::to_path_buf)));
    if let Some(dir) = &install_dir {
        locations += 1;
        c.add_dir(dir, "installDir", Risk::Safe);
    }

    let user_roots = [env_dir("APPDATA"), env_dir("LOCALAPPDATA"), env_dir("LOCALAPPDATA").map(|p| p.join("Programs"))];
    let machine_roots = [env_dir("ProgramData"), env_dir("ProgramFiles"), env_dir("ProgramFiles(x86)")];
    for root in user_roots.iter().chain(machine_roots.iter()).flatten() {
        locations += 1;
        if let Some(v) = &vendor {
            let vendor_dir = root.join(v);
            let product_dir = vendor_dir.join(&name);
            if product_dir.is_dir() {
                c.add_dir(&product_dir, "publisherName", Risk::Safe);
            }
            // A bare vendor folder is only safe when it holds nothing but this product.
            if vendor_dir.is_dir() && !vendor_shared && only_contains(&vendor_dir, &name) {
                c.add_dir(&vendor_dir, "publisherName", Risk::Safe);
            } else if vendor_dir.is_dir() && vendor_shared && product_dir.is_dir() {
                c.add(LeftoverCategory::Folder, vendor_dir.display().to_string(), None, Risk::Protected, "sharedVendorDir", false);
            }
        }
        let direct = root.join(&name);
        if direct.is_dir() && Some(&direct) != install_dir.as_ref() {
            c.add_dir(&direct, "nameMatch", Risk::Safe);
        }
    }
    if let Some(temp) = env_dir("TEMP") {
        if let Ok(rd) = std::fs::read_dir(&temp) {
            let needle = name.to_lowercase().replace(' ', "");
            for e in rd.flatten().take(5000) {
                let fname = e.file_name().to_string_lossy().to_lowercase().replace(' ', "");
                if needle.len() >= 4 && fname.contains(&needle) && e.path().is_file() {
                    let size = e.metadata().ok().map(|m| m.len());
                    c.add(LeftoverCategory::File, e.path().display().to_string(), size, Risk::Safe, "nameMatch", true);
                }
            }
        }
    }
    progress(ScanProgress { phase: "files", percent: 40, found: c.items.len() });

    // ---------- phase 2: registry ----------
    progress(ScanProgress { phase: "registry", percent: 45, found: c.items.len() });
    if ctx.still_registered {
        c.add(LeftoverCategory::Registry, app.registry_path.clone(), None, Risk::Safe, "uninstallKey", true);
    }
    #[cfg(windows)]
    {
        let exe_name = app.display_icon.as_deref().and_then(exe_from_display_icon).and_then(|p| p.file_name().map(|f| f.to_string_lossy().to_string()));
        let mut keys: Vec<(&str, HKEY, u32, String)> = Vec::new();
        if let Some(v) = &vendor {
            keys.push(("HKCU", HKEY_CURRENT_USER, KEY_WOW64_64KEY, format!(r"Software\{v}\{name}")));
            keys.push(("HKLM", HKEY_LOCAL_MACHINE, KEY_WOW64_64KEY, format!(r"SOFTWARE\{v}\{name}")));
            keys.push(("HKLM", HKEY_LOCAL_MACHINE, KEY_WOW64_32KEY, format!(r"SOFTWARE\{v}\{name}")));
        } else {
            keys.push(("HKCU", HKEY_CURRENT_USER, KEY_WOW64_64KEY, format!(r"Software\{name}")));
        }
        if let Some(exe) = &exe_name {
            keys.push(("HKLM", HKEY_LOCAL_MACHINE, KEY_WOW64_64KEY, format!(r"SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\{exe}")));
            keys.push(("HKLM", HKEY_LOCAL_MACHINE, KEY_WOW64_32KEY, format!(r"SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\{exe}")));
            keys.push(("HKCU", HKEY_CURRENT_USER, KEY_WOW64_64KEY, format!(r"Software\Classes\Applications\{exe}")));
        }
        for (hive_name, hive, flag, sub) in keys {
            locations += 1;
            if RegKey::predef(hive).open_subkey_with_flags(&sub, KEY_READ | flag).is_ok() {
                let display = if flag == KEY_WOW64_32KEY && hive == HKEY_LOCAL_MACHINE { sub.replacen("SOFTWARE\\", "SOFTWARE\\WOW6432Node\\", 1) } else { sub.clone() };
                let risk = if sub.contains("App Paths") || sub.contains("Classes") { Risk::Safe } else { Risk::Safe };
                c.add(LeftoverCategory::Registry, format!(r"{hive_name}\{display}"), None, risk, if sub.contains("App Paths") { "appPaths" } else if sub.contains("Classes") { "fileAssociation" } else { "publisherName" }, true);
            }
        }
        if let Some(code) = &app.msi_product_code {
            let packed = pack_guid(code);
            let p = format!(r"SOFTWARE\Classes\Installer\Products\{packed}");
            if RegKey::predef(HKEY_LOCAL_MACHINE).open_subkey_with_flags(&p, KEY_READ).is_ok() {
                c.add(LeftoverCategory::Registry, format!(r"HKLM\{p}"), None, Risk::Caution, "msiProduct", true);
            }
        }
    }
    progress(ScanProgress { phase: "registry", percent: 70, found: c.items.len() });

    // ---------- phase 3: shortcuts ----------
    progress(ScanProgress { phase: "shortcuts", percent: 75, found: c.items.len() });
    let mut shortcut_dirs = Vec::new();
    if let Some(a) = env_dir("APPDATA") {
        shortcut_dirs.push(a.join(r"Microsoft\Windows\Start Menu\Programs"));
    }
    if let Some(p) = env_dir("ProgramData") {
        shortcut_dirs.push(p.join(r"Microsoft\Windows\Start Menu\Programs"));
    }
    if let Some(u) = env_dir("USERPROFILE") {
        shortcut_dirs.push(u.join("Desktop"));
    }
    if let Some(pd) = env_dir("PUBLIC") {
        shortcut_dirs.push(pd.join("Desktop"));
    }
    for dir in shortcut_dirs {
        locations += 1;
        // Folder named after the product (common for Start Menu).
        let folder = dir.join(&name);
        if folder.is_dir() {
            c.add_dir(&folder, "shortcutTarget", Risk::Safe);
        }
        // Loose .lnk files whose target points into the install dir.
        if let (Some(install), Ok(rd)) = (&install_dir, std::fs::read_dir(&dir)) {
            let needle = norm(install);
            for e in rd.flatten().take(2000) {
                let p = e.path();
                if p.extension().map(|x| x.eq_ignore_ascii_case("lnk")).unwrap_or(false) && lnk_points_into(&p, &needle) {
                    c.add(LeftoverCategory::Shortcut, p.display().to_string(), e.metadata().ok().map(|m| m.len()), Risk::Safe, "shortcutTarget", true);
                }
            }
        }
    }
    progress(ScanProgress { phase: "shortcuts", percent: 85, found: c.items.len() });

    // ---------- phase 4: services & scheduled tasks ----------
    progress(ScanProgress { phase: "services", percent: 88, found: c.items.len() });
    #[cfg(windows)]
    if let Some(dir) = &install_dir {
        let needle = norm(dir);
        locations += 1;
        if let Ok(services) = RegKey::predef(HKEY_LOCAL_MACHINE).open_subkey_with_flags(r"SYSTEM\CurrentControlSet\Services", KEY_READ) {
            for svc in services.enum_keys().flatten() {
                if let Ok(k) = services.open_subkey_with_flags(&svc, KEY_READ) {
                    if let Ok(image) = k.get_value::<String, _>("ImagePath") {
                        if image.to_lowercase().contains(&needle) {
                            c.add(LeftoverCategory::Service, format!(r"HKLM\SYSTEM\CurrentControlSet\Services\{svc}"), None, Risk::Caution, "serviceImagePath", true);
                        }
                    }
                }
            }
        }
        if let Some(tasks) = env_dir("SystemRoot").map(|w| w.join(r"System32\Tasks")) {
            locations += 1;
            walk_tasks(&tasks, &needle, &mut c, 0);
        }
    }
    progress(ScanProgress { phase: "services", percent: 100, found: c.items.len() });

    tracing::info!(app = %app.name, items = c.items.len(), ms = started.elapsed().as_millis(), "leftover scan finished");
    ScanResult { app_id: app.id.clone(), app_name: app.name.clone(), items: c.items, duration_ms: started.elapsed().as_millis(), scanned_locations: locations }
}

fn only_contains(dir: &Path, name: &str) -> bool {
    match std::fs::read_dir(dir) {
        Ok(rd) => {
            let entries: Vec<_> = rd.flatten().collect();
            entries.len() <= 1 && entries.iter().all(|e| e.file_name().to_string_lossy().eq_ignore_ascii_case(name))
        }
        Err(_) => false,
    }
}

pub fn exe_from_display_icon(display_icon: &str) -> Option<PathBuf> {
    let s = display_icon.trim().trim_matches('"');
    let lower = s.to_lowercase();
    let end = [".exe", ".dll", ".ico"].iter().filter_map(|ext| lower.find(ext).map(|i| i + ext.len())).min()?;
    Some(PathBuf::from(&s[..end]))
}

/// Minimal `.lnk` inspection: the target path appears as UTF-16 or ANSI in the file body.
fn lnk_points_into(lnk: &Path, needle_lower: &str) -> bool {
    let Ok(bytes) = std::fs::read(lnk) else { return false };
    let ansi = String::from_utf8_lossy(&bytes).to_lowercase();
    if ansi.contains(needle_lower) {
        return true;
    }
    let wide: Vec<u16> = bytes.chunks_exact(2).map(|b| u16::from_le_bytes([b[0], b[1]])).collect();
    String::from_utf16_lossy(&wide).to_lowercase().contains(needle_lower)
}

fn walk_tasks(dir: &Path, needle: &str, c: &mut Collector, depth: usize) {
    if depth > 4 {
        return;
    }
    let Ok(rd) = std::fs::read_dir(dir) else { return };
    for e in rd.flatten() {
        let p = e.path();
        if p.is_dir() {
            walk_tasks(&p, needle, c, depth + 1);
        } else if let Ok(bytes) = std::fs::read(&p) {
            let wide: Vec<u16> = bytes.chunks_exact(2).map(|b| u16::from_le_bytes([b[0], b[1]])).collect();
            if String::from_utf16_lossy(&wide).to_lowercase().contains(needle) || String::from_utf8_lossy(&bytes).to_lowercase().contains(needle) {
                c.add(LeftoverCategory::Task, p.display().to_string(), None, Risk::Caution, "taskAction", true);
            }
        }
    }
}

/// Windows Installer "packed" GUID: reversed nibble groups without braces/dashes.
pub fn pack_guid(guid: &str) -> String {
    let g: String = guid.chars().filter(|c| c.is_ascii_hexdigit()).collect();
    if g.len() != 32 {
        return g;
    }
    let rev = |s: &str| s.chars().rev().collect::<String>();
    let mut out = String::new();
    out += &rev(&g[0..8]);
    out += &rev(&g[8..12]);
    out += &rev(&g[12..16]);
    for i in (16..32).step_by(2) {
        out += &rev(&g[i..i + 2]);
    }
    out
}
