import { Cpu, Globe, ShieldAlert, ShieldCheck } from 'lucide-react';
import { useT, useVisibleApps } from '../store/hooks';
import { useAppStore } from '../store/useAppStore';
import { formatTime } from '../utils/format';
import { Spinner } from './ui';

export function StatusBar() {
  const t = useT();
  const visible = useVisibleApps();
  const total = useAppStore((s) => s.apps.length);
  const selected = useAppStore((s) => s.selectedIds.length);
  const isAdmin = useAppStore((s) => s.isAdmin);
  const backend = useAppStore((s) => s.backend);
  const loading = useAppStore((s) => s.loading);
  const busy = useAppStore((s) => s.busy);
  const lastRefresh = useAppStore((s) => s.lastRefresh);

  return (
    <footer className="flex h-7 shrink-0 items-center gap-4 border-t border-stroke bg-layer-solid px-3 text-[11px] text-fg2 select-none">
      <span className="tabular-nums">{t('status.showing', { shown: visible.length, total })}</span>
      {selected > 0 && <span className="tabular-nums text-accent">{t('status.selected', { count: selected })}</span>}
      {(loading || busy) && (
        <span className="flex items-center gap-1.5">
          <Spinner className="h-3 w-3" />
          {busy ?? t('status.loading')}
        </span>
      )}
      <span className="flex-1" />
      {lastRefresh && <span className="hidden sm:inline">{t('status.lastRefresh', { time: formatTime(lastRefresh) })}</span>}
      <span className="flex items-center gap-1" title={backend === 'tauri' ? 'Tauri 2 · Rust' : 'Mock backend'}>
        {backend === 'tauri' ? <Cpu className="h-3 w-3" /> : <Globe className="h-3 w-3" />}
        {backend === 'tauri' ? t('status.backendTauri') : t('status.backendMock')}
      </span>
      <span className={isAdmin ? 'flex items-center gap-1 text-success' : 'flex items-center gap-1 text-warning'}>
        {isAdmin ? <ShieldCheck className="h-3 w-3" /> : <ShieldAlert className="h-3 w-3" />}
        {isAdmin ? t('status.admin') : t('status.standard')}
      </span>
    </footer>
  );
}
