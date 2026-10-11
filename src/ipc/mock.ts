import type {
  AppDetail,
  BackupInfo,
  DeleteLeftoversResult,
  ExportField,
  ExportRequest,
  ExportResult,
  InstalledApp,
  LeftoverItem,
  ListOptions,
  LogEntry,
  LogLevel,
  PrivilegeInfo,
  ScanProgress,
  ScanResult,
  Settings,
  UninstallResult,
} from '../types/app';
import { DEFAULT_SETTINGS } from '../types/app';
import type { Backend, DeleteLeftoversArgs, UninstallArgs } from './backend';
import { generateMockApps, makeSvgIcon, mulberry32, USER_PROFILE, type MockApp } from './mockData';
import { executableFromDisplayIcon, parseUninstallCommand } from '../utils/command';
import { buildExport } from '../utils/exporter';
import { hashString, tileColor } from '../utils/format';

const SETTINGS_KEY = 'duster.settings.v1';
const BACKUP_DIR = '%APPDATA%\\Duster\\backups';

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

class MockError extends Error {
  code: string;
  details?: string;
  constructor(code: string, message: string, details?: string) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

interface MockState {
  apps: MockApp[];
  archive: Map<string, MockApp>;
  backups: BackupInfo[];
  logs: LogEntry[];
  admin: boolean;
}

const state: MockState = {
  apps: generateMockApps(),
  archive: new Map(),
  backups: [],
  logs: [],
  admin: false,
};

function log(level: LogLevel, message: string) {
  state.logs.push({ ts: new Date().toISOString(), level, message });
  if (state.logs.length > 500) state.logs.shift();
}

function findApp(appId: string): MockApp {
  const app = state.apps.find((a) => a.id === appId) ?? state.archive.get(appId);
  if (!app) throw new MockError('APP_NOT_FOUND', `No application with id ${appId}`);
  return app;
}

function removeFromList(appId: string) {
  const idx = state.apps.findIndex((a) => a.id === appId);
  if (idx >= 0) {
    const [app] = state.apps.splice(idx, 1);
    state.archive.set(app.id, app);
  }
}

function timestampForFile(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function createBackup(app: InstalledApp, kind: BackupInfo['kind'], keys: string[]): BackupInfo {
  const backup: BackupInfo = {
    id: `bk-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`,
    createdAt: new Date().toISOString(),
    appId: app.id,
    appName: app.name,
    kind,
    path: `${BACKUP_DIR}\\${timestampForFile()}_${app.id}.${kind === 'registry' ? 'reg' : 'json'}`,
    keys,
    restorable: keys.length > 0,
  };
  state.backups.unshift(backup);
  log('info', `Backup written: ${backup.path} (${keys.length} keys)`);
  return backup;
}

/* ------------------------------------------------------------------ */
/* Leftover generation (mirrors internal/leftovers)                   */
/* ------------------------------------------------------------------ */

const PROTECTED_ROOTS = [
  'c:\\',
  'c:\\program files',
  'c:\\program files (x86)',
  'c:\\windows',
  'c:\\users',
  'c:\\programdata',
  USER_PROFILE.toLowerCase(),
  `${USER_PROFILE.toLowerCase()}\\appdata\\local`,
  `${USER_PROFILE.toLowerCase()}\\appdata\\roaming`,
];

function isProtectedPath(p: string): boolean {
  const n = p.toLowerCase().replace(/\\+$/, '');
  return PROTECTED_ROOTS.includes(n) || n === 'c:\\program files\\windowsapps' || n.startsWith('c:\\windows\\');
}

function baseName(name: string): string {
  return name
    .replace(/\s*\(.*?\)\s*/g, ' ')
    .replace(/\s+(x64|x86|64-bit|32-bit|amd64|release)\b/gi, '')
    .replace(/\s+v?\d+(\.\d+)+.*$/i, '')
    .replace(/\s+\d{4}(\s|$).*$/, '')
    .trim();
}

function vendorName(publisher?: string): string | undefined {
  if (!publisher) return undefined;
  const v = publisher
    .split(',')[0]
    .replace(/\b(inc|llc|ltd|gmbh|corp|corporation|co|s\.r\.o|foundation|team|software)\b\.?/gi, '')
    .replace(/[^\p{L}\p{N} .-]/gu, '')
    .trim();
  return v || undefined;
}

const SHARED_VENDORS = ['microsoft', 'google', 'nvidia', 'intel', 'adobe', 'apple', 'valve', 'oracle'];

function generateLeftovers(app: MockApp, stillRegistered: boolean): LeftoverItem[] {
  const rng = mulberry32(hashString(app.id));
  const items: LeftoverItem[] = [];
  let n = 0;
  const add = (item: Omit<LeftoverItem, 'id'>) => items.push({ id: `${app.id}-lo${n++}`, ...item });

  const name = baseName(app.name) || app.name;
  const vendor = vendorName(app.publisher);
  const vendorShared = vendor ? SHARED_VENDORS.some((s) => vendor.toLowerCase().includes(s)) : false;
  const perUser = app.hive === 'HKCU';
  const exe = executableFromDisplayIcon(app.displayIcon)?.split('\\').pop() ?? `${name}.exe`;
  const sizeBytes = (app.estimatedSizeKb ?? 50_000) * 1024;

  // --- install directory ---
  if (app.installLocation) {
    if (isProtectedPath(app.installLocation)) {
      add({ category: 'folder', path: app.installLocation, risk: 'protected', reason: 'installDir', defaultSelected: false });
    } else {
      const remaining = app.broken || stillRegistered ? sizeBytes : Math.round(sizeBytes * (0.02 + rng() * 0.15));
      add({ category: 'folder', path: app.installLocation, sizeBytes: remaining, risk: 'safe', reason: 'installDir', defaultSelected: true });
      const files = ['unins000.dat', 'settings.ini', 'logs\\application.log', `${exe}`, 'resources\\app.asar.unpacked', 'cache\\index'];
      const count = 1 + Math.floor(rng() * 3);
      for (let i = 0; i < count; i++) {
        add({
          category: 'file',
          path: `${app.installLocation}\\${files[(i * 2 + Math.floor(rng() * 2)) % files.length]}`,
          sizeBytes: Math.round(remaining * (0.05 + rng() * 0.2)),
          risk: 'safe',
          reason: 'installDir',
          defaultSelected: true,
        });
      }
    }
  }

  // --- user data ---
  if (app.kind !== 'update' && app.kind !== 'store') {
    const roaming = vendor ? `${USER_PROFILE}\\AppData\\Roaming\\${vendor}\\${name}` : `${USER_PROFILE}\\AppData\\Roaming\\${name}`;
    add({ category: 'folder', path: roaming, sizeBytes: Math.round(1024 * 1024 * (1 + rng() * 120)), risk: 'safe', reason: 'publisherName', defaultSelected: true });
    if (rng() > 0.4) {
      add({ category: 'folder', path: `${USER_PROFILE}\\AppData\\Local\\${vendor ? `${vendor}\\` : ''}${name}`, sizeBytes: Math.round(1024 * 1024 * (5 + rng() * 400)), risk: 'safe', reason: 'publisherName', defaultSelected: true });
    }
    if (rng() > 0.5) {
      add({ category: 'file', path: `${USER_PROFILE}\\AppData\\Local\\Temp\\${name.replace(/\s+/g, '_')}_install.log`, sizeBytes: Math.round(1024 * (10 + rng() * 900)), risk: 'safe', reason: 'nameMatch', defaultSelected: true });
    }
    if (!perUser && rng() > 0.45) {
      if (vendorShared) {
        add({ category: 'folder', path: `C:\\ProgramData\\${vendor}`, risk: 'protected', reason: 'sharedVendorDir', defaultSelected: false });
        add({ category: 'folder', path: `C:\\ProgramData\\${vendor}\\${name}`, sizeBytes: Math.round(1024 * 1024 * (2 + rng() * 60)), risk: 'caution', reason: 'publisherName', defaultSelected: false });
      } else {
        add({ category: 'folder', path: `C:\\ProgramData\\${vendor ?? name}`, sizeBytes: Math.round(1024 * 1024 * (2 + rng() * 60)), risk: 'safe', reason: 'publisherName', defaultSelected: true });
      }
    }
    if (rng() > 0.7 && vendor && !vendorShared) {
      add({ category: 'folder', path: `C:\\Program Files\\Common Files\\${vendor}`, risk: 'caution', reason: 'sharedVendorDir', defaultSelected: false });
    }
  }

  // --- registry ---
  if (stillRegistered) {
    add({ category: 'registry', path: app.registryPath, risk: 'safe', reason: 'uninstallKey', defaultSelected: true });
  }
  if (app.kind !== 'update') {
    if (vendor) {
      add({ category: 'registry', path: `HKCU\\Software\\${vendor}\\${name}`, risk: 'safe', reason: 'publisherName', defaultSelected: true });
      if (!perUser) {
        const hklm = app.registryView === 'x86' ? `HKLM\\SOFTWARE\\WOW6432Node\\${vendor}\\${name}` : `HKLM\\SOFTWARE\\${vendor}\\${name}`;
        add({ category: 'registry', path: hklm, risk: 'safe', reason: 'publisherName', defaultSelected: true });
      }
    } else {
      add({ category: 'registry', path: `HKCU\\Software\\${name}`, risk: 'safe', reason: 'nameMatch', defaultSelected: true });
    }
    if (app.kind === 'program' || app.kind === 'msi') {
      add({ category: 'registry', path: `HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\${exe}`, risk: 'safe', reason: 'appPaths', defaultSelected: true });
      if (rng() > 0.5) add({ category: 'registry', path: `HKCU\\Software\\Classes\\Applications\\${exe}`, risk: 'safe', reason: 'fileAssociation', defaultSelected: true });
      if (rng() > 0.6) add({ category: 'registry', path: `HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run\\${name.replace(/\s+/g, '')}`, risk: 'caution', reason: 'autorun', defaultSelected: true });
    }
    if (app.isMsi && app.msiProductCode) {
      const packed = app.msiProductCode.replace(/[{}-]/g, '').split('').reverse().join('');
      add({ category: 'registry', path: `HKLM\\SOFTWARE\\Classes\\Installer\\Products\\${packed}`, risk: 'caution', reason: 'msiProduct', defaultSelected: true });
      add({ category: 'registry', path: `HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Installer\\UserData\\S-1-5-18\\Products\\${packed}`, risk: 'caution', reason: 'msiProduct', defaultSelected: false });
    }
  }

  // --- shortcuts ---
  if (app.kind === 'program' || app.kind === 'msi' || app.kind === 'game') {
    const startMenu = perUser
      ? `${USER_PROFILE}\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs`
      : 'C:\\ProgramData\\Microsoft\\Windows\\Start Menu\\Programs';
    add({ category: 'shortcut', path: `${startMenu}\\${name}\\${name}.lnk`, sizeBytes: 2048, risk: 'safe', reason: 'shortcutTarget', defaultSelected: true });
    if (rng() > 0.5) add({ category: 'shortcut', path: `${startMenu}\\${name}\\Uninstall ${name}.lnk`, sizeBytes: 2048, risk: 'safe', reason: 'shortcutTarget', defaultSelected: true });
    if (rng() > 0.5) add({ category: 'shortcut', path: `${USER_PROFILE}\\Desktop\\${name}.lnk`, sizeBytes: 2048, risk: 'safe', reason: 'shortcutTarget', defaultSelected: true });
  }

  // --- services & tasks ---
  if (!perUser && (app.kind === 'program' || app.kind === 'msi') && rng() > 0.7) {
    add({ category: 'service', path: `HKLM\\SYSTEM\\CurrentControlSet\\Services\\${(vendor ?? name).replace(/\s+/g, '')}UpdateService`, risk: 'caution', reason: 'serviceImagePath', defaultSelected: true });
  }
  if ((app.kind === 'program' || app.kind === 'msi') && rng() > 0.7) {
    add({ category: 'task', path: `C:\\Windows\\System32\\Tasks\\${vendor ? `${vendor}\\` : ''}${name} Update Task`, risk: 'caution', reason: 'taskAction', defaultSelected: true });
  }

  return items;
}

/* ------------------------------------------------------------------ */
/* Backend implementation                                              */
/* ------------------------------------------------------------------ */

















/* ------------------------------------------------------------------ */
/* Backend implementation                                              */
/* ------------------------------------------------------------------ */

function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (raw) return { ...DEFAULT_SETTINGS, ...(JSON.parse(raw) as Partial<Settings>) };
  } catch {
    /* ignore */
  }
  return { ...DEFAULT_SETTINGS };
}

