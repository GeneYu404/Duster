import { memo, useCallback, useEffect, useRef, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { ArrowDown, ArrowUp, PackageSearch, SearchX } from 'lucide-react';
import type { InstalledApp } from '../types/app';
import { useT, useVisibleApps } from '../store/hooks';
import { useAppStore, type SortKey } from '../store/useAppStore';
import { cn } from '../utils/cn';
import { formatKb } from '../utils/format';
import { AppIcon } from './AppIcon';
import { Badge, KIND_TONE, Spinner } from './ui';
import type { TKey } from '../i18n';

const ROW_H = 34;
const GRID = 'minmax(260px, 2.4fr) minmax(150px, 1.3fr) 130px 92px 104px 60px';

const COLUMNS: { key: SortKey; label: TKey; align?: 'right' }[] = [
  { key: 'name', label: 'name' },
  { key: 'publisher', label: 'publisher' },
  { key: 'version', label: 'version' },
  { key: 'estimatedSizeKb', label: 'size', align: 'right' },
  { key: 'installDate', label: 'installDate' },
  { key: 'architecture', label: 'architecture' },
];

interface RowProps {
  app: InstalledApp;
  selected: boolean;
  focused: boolean;
  striped: boolean;
  style: CSSProperties;
  kindLabel: string;
  onMouseDown: (e: MouseEvent, app: InstalledApp) => void;
  onContextMenu: (e: MouseEvent, app: InstalledApp) => void;
  onDoubleClick: (app: InstalledApp) => void;
}

const Row = memo(function Row({ app, selected, focused, striped, style, kindLabel, onMouseDown, onContextMenu, onDoubleClick }: RowProps) {
  return (
    <div
      role="row"
      aria-selected={selected}
      style={{ ...style, gridTemplateColumns: GRID }}
      onMouseDown={(e) => onMouseDown(e, app)}
      onContextMenu={(e) => onContextMenu(e, app)}
      onDoubleClick={() => onDoubleClick(app)}
      className={cn(
        'row',
        selected ? 'row--sel' : striped ? 'row--striped' : 'row--plain',
        focused && 'row--focused',
      )}
    >
      <div className="cell-name">
        <AppIcon appId={app.id} name={app.name} size={18} />
        <span className="truncate">{app.name}</span>
        {app.kind !== 'program' && <Badge tone={KIND_TONE[app.kind]}>{kindLabel}</Badge>}
        {!app.uninstallString && !app.quietUninstallString && app.kind !== 'store' && (
          <span className="warn-dot" title="No uninstall command" />
        )}
      </div>
      <div className="cell-pub">{app.publisher ?? '—'}</div>
      <div className="cell-ver">{app.version ?? '—'}</div>
      <div className="cell-size">{formatKb(app.estimatedSizeKb)}</div>
      <div className="cell-date">{app.installDate ?? '—'}</div>
      <div className="cell-arch">{app.architecture === 'unknown' ? '—' : app.architecture}</div>
    </div>
  );
});

export function AppTable() {
  const t = useT();
  const rows = useVisibleApps();
  const loading = useAppStore((s) => s.loading);
  const initialised = useAppStore((s) => s.initialised);
  const query = useAppStore((s) => s.query);
  const setQuery = useAppStore((s) => s.setQuery);
  const selectedIds = useAppStore((s) => s.selectedIds);
  const anchorId = useAppStore((s) => s.anchorId);
  const sortKey = useAppStore((s) => s.sortKey);
  const sortDir = useAppStore((s) => s.sortDir);
  const setSort = useAppStore((s) => s.setSort);
  const select = useAppStore((s) => s.select);
  const toggleSelect = useAppStore((s) => s.toggleSelect);
  const selectRange = useAppStore((s) => s.selectRange);
  const openContextMenu = useAppStore((s) => s.openContextMenu);
  const openDialog = useAppStore((s) => s.openDialog);
  const totalApps = useAppStore((s) => s.apps.length);

  const parentRef = useRef<HTMLDivElement>(null);
  const headerRef = useRef<HTMLDivElement>(null);

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ROW_H,
    overscan: 10,
  });

  const selectedSet = new Set(selectedIds);

  const handleMouseDown = useCallback(
    (e: MouseEvent, app: InstalledApp) => {
      if (e.button === 2) return; // handled by contextmenu
      if (e.shiftKey) {
        e.preventDefault();
        selectRange(
          app.id,
          rows.map((r) => r.id),
        );
      } else if (e.ctrlKey || e.metaKey) {
        toggleSelect(app.id);
      } else {
        select([app.id], app.id);
      }
    },
    [rows, select, selectRange, toggleSelect],
  );

  const handleContextMenu = useCallback(
    (e: MouseEvent, app: InstalledApp) => {
      e.preventDefault();
      if (!useAppStore.getState().selectedIds.includes(app.id)) select([app.id], app.id);
      openContextMenu({ x: e.clientX, y: e.clientY, appId: app.id });
    },
    [openContextMenu, select],
  );

  const handleDoubleClick = useCallback(
    (app: InstalledApp) => {
      openDialog({ type: 'uninstall', appIds: [app.id], quiet: false });
    },
    [openDialog],
  );

  // Keyboard navigation inside the list.
  const onKeyDown = (e: ReactKeyboardEvent) => {
    if (rows.length === 0) return;
    const idx = anchorId ? rows.findIndex((r) => r.id === anchorId) : -1;
    const move = (next: number) => {
      const clamped = Math.max(0, Math.min(rows.length - 1, next));
      const target = rows[clamped];
      if (e.shiftKey) {
        selectRange(
          target.id,
          rows.map((r) => r.id),
        );
        useAppStore.setState({ anchorId: target.id });
      } else {
        select([target.id], target.id);
      }
      virtualizer.scrollToIndex(clamped, { align: 'auto' });
    };
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        move(idx + 1);
        break;
      case 'ArrowUp':
        e.preventDefault();
        move(idx <= 0 ? 0 : idx - 1);
        break;
      case 'PageDown':
        e.preventDefault();
        move(idx + 15);
        break;
      case 'PageUp':
        e.preventDefault();
        move(idx - 15);
        break;
      case 'Home':
        e.preventDefault();
        move(0);
        break;
      case 'End':
        e.preventDefault();
        move(rows.length - 1);
        break;
      case 'Enter':
        if (anchorId) {
          e.preventDefault();
          openDialog({ type: 'properties', appId: anchorId });
        }
        break;
      case 'Delete':
        if (selectedIds.length > 0) {
          e.preventDefault();
          openDialog({ type: 'uninstall', appIds: selectedIds, quiet: false });
        }
        break;
      case 'a':
      case 'A':
        if (e.ctrlKey || e.metaKey) {
          e.preventDefault();
          select(
            rows.map((r) => r.id),
            anchorId,
          );
        }
        break;
    }
  };

  // Keep the header horizontally aligned with the body.
  useEffect(() => {
    const el = parentRef.current;
    if (!el) return;
    const sync = () => {
      if (headerRef.current) headerRef.current.scrollLeft = el.scrollLeft;
    };
    el.addEventListener('scroll', sync, { passive: true });
    return () => el.removeEventListener('scroll', sync);
  }, []);

  const items = virtualizer.getVirtualItems();

  return (
    <div className="table">
      <div ref={headerRef} className="table-head">
        <div role="row" className="table-grid" style={{ gridTemplateColumns: GRID }}>
          {COLUMNS.map((c) => {
            const active = sortKey === c.key;
            return (
              <button
                key={c.key}
                type="button"
                onClick={() => setSort(c.key)}
                className={cn('col-btn', active ? 'col-btn--on' : 'col-btn--off', c.align === 'right' && 'col-btn--right')}
              >
                <span className="truncate">{t(c.label)}</span>
                {active && (sortDir === 'asc' ? <ArrowUp className="sort-icon" /> : <ArrowDown className="sort-icon" />)}
              </button>
            );
          })}
        </div>
      </div>

      <div
        ref={parentRef}
        tabIndex={0}
        role="grid"
        aria-rowcount={rows.length}
        onKeyDown={onKeyDown}
        className="win-scroll table-scroll"
      >
        {rows.length > 0 && (
          <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
            {items.map((vi) => {
              const app = rows[vi.index];
              return (
                <Row
                  key={app.id}
                  app={app}
                  selected={selectedSet.has(app.id)}
                  focused={anchorId === app.id && selectedSet.size > 1}
                  striped={vi.index % 2 === 1}
                  kindLabel={t(`kind.${app.kind}` as TKey)}
                  style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: vi.size, transform: `translateY(${vi.start}px)` }}
                  onMouseDown={handleMouseDown}
                  onContextMenu={handleContextMenu}
                  onDoubleClick={handleDoubleClick}
                />
              );
            })}
          </div>
        )}

        {rows.length === 0 && initialised && !loading && (
          <div className="table-empty">
            {totalApps === 0 ? <PackageSearch className="i40 c-fg3" /> : <SearchX className="i40 c-fg3" />}
            <div className="t-sm">{totalApps === 0 ? t('table.empty') : t('table.noMatch')}</div>
            {query && (
              <button type="button" className="table-empty-action" onClick={() => setQuery('')}>
                {t('table.clearSearch')}
              </button>
            )}
          </div>
        )}
      </div>

      {loading && !initialised && (
        <div className="table-loading">
          <Spinner className="spinner--lg" />
          {t('table.loading')}
        </div>
      )}
    </div>
  );
}
