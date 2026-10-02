import { useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, CheckCircle2, Circle, Eraser, Loader2, ShieldAlert, Trash2, XCircle } from 'lucide-react';
import { ipc, toAppError } from '../../ipc/commands';
import { useT } from '../../store/hooks';
import { getAppById, useAppStore } from '../../store/useAppStore';
import type { UninstallResult } from '../../types/app';
import { parseUninstallCommand } from '../../utils/command';
import { cn } from '../../utils/cn';
import { formatDuration } from '../../utils/format';
import { AppIcon } from '../AppIcon';
import { Button, Checkbox, Modal } from '../ui';

interface Props {
  appIds: string[];
  quiet: boolean;
}

type Step = 'confirm' | 'running' | 'done';

export function UninstallDialog({ appIds, quiet: quietInitial }: Props) {
  const t = useT();
  const closeDialog = useAppStore((s) => s.closeDialog);
  const openDialog = useAppStore((s) => s.openDialog);
  const settings = useAppStore((s) => s.settings);
  const isAdmin = useAppStore((s) => s.isAdmin);
  const removeApps = useAppStore((s) => s.removeApps);
  const setBusy = useAppStore((s) => s.setBusy);
  const pushToast = useAppStore((s) => s.pushToast);
  const log = useAppStore((s) => s.log);
  const refresh = useAppStore((s) => s.refresh);

  // Snapshot the apps so the dialog survives list refreshes/removals (successful uninstalls drop rows immediately).
  const apps = useMemo(() => appIds.map((id) => getAppById(id)).filter((a): a is NonNullable<typeof a> => !!a), [appIds]);
  const single = apps.length === 1 ? apps[0] : undefined;

  const [step, setStep] = useState<Step>('confirm');
  const [quiet, setQuiet] = useState(quietInitial);
  const [scanAfter, setScanAfter] = useState(settings.enableLeftoverScan && settings.scanAfterUninstall);
  const [currentId, setCurrentId] = useState<string | undefined>();
  const [results, setResults] = useState<Record<string, UninstallResult>>({});
  const [lines, setLines] = useState<string[]>([]);
  const [elapsed, setElapsed] = useState(0);
  const logRef = useRef<HTMLDivElement>(null);

  const quietAvailable = single ? !!single.quietUninstallString || single.isMsi : apps.some((a) => a.quietUninstallString || a.isMsi);
  const command = single ? parseUninstallCommand(quiet && single.quietUninstallString ? single.quietUninstallString : single.uninstallString, quiet)?.normalized : undefined;

  useEffect(() => {
    if (step !== 'running') return;
    const started = Date.now();
    const id = setInterval(() => setElapsed(Date.now() - started), 250);
    return () => clearInterval(id);
  }, [step]);

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [lines]);

  const start = async () => {
    setStep('running');
    setBusy(t('status.busy'));
    const collected: Record<string, UninstallResult> = {};
    for (const app of apps) {
      setCurrentId(app.id);
      if (apps.length > 1) setLines((l) => [...l, `━━ ${app.name} ━━`]);
      try {
        const r = await ipc.uninstallApp({ appId: app.id, quiet }, (line) => setLines((l) => [...l, line]));
        collected[app.id] = r;
        if (r.success) {
          removeApps([app.id]);
          log('info', `Uninstalled "${app.name}" (exit ${r.exitCode ?? 0}, ${formatDuration(r.durationMs)})`);
        } else {
          log('warn', `Uninstall of "${app.name}" failed: ${r.message}`);
        }
      } catch (e) {
        const err = toAppError(e);
        collected[app.id] = { appId: app.id, success: false, rebootRequired: false, cancelled: false, message: err.message, commandLine: '', durationMs: 0, log: [] };
        setLines((l) => [...l, `✖ ${err.message}`]);
        log('error', `Uninstall of "${app.name}" errored: ${err.code} ${err.message}`);
      }
      setResults({ ...collected });
    }
    setCurrentId(undefined);
    setBusy(null);
    setStep('done');

    const okCount = Object.values(collected).filter((r) => r.success).length;
    if (single) {
      const r = collected[single.id];
      if (r?.success) {
        pushToast('success', t('toast.uninstalled', { name: single.name }));
        if (scanAfter) {
          openDialog({ type: 'leftovers', appId: single.id, appName: single.name, mode: 'scan' });
          return;
        }
      }
    } else if (okCount > 0) {
      pushToast('success', t('un.summary', { ok: okCount, fail: apps.length - okCount }));
    }
    void refresh(true);
  };

  const okCount = Object.values(results).filter((r) => r.success).length;
  const failCount = Object.values(results).length - okCount;
  const singleResult = single ? results[single.id] : undefined;

  const title = single ? t('un.title') : t('un.titleBatch', { count: apps.length });

  const statusIcon = (id: string) => {
    const r = results[id];
    if (currentId === id) return <Loader2 className="i16 spin c-accent" />;
    if (!r) return <Circle className="i16 c-fg3" />;
    if (r.success) return <CheckCircle2 className="i16 c-success" />;
    if (r.cancelled) return <AlertTriangle className="i16 c-warning" />;
    return <XCircle className="i16 c-danger" />;
  };

  return (
    <Modal
      title={title}
      subtitle={single ? [single.version, single.publisher].filter(Boolean).join(' · ') : undefined}
      icon={single ? <AppIcon appId={single.id} name={single.name} size={28} /> : <Trash2 className="i24 c-danger" />}
      onClose={closeDialog}
      busy={step === 'running'}
      size={single && step === 'confirm' ? 'md' : 'lg'}
      footer={
        step === 'confirm' ? (
          <>
            <Button onClick={closeDialog}>{t('cancel')}</Button>
            <Button variant="primary" icon={<Trash2 className="i14" />} onClick={() => void start()} disabled={apps.length === 0}>
              {t('un.start')}
            </Button>
          </>
        ) : step === 'running' ? (
          <span className="t-xs c-fg2">{t('un.elapsed', { time: formatDuration(elapsed) })}</span>
        ) : (
          <>
            {single && singleResult && !singleResult.success && (
              <Button variant="danger" icon={<Eraser className="i14" />} onClick={() => openDialog({ type: 'leftovers', appId: single.id, appName: single.name, mode: 'force' })}>
                {t('un.forceNow')}
              </Button>
            )}
            <Button variant="primary" onClick={closeDialog}>
              {t('done')}
            </Button>
          </>
        )
      }
    >
      {step === 'confirm' && (
        <div className="stack-16">
          <p className="dialog-muted">{t('un.confirmText')}</p>
          {single ? (
            <div className="dialog-card">
              <div className="uninstall-app-row">
                <AppIcon appId={single.id} name={single.name} size={36} />
                <div className="min-w-0">
                  <div className="uninstall-app-name">{single.name}</div>
                  <div className="uninstall-app-path">{single.installLocation ?? single.registryPath}</div>
                </div>
              </div>
              <div className="section-title section-title--top">{t('un.command')}</div>
              <code className="dialog-code">
                {command ?? <span className="c-warning">{t('un.noCommand')}</span>}
              </code>
            </div>
          ) : (
            <ul className="uninstall-list">
              {apps.map((a) => (
                <li key={a.id} className="uninstall-list-item">
                  <AppIcon appId={a.id} name={a.name} size={16} />
                  <span className="truncate">{a.name}</span>
                  {!a.uninstallString && !a.quietUninstallString && <span className="uninstall-list-note">{t('un.noCommand')}</span>}
                </li>
              ))}
            </ul>
          )}
          <div className="stack-8">
            <Checkbox checked={quiet} onChange={setQuiet} disabled={!quietAvailable} label={t('un.quiet')} description={!quietAvailable ? t('un.quietUnavailable') : undefined} />
            {single && <Checkbox checked={scanAfter} onChange={setScanAfter} disabled={!settings.enableLeftoverScan} label={t('un.scanAfter')} description={!settings.enableLeftoverScan ? t('lo.disabledByPolicy') : undefined} />}
          </div>
          {!isAdmin && (
            <div className="callout callout--warning">
              <ShieldAlert className="callout-icon" />
              {t('un.uacNote')}
            </div>
          )}
        </div>
      )}

      {step !== 'confirm' && (
        <div className="stack-12">
          {single ? (
            <div className="uninstall-status-row">
              {step === 'running' ? (
                <Loader2 className="i32 spin c-accent" />
              ) : singleResult?.success ? (
                <CheckCircle2 className="i32 c-success" />
              ) : singleResult?.cancelled ? (
                <AlertTriangle className="i32 c-warning" />
              ) : (
                <XCircle className="i32 c-danger" />
              )}
              <div className="min-w-0">
                <div className="uninstall-status-title">
                  {step === 'running'
                    ? t('un.running', { name: single.name })
                    : singleResult?.success
                      ? t('un.success')
                      : singleResult?.cancelled
                        ? t('un.cancelled')
                        : t('un.failed')}
                </div>
                <div className="uninstall-status-desc">
                  {step === 'running'
                    ? t('un.waiting')
                    : [
                        singleResult?.message,
                        singleResult?.exitCode !== undefined ? t('un.exitCode', { code: singleResult.exitCode }) : undefined,
                        singleResult ? formatDuration(singleResult.durationMs) : undefined,
                      ]
                        .filter(Boolean)
                        .join(' · ')}
                </div>
                {singleResult?.rebootRequired && <div className="uninstall-reboot">{t('un.rebootRequired')}</div>}
              </div>
            </div>
          ) : (
            <div>
              <ul className="uninstall-list uninstall-list--sm">
                {apps.map((a) => (
                  <li key={a.id} className={cn('uninstall-list-item', results[a.id] && !results[a.id].success && 'is-failed')}>
                    {statusIcon(a.id)}
                    <span className="truncate">{a.name}</span>
                    <span className="uninstall-list-state">
                      {results[a.id] ? (results[a.id].success ? t('un.success') : results[a.id].message) : currentId === a.id ? t('un.waiting') : t('un.pending')}
                    </span>
                  </li>
                ))}
              </ul>
              {step === 'done' && <div className="uninstall-summary">{t('un.summary', { ok: okCount, fail: failCount })}</div>}
            </div>
          )}
          <div>
            <div className="section-title section-title--sub">{t('un.log')}</div>
            <div ref={logRef} className="win-scroll uninstall-log">
              {lines.map((l, m) => (
                <div key={m} className={cn('log-line', l.startsWith('✖') && 'log-line--error', l.startsWith('━━') && 'log-line--head')}>
                  {l}
                </div>
              ))}
              {step === 'running' && <div className="pulse log-caret">▌</div>}
            </div>
          </div>
        </div>
      )}
    </Modal>
  );
}