async function runUninstall(app: MockApp, quiet: boolean, onLog?: (line: string) => void): Promise<UninstallResult> {
  const started = performance.now();
  const lines: string[] = [];
  const emit = async (line: string, wait = 0) => {
    const stamped = `[${new Date().toLocaleTimeString()}] ${line}`;
    lines.push(stamped);
    onLog?.(stamped);
    if (wait) await delay(wait);
  };

  const commandSource = quiet && app.quietUninstallString ? app.quietUninstallString : app.uninstallString;
  const parsed = parseUninstallCommand(commandSource, quiet);

  const finish = (partial: Omit<UninstallResult, 'appId' | 'durationMs' | 'log' | 'commandLine'>): UninstallResult => {
    const result: UninstallResult = {
      appId: app.id,
      durationMs: performance.now() - started,
      log: lines,
      commandLine: parsed?.normalized ?? '',
      ...partial,
    };
    log(result.success ? 'info' : 'warn', `Uninstall ${app.name}: ${result.message} (exit ${result.exitCode ?? '-'})`);
    return result;
  };

  await emit(`Resolving uninstall command for "${app.name}"…`, 200);
  if (!parsed) {
    await emit('No UninstallString / QuietUninstallString found in the registry key.');
    return finish({ success: false, rebootRequired: false, cancelled: false, message: 'No uninstall command available', exitCode: undefined });
  }
  await emit(`Command: ${parsed.normalized}`, 150);
  if (!state.admin) await emit('Process requires elevation — requesting UAC consent…', 500);
  if (app.broken) {
    await emit(`CreateProcess failed: The system cannot find the file specified. (${parsed.program})`, 150);
    return finish({ success: false, rebootRequired: false, cancelled: false, message: 'Uninstaller executable is missing', exitCode: 2 });
  }
  const pid = 1000 + (hashString(app.id) % 30000);
  await emit(`Launched ${parsed.program.split('\\').pop()} (PID ${pid})`, 200);
  await emit('Waiting for the uninstaller process to exit…', quiet ? 900 : 1600);

  const roll = hashString(`${app.id}:outcome`) % 100;
  if (roll < 6 && !quiet) {
    await emit('Process exited with code 1602.');
    return finish({ success: false, rebootRequired: false, cancelled: true, message: 'User cancelled installation', exitCode: 1602 });
  }
  if (roll < 10) {
    await emit('Process exited with code 1603.');
    return finish({ success: false, rebootRequired: false, cancelled: false, message: 'Fatal error during installation', exitCode: 1603 });
  }
  removeFromList(app.id);
  if (roll < 15) {
    await emit('Process exited with code 3010 (ERROR_SUCCESS_REBOOT_REQUIRED).');
    await emit('Registry Uninstall key removed by the installer.');
    return finish({ success: true, rebootRequired: true, cancelled: false, message: 'Uninstalled; restart required', exitCode: 3010 });
  }
  await emit('Process exited with code 0.');
  await emit('Registry Uninstall key removed by the installer.');
  return finish({ success: true, rebootRequired: false, cancelled: false, message: 'Uninstalled successfully', exitCode: 0 });
}

