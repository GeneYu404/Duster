import { create } from 'zustand';
import type { AppError, InstalledApp, LogEntry, LogLevel, Settings } from '../types/app';
import { DEFAULT_SETTINGS } from '../types/app';
import { backendKind, ipc, toAppError } from '../ipc/commands';
import { compareVersions, isRecent } from '../utils/format';
import { translate } from '../i18n';

export type FilterKind = 'all' | 'program' | 'msi' | 'store' | 'game' | 'system' | 'update' | 'large' | 'recent' | 'broken';
export type SortKey = 'name' | 'publisher' | 'version' | 'estimatedSizeKb' | 'installDate' | 'architecture';
export type SortDir = 'asc' | 'desc';

export type DialogState =
  | { type: 'none' }
  | { type: 'uninstall'; appIds: string[]; quiet: boolean }
  | { type: 'leftovers'; appId: string; appName: string; mode: 'scan' | 'force' }
  | { type: 'delete-entry'; appId: string }
  | { type: 'settings' }
  | { type: 'export'; scope: 'all' | 'view' | 'selected' }
  | { type: 'error'; title?: string; error: AppError }
  | { type: 'backups' }
  | { type: 'logs' }
  | { type: 'properties'; appId: string };

export interface Toast {
  id: number;
  kind: 'success' | 'error' | 'info';
  message: string;
}

export interface ContextMenuState {
  x: number;
  y: number;
  appId: string;
}

export const LARGE_APP_KB = 500 * 1024;

interface AppState {
  apps: InstalledApp[];
  loading: boolean;
  initialised: boolean;
  lastRefresh?: number;
  query: string;
  sortKey: SortKey;
  sortDir: SortDir;
  filter: FilterKind;
  selectedIds: string[];
  anchorId?: string;
  settings: Settings;
  isAdmin: boolean;
  backend: typeof backendKind;
  busy: string | null;
  detailOpen: boolean;
  dialog: DialogState;
  contextMenu: ContextMenuState | null;
  toasts: Toast[];
  logs: LogEntry[];
  iconCache: Record<string, string | null>;

  init(): Promise<void>;
  refresh(silent?: boolean): Promise<void>;
  setQuery(q: string): void;
  setSort(key: SortKey): void;
  setFilter(f: FilterKind): void;
  select(ids: string[], anchorId?: string): void;
  toggleSelect(id: string): void;
  selectRange(toId: string, visibleIds: string[]): void;
  clearSelection(): void;
  removeApps(ids: string[]): void;
  upsertApps(apps: InstalledApp[]): void;
  openDialog(d: DialogState): void;
  closeDialog(): void;
  openContextMenu(m: ContextMenuState): void;
  closeContextMenu(): void;
  pushToast(kind: Toast['kind'], message: string): void;
  dismissToast(id: number): void;
  log(level: LogLevel, message: string): void;
  clearLogs(): void;
  updateSettings(patch: Partial<Settings>): Promise<void>;
  setDetailOpen(open: boolean): void;
  setBusy(label: string | null): void;
  ensureAdmin(): Promise<boolean>;
  cacheIcon(id: string, dataUrl: string | null): void;
  reportError(e: unknown, title?: string): void;
}

let toastSeq = 1;

