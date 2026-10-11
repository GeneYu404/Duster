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
    <footer className="statusbar">
      <span className="status-num">{t('status.showing', { shown: visible.length, total })}</span>
      {selected > 0 && <span className="status-selected">{t('status.selected', { count: selected })}</span>}
      {(loading || busy) && (
        <span className="status-busy">
          <Spinner className="spinner--sm" />
          {busy ?? t('status.loading')}
        </span>
      )}
      <span className="status-spacer" />
      {lastRefresh && <span className="status-refresh">{t('status.lastRefresh', { time: formatTime(lastRefresh) })}</span>}
      <span className="status-backend" title={backend === 'mygo' ? 'Go 1.27 · MyGo 3' : 'Mock backend'}>
        {backend === 'mygo' ? <Cpu className="i12" /> : <Globe className="i12" />}
        {backend === 'mygo' ? t('status.backendGo') : t('status.backendMock')}
      </span>
      <span className={isAdmin ? 'status-priv status-priv--admin' : 'status-priv status-priv--user'}>
        {isAdmin ? <ShieldCheck className="i12" /> : <ShieldAlert className="i12" />}
        {isAdmin ? t('status.admin') : t('status.standard')}
      </span>
    </footer>
  );
}
