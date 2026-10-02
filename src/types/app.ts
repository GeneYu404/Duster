/**
 * Shared data model between the React front-end and the Rust (Tauri) back-end.
 * Field names are camelCase on the wire (the Rust side uses `#[serde(rename_all = "camelCase")]`).
 */

export type AppKind = 'program' | 'msi' | 'store' | 'system' | 'update' | 'game';
export type Architecture = 'x64' | 'x86' | 'arm64' | 'unknown';
export type RegistryView = 'x64' | 'x86';
export type Hive = 'HKLM' | 'HKCU';
export type AppSource = 'registry' | 'msi' | 'store' | 'steam' | 'epic';

/** One row of the installed-software list (what `list_installed_apps` returns). */
export interface InstalledApp {
  /** Stable id derived from the registry path (FNV-1a hex). */
  id: string;
  /** DisplayName */
  name: string;
  /** DisplayVersion */
  version?: string;
  /** Publisher */
  publisher?: string;
  /** InstallDate normalised to YYYY-MM-DD */
  installDate?: string;
  /** EstimatedSize (registry stores KB) */
  estimatedSizeKb?: number;
  /** InstallLocation */
  installLocation?: string;
  /** UninstallString */
  uninstallString?: string;
  /** QuietUninstallString */
  quietUninstallString?: string;
  /** DisplayIcon ("path,index") */
  displayIcon?: string;
  /** Full registry key path, e.g. HKLM\SOFTWARE\...\Uninstall\{GUID} */
  registryPath: string;
  hive: Hive;
  /** Which registry view the key was read from (KEY_WOW64_64KEY / KEY_WOW64_32KEY). */
  registryView: RegistryView;
  architecture: Architecture;
  kind: AppKind;
  isMsi: boolean;
  isSystemComponent: boolean;
  isUpdate: boolean;
  msiProductCode?: string;
  helpLink?: string;
  aboutUrl?: string;
  updateInfoUrl?: string;
  /** Store (AppX / MSIX) package full name. */
  packageFullName?: string;
  source: AppSource;
}

/** Parsed uninstall command as the back-end intends to execute it. */
export interface ParsedCommand {
  program: string;
  args: string;
  isMsi: boolean;
  /** Final command line that will actually be run (after msiexec normalisation). */
  normalized: string;
}

/** Everything in InstalledApp plus on-demand enrichment (`get_app_detail`). */
export interface AppDetail extends InstalledApp {
  executablePath?: string;
  installLocationExists: boolean;
  uninstallerExists: boolean;
  parsedCommand?: ParsedCommand;
  modifyPath?: string;
  comments?: string;
  contact?: string;
  language?: string;
  /** Raw registry values of the Uninstall key. */
  registryValues: Record<string, string>;
}

export type LeftoverCategory = 'folder' | 'file' | 'registry' | 'shortcut' | 'service' | 'task';
export type Risk = 'safe' | 'caution' | 'protected';

export interface LeftoverItem {
  id: string;
  category: LeftoverCategory;
  path: string;
  sizeBytes?: number;
  risk: Risk;
  /** Why the scanner matched this item (install dir, publisher/name match, uninstall key, ...). */
  reason: string;
  defaultSelected: boolean;
}

export interface ScanProgress {
  phase: 'files' | 'registry' | 'shortcuts' | 'services';
  percent: number;
  found: number;
}

export interface ScanResult {
  appId: string;
  appName: string;
  items: LeftoverItem[];
  durationMs: number;
  scannedLocations: number;
}

export interface UninstallResult {
  appId: string;
  success: boolean;
  exitCode?: number;
  rebootRequired: boolean;
  cancelled: boolean;
  message: string;
  commandLine: string;
  durationMs: number;
  log: string[];
}

export interface BackupInfo {
  id: string;
  createdAt: string;
  appId: string;
  appName: string;
  kind: 'registry' | 'leftovers';
  /** Path of the .reg / .json backup file on disk. */
  path: string;
  keys: string[];
  restorable: boolean;
}

export interface DeleteLeftoversResult {
  deleted: string[];
  failed: { id: string; path: string; reason: string }[];
  recycled: number;
  backup?: BackupInfo;
}

export type ExportFormat = 'csv' | 'json' | 'html';
export type ExportField =
  | 'name'
  | 'version'
  | 'publisher'
  | 'installDate'
  | 'estimatedSizeKb'
  | 'installLocation'
  | 'uninstallString'
  | 'quietUninstallString'
  | 'registryPath'
  | 'architecture'
  | 'kind';

export const ALL_EXPORT_FIELDS: ExportField[] = [
  'name',
  'version',
  'publisher',
  'installDate',
  'estimatedSizeKb',
  'installLocation',
  'uninstallString',
  'quietUninstallString',
  'registryPath',
  'architecture',
  'kind',
];

export interface ExportRequest {
  format: ExportFormat;
  fields: ExportField[];
  /** Localised column names. The mock and native exporters use the same headers. */
  labels?: Partial<Record<ExportField, string>>;
  /** When omitted, every app is exported. */
  appIds?: string[];
}

export interface ExportResult {
  fileName: string;
  /** Set when the back-end wrote the file itself (Tauri). */
  path?: string;
  /** Set when the caller must persist it (browser preview). */
  content?: string;
  mimeType: string;
  count: number;
}

export type Theme = 'light' | 'dark' | 'system';
export type Language = 'zh-CN' | 'en-US';
export type LogLevel = 'error' | 'warn' | 'info' | 'debug' | 'trace';

export interface Settings {
  theme: Theme;
  language: Language;
  portableMode: boolean;
  logLevel: LogLevel;
  requestAdminOnStartup: boolean;
  showSystemComponents: boolean;
  showUpdates: boolean;
  showStoreApps: boolean;
  enableLeftoverScan: boolean;
  scanAfterUninstall: boolean;
  useRecycleBin: boolean;
  backupDirectory: string;
}

export const DEFAULT_SETTINGS: Settings = {
  theme: 'system',
  language: 'zh-CN',
  portableMode: false,
  logLevel: 'info',
  requestAdminOnStartup: false,
  showSystemComponents: false,
  showUpdates: false,
  showStoreApps: true,
  enableLeftoverScan: true,
  scanAfterUninstall: true,
  useRecycleBin: true,
  backupDirectory: '%APPDATA%\\Duster\\backups',
};

export interface LogEntry {
  ts: string;
  level: LogLevel;
  message: string;
}

export interface ListOptions {
  includeSystemComponents: boolean;
  includeUpdates: boolean;
  includeStoreApps: boolean;
}

export interface PrivilegeInfo {
  isAdmin: boolean;
  canElevate: boolean;
}

/** Error shape produced by the Rust side (`AppError` serialised). */
export interface AppError {
  code: string;
  message: string;
  details?: string;
}
