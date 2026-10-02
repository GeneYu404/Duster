//! Shared software data model. Must stay in sync with `src/types/app.ts`.
//! All structs serialise with camelCase field names.

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AppKind {
    Program,
    Msi,
    Store,
    System,
    Update,
    Game,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Architecture {
    X64,
    X86,
    Arm64,
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RegistryView {
    X64,
    X86,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum Hive {
    #[serde(rename = "HKLM")]
    Hklm,
    #[serde(rename = "HKCU")]
    Hkcu,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AppSource {
    Registry,
    Msi,
    Store,
    Steam,
    Epic,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstalledApp {
    pub id: String,
    pub name: String,
    pub version: Option<String>,
    pub publisher: Option<String>,
    /// Normalised to YYYY-MM-DD.
    pub install_date: Option<String>,
    /// EstimatedSize is stored in KB by Windows Installer / most setup tools.
    pub estimated_size_kb: Option<u32>,
    pub install_location: Option<String>,
    pub uninstall_string: Option<String>,
    pub quiet_uninstall_string: Option<String>,
    pub display_icon: Option<String>,
    /// e.g. `HKLM\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\{GUID}`
    pub registry_path: String,
    pub hive: Hive,
    pub registry_view: RegistryView,
    pub architecture: Architecture,
    pub kind: AppKind,
    pub is_msi: bool,
    pub is_system_component: bool,
    pub is_update: bool,
    pub msi_product_code: Option<String>,
    pub help_link: Option<String>,
    pub about_url: Option<String>,
    pub update_info_url: Option<String>,
    pub package_full_name: Option<String>,
    pub source: AppSource,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ParsedCommand {
    pub program: String,
    pub args: String,
    pub is_msi: bool,
    pub normalized: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppDetail {
    #[serde(flatten)]
    pub app: InstalledApp,
    pub executable_path: Option<String>,
    pub install_location_exists: bool,
    pub uninstaller_exists: bool,
    pub parsed_command: Option<ParsedCommand>,
    pub modify_path: Option<String>,
    pub comments: Option<String>,
    pub contact: Option<String>,
    pub language: Option<String>,
    pub registry_values: BTreeMap<String, String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum LeftoverCategory {
    Folder,
    File,
    Registry,
    Shortcut,
    Service,
    Task,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Risk {
    Safe,
    Caution,
    Protected,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LeftoverItem {
    pub id: String,
    pub category: LeftoverCategory,
    pub path: String,
    pub size_bytes: Option<u64>,
    pub risk: Risk,
    /// Machine readable match reason (`installDir`, `publisherName`, `uninstallKey`, ...).
    pub reason: String,
    pub default_selected: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanProgress {
    pub phase: &'static str,
    pub percent: u8,
    pub found: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanResult {
    pub app_id: String,
    pub app_name: String,
    pub items: Vec<LeftoverItem>,
    pub duration_ms: u128,
    pub scanned_locations: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UninstallResult {
    pub app_id: String,
    pub success: bool,
    pub exit_code: Option<i32>,
    pub reboot_required: bool,
    pub cancelled: bool,
    pub message: String,
    pub command_line: String,
    pub duration_ms: u128,
    pub log: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum BackupKind {
    Registry,
    Leftovers,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupInfo {
    pub id: String,
    pub created_at: String,
    pub app_id: String,
    pub app_name: String,
    pub kind: BackupKind,
    pub path: String,
    pub keys: Vec<String>,
    pub restorable: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FailedItem {
    pub id: String,
    pub path: String,
    pub reason: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteLeftoversResult {
    pub deleted: Vec<String>,
    pub failed: Vec<FailedItem>,
    pub recycled: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub backup: Option<BackupInfo>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ExportFormat {
    Csv,
    Json,
    Html,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportRequest {
    pub format: ExportFormat,
    pub fields: Vec<String>,
    #[serde(default)]
    pub labels: Option<BTreeMap<String, String>>,
    pub app_ids: Option<Vec<String>>,
    /// Destination chosen through the save dialog; when absent the content is returned inline.
    pub path: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportResult {
    pub file_name: String,
    pub path: Option<String>,
    pub content: Option<String>,
    pub mime_type: String,
    pub count: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    pub theme: String,
    pub language: String,
    pub portable_mode: bool,
    pub log_level: String,
    pub request_admin_on_startup: bool,
    pub show_system_components: bool,
    pub show_updates: bool,
    pub show_store_apps: bool,
    pub enable_leftover_scan: bool,
    pub scan_after_uninstall: bool,
    pub use_recycle_bin: bool,
    pub backup_directory: String,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            theme: "system".into(),
            language: "zh-CN".into(),
            portable_mode: false,
            log_level: "info".into(),
            request_admin_on_startup: false,
            show_system_components: false,
            show_updates: false,
            show_store_apps: true,
            enable_leftover_scan: true,
            scan_after_uninstall: true,
            use_recycle_bin: true,
            backup_directory: String::new(),
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListOptions {
    pub include_system_components: bool,
    pub include_updates: bool,
    pub include_store_apps: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrivilegeInfo {
    pub is_admin: bool,
    pub can_elevate: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LogEntry {
    pub ts: String,
    pub level: String,
    pub message: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UninstallArgs {
    pub app_id: String,
    pub quiet: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteLeftoversArgs {
    pub app_id: String,
    pub item_ids: Vec<String>,
}

/// Stable id for an entry: FNV-1a over the lower-cased registry path (same algorithm as the UI).
pub fn stable_id(registry_path: &str) -> String {
    let mut h: u32 = 0x811c9dc5;
    for b in registry_path.to_lowercase().encode_utf16() {
        h ^= b as u32;
        h = h.wrapping_mul(0x01000193);
    }
    format!("{h:08x}")
}
