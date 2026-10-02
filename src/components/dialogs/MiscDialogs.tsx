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
      icon={<ListX className="h-5 w-5 text-danger" />}
      onClose={closeDialog}
      busy={working}
      footer={
        <>
          <Button onClick={closeDialog} disabled={working}>
            {t('cancel')}
          </Button>
          <Button variant="danger" icon={<Trash2 className="h-3.5 w-3.5" />} disabled={!ack} loading={working} onClick={() => void run()}>
            {t('de.button')}
          </Button>
        </>
      }
    >
      <div className="space-y-4 text-[13px]">
        <p className="text-fg2">{t('de.text')}</p>
        <code className="block rounded-md border border-stroke bg-layer-solid px-3 py-2 font-mono text-[12px] break-all">{app.registryPath}</code>
        {(app.uninstallString || app.quietUninstallString) && (
          <p className="flex items-start gap-2 text-xs text-warning">
            <Info className="mt-px h-3.5 w-3.5 shrink-0" />
            {t('de.warning')}
          </p>
        )}
        <p className="flex items-start gap-2 text-xs text-fg2">
          <ShieldCheck className="mt-px h-3.5 w-3.5 shrink-0 text-success" />
          {t('de.backupNote')} <span className="font-mono">{settings.backupDirectory}</span>
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
      icon={<AlertOctagon className="h-5 w-5 text-danger" />}
      onClose={closeDialog}
      size="sm"
      footer={
        <>
          <Button icon={<ClipboardCopy className="h-3.5 w-3.5" />} onClick={() => void copyText(text).then((ok) => pushToast(ok ? 'success' : 'error', t(ok ? 'copied' : 'copyFailed')))}>
            {t('err.copy')}
          </Button>
          <Button variant="primary" onClick={closeDialog}>
            {t('close')}
          </Button>
        </>
      }
    >
      <div className="space-y-3 text-[13px]">
        <div className="flex items-start gap-2">
          <Badge tone="red">{error.code}</Badge>
          <span className="break-words">{error.message}</span>
        </div>
        {error.details && (
          <div>
            <div className="mb-1 text-[11px] font-semibold tracking-wider text-fg3 uppercase">{t('err.details')}</div>
            <pre className="max-h-48 overflow-auto rounded-md bg-console p-2 font-mono text-[11px] whitespace-pre-wrap text-console-fg">{error.details}</pre>
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
          <Button icon={<ClipboardCopy className="h-3.5 w-3.5" />} onClick={() => void copyText(formatAppInfo(detail ?? app, t)).then((ok) => pushToast(ok ? 'success' : 'error', t(ok ? 'copied' : 'copyFailed')))}>
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
      icon={<ScrollText className="h-5 w-5 text-accent" />}
      onClose={closeDialog}
      size="lg"
      footer={
        <>
          <div className="mr-auto flex items-center gap-2 text-xs text-fg2">
            {t('lg.level')}
            <Select value={level} onChange={(e) => setLevel(e.target.value as LogLevel)} className="h-7">
              {LEVEL_ORDER.map((l) => (
                <option key={l} value={l}>
                  {l}
                </option>
              ))}
            </Select>
          </div>
          <Button onClick={clearLogs}>{t('lg.clear')}</Button>
          <Button icon={<ClipboardCopy className="h-3.5 w-3.5" />} onClick={() => void copyText(text).then((ok) => pushToast(ok ? 'success' : 'error', t(ok ? 'copied' : 'copyFailed')))}>
            {t('lg.copy')}
          </Button>
          <Button variant="primary" onClick={closeDialog}>
            {t('close')}
          </Button>
        </>
      }
    >
      {shown.length === 0 ? (
        <p className="py-8 text-center text-sm text-fg2">{t('lg.empty')}</p>
      ) : (
        <ul className="space-y-0.5 font-mono text-[11.5px]">
          {shown.map((e, m) => (
            <li key={m} className="flex items-start gap-2 rounded px-1 py-0.5 odd:bg-layer-solid">
              <span className="shrink-0 text-fg3 tabular-nums">{formatTime(e.ts)}</span>
              <Badge tone={LEVEL_TONE[e.level]} className="w-12 shrink-0 justify-center">
                {e.level}
              </Badge>
              <span className="break-all text-fg">{e.message}</span>
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
      icon={<Archive className="h-5 w-5 text-accent" />}
      onClose={closeDialog}
      size="lg"
      footer={
        <Button variant="primary" onClick={closeDialog}>
          {t('close')}
        </Button>
      }
    >
      {!backups ? (
        <p className="py-8 text-center text-sm text-fg2">{t('loading')}</p>
      ) : backups.length === 0 ? (
        <p className="py-8 text-center text-sm text-fg2">{t('bk.empty')}</p>
      ) : (
        <ul className="space-y-2">
          {backups.map((b) => (
            <li key={b.id} className={cn('rounded-lg border border-stroke p-3', !b.restorable && 'opacity-60')}>
              <div className="flex items-start gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-[13px] font-medium">{b.appName}</span>
                    <Badge tone={b.kind === 'registry' ? 'sky' : 'amber'}>{t(b.kind === 'registry' ? 'bk.kind.registry' : 'bk.kind.leftovers')}</Badge>
                    {!b.restorable && <Badge>{t('bk.notRestorable')}</Badge>}
                  </div>
                  <div className="mt-0.5 text-xs text-fg2">
                    {formatDateTime(b.createdAt)} · {t('bk.keys')}: {b.keys.length}
                  </div>
                  <div className="mt-1 font-mono text-[11px] break-all text-fg2">{b.path}</div>
                  {b.keys.length > 0 && (
                    <ul className="mt-1 space-y-0.5 font-mono text-[11px] text-fg2">
                      {b.keys.slice(0, 4).map((k) => (
                        <li key={k} className="truncate">
                          {k}
                        </li>
                      ))}
                      {b.keys.length > 4 && <li className="text-fg3">… +{b.keys.length - 4}</li>}
                    </ul>
                  )}
                </div>
                <div className="shrink-0">
                  {confirmId === b.id ? (
                    <div className="flex flex-col items-end gap-1.5">
                      <span className="max-w-[200px] text-right text-[11px] text-fg2">{t('bk.confirmRestore')}</span>
                      <div className="flex gap-1.5">
                        <Button size="sm" onClick={() => setConfirmId(undefined)}>
                          {t('cancel')}
                        </Button>
                        <Button size="sm" variant="primary" loading={working === b.id} onClick={() => void restore(b)}>
                          {t('confirm')}
                        </Button>
                      </div>
                    </div>
                  ) : (
                    <Button size="sm" icon={<RotateCcw className="h-3.5 w-3.5" />} disabled={!b.restorable} onClick={() => setConfirmId(b.id)}>
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