async function runScan(app: MockApp, onProgress?: (p: ScanProgress) => void): Promise<ScanResult> {
  const started = performance.now();
  const stillRegistered = state.apps.some((a) => a.id === app.id);
  const items = generateLeftovers(app, stillRegistered);
  const phases: ScanProgress['phase'][] = ['files', 'registry', 'shortcuts', 'services'];
  let found = 0;
  for (let i = 0; i < phases.length; i++) {
    const phase = phases[i];
    const steps = 4;
    for (let s = 1; s <= steps; s++) {
      await delay(70 + Math.random() * 90);
      const percent = Math.round(((i + s / steps) / phases.length) * 100);
      const target = Math.round((items.length * (i + s / steps)) / phases.length);
      found = Math.max(found, target);
      onProgress?.({ phase, percent, found });
    }
  }
  log('info', `Leftover scan for ${app.name}: ${items.length} items`);
  return { appId: app.id, appName: app.name, items, durationMs: performance.now() - started, scannedLocations: 14 };
}

export const mockBackend: Backend = {
  async listInstalledApps(options: ListOptions): Promise<InstalledApp[]> {
    await delay(260 + Math.random() * 200);
    const list = state.apps.filter((a) => {
      if (!options.includeSystemComponents && a.isSystemComponent) return false;
      if (!options.includeUpdates && a.isUpdate) return false;
      if (!options.includeStoreApps && a.kind === 'store') return false;
      return true;
    });
    log('info', `Enumerated ${list.length} entries (HKLM x64/x86, HKCU, AppX)`);
    // strip preview-only fields
    return list.map(({ broken: _broken, ...rest }) => rest);
  },

  async getAppDetail(appId: string): Promise<AppDetail> {
    await delay(40);
    const app = findApp(appId);
    const executablePath = executableFromDisplayIcon(app.displayIcon);
    const parsedCommand = parseUninstallCommand(app.uninstallString);
    const values: Record<string, string> = { DisplayName: app.name };
    if (app.version) values.DisplayVersion = app.version;
    if (app.publisher) values.Publisher = app.publisher;
    if (app.installDate) values.InstallDate = app.installDate.replace(/-/g, '');
    if (app.estimatedSizeKb) values.EstimatedSize = `0x${app.estimatedSizeKb.toString(16)} (${app.estimatedSizeKb})`;
    if (app.installLocation) values.InstallLocation = app.installLocation;
    if (app.uninstallString) values.UninstallString = app.uninstallString;
    if (app.quietUninstallString) values.QuietUninstallString = app.quietUninstallString;
    if (app.displayIcon) values.DisplayIcon = app.displayIcon;
    if (app.isMsi) values.WindowsInstaller = '0x1 (1)';
    if (app.isSystemComponent) values.SystemComponent = '0x1 (1)';
    if (app.helpLink) values.HelpLink = app.helpLink;
    if (app.aboutUrl) values.URLInfoAbout = app.aboutUrl;
    if (app.kind === 'update') values.ReleaseType = 'Security Update';
    values.NoModify = '0x1 (1)';
    values.NoRepair = '0x1 (1)';
    const { broken, ...rest } = app;
    return {
      ...rest,
      executablePath,
      installLocationExists: !!app.installLocation && !broken,
      uninstallerExists: !!app.uninstallString && !broken,
      parsedCommand,
      modifyPath: app.isMsi && app.msiProductCode ? `MsiExec.exe /I${app.msiProductCode}` : undefined,
      language: app.hive === 'HKLM' && app.registryView === 'x86' ? '2052' : '1033',
      registryValues: values,
    };
  },

  async getAppIcon(appId: string): Promise<string | null> {
    await delay(10 + Math.random() * 30);
    const app = state.apps.find((a) => a.id === appId) ?? state.archive.get(appId);
    if (!app) return null;
    if (app.kind === 'update') return null;
    if (app.kind === 'store' || hashString(`${app.id}:icon`) % 10 < 4) {
      return makeSvgIcon(app.name, tileColor(app.name));
    }
    return null;
  },

  async uninstallApp(args: UninstallArgs, onLog?: (line: string) => void): Promise<UninstallResult> {
    const app = findApp(args.appId);
    return runUninstall(app, args.quiet, onLog);
  },

  async forceUninstallApp(appId: string, onProgress?: (p: ScanProgress) => void): Promise<ScanResult> {
    const app = findApp(appId);
    if (app.isSystemComponent || app.isUpdate) {
      throw new MockError('PROTECTED_PATH', `Refusing force removal of ${app.name}`);
    }
    // Previewing a force removal must not uninstall or remove anything.
    return runScan(app, onProgress);
  },

  async deleteAppEntry(appId: string): Promise<BackupInfo> {
    await delay(350);
    const app = findApp(appId);
    if (!state.admin && app.hive === 'HKLM') {
      throw new MockError('ELEVATION_REQUIRED', 'Deleting HKLM keys requires administrator rights', app.registryPath);
    }
    const backup = createBackup(app, 'registry', [app.registryPath]);
    removeFromList(appId);
    log('warn', `Deleted registry key ${app.registryPath}`);
    return backup;
  },

  async scanLeftovers(appId: string, onProgress?: (p: ScanProgress) => void): Promise<ScanResult> {
    const app = findApp(appId);
    return runScan(app, onProgress);
  },

  async deleteLeftovers(args: DeleteLeftoversArgs): Promise<DeleteLeftoversResult> {
    const app = findApp(args.appId);
    const stillRegistered = state.apps.some((a) => a.id === app.id);
    const items = generateLeftovers(app, stillRegistered).filter((i) => args.itemIds.includes(i.id));
    await delay(400 + items.length * 60);
    const deleted: string[] = [];
    const failed: DeleteLeftoversResult['failed'] = [];
    let recycled = 0;
    const regKeys: string[] = [];
    for (const item of items) {
      if (item.risk === 'protected') {
        failed.push({ id: item.id, path: item.path, reason: 'Protected system path — refused by policy' });
        continue;
      }
      const roll = hashString(`${item.id}:del`) % 100;
      if ((item.category === 'file' || item.category === 'folder') && roll < 4) {
        failed.push({ id: item.id, path: item.path, reason: 'The process cannot access the file because it is being used by another process (0x20)' });
        continue;
      }
      if (item.category === 'registry' || item.category === 'service') regKeys.push(item.path);
      if (item.category === 'file' || item.category === 'folder' || item.category === 'shortcut') recycled++;
      deleted.push(item.id);
      if (item.category === 'registry' && item.path === app.registryPath) removeFromList(app.id);
    }
    const backup = regKeys.length ? createBackup(app, 'leftovers', regKeys) : undefined;
    log('warn', `Deleted ${deleted.length} leftovers of ${app.name} (${failed.length} failed, ${recycled} recycled)`);
    return { deleted, failed, recycled, backup };
  },

  async openInstallLocation(appId: string): Promise<void> {
    const app = findApp(appId);
    await delay(80);
    if (!app.installLocation) throw new MockError('PATH_NOT_FOUND', 'This entry has no install location');
    log('info', `explorer.exe "${app.installLocation}"`);
  },

  async revealPath(path: string): Promise<void> {
    await delay(80);
    log('info', `explorer.exe /select,"${path}"`);
  },

  async openRegistryKey(path: string): Promise<void> {
    await delay(80);
    log('info', `regedit.exe → ${path}`);
  },

  async openExternal(url: string): Promise<void> {
    await delay(30);
    log('info', `Open external URL: ${url}`);
    window.open(url, '_blank', 'noopener,noreferrer');
  },

  async exportApps(req: ExportRequest): Promise<ExportResult> {
    await delay(150);
    const apps = (req.appIds ? state.apps.filter((a) => req.appIds!.includes(a.id)) : state.apps).map(({ broken: _b, ...rest }) => rest);
    const labels = Object.fromEntries(req.fields.map((f) => [f, f])) as Record<ExportField, string>;
    const built = buildExport(apps, req.format, req.fields, labels);
    log('info', `Exported ${apps.length} entries as ${req.format.toUpperCase()}`);
    return { fileName: built.fileName, content: built.content, mimeType: built.mimeType, count: apps.length };
  },

  async isAdmin(): Promise<PrivilegeInfo> {
    await delay(20);
    return { isAdmin: state.admin, canElevate: true };
  },

  async requestElevation(): Promise<boolean> {
    await delay(700);
    state.admin = true;
    log('info', 'Process elevated via UAC (simulated)');
    return true;
  },

  async getSettings(): Promise<Settings> {
    await delay(10);
    return loadSettings();
  },

  async saveSettings(settings: Settings): Promise<void> {
    await delay(30);
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
    log('debug', 'Settings saved');
  },

  async listBackups(): Promise<BackupInfo[]> {
    await delay(40);
    return [...state.backups];
  },

  async restoreBackup(backupId: string): Promise<void> {
    await delay(400);
    const backup = state.backups.find((b) => b.id === backupId);
    if (!backup) throw new MockError('BACKUP_NOT_FOUND', `Backup ${backupId} not found`);
    if (!backup.restorable) throw new MockError('BACKUP_NOT_RESTORABLE', 'This backup has already been restored');
    const archived = state.archive.get(backup.appId);
    if (archived && backup.keys.includes(archived.registryPath) && !state.apps.some((a) => a.id === archived.id)) {
      state.apps.push(archived);
      state.archive.delete(archived.id);
    }
    backup.restorable = false;
    log('info', `Restored backup ${backup.path}`);
  },

  async getLogs(): Promise<LogEntry[]> {
    return [...state.logs];
  },
};
