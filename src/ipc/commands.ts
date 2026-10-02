import type {
  AppDetail,
  AppError,
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
import { COMMANDS, EVENTS, type Backend, type DeleteLeftoversArgs, type UninstallArgs } from './backend';
import { mockBackend } from './mock';
import { isTauri as tauriIsTauri } from '@tauri-apps/api/core';

export type BackendKind = 'tauri' | 'mock';

export function isTauri(): boolean {
  return typeof window !== 'undefined' && tauriIsTauri();
}

/** Normalise anything thrown by invoke()/the mock into the shared AppError shape. */
export function toAppError(e: unknown): AppError {
  if (e && typeof e === 'object') {
    const o = e as Record<string, unknown>;
    if (typeof o.code === 'string' && typeof o.message === 'string') {
      return { code: o.code, message: o.message, details: typeof o.details === 'string' ? o.details : undefined };
    }
    if (e instanceof Error) {
      return { code: 'UNKNOWN', message: e.message, details: e.stack };
    }
  }
  if (typeof e === 'string') {
    try {
      const parsed = JSON.parse(e) as Record<string, unknown>;
      if (typeof parsed.message === 'string') {
        return { code: String(parsed.code ?? 'UNKNOWN'), message: parsed.message, details: typeof parsed.details === 'string' ? parsed.details : undefined };
      }
    } catch {
      /* plain string */
    }
    return { code: 'UNKNOWN', message: e };
  }
  return { code: 'UNKNOWN', message: String(e) };
}

function createTauriBackend(): Backend {
  const invoke = async <T>(cmd: string, args?: Record<string, unknown>): Promise<T> => {
    const core = await import('@tauri-apps/api/core');
    try {
      return await core.invoke<T>(cmd, args);
    } catch (e) {
      throw toAppError(e);
    }
  };

  /** Subscribe to a progress event for the duration of one command. */
  const withEvent = async <P, T>(event: string, appId: string, handler: ((p: P) => void) | undefined, run: () => Promise<T>): Promise<T> => {
    if (!handler) return run();
    const { listen } = await import('@tauri-apps/api/event');
    const unlisten = await listen<{ appId: string; payload: P }>(event, (ev) => {
      if (ev.payload.appId === appId) handler(ev.payload.payload);
    });
    try {
      return await run();
    } finally {
      unlisten();
    }
  };

  return {
    listInstalledApps: (options: ListOptions) => invoke<InstalledApp[]>(COMMANDS.listInstalledApps, { options }),
    getAppDetail: (appId: string) => invoke<AppDetail>(COMMANDS.getAppDetail, { appId }),
    getAppIcon: (appId: string) => invoke<string | null>(COMMANDS.getAppIcon, { appId }),
    uninstallApp: (args: UninstallArgs, onLog) =>
      withEvent<string, UninstallResult>(EVENTS.uninstallLog, args.appId, onLog, () => invoke<UninstallResult>(COMMANDS.uninstallApp, { args })),
    forceUninstallApp: (appId: string, onProgress) =>
      withEvent<ScanProgress, ScanResult>(EVENTS.scanProgress, appId, onProgress, () => invoke<ScanResult>(COMMANDS.forceUninstallApp, { appId })),
    deleteAppEntry: (appId: string) => invoke<BackupInfo>(COMMANDS.deleteAppEntry, { appId }),
    scanLeftovers: (appId: string, onProgress) =>
      withEvent<ScanProgress, ScanResult>(EVENTS.scanProgress, appId, onProgress, () => invoke<ScanResult>(COMMANDS.scanLeftovers, { appId })),
    deleteLeftovers: (args: DeleteLeftoversArgs) => invoke<DeleteLeftoversResult>(COMMANDS.deleteLeftovers, { args }),
    openInstallLocation: (appId: string) => invoke<void>(COMMANDS.openInstallLocation, { appId }),
    revealPath: (path: string) => invoke<void>(COMMANDS.revealPath, { path }),
    openRegistryKey: (path: string) => invoke<void>(COMMANDS.openRegistryKey, { path }),
    openExternal: (url: string) => invoke<void>(COMMANDS.openExternal, { url }),
    exportApps: (req: ExportRequest) => invoke<ExportResult>(COMMANDS.exportApps, { request: req }),
    isAdmin: () => invoke<PrivilegeInfo>(COMMANDS.isAdmin),
    requestElevation: () => invoke<boolean>(COMMANDS.requestElevation),
    getSettings: () => invoke<Settings>(COMMANDS.getSettings),
    saveSettings: (settings: Settings) => invoke<void>(COMMANDS.saveSettings, { settings }),
    listBackups: () => invoke<BackupInfo[]>(COMMANDS.listBackups),
    restoreBackup: (backupId: string) => invoke<void>(COMMANDS.restoreBackup, { backupId }),
    getLogs: () => invoke<LogEntry[]>(COMMANDS.getLogs),
  };
}

export const backendKind: BackendKind = isTauri() ? 'tauri' : 'mock';
export const ipc: Backend = backendKind === 'tauri' ? createTauriBackend() : mockBackend;
