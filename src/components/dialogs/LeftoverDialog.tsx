import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, CalendarClock, CheckCircle2, Cog, Eraser, File, Folder, Link2, Regex, ShieldCheck, Sparkles, XCircle, type LucideIcon } from 'lucide-react';
import { ipc } from '../../ipc/commands';
import { useT } from '../../store/hooks';
import { useAppStore } from '../../store/useAppStore';
import type { DeleteLeftoversResult, LeftoverCategory, LeftoverItem, ScanProgress, ScanResult } from '../../types/app';
import type { TKey } from '../../i18n';
import { cn } from '../../utils/cn';
import { formatBytes, formatDuration } from '../../utils/format';
import { Badge, Button, Checkbox, Modal, Spinner } from '../ui';

interface Props {
  appId: string;
  appName: string;
  mode: 'scan' | 'force';
}

/** scanning → ready → confirm (2nd confirmation) → deleting → done */
type Status = 'disabled' | 'scanning' | 'ready' | 'confirm' | 'deleting' | 'done' | 'error';

const GROUPS: { key: LeftoverCategory; label: TKey; icon: LucideIcon }[] = [
  { key: 'folder', label: 'lo.group.folder', icon: Folder },
  { key: 'file', label: 'lo.group.file', icon: File },
  { key: 'registry', label: 'lo.group.registry', icon: Regex },
  { key: 'shortcut', label: 'lo.group.shortcut', icon: Link2 },
  { key: 'service', label: 'lo.group.service', icon: Cog },
  { key: 'task', label: 'lo.group.task', icon: CalendarClock },
];

const PHASES: ScanProgress['phase'][] = ['files', 'registry', 'shortcuts', 'services'];

