import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import {
  ClipboardCopy,
  Copy,
  Download,
  Eraser,
  FileSearch,
  FolderOpen,
  Info,
  ListX,
  Locate,
  Regex,
  ScanSearch,
  Trash2,
  VolumeX,
  XSquare,
  type LucideIcon,
} from 'lucide-react';
import { ipc } from '../ipc/commands';
import { useSelectedApps, useT } from '../store/hooks';
import { useAppStore } from '../store/useAppStore';
import { cn } from '../utils/cn';
import { executableFromDisplayIcon } from '../utils/command';
import { copyText } from '../utils/format';
import { formatAppInfo, formatAppList } from '../utils/appInfo';

interface Item {
  id: string;
  label: ReactNode;
  icon?: LucideIcon;
  danger?: boolean;
  disabled?: boolean;
  onSelect: () => void;
}

type Entry = Item | 'sep';

export function ContextMenu() {
  const t = useT();
  const menu = useAppStore((s) => s.contextMenu);
  const close = useAppStore((s) => s.closeContextMenu);
  const openDialog = useAppStore((s) => s.openDialog);
  const clearSelection = useAppStore((s) => s.clearSelection);
  const pushToast = useAppStore((s) => s.pushToast);
  const reportError = useAppStore((s) => s.reportError);
  const apps = useAppStore((s) => s.apps);
  const selected = useSelectedApps();
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);

  useLayoutEffect(() => {
    if (!menu || !ref.current) {
      setPos(null);
      return;
    }
    const rect = ref.current.getBoundingClientRect();
    const x = Math.min(menu.x, window.innerWidth - rect.width - 8);
    const y = Math.min(menu.y, window.innerHeight - rect.height - 8);
    setPos({ x: Math.max(4, x), y: Math.max(4, y) });
  }, [menu]);

  useEffect(() => {
    if (!menu) return;
    const onDown = (e: Event) => {
      if (ref.current && e.target instanceof Node && ref.current.contains(e.target)) return;
      close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    window.addEventListener('mousedown', onDown, true);
    window.addEventListener('wheel', onDown, { capture: true, passive: true });
    window.addEventListener('resize', close);
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('mousedown', onDown, true);
      window.removeEventListener('wheel', onDown, true);
      window.removeEventListener('resize', close);
      window.removeEventListener('keydown', onKey, true);
    };
  }, [menu, close]);

  if (!menu) return null;
  const app = apps.find((a) => a.id === menu.appId);
  if (!app) return null;

  const run = async (fn: () => Promise<void>, successMsg?: string) => {
    try {
      await fn();
      if (successMsg) pushToast('success', successMsg);
    } catch (e) {
      reportError(e);
    }
  };

  const multi = selected.length > 1;
  const hasCommand = !!(app.uninstallString || app.quietUninstallString);
  const exe = executableFromDisplayIcon(app.displayIcon);

  const entries: Entry[] = multi
    ? [
        { id: 'batch', label: t('menu.uninstallSelected', { count: selected.length }), icon: Trash2, onSelect: () => openDialog({ type: 'uninstall', appIds: selected.map((a) => a.id), quiet: false }) },
        { id: 'export', label: t('menu.exportSelected'), icon: Download, onSelect: () => openDialog({ type: 'export', scope: 'selected' }) },
        {
          id: 'copyList',
          label: t('menu.copyInfo'),
          icon: ClipboardCopy,
          onSelect: () => void copyText(formatAppList(selected)).then((ok) => pushToast(ok ? 'success' : 'error', t(ok ? 'copied' : 'copyFailed'))),
        },
        'sep',
        { id: 'clear', label: t('clearSelection'), icon: XSquare, onSelect: clearSelection },
      ]
    : [
        { id: 'uninstall', label: t('menu.uninstall'), icon: Trash2, disabled: !hasCommand, onSelect: () => openDialog({ type: 'uninstall', appIds: [app.id], quiet: false }) },
        { id: 'quiet', label: t('menu.quietUninstall'), icon: VolumeX, disabled: !app.quietUninstallString && !app.isMsi, onSelect: () => openDialog({ type: 'uninstall', appIds: [app.id], quiet: true }) },
        { id: 'force', label: t('menu.forceRemove'), icon: Eraser, danger: true, onSelect: () => openDialog({ type: 'leftovers', appId: app.id, appName: app.name, mode: 'force' }) },
        { id: 'scan', label: t('menu.scanLeftovers'), icon: ScanSearch, onSelect: () => openDialog({ type: 'leftovers', appId: app.id, appName: app.name, mode: 'scan' }) },
        'sep',
        { id: 'entry', label: t('menu.removeEntry'), icon: ListX, danger: true, onSelect: () => openDialog({ type: 'delete-entry', appId: app.id }) },
        'sep',
        { id: 'open', label: t('menu.openLocation'), icon: FolderOpen, disabled: !app.installLocation, onSelect: () => void run(() => ipc.openInstallLocation(app.id), t('toast.opened')) },
        { id: 'reveal', label: t('menu.revealExe'), icon: Locate, disabled: !exe, onSelect: () => void run(() => ipc.revealPath(exe!), t('toast.opened')) },
        { id: 'reg', label: t('menu.openRegistry'), icon: Regex, onSelect: () => void run(() => ipc.openRegistryKey(app.registryPath), t('toast.opened')) },
        'sep',
        { id: 'props', label: t('menu.properties'), icon: Info, onSelect: () => openDialog({ type: 'properties', appId: app.id }) },
        {
          id: 'copy',
          label: t('menu.copyInfo'),
          icon: ClipboardCopy,
          onSelect: () => void copyText(formatAppInfo(app, t)).then((ok) => pushToast(ok ? 'success' : 'error', t(ok ? 'copied' : 'copyFailed'))),
        },
        { id: 'copyName', label: t('menu.copyName'), icon: Copy, onSelect: () => void copyText(app.name).then((ok) => pushToast(ok ? 'success' : 'error', t(ok ? 'copied' : 'copyFailed'))) },
        { id: 'export', label: t('menu.exportSelected'), icon: FileSearch, onSelect: () => openDialog({ type: 'export', scope: 'selected' }) },
      ];

  return (
    <div
      ref={ref}
      role="menu"
      style={{ left: pos?.x ?? menu.x, top: pos?.y ?? menu.y, visibility: pos ? 'visible' : 'hidden' }}
      className="fixed z-40 min-w-[220px] rounded-lg border border-stroke bg-acrylic p-1 text-[13px] text-fg shadow-flyout backdrop-blur-2xl"
    >
      <div className="truncate border-b border-stroke px-2.5 py-1.5 text-[11px] text-fg2">
        {multi ? t('detail.multi', { count: selected.length }) : app.name}
      </div>
      {entries.map((e, i) =>
        e === 'sep' ? (
          <div key={`sep-${i}`} className="my-1 h-px bg-stroke" />
        ) : (
          <button
            key={e.id}
            type="button"
            role="menuitem"
            disabled={e.disabled}
            onClick={() => {
              close();
              e.onSelect();
            }}
            className={cn(
              'flex w-full items-center gap-2.5 rounded-md px-2.5 py-1.5 text-left transition-colors disabled:opacity-40',
              e.danger ? 'text-danger hover:bg-danger-soft' : 'hover:bg-subtle',
              'disabled:hover:bg-transparent',
            )}
          >
            {e.icon && <e.icon className="h-4 w-4 shrink-0 opacity-80" />}
            <span className="flex-1">{e.label}</span>
          </button>
        ),
      )}
    </div>
  );
}
