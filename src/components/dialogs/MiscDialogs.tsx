import { useEffect, useState } from 'react';
import { AlertOctagon, Archive, ClipboardCopy, Info, ListX, RotateCcw, ScrollText, ShieldCheck, Trash2 } from 'lucide-react';
import { ipc } from '../../ipc/commands';
import { useT } from '../../store/hooks';
import { getAppById, useAppStore } from '../../store/useAppStore';
import type { AppError, BackupInfo, LogLevel } from '../../types/app';
import { cn } from '../../utils/cn';
import { copyText, formatDateTime, formatTime } from '../../utils/format';
import { formatAppInfo } from '../../utils/appInfo';
import { AppIcon } from '../AppIcon';
import { DetailBody, useAppDetail } from '../DetailPanel';
import { Badge, Button, Checkbox, Modal, Select } from '../ui';

/* ------------------------------ Delete entry ------------------------------ */

export function DeleteEntryDialog({ appId }: { appId: string }) {
  const t = useT();
  const closeDialog = useAppStore((s) => s.closeDialog);
  const removeApps = useAppStore((s) => s.removeApps);
  const pushToast = useAppStore((s) => s.pushToast);
  const reportError = useAppStore((s) => s.reportError);
  const log = useAppStore((s) => s.log);
  const settings = useAppStore((s) => s.settings);
  const [app] = useState(() => getAppById(appId));
  const [ack, setAck] = useState(false);
  const [working, setWorking] = useState(false);

  if (!app) return null;

  const run = async () => {
    setWorking(true);
    try {
      const backup = await ipc.deleteAppEntry(app.id);
      removeApps([app.id]);
      log('warn', `Removed registry entry ${app.registryPath} (backup ${backup.path})`);
      pushToast('success', t('de.success', { name: app.name }));
      closeDialog();
    } catch (e) {
      reportError(e);
    } finally {
      setWorking(false);
    }
  };

  return (
    <Modal
      title={t('de.title')}
      subtitle={app.name}
      icon={<ListX className="i20 c-danger" />}
      onClose={closeDialog}
      busy={working}
      footer={
        <>
          <Button onClick={closeDialog} disabled={working}>
            {t('cancel')}
          </Button>
          <Button variant="danger" icon={<Trash2 className="i14" />} disabled={!ack} loading={working} onClick={() => void run()}>
            {t('de.button')}
          </Button>
        </>
      }
    >
      <div className="stack-16 dialog-muted">
        <p className="c-fg2">{t('de.text')}</p>
        <code className="dialog-code dialog-code--boxed">{app.registryPath}</code>
        {(app.uninstallString || app.quietUninstallString) && (
          <p className="callout callout--plain callout--plain-warn">
            <Info className="callout-icon--plain" />
            {t('de.warning')}
          </p>
        )}
        <p className="callout callout--plain">
          <ShieldCheck className="callout-icon--plain callout-icon--success" />
          {t('de.backupNote')} <span className="mono">{settings.backupDirectory}</span>
        </p>
        <Checkbox checked={ack} onChange={setAck} label={t('de.ack')} />
      </div>
    </Modal>
  );
}

/* ---------------------------------- Error --------------------------------- */

export function ErrorDialog({ title, error }: { title?: string; error: AppError }) {
  const t = useT();
  const closeDialog = useAppStore((s) => s.closeDialog);
  const pushToast = useAppStore((s) => s.pushToast);
  const text = `[${error.code}] ${error.message}${error.details ? `\n${error.details}` : ''}`;
  return (
    <Modal
      title={title ?? t('err.title')}
      icon={<AlertOctagon className="i20 c-danger" />}
      onClose={closeDialog}
      size="sm"
      footer={
        <>
          <Button icon={<ClipboardCopy className="i14" />} onClick={() => void copyText(text).then((ok) => pushToast(ok ? 'success' : 'error', t(ok ? 'copied' : 'copyFailed')))}>
            {t('err.copy')}
          </Button>
          <Button variant="primary" onClick={closeDialog}>
            {t('close')}
          </Button>
        </>
      }
    >
      <div className="stack-12 dialog-muted">
        <div className="dialog-error-code">
          <Badge tone="red">{error.code}</Badge>
          <span className="break-words">{error.message}</span>
        </div>
        {error.details && (
          <div>
            <div className="section-title section-title--sub">{t('err.details')}</div>
            <pre className="dialog-console">{error.details}</pre>
          </div>
        )}
      </div>
    </Modal>
  );
}

