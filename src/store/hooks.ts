import { useCallback, useEffect, useMemo } from 'react';
import { translate, type TKey } from '../i18n';
import { ipc } from '../ipc/commands';
import type { InstalledApp } from '../types/app';
import { selectVisibleApps, useAppStore } from './useAppStore';

export function useT() {
  const lang = useAppStore((s) => s.settings.language);
  return useCallback((key: TKey, params?: Record<string, string | number>) => translate(lang, key, params), [lang]);
}

export function useVisibleApps(): InstalledApp[] {
  return useAppStore(selectVisibleApps);
}

export function useSelectedApps(): InstalledApp[] {
  const apps = useAppStore((s) => s.apps);
  const selectedIds = useAppStore((s) => s.selectedIds);
  return useMemo(() => {
    if (selectedIds.length === 0) return [];
    const set = new Set(selectedIds);
    return apps.filter((a) => set.has(a.id));
  }, [apps, selectedIds]);
}

const pending = new Set<string>();

/** Lazily resolves (and caches) an app icon via `get_app_icon`. */
export function useAppIcon(appId: string | undefined): string | null | undefined {
  const cached = useAppStore((s) => (appId ? s.iconCache[appId] : undefined));
  const cacheIcon = useAppStore((s) => s.cacheIcon);
  useEffect(() => {
    if (!appId || cached !== undefined || pending.has(appId)) return;
    pending.add(appId);
    // Results are written to the global cache even if the row unmounts meanwhile
    // (virtualised rows mount/unmount constantly while scrolling).
    ipc
      .getAppIcon(appId)
      .then((url) => cacheIcon(appId, url))
      .catch(() => cacheIcon(appId, null))
      .finally(() => pending.delete(appId));
  }, [appId, cached, cacheIcon]);
  return cached;
}