export function LeftoverDialog({ appId, appName, mode }: Props) {
  const t = useT();
  const closeDialog = useAppStore((s) => s.closeDialog);
  const settings = useAppStore((s) => s.settings);
  const refresh = useAppStore((s) => s.refresh);
  const setBusy = useAppStore((s) => s.setBusy);
  const pushToast = useAppStore((s) => s.pushToast);
  const reportError = useAppStore((s) => s.reportError);
  const log = useAppStore((s) => s.log);

  const [status, setStatus] = useState<Status>(settings.enableLeftoverScan ? 'scanning' : 'disabled');
  const [progress, setProgress] = useState<ScanProgress | undefined>();
  const [result, setResult] = useState<ScanResult | undefined>();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [deleteResult, setDeleteResult] = useState<DeleteLeftoversResult | undefined>();
  const [scanToken, setScanToken] = useState(0);

  useEffect(() => {
    if (!settings.enableLeftoverScan) return;
    let cancelled = false;
    setStatus('scanning');
    setProgress(undefined);
    setResult(undefined);
    setBusy(t('status.scanning'));
    (async () => {
      try {
        const r = mode === 'force' ? await ipc.forceUninstallApp(appId, setProgress) : await ipc.scanLeftovers(appId, setProgress);
        if (cancelled) return;
        setResult(r);
        setSelected(new Set(r.items.filter((m) => m.defaultSelected && m.risk !== 'protected').map((m) => m.id)));
        setStatus('ready');
        log('info', `Scan "${appName}": ${r.items.length} leftovers in ${formatDuration(r.durationMs)}`);
      } catch (e) {
        if (cancelled) return;
        setStatus('error');
        reportError(e);
      } finally {
        if (!cancelled) setBusy(null);
      }
    })();
    return () => {
      cancelled = true;
      setBusy(null);
    };
    // element-disabled-next-line react-hooks/exhaustive-deps
  }, [appId, mode, scanToken]);

  const grouped = useMemo(() => {
    const map = new Map<LeftoverCategory, LeftoverItem[]>();
    for (const item of result?.items ?? []) {
      const list = map.get(item.category) ?? [];
      list.push(item);
      map.set(item.category, list);
    }
    return map;
  }, [result]);

  const totalSize = useMemo(() => (result?.items ?? []).reduce((s, m) => s + (m.sizeBytes ?? 0), 0), [result]);
  const selectedItems = useMemo(() => (result?.items ?? []).filter((m) => selected.has(m.id)), [result, selected]);
  const selectedFiles = selectedItems.filter((m) => m.category === 'folder' || m.category === 'file' || m.category === 'shortcut').length;
  const selectedKeys = selectedItems.length - selectedFiles;

  const toggle = (id: string, on: boolean) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });

  const toggleGroup = (items: LeftoverItem[], on: boolean) =>
    setSelected((prev) => {
      const next = new Set(prev);
      for (const m of items) {
        if (m.risk === 'protected') continue;
        if (on) next.add(m.id);
        else next.delete(m.id);
      }
      return next;
    });

  const doDelete = async () => {
    setStatus('deleting');
    setBusy(t('lo.deleting'));
    try {
      const r = await ipc.deleteLeftovers({ appId, itemIds: Array.from(selected) });
      setDeleteResult(r);
      setStatus('done');
      log('warn', `Deleted ${r.deleted.length} leftovers of "${appName}" (${r.failed.length} failed)`);
      pushToast('success', t('toast.leftoversDeleted', { count: r.deleted.length }));
      void refresh(true);
    } catch (e) {
      setStatus('ready');
      reportError(e);
    } finally {
      setBusy(null);
    }
  };

  const title = mode === 'force' ? t('lo.titleForce', { name: appName }) : t('lo.title', { name: appName });
  const busy = status === 'scanning' || status === 'deleting';

  const footer =
    status === 'ready' ? (
      <>
        <span className="mr-auto text-xs text-fg2">{selectedItems.length > 0 && formatBytes(selectedItems.reduce((s, m) => s + (m.sizeBytes ?? 0), 0))}</span>
        <Button onClick={() => setScanToken((n) => n + 1)}>{t('lo.retryScan')}</Button>
        <Button onClick={closeDialog}>{t('cancel')}</Button>
        <Button variant="danger" icon={<Eraser className="h-3.5 w-3.5" />} disabled={selected.size === 0} onClick={() => setStatus('confirm')}>
          {t('lo.deleteSelected', { count: selected.size })}
        </Button>
      </>
    ) : status === 'confirm' ? (
      <>
        <Button onClick={closeDialog}>{t('cancel')}</Button>
        <Button variant="danger" icon={<Eraser className="h-3.5 w-3.5" />} onClick={() => void doDelete()}>
          {t('confirm')}
        </Button>
      </>
    ) : status === 'done' || status === 'disabled' || status === 'error' ? (
      <Button variant="primary" onClick={closeDialog}>
        {t('done')}
      </Button>
    ) : undefined;

  return (
    <Modal title={title} icon={<Eraser className="h-5 w-5 text-danger" />} onClose={closeDialog} busy={busy} size="xl" footer={footer} bodyClassName="bg-app">
      {status === 'disabled' && <p className="text-sm text-fg2">{t('lo.disabledByPolicy')}</p>}

      {status === 'scanning' && (
        <div className="py-6">
          <div className="flex items-center gap-3">
            <Spinner className="h-6 w-6" />
            <div>
              <div className="font-medium">{t('lo.scanning')}</div>
              <div className="text-xs text-fg2">{progress ? `${t(`lo.phase.${progress.phase}` as TKey)} · ${progress.found}` : '…'}</div>
            </div>
          </div>
          <div className="mt-4 h-1.5 w-full overflow-hidden rounded-full bg-subtle">
            <div className="h-full rounded-full bg-accent transition-all duration-200" style={{ width: `${progress?.percent ?? 3}%` }} />
          </div>
          <ol className="mt-4 grid grid-cols-4 gap-2 text-[11px]">
            {PHASES.map((p) => {
              const idx = progress ? PHASES.indexOf(progress.phase) : -1;
              const m = PHASES.indexOf(p);
              return (
                <li key={p} className={cn('flex items-center gap-1.5 rounded-md border px-2 py-1.5', m < idx ? 'border-success/30 text-success' : m === idx ? 'border-accent text-accent' : 'border-stroke text-fg3')}>
                  {m < idx ? <CheckCircle2 className="h-3 w-3" /> : m === idx ? <Spinner className="h-3 w-3" /> : <span className="h-3 w-3 rounded-full border border-current" />}
                  {t(`lo.phase.${p}` as TKey)}
                </li>
              );
            })}
          </ol>
        </div>
      )}

      {(status === 'ready' || status === 'confirm' || status === 'deleting') && result && (
        <div className="space-y-3">
          {mode === 'force' && (
            <div className="flex items-start gap-2 rounded-md border border-info/30 bg-info-soft px-3 py-2 text-xs text-info">
              <ShieldCheck className="mt-px h-3.5 w-3.5 shrink-0" />
              {t('lo.previewOnly')}
            </div>
          )}

          {result.items.length === 0 ? (
            <div className="flex flex-col items-center gap-2 py-10 text-center">
              <Sparkles className="h-8 w-8 text-success" />
              <div className="text-sm font-medium">{t('lo.none')}</div>
            </div>
          ) : (
            <>
              <div className="flex items-center justify-between gap-3">
                <div className="text-[13px] font-medium">{t('lo.found', { count: result.items.length, locations: result.scannedLocations, size: formatBytes(totalSize) })}</div>
                <div className="flex gap-2 text-xs">
                  <button type="button" className="text-accent hover:underline" onClick={() => toggleGroup(result.items, true)}>
                    {t('selectAll')}
                  </button>
                  <button type="button" className="text-fg2 hover:underline" onClick={() => setSelected(new Set())}>
                    {t('clearSelection')}
                  </button>
                </div>
              </div>

              {status === 'confirm' && (
                <div className="flex items-start gap-2 rounded-md border border-danger/30 bg-danger-soft px-3 py-2.5 text-[13px] text-danger">
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                  <div>
                    <div className="font-semibold">{t('lo.confirmTitle')}</div>
                    <div className="text-xs">{t('lo.confirmText', { files: selectedFiles, keys: selectedKeys })}</div>
                  </div>
                </div>
              )}

              <div className={cn('space-y-2', status === 'deleting' && 'pointer-events-none opacity-60')}>
                {GROUPS.map(({ key, label, icon: Icon }) => {
                  const items = grouped.get(key);
                  if (!items || items.length === 0) return null;
                  const selectable = items.filter((m) => m.risk !== 'protected');
                  const selectedCount = selectable.filter((m) => selected.has(m.id)).length;
                  const groupSize = items.reduce((s, m) => s + (m.sizeBytes ?? 0), 0);
                  return (
                    <div key={key} className="overflow-hidden rounded-lg border border-stroke bg-layer-solid">
                      <div className="flex items-center gap-2 border-b border-stroke bg-layer-solid px-3 py-1.5">
                        <Checkbox checked={selectedCount > 0 && selectedCount === selectable.length} indeterminate={selectedCount > 0 && selectedCount < selectable.length} onChange={(on) => toggleGroup(items, on)} disabled={selectable.length === 0} />
                        <Icon className="h-4 w-4 text-fg2" />
                        <span className="text-[13px] font-medium">{t(label)}</span>
                        <span className="text-xs text-fg3">{items.length}</span>
                        {groupSize > 0 && <span className="ml-auto text-xs text-fg3 tabular-nums">{formatBytes(groupSize)}</span>}
                      </div>
                      <ul>
                        {items.map((item) => (
                          <li key={item.id} className={cn('flex items-start gap-2 px-3 py-1.5 text-[12.5px] odd:bg-layer-solid/50', item.risk === 'protected' && 'opacity-60')}>
                            <Checkbox checked={selected.has(item.id)} onChange={(on) => toggle(item.id, on)} disabled={item.risk === 'protected'} className="mt-px" />
                            <div className="min-w-0 flex-1">
                              <div className="font-mono break-all text-fg">{item.path}</div>
                              <div className="text-[11px] text-fg3">
                                {t('lo.reason')}: {t(`reason.${item.reason}` as TKey)}
                              </div>
                            </div>
                            <div className="flex shrink-0 items-center gap-2">
                              {item.sizeBytes !== undefined && <span className="text-xs text-fg3 tabular-nums">{formatBytes(item.sizeBytes)}</span>}
                              <Badge tone={item.risk === 'safe' ? 'green' : item.risk === 'caution' ? 'amber' : 'red'}>{t(`lo.risk.${item.risk}` as TKey)}</Badge>
                            </div>
                          </li>
                        ))}
                      </ul>
                    </div>
                  );
                })}
              </div>

              <div className="flex items-start gap-2 text-[11px] text-fg2">
                <ShieldCheck className="mt-px h-3.5 w-3.5 shrink-0 text-success" />
                {t('lo.protectNote')}
              </div>
            </>
          )}
        </div>
      )}

      {status === 'done' && deleteResult && (
        <div className="space-y-4">
          <div className="flex items-center gap-3">
            {deleteResult.failed.length === 0 ? <CheckCircle2 className="h-8 w-8 text-success" /> : <AlertTriangle className="h-8 w-8 text-warning" />}
            <div>
              <div className="font-semibold">{t('lo.doneTitle')}</div>
              <div className="text-xs text-fg2">
                {[
                  t('lo.deleted', { count: deleteResult.deleted.length }),
                  deleteResult.recycled > 0 ? t('lo.recycled', { count: deleteResult.recycled }) : undefined,
                  deleteResult.failed.length > 0 ? t('lo.failed', { count: deleteResult.failed.length }) : undefined,
                ]
                  .filter(Boolean)
                  .join(' · ')}
              </div>
            </div>
          </div>
          {deleteResult.backup && (
            <div className="rounded-md border border-stroke bg-layer-solid px-3 py-2 text-xs">
              <div className="text-fg2">{t('lo.backupSaved')}</div>
              <div className="mt-0.5 font-mono break-all text-fg">{deleteResult.backup.path}</div>
            </div>
          )}
          {deleteResult.failed.length > 0 && (
            <ul className="space-y-1 rounded-md border border-danger/30 bg-danger-soft p-2 text-xs">
              {deleteResult.failed.map((f) => (
                <li key={f.id} className="flex items-start gap-2 text-danger">
                  <XCircle className="mt-px h-3.5 w-3.5 shrink-0" />
                  <div className="min-w-0">
                    <div className="font-mono break-all">{f.path}</div>
                    <div className="opacity-80">{f.reason}</div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </Modal>
  );
}