/* -------------------------------- Properties ------------------------------ */

export function PropertiesDialog({ appId }: { appId: string }) {
  const t = useT();
  const closeDialog = useAppStore((s) => s.closeDialog);
  const pushToast = useAppStore((s) => s.pushToast);
  const app = useAppStore((s) => s.apps.find((a) => a.id === appId));
  const { detail } = useAppDetail(app?.id);
  if (!app) return null;
  return (
    <Modal
      title={t('pr.title', { name: app.name })}
      subtitle={[app.version, app.publisher].filter(Boolean).join(' · ')}
      icon={<AppIcon appId={app.id} name={app.name} size={28} />}
      onClose={closeDialog}
      size="lg"
      footer={
        <>
          <Button icon={<ClipboardCopy className="i14" />} onClick={() => void copyText(formatAppInfo(detail ?? app, t)).then((ok) => pushToast(ok ? 'success' : 'error', t(ok ? 'copied' : 'copyFailed')))}>
            {t('detail.copyAll')}
          </Button>
          <Button variant="primary" onClick={closeDialog}>
            {t('close')}
          </Button>
        </>
      }
    >
      <DetailBody app={app} detail={detail} showRaw />
    </Modal>
  );
}

/* ----------------------------------- Logs --------------------------------- */

const LEVEL_TONE: Record<LogLevel, 'red' | 'amber' | 'sky' | 'neutral' | 'violet'> = { error: 'red', warn: 'amber', info: 'sky', debug: 'neutral', trace: 'violet' };
const LEVEL_ORDER: LogLevel[] = ['error', 'warn', 'info', 'debug', 'trace'];

export function LogsDialog() {
  const t = useT();
  const closeDialog = useAppStore((s) => s.closeDialog);
  const logs = useAppStore((s) => s.logs);
  const clearLogs = useAppStore((s) => s.clearLogs);
  const pushToast = useAppStore((s) => s.pushToast);
  const [level, setLevel] = useState<LogLevel>('trace');
  const [backendLogs, setBackendLogs] = useState<{ ts: string; level: LogLevel; message: string }[]>([]);

  useEffect(() => {
    ipc.getLogs().then((l) => setBackendLogs(l.map((e) => ({ ...e, message: `[backend] ${e.message}` })))).catch(() => undefined);
  }, [logs.length]);

  const merged = [...logs, ...backendLogs].sort((a, b) => a.ts.localeCompare(b.ts));
  const max = LEVEL_ORDER.indexOf(level);
  const shown = merged.filter((e) => LEVEL_ORDER.indexOf(e.level) <= max);
  const text = shown.map((e) => `${e.ts} ${e.level.toUpperCase().padEnd(5)} ${e.message}`).join('\n');

  return (
    <Modal
      title={t('lg.title')}
      icon={<ScrollText className="i20 c-accent" />}
      onClose={closeDialog}
      size="lg"
      footer={
        <>
          <div className="log-filter">
            {t('lg.level')}
            <Select value={level} onChange={(e) => setLevel(e.target.value as LogLevel)} className="select--sm">
              {LEVEL_ORDER.map((l) => (
                <option key={l} value={l}>
                  {l}
                </option>
              ))}
            </Select>
          </div>
          <Button onClick={clearLogs}>{t('lg.clear')}</Button>
          <Button icon={<ClipboardCopy className="i14" />} onClick={() => void copyText(text).then((ok) => pushToast(ok ? 'success' : 'error', t(ok ? 'copied' : 'copyFailed')))}>
            {t('lg.copy')}
          </Button>
          <Button variant="primary" onClick={closeDialog}>
            {t('close')}
          </Button>
        </>
      }
    >
      {shown.length === 0 ? (
        <p className="empty-note">{t('lg.empty')}</p>
      ) : (
        <ul className="log-list stack-2">
          {shown.map((e, m) => (
            <li key={m} className="log-entry">
              <span className="log-time">{formatTime(e.ts)}</span>
              <Badge tone={LEVEL_TONE[e.level]} className="badge--log">
                {e.level}
              </Badge>
              <span className="log-message">{e.message}</span>
            </li>
          ))}
        </ul>
      )}
    </Modal>
  );
}