export const useAppStore = create<AppState>((set, get) => ({
  apps: [],
  loading: false,
  initialised: false,
  query: '',
  sortKey: 'name',
  sortDir: 'asc',
  filter: 'all',
  selectedIds: [],
  settings: DEFAULT_SETTINGS,
  isAdmin: false,
  backend: backendKind,
  busy: null,
  detailOpen: true,
  dialog: { type: 'none' },
  contextMenu: null,
  toasts: [],
  logs: [],
  iconCache: {},

  async init() {
    try {
      const [settings, priv] = await Promise.all([ipc.getSettings(), ipc.isAdmin()]);
      set({ settings, isAdmin: priv.isAdmin });
      if (settings.requestAdminOnStartup && !priv.isAdmin) {
        const ok = await ipc.requestElevation().catch(() => false);
        if (ok) set({ isAdmin: true });
      }
    } catch (e) {
      get().reportError(e);
    }
    get().log('info', `Duster 拂尘 started (${backendKind === 'mygo' ? 'Go + MyGo backend' : 'browser preview with simulated data'})`);
    await get().refresh();
    set({ initialised: true });
  },

  async refresh(silent = false) {
    const { settings } = get();
    set({ loading: true });
    const started = performance.now();
    try {
      const apps = await ipc.listInstalledApps({
        includeSystemComponents: true,
        includeUpdates: true,
        includeStoreApps: settings.showStoreApps,
      });
      const existing = new Set(apps.map((a) => a.id));
      set((s) => ({
        apps,
        lastRefresh: Date.now(),
        selectedIds: s.selectedIds.filter((id) => existing.has(id)),
      }));
      get().log('info', `Loaded ${apps.length} entries in ${Math.round(performance.now() - started)} ms`);
      if (!silent) get().pushToast('info', translate(get().settings.language, 'toast.refreshed', { count: apps.length }));
    } catch (e) {
      get().reportError(e);
    } finally {
      set({ loading: false });
    }
  },

  setQuery(query) {
    set({ query });
  },

  setSort(key) {
    set((s) => (s.sortKey === key ? { sortDir: s.sortDir === 'asc' ? 'desc' : 'asc' } : { sortKey: key, sortDir: key === 'estimatedSizeKb' || key === 'installDate' ? 'desc' : 'asc' }));
  },

  setFilter(filter) {
    set({ filter, contextMenu: null });
  },

  select(ids, anchorId) {
    set({ selectedIds: ids, anchorId: anchorId ?? ids[ids.length - 1] });
  },

  toggleSelect(id) {
    set((s) => {
      const has = s.selectedIds.includes(id);
      return { selectedIds: has ? s.selectedIds.filter((x) => x !== id) : [...s.selectedIds, id], anchorId: id };
    });
  },

  selectRange(toId, visibleIds) {
    const { anchorId, selectedIds } = get();
    const from = anchorId ? visibleIds.indexOf(anchorId) : -1;
    const to = visibleIds.indexOf(toId);
    if (from < 0 || to < 0) {
      set({ selectedIds: [toId], anchorId: toId });
      return;
    }
    const [a, b] = from < to ? [from, to] : [to, from];
    const range = visibleIds.slice(a, b + 1);
    const merged = Array.from(new Set([...selectedIds, ...range]));
    set({ selectedIds: merged });
  },

  clearSelection() {
    set({ selectedIds: [], anchorId: undefined });
  },

  removeApps(ids) {
    const drop = new Set(ids);
    set((s) => ({
      apps: s.apps.filter((a) => !drop.has(a.id)),
      selectedIds: s.selectedIds.filter((id) => !drop.has(id)),
    }));
  },

  upsertApps(incoming) {
    set((s) => {
      const map = new Map(s.apps.map((a) => [a.id, a]));
      for (const a of incoming) map.set(a.id, a);
      return { apps: Array.from(map.values()) };
    });
  },

  openDialog(dialog) {
    set({ dialog, contextMenu: null });
  },

  closeDialog() {
    set({ dialog: { type: 'none' } });
  },

  openContextMenu(contextMenu) {
    set({ contextMenu });
  },

  closeContextMenu() {
    if (get().contextMenu) set({ contextMenu: null });
  },

  pushToast(kind, message) {
    const id = toastSeq++;
    set((s) => ({ toasts: [...s.toasts.slice(-4), { id, kind, message }] }));
    setTimeout(() => get().dismissToast(id), kind === 'error' ? 7000 : 4000);
  },

  dismissToast(id) {
    set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
  },

  log(level, message) {
    set((s) => ({ logs: [...s.logs.slice(-499), { ts: new Date().toISOString(), level, message }] }));
  },

  clearLogs() {
    set({ logs: [] });
  },

  async updateSettings(patch) {
    const prev = get().settings;
    const next = { ...prev, ...patch };
    set({ settings: next });
    try {
      await ipc.saveSettings(next);
      if (prev.showStoreApps !== next.showStoreApps) await get().refresh(true);
    } catch (e) {
      get().reportError(e);
    }
  },

  setDetailOpen(detailOpen) {
    set({ detailOpen });
  },

  setBusy(busy) {
    set({ busy });
  },

  async ensureAdmin() {
    if (get().isAdmin) return true;
    try {
      const ok = await ipc.requestElevation();
      if (ok) {
        set({ isAdmin: true });
        get().log('info', 'Elevated to administrator');
      } else {
        get().log('warn', 'Elevation request denied');
      }
      return ok;
    } catch (e) {
      get().reportError(e);
      return false;
    }
  },

  cacheIcon(id, dataUrl) {
    set((s) => ({ iconCache: { ...s.iconCache, [id]: dataUrl } }));
  },

  reportError(e, title) {
    const error = toAppError(e);
    get().log('error', `${error.code}: ${error.message}`);
    set({ dialog: { type: 'error', title, error } });
  },
}));

