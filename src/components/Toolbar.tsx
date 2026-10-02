import { Archive, Download, PanelRight, RefreshCw, ScrollText, Search, Settings, ShieldAlert, ShieldCheck, X } from 'lucide-react';
import { useT } from '../store/hooks';
import { useAppStore } from '../store/useAppStore';
import { cn } from '../utils/cn';
import { Button, IconButton, Kbd } from './ui';

export const SEARCH_INPUT_ID = 'duster-global-search';

/**
 * 品牌标识：与 `src-tauri/icons/source-1024.png` 同一形状（等轴六边形包裹轮廓 +
 * 居中减号）。原来用的 lucide `PackageMinus` 在 18px 下中线会和横杠连成「＋」，
 * 语义从"卸载"变成"添加"，所以改成自绘路径。
 */
function BrandMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinejoin="round" className={className} aria-hidden>
      <path d="M12 5 19.2 8.8v6.4L12 19l-7.2-3.8V8.8z" />
      <rect x="8.25" y="11.1" width="7.5" height="1.85" rx="0.92" fill="currentColor" stroke="none" />
    </svg>
  );
}

export function Toolbar() {
  const t = useT();
  const query = useAppStore((s) => s.query);
  const setQuery = useAppStore((s) => s.setQuery);
  const loading = useAppStore((s) => s.loading);
  const refresh = useAppStore((s) => s.refresh);
  const openDialog = useAppStore((s) => s.openDialog);
  const isAdmin = useAppStore((s) => s.isAdmin);
  const ensureAdmin = useAppStore((s) => s.ensureAdmin);
  const pushToast = useAppStore((s) => s.pushToast);
  const detailOpen = useAppStore((s) => s.detailOpen);
  const setDetailOpen = useAppStore((s) => s.setDetailOpen);
  const selectedCount = useAppStore((s) => s.selectedIds.length);

  return (
    <header className="flex h-12 shrink-0 items-center gap-2 border-b border-stroke bg-card px-3">
      <div className="mr-1 flex items-center gap-2 select-none">
        <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-gradient-to-br from-accent to-brand2 text-on-accent shadow-sm">
          <BrandMark className="h-[18px] w-[18px]" />
        </span>
        <div className="leading-tight">
          <div className="text-[14px] font-semibold tracking-tight text-fg">{t('appName')}</div>
          <div className="hidden text-[10px] text-fg2 lg:block">{t('tagline')}</div>
        </div>
      </div>

      <div className="relative mx-2 flex max-w-xl flex-1 items-center">
        <Search className="pointer-events-none absolute left-2.5 h-4 w-4 text-fg3" />
        <input
          id={SEARCH_INPUT_ID}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              setQuery('');
              (e.target as HTMLInputElement).blur();
            }
          }}
          placeholder={t('search')}
          spellCheck={false}
          className="h-8 w-full rounded-md border border-stroke bg-layer-solid pr-16 pl-8 text-[13px] text-fg placeholder:text-fg3 focus:border-accent focus:bg-card focus:outline-none"
        />
        <div className="absolute right-2 flex items-center gap-1">
          {query ? (
            <button type="button" onClick={() => setQuery('')} className="rounded p-0.5 text-fg3 hover:text-fg" title={t('table.clearSearch')}>
              <X className="h-3.5 w-3.5" />
            </button>
          ) : (
            <span className="hidden items-center gap-0.5 md:flex">
              <Kbd>Ctrl</Kbd>
              <Kbd>F</Kbd>
            </span>
          )}
        </div>
      </div>

      <div className="ml-auto flex items-center gap-0.5">
        <IconButton label={`${t('refresh')} (F5)`} onClick={() => refresh()} disabled={loading}>
          <RefreshCw className={cn('h-4 w-4', loading && 'animate-spin')} />
        </IconButton>
        <IconButton label={t('export')} onClick={() => openDialog({ type: 'export', scope: selectedCount > 0 ? 'selected' : 'view' })}>
          <Download className="h-4 w-4" />
        </IconButton>
        <IconButton label={t('backups')} onClick={() => openDialog({ type: 'backups' })}>
          <Archive className="h-4 w-4" />
        </IconButton>
        <IconButton label={t('logs')} onClick={() => openDialog({ type: 'logs' })}>
          <ScrollText className="h-4 w-4" />
        </IconButton>
        <IconButton label={t('settings')} onClick={() => openDialog({ type: 'settings' })}>
          <Settings className="h-4 w-4" />
        </IconButton>
        <span className="mx-1.5 h-5 w-px bg-stroke" />
        {isAdmin ? (
          <span className="flex h-8 items-center gap-1.5 rounded-md px-2 text-xs font-medium text-success" title={t('status.admin')}>
            <ShieldCheck className="h-4 w-4" />
            <span className="hidden sm:inline">{t('toolbar.admin')}</span>
          </span>
        ) : (
          <Button
            variant="subtle"
            size="sm"
            icon={<ShieldAlert className="h-3.5 w-3.5 text-warning" />}
            title={t('toolbar.adminTip')}
            onClick={async () => {
              const ok = await ensureAdmin();
              pushToast(ok ? 'success' : 'error', t(ok ? 'toast.elevated' : 'toast.elevationDenied'));
            }}
          >
            <span className="hidden sm:inline">{t('toolbar.runAsAdmin')}</span>
          </Button>
        )}
        <span className="mx-1.5 h-5 w-px bg-stroke" />
        <IconButton label={t('toolbar.toggleDetails')} active={detailOpen} onClick={() => setDetailOpen(!detailOpen)}>
          <PanelRight className="h-4 w-4" />
        </IconButton>
      </div>
    </header>
  );
}
