import { Archive, Download, PanelRight, RefreshCw, ScrollText, Search, Settings, ShieldAlert, ShieldCheck, X } from 'lucide-react';
import { useT } from '../store/hooks';
import { useAppStore } from '../store/useAppStore';
import { cn } from '../utils/cn';
import { Button, IconButton, Kbd } from './ui';

export const SEARCH_INPUT_ID = 'duster-global-search';

/**
 * 品牌标识：与仓库根的 `icon.png`（1024×1024 图标母版）同一形状（等轴六边形包裹轮廓 +
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
    <header className="toolbar">
      <div className="brand">
        <span className="brand-mark">
          <BrandMark className="i18" />
        </span>
        <div className="brand-text">
          <div className="brand-name">{t('appName')}</div>
          <div className="brand-tagline">{t('tagline')}</div>
        </div>
      </div>

      <div className="search-field">
        <Search className="search-icon i16 c-fg3" />
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
          className="search-input"
        />
        <div className="search-tools">
          {query ? (
            <button type="button" onClick={() => setQuery('')} className="search-clear" title={t('table.clearSearch')}>
              <X className="i14" />
            </button>
          ) : (
            <span className="search-hints">
              <Kbd>Ctrl</Kbd>
              <Kbd>F</Kbd>
            </span>
          )}
        </div>
      </div>

      <div className="toolbar-actions">
        <IconButton label={`${t('refresh')} (F5)`} onClick={() => refresh()} disabled={loading}>
          <RefreshCw className={cn('i16', loading && 'spin')} />
        </IconButton>
        <IconButton label={t('export')} onClick={() => openDialog({ type: 'export', scope: selectedCount > 0 ? 'selected' : 'view' })}>
          <Download className="i16" />
        </IconButton>
        <IconButton label={t('backups')} onClick={() => openDialog({ type: 'backups' })}>
          <Archive className="i16" />
        </IconButton>
        <IconButton label={t('logs')} onClick={() => openDialog({ type: 'logs' })}>
          <ScrollText className="i16" />
        </IconButton>
        <IconButton label={t('settings')} onClick={() => openDialog({ type: 'settings' })}>
          <Settings className="i16" />
        </IconButton>
        <span className="toolbar-sep" />
        {isAdmin ? (
          <span className="admin-pill" title={t('status.admin')}>
            <ShieldCheck className="i16" />
            <span className="admin-label">{t('toolbar.admin')}</span>
          </span>
        ) : (
          <Button
            variant="subtle"
            size="sm"
            icon={<ShieldAlert className="i14 c-warning" />}
            title={t('toolbar.adminTip')}
            onClick={async () => {
              const ok = await ensureAdmin();
              pushToast(ok ? 'success' : 'error', t(ok ? 'toast.elevated' : 'toast.elevationDenied'));
            }}
          >
            <span className="admin-label">{t('toolbar.runAsAdmin')}</span>
          </Button>
        )}
        <span className="toolbar-sep" />
        <IconButton label={t('toolbar.toggleDetails')} active={detailOpen} onClick={() => setDetailOpen(!detailOpen)}>
          <PanelRight className="i16" />
        </IconButton>
      </div>
    </header>
  );
}