/* ------------------------------------------------------------------ */
/* Derived data: filtered + sorted list, memoised on its inputs.       */
/* ------------------------------------------------------------------ */

const collator = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true });

function matchesFilter(app: InstalledApp, filter: FilterKind, settings: Settings): boolean {
  switch (filter) {
    case 'all':
      if (app.isSystemComponent && !settings.showSystemComponents) return false;
      if (app.isUpdate && !settings.showUpdates) return false;
      return true;
    case 'program':
      return app.kind === 'program';
    case 'msi':
      return app.isMsi && !app.isSystemComponent && !app.isUpdate;
    case 'store':
      return app.kind === 'store';
    case 'game':
      return app.kind === 'game';
    case 'system':
      return app.isSystemComponent;
    case 'update':
      return app.isUpdate;
    case 'large':
      return (app.estimatedSizeKb ?? 0) >= LARGE_APP_KB;
    case 'recent':
      return isRecent(app.installDate, 30);
    case 'broken':
      return !app.uninstallString && !app.quietUninstallString;
    default:
      return true;
  }
}

function sortApps(apps: InstalledApp[], key: SortKey, dir: SortDir): InstalledApp[] {
  const sign = dir === 'asc' ? 1 : -1;
  const sorted = [...apps].sort((a, b) => {
    let r = 0;
    switch (key) {
      case 'name':
        r = collator.compare(a.name, b.name);
        break;
      case 'publisher':
        r = collator.compare(a.publisher ?? '\uffff', b.publisher ?? '\uffff');
        break;
      case 'version':
        r = compareVersions(a.version, b.version);
        break;
      case 'estimatedSizeKb':
        r = (a.estimatedSizeKb ?? -1) - (b.estimatedSizeKb ?? -1);
        break;
      case 'installDate':
        r = (a.installDate ?? '').localeCompare(b.installDate ?? '');
        break;
      case 'architecture':
        r = a.architecture.localeCompare(b.architecture);
        break;
    }
    if (r === 0) r = collator.compare(a.name, b.name);
    return r * sign;
  });
  return sorted;
}

let cacheInputs: [InstalledApp[], string, SortKey, SortDir, FilterKind, Settings] | null = null;
let cacheResult: InstalledApp[] = [];

export function selectVisibleApps(s: AppState): InstalledApp[] {
  const inputs: typeof cacheInputs = [s.apps, s.query, s.sortKey, s.sortDir, s.filter, s.settings];
  if (cacheInputs && cacheInputs.every((v, i) => v === inputs[i])) return cacheResult;
  const tokens = s.query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const filtered = s.apps.filter((app) => {
    if (!matchesFilter(app, s.filter, s.settings)) return false;
    if (tokens.length === 0) return true;
    const hay = `${app.name} ${app.publisher ?? ''} ${app.version ?? ''}`.toLowerCase();
    return tokens.every((t) => hay.includes(t));
  });
  cacheInputs = inputs;
  cacheResult = sortApps(filtered, s.sortKey, s.sortDir);
  return cacheResult;
}

export function selectSelectedApps(s: AppState): InstalledApp[] {
  if (s.selectedIds.length === 0) return [];
  const set = new Set(s.selectedIds);
  return s.apps.filter((a) => set.has(a.id));
}

export function getAppById(id: string | undefined): InstalledApp | undefined {
  if (!id) return undefined;
  return useAppStore.getState().apps.find((a) => a.id === id);
}