/* --------------------------------- Backups -------------------------------- */

export function BackupsDialog() {
  const t = useT();
  const closeDialog = useAppStore((s) => s.closeDialog);
  const pushToast = useAppStore((s) => s.pushToast);
  const reportError = useAppStore((s) => s.reportError);
  const refresh = useAppStore((s) => s.refresh);
  const [backups, setBackups] = useState<BackupInfo[] | undefined>();
  const [confirmId, setConfirmId] = useState<string | undefined>();
  const [working, setWorking] = useState<string | undefined>();

  const load = () => ipc.listBackups().then(setBackups).catch(reportError);
  useEffect(() => {
    void load();
    // element-disabled-next-line react-hooks/exhaustive-deps
  }, []);

  const restore = async (b: BackupInfo) => {
    setWorking(b.id);
    try {
      await ipc.restoreBackup(b.id);
      pushToast('success', t('bk.restored', { name: b.appName }));
      setConfirmId(undefined);
      await load();
      void refresh(true);
    } catch (e) {
      reportError(e);
    } finally {
      setWorking(undefined);
    }
  };

  return (
    <Modal
      title={t('bk.title')}
      icon={<Archive className="i20 c-accent" />}
      onClose={closeDialog}
      size="lg"
      footer={
        <Button variant="primary" onClick={closeDialog}>
          {t('close')}
        </Button>
      }
    >
      {!backups ? (
        <p className="empty-note">{t('loading')}</p>
      ) : backups.length === 0 ? (
        <p className="empty-note">{t('bk.empty')}</p>
      ) : (
        <ul className="backup-list stack-8">
          {backups.map((b) => (
            <li key={b.id} className={cn('backup-item', !b.restorable && 'is-locked')}>
              <div className="backup-row">
                <div className="backup-body">
                  <div className="backup-title-row">
                    <span className="backup-name">{b.appName}</span>
                    <Badge tone={b.kind === 'registry' ? 'sky' : 'amber'}>{t(b.kind === 'registry' ? 'bk.kind.registry' : 'bk.kind.leftovers')}</Badge>
                    {!b.restorable && <Badge>{t('bk.notRestorable')}</Badge>}
                  </div>
                  <div className="backup-meta">
                    {formatDateTime(b.createdAt)} · {t('bk.keys')}: {b.keys.length}
                  </div>
                  <div className="backup-path">{b.path}</div>
                  {b.keys.length > 0 && (
                    <ul className="backup-keys stack-2">
                      {b.keys.slice(0, 4).map((k) => (
                        <li key={k} className="backup-key">
                          {k}
                        </li>
                      ))}
                      {b.keys.length > 4 && <li className="backup-keys-more">… +{b.keys.length - 4}</li>}
                    </ul>
                  )}
                </div>
                <div className="backup-actions">
                  {confirmId === b.id ? (
                    <div className="backup-confirm">
                      <span className="backup-confirm-text">{t('bk.confirmRestore')}</span>
                      <div className="backup-confirm-actions">
                        <Button size="sm" onClick={() => setConfirmId(undefined)}>
                          {t('cancel')}
                        </Button>
                        <Button size="sm" variant="primary" loading={working === b.id} onClick={() => void restore(b)}>
                          {t('confirm')}
                        </Button>
                      </div>
                    </div>
                  ) : (
                    <Button size="sm" icon={<RotateCcw className="i14" />} disabled={!b.restorable} onClick={() => setConfirmId(b.id)}>
                      {t('bk.restore')}
                    </Button>
                  )}
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </Modal>
  );
}
