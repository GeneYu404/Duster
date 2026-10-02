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
    if (currentId === id) return <Loader2 className="h-4 w-4 animate-spin text-accent" />;
    if (!r) return <Circle className="h-4 w-4 text-fg3" />;
    if (r.success) return <CheckCircle2 className="h-4 w-4 text-success" />;
    if (r.cancelled) return <AlertTriangle className="h-4 w-4 text-warning" />;
    return <XCircle className="h-4 w-4 text-danger" />;
  };

  return (
    <Modal
      title={title}
      subtitle={single ? [single.version, single.publisher].filter(Boolean).join(' · ') : undefined}
      icon={single ? <AppIcon appId={single.id} name={single.name} size={28} /> : <Trash2 className="h-6 w-6 text-danger" />}
      onClose={closeDialog}
      busy={step === 'running'}
      size={single && step === 'confirm' ? 'md' : 'lg'}
      footer={
        step === 'confirm' ? (
          <>
            <Button onClick={closeDialog}>{t('cancel')}</Button>
            <Button variant="primary" icon={<Trash2 className="h-3.5 w-3.5" />} onClick={() => void start()} disabled={apps.length === 0}>
              {t('un.start')}
            </Button>
          </>
        ) : step === 'running' ? (
          <span className="text-xs text-fg2">{t('un.elapsed', { time: formatDuration(elapsed) })}</span>
        ) : (
          <>
            {single && singleResult && !singleResult.success && (
              <Button variant="danger" icon={<Eraser className="h-3.5 w-3.5" />} onClick={() => openDialog({ type: 'leftovers', appId: single.id, appName: single.name, mode: 'force' })}>
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
        <div className="space-y-4">
          <p className="text-[13px] text-fg2">{t('un.confirmText')}</p>
          {single ? (
            <div className="rounded-lg border border-stroke bg-layer-solid p-3">
              <div className="flex items-center gap-3">
                <AppIcon appId={single.id} name={single.name} size={36} />
                <div className="min-w-0">
                  <div className="truncate font-semibold">{single.name}</div>
                  <div className="truncate text-xs text-fg2">{single.installLocation ?? single.registryPath}</div>
                </div>
              </div>
              <div className="mt-3 text-[11px] font-semibold tracking-wider text-fg3 uppercase">{t('un.command')}</div>
              <code className="mt-1 block rounded bg-card px-2 py-1.5 font-mono text-[12px] break-all text-fg">
                {command ?? <span className="text-warning">{t('un.noCommand')}</span>}
              </code>
            </div>
          ) : (
            <ul className="max-h-56 space-y-1 overflow-auto rounded-lg border border-stroke p-2">
              {apps.map((a) => (
                <li key={a.id} className="flex items-center gap-2 text-[13px]">
                  <AppIcon appId={a.id} name={a.name} size={16} />
                  <span className="truncate">{a.name}</span>
                  {!a.uninstallString && !a.quietUninstallString && <span className="ml-auto text-[11px] text-warning">{t('un.noCommand')}</span>}
                </li>
              ))}
            </ul>
          )}
          <div className="space-y-2">
            <Checkbox checked={quiet} onChange={setQuiet} disabled={!quietAvailable} label={t('un.quiet')} description={!quietAvailable ? t('un.quietUnavailable') : undefined} />
            {single && <Checkbox checked={scanAfter} onChange={setScanAfter} disabled={!settings.enableLeftoverScan} label={t('un.scanAfter')} description={!settings.enableLeftoverScan ? t('lo.disabledByPolicy') : undefined} />}
          </div>
          {!isAdmin && (
            <div className="flex items-start gap-2 rounded-md border border-warning/30 bg-warning-soft px-3 py-2 text-xs text-warning">
              <ShieldAlert className="mt-px h-3.5 w-3.5 shrink-0" />
              {t('un.uacNote')}
            </div>
          )}
        </div>
      )}

      {step !== 'confirm' && (
        <div className="space-y-3">
          {single ? (
            <div className="flex items-center gap-3">
              {step === 'running' ? (
                <Loader2 className="h-8 w-8 animate-spin text-accent" />
              ) : singleResult?.success ? (
                <CheckCircle2 className="h-8 w-8 text-success" />
              ) : singleResult?.cancelled ? (
                <AlertTriangle className="h-8 w-8 text-warning" />
              ) : (
                <XCircle className="h-8 w-8 text-danger" />
              )}
              <div className="min-w-0">
                <div className="font-semibold">
                  {step === 'running'
                    ? t('un.running', { name: single.name })
                    : singleResult?.success
                      ? t('un.success')
                      : singleResult?.cancelled
                        ? t('un.cancelled')
                        : t('un.failed')}
                </div>
                <div className="text-xs text-fg2">
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
                {singleResult?.rebootRequired && <div className="mt-0.5 text-xs text-warning">{t('un.rebootRequired')}</div>}
              </div>
            </div>
          ) : (
            <div>
              <ul className="max-h-48 space-y-1 overflow-auto rounded-lg border border-stroke p-2">
                {apps.map((a) => (
                  <li key={a.id} className={cn('flex items-center gap-2 text-[13px]', results[a.id] && !results[a.id].success && 'text-danger')}>
                    {statusIcon(a.id)}
                    <span className="truncate">{a.name}</span>
                    <span className="ml-auto shrink-0 text-[11px] text-fg3">
                      {results[a.id] ? (results[a.id].success ? t('un.success') : results[a.id].message) : currentId === a.id ? t('un.waiting') : t('un.pending')}
                    </span>
                  </li>
                ))}
              </ul>
              {step === 'done' && <div className="mt-2 text-xs text-fg2">{t('un.summary', { ok: okCount, fail: failCount })}</div>}
            </div>
          )}
          <div>
            <div className="mb-1 text-[11px] font-semibold tracking-wider text-fg3 uppercase">{t('un.log')}</div>
            <div ref={logRef} className="win-scroll h-40 overflow-auto rounded-md border border-stroke bg-console p-2 font-mono text-[11.5px] leading-relaxed text-console-fg">
              {lines.map((l, m) => (
                <div key={m} className={cn('whitespace-pre-wrap', l.startsWith('✖') && 'text-danger', l.startsWith('━━') && 'mt-1 text-accent')}>
                  {l}
                </div>
              ))}
              {step === 'running' && <div className="animate-pulse text-fg2">▌</div>}
            </div>
          </div>
        </div>
      )}
    </Modal>
  );
}
