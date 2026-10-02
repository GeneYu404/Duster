import { useMemo } from 'react';
import { AlertTriangle, Boxes, Clock, Cog, Gamepad2, HardDrive, LayoutGrid, Package, Puzzle, ShoppingBag, type LucideIcon } from 'lucide-react';
import { useT, useVisibleApps } from '../store/hooks';
import { LARGE_APP_KB, useAppStore, type FilterKind } from '../store/useAppStore';
import { cn } from '../utils/cn';
import { formatKb, isRecent } from '../utils/format';
import type { TKey } from '../i18n';

const CATEGORIES: { key: FilterKind; label: TKey; icon: LucideIcon }[] = [
  { key: 'all', label: 'filter.all', icon: LayoutGrid },
  { key: 'program', label: 'filter.program', icon: Package },
  { key: 'msi', label: 'filter.msi', icon: Boxes },
  { key: 'store', label: 'filter.store', icon: ShoppingBag },
  { key: 'game', label: 'filter.game', icon: Gamepad2 },
  { key: 'system', label: 'filter.system', icon: Cog },
  { key: 'update', label: 'filter.update', icon: Puzzle },
];

const QUICK: { key: FilterKind; label: TKey; icon: LucideIcon }[] = [
  { key: 'large', label: 'filter.large', icon: HardDrive },
  { key: 'recent', label: 'filter.recent', icon: Clock },
  { key: 'broken', label: 'filter.broken', icon: AlertTriangle },
];

export function Sidebar() {
  const t = useT();
  const apps = useAppStore((s) => s.apps);
  const settings = useAppStore((s) => s.settings);
  const filter = useAppStore((s) => s.filter);
  const setFilter = useAppStore((s) => s.setFilter);
  const visible = useVisibleApps();

  const counts = useMemo(() => {
    const c: Record<FilterKind, number> = { all: 0, program: 0, msi: 0, store: 0, game: 0, system: 0, update: 0, large: 0, recent: 0, broken: 0 };
    for (const a of apps) {
      const hiddenInAll = (a.isSystemComponent && !settings.showSystemComponents) || (a.isUpdate && !settings.showUpdates);
      if (!hiddenInAll) c.all++;
      if (a.kind === 'program') c.program++;
      if (a.isMsi && !a.isSystemComponent && !a.isUpdate) c.msi++;
      if (a.kind === 'store') c.store++;
      if (a.kind === 'game') c.game++;
      if (a.isSystemComponent) c.system++;
      if (a.isUpdate) c.update++;
      if ((a.estimatedSizeKb ?? 0) >= LARGE_APP_KB) c.large++;
      if (isRecent(a.installDate, 30)) c.recent++;
      if (!a.uninstallString && !a.quietUninstallString) c.broken++;
    }
    return c;
  }, [apps, settings.showSystemComponents, settings.showUpdates]);

  const visibleSize = useMemo(() => visible.reduce((sum, a) => sum + (a.estimatedSizeKb ?? 0), 0), [visible]);

  const renderItem = ({ key, label, icon: Icon }: { key: FilterKind; label: TKey; icon: LucideIcon }) => {
    const active = filter === key;
    return (
      <button
        key={key}
        type="button"
        onClick={() => setFilter(key)}
        className={cn('nav-item t-colors', active && 'nav-item--active')}
      >
        <Icon className="nav-icon" />
        <span className="nav-text">{t(label)}</span>
        <span className="nav-count">{counts[key]}</span>
      </button>
    );
  };

  return (
    <aside className="sidebar">
      <div className="win-scroll sidebar-scroll">
        <div className={cn('group-label', 'sidebar-group')}>{t('sidebar.categories')}</div>
        <div className="sidebar-list stack-2">{CATEGORIES.map(renderItem)}</div>
        <div className={cn('group-label', 'sidebar-group', 'sidebar-group--spaced')}>{t('sidebar.quick')}</div>
        <div className="sidebar-list stack-2">{QUICK.map(renderItem)}</div>
        {(!settings.showSystemComponents || !settings.showUpdates) && (
          <p className="sidebar-hint">{t('sidebar.hiddenHint')}</p>
        )}
      </div>
      <div className="sidebar-foot">
        <div className="group-label">{t('sidebar.totalSize')}</div>
        <div className="sidebar-size">{formatKb(visibleSize)}</div>
        <div className="sidebar-count">{t('items', { count: visible.length })}</div>
      </div>
    </aside>
  );
}
