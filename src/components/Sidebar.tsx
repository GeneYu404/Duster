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
        className={cn(
          'group flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] transition-colors',
          active
            ? 'bg-accent-soft font-medium text-accent'
            : 'text-fg2 hover:bg-subtle hover:text-fg',
        )}
      >
        <Icon className={cn('h-4 w-4 shrink-0', active ? 'text-accent' : 'text-fg3 group-hover:text-fg2')} />
        <span className="flex-1 truncate">{t(label)}</span>
        <span className={cn('rounded-full px-1.5 text-[11px] tabular-nums', active ? 'bg-accent text-on-accent' : 'bg-subtle text-fg3')}>
          {counts[key]}
        </span>
      </button>
    );
  };

  return (
    <aside className="hidden w-52 shrink-0 flex-col border-r border-stroke bg-layer-solid md:flex">
      <div className="win-scroll flex-1 overflow-auto p-2">
        <div className="px-2 pt-1 pb-1.5 text-[10px] font-semibold tracking-wider text-fg3 uppercase">{t('sidebar.categories')}</div>
        <div className="space-y-0.5">{CATEGORIES.map(renderItem)}</div>
        <div className="px-2 pt-4 pb-1.5 text-[10px] font-semibold tracking-wider text-fg3 uppercase">{t('sidebar.quick')}</div>
        <div className="space-y-0.5">{QUICK.map(renderItem)}</div>
        {(!settings.showSystemComponents || !settings.showUpdates) && (
          <p className="mt-4 px-2 text-[11px] leading-relaxed text-fg3">{t('sidebar.hiddenHint')}</p>
        )}
      </div>
      <div className="border-t border-stroke px-3 py-2.5">
        <div className="text-[10px] font-semibold tracking-wider text-fg3 uppercase">{t('sidebar.totalSize')}</div>
        <div className="mt-0.5 text-[15px] font-semibold tabular-nums text-fg">{formatKb(visibleSize)}</div>
        <div className="text-[11px] text-fg2">{t('items', { count: visible.length })}</div>
      </div>
    </aside>
  );
}
