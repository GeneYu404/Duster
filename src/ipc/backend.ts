import type {
  AppDetail,
  BackupInfo,
  DeleteLeftoversResult,
  ExportRequest,
  ExportResult,
  InstalledApp,
  ListOptions,
  LogEntry,
  PrivilegeInfo,
  ScanProgress,
  ScanResult,
  Settings,
  UninstallResult,
} from '../types/app';

/**
 * Tauri command names (Rust `#[tauri::command]` functions registered in src-tauri/src/lib.rs).
 * Keeping them in one place keeps the IPC surface auditable.
 *
 * 2026-10-11：后端换成 Go + MyGo 之后，这些名字只作为**历史对照**保留 ——
 * 命令名变成了 Go 的导出方法（见 src/mygo.ts，由 `bun run generate` 生成）。
 * 前端已不再按字符串 invoke，这里保留是为了让「原命令 ↔ 新绑定方法」
 * 的对应关系仍然可查。
 */
export const COMMANDS = {
  listInstalledApps: 'list_installed_apps',
  refreshApps: 'refresh_apps',
  getAppDetail: 'get_app_detail',
  getAppIcon: 'get_app_icon',
  uninstallApp: 'uninstall_app',
  forceUninstallApp: 'force_uninstall_app',
  deleteAppEntry: 'delete_app_entry',
  scanLeftovers: 'scan_leftovers',
  deleteLeftovers: 'delete_leftovers',
  openInstallLocation: 'open_install_location',
  revealPath: 'reveal_path',
  openRegistryKey: 'open_registry_key',
  openExternal: 'open_external',
  exportApps: 'export_apps',
  isAdmin: 'is_admin',
  requestElevation: 'request_elevation',
  getSettings: 'get_settings',
  saveSettings: 'save_settings',
  listBackups: 'list_backups',
  restoreBackup: 'restore_backup',
  getLogs: 'get_logs',
} as const;

/**
 * 事件名。后端换成 Go 之后由 `mygo.NewEvent` 声明，
 * 名字保持不变，所以桥接层（src/ipc/commands.ts）不用改事件名。
 */
export const EVENTS = {
  uninstallLog: 'uninstall-log',
  scanProgress: 'scan-progress',
} as const;

export type UninstallArgs = { appId: string; quiet: boolean };
export type DeleteLeftoversArgs = { appId: string; itemIds: string[] };

export interface Backend {
  listInstalledApps(options: ListOptions): Promise<InstalledApp[]>;
  getAppDetail(appId: string): Promise<AppDetail>;
  /** Returns a data URL (PNG) or null when no icon could be extracted. */
  getAppIcon(appId: string): Promise<string | null>;
  uninstallApp(args: UninstallArgs, onLog?: (line: string) => void): Promise<UninstallResult>;
  /** Read-only preview. Never starts an uninstaller or deletes files. */
  forceUninstallApp(appId: string, onProgress?: (p: ScanProgress) => void): Promise<ScanResult>;
  deleteAppEntry(appId: string): Promise<BackupInfo>;
  scanLeftovers(appId: string, onProgress?: (p: ScanProgress) => void): Promise<ScanResult>;
  deleteLeftovers(args: DeleteLeftoversArgs): Promise<DeleteLeftoversResult>;
  openInstallLocation(appId: string): Promise<void>;
  revealPath(path: string): Promise<void>;
  openRegistryKey(path: string): Promise<void>;
  openExternal(url: string): Promise<void>;
  exportApps(req: ExportRequest): Promise<ExportResult>;
  isAdmin(): Promise<PrivilegeInfo>;
  requestElevation(): Promise<boolean>;
  getSettings(): Promise<Settings>;
  saveSettings(settings: Settings): Promise<void>;
  listBackups(): Promise<BackupInfo[]>;
  restoreBackup(backupId: string): Promise<void>;
  getLogs(): Promise<LogEntry[]>;
}
