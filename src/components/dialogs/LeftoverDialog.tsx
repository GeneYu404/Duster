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
        <span className="lo-footer-size">{selectedItems.length > 0 && formatBytes(selectedItems.reduce((s, m) => s + (m.sizeBytes ?? 0), 0))}</span>
        <Button onClick={() => setScanToken((n) => n + 1)}>{t('lo.retryScan')}</Button>
        <Button onClick={closeDialog}>{t('cancel')}</Button>
        <Button variant="danger" icon={<Eraser className="i14" />} disabled={selected.size === 0} onClick={() => setStatus('confirm')}>
          {t('lo.deleteSelected', { count: selected.size })}
        </Button>
      </>
    ) : status === 'confirm' ? (
      <>
        <Button onClick={closeDialog}>{t('cancel')}</Button>
        <Button variant="danger" icon={<Eraser className="i14" />} onClick={() => void doDelete()}>
          {t('confirm')}
        </Button>
      </>
    ) : status === 'done' || status === 'disabled' || status === 'error' ? (
      <Button variant="primary" onClick={closeDialog}>
        {t('done')}
      </Button>
    ) : undefined;

  return (
    <Modal title={title} icon={<Eraser className="i20 c-danger" />} onClose={closeDialog} busy={busy} size="xl" footer={footer} bodyClassName="dialog-body--app">
      {status === 'disabled' && <p className="t-sm c-fg2">{t('lo.disabledByPolicy')}</p>}

      {status === 'scanning' && (
        <div className="lo-block">
          <div className="lo-head-row">
            <Spinner className="spinner--lg" />
            <div>
              <div className="lo-head-title">{t('lo.scanning')}</div>
              <div className="lo-head-desc">{progress ? `${t(`lo.phase.${progress.phase}` as TKey)} · ${progress.found}` : '…'}</div>
            </div>
          </div>
          <div className="lo-track">
            <div className="lo-fill" style={{ width: `${progress?.percent ?? 3}%` }} />
          </div>
          <ol className="lo-phases">
            {PHASES.map((p) => {
              const idx = progress ? PHASES.indexOf(progress.phase) : -1;
              const m = PHASES.indexOf(p);
              return (
                <li key={p} className={cn('lo-phase', m < idx ? 'lo-phase--done' : m === idx ? 'lo-phase--active' : 'lo-phase--idle')}>
                  {m < idx ? <CheckCircle2 className="i12" /> : m === idx ? <Spinner className="spinner--sm" /> : <span className="lo-phase-dot" />}
                  {t(`lo.phase.${p}` as TKey)}
                </li>
              );
            })}
          </ol>
        </div>
      )}

      {(status === 'ready' || status === 'confirm' || status === 'deleting') && result && (
        <div className="stack-12">
          {mode === 'force' && (
            <div className="callout callout--info">
              <ShieldCheck className="callout-icon" />
              {t('lo.previewOnly')}
            </div>
          )}

          {result.items.length === 0 ? (
            <div className="lo-empty">
              <Sparkles className="i32 c-success" />
              <div className="lo-empty-title">{t('lo.none')}</div>
            </div>
          ) : (
            <>
              <div className="lo-summary-row">
                <div className="lo-summary-text">{t('lo.found', { count: result.items.length, locations: result.scannedLocations, size: formatBytes(totalSize) })}</div>
                <div className="export-fields-actions">
                  <button type="button" className="link-accent" onClick={() => toggleGroup(result.items, true)}>
                    {t('selectAll')}
                  </button>
                  <button type="button" className="link-muted" onClick={() => setSelected(new Set())}>
                    {t('clearSelection')}
                  </button>
                </div>
              </div>

              {status === 'confirm' && (
                <div className="callout callout--danger callout--lg">
                  <AlertTriangle className="callout-icon--lg" />
                  <div>
                    <div className="callout-title">{t('lo.confirmTitle')}</div>
                    <div className="callout-text">{t('lo.confirmText', { files: selectedFiles, keys: selectedKeys })}</div>
                  </div>
                </div>
              )}

              <div className={cn('stack-8', 'lo-groups', status === 'deleting' && 'is-busy')}>
                {GROUPS.map(({ key, label, icon: Icon }) => {
                  const items = grouped.get(key);
                  if (!items || items.length === 0) return null;
                  const selectable = items.filter((m) => m.risk !== 'protected');
                  const selectedCount = selectable.filter((m) => selected.has(m.id)).length;
                  const groupSize = items.reduce((s, m) => s + (m.sizeBytes ?? 0), 0);
                  return (
                    <div key={key} className="lo-group">
                      <div className="lo-group-head">
                        <Checkbox checked={selectedCount > 0 && selectedCount === selectable.length} indeterminate={selectedCount > 0 && selectedCount < selectable.length} onChange={(on) => toggleGroup(items, on)} disabled={selectable.length === 0} />
                        <Icon className="i16 c-fg2" />
                        <span className="lo-group-name">{t(label)}</span>
                        <span className="lo-group-count">{items.length}</span>
                        {groupSize > 0 && <span className="lo-group-size">{formatBytes(groupSize)}</span>}
                      </div>
                      <ul>
                        {items.map((item) => (
                          <li key={item.id} className={cn('lo-item', item.risk === 'protected' && 'is-protected')}>
                            <Checkbox checked={selected.has(item.id)} onChange={(on) => toggle(item.id, on)} disabled={item.risk === 'protected'} className="checkbox--tight" />
                            <div className="lo-item-body">
                              <div className="lo-item-path">{item.path}</div>
                              <div className="lo-item-reason">
                                {t('lo.reason')}: {t(`reason.${item.reason}` as TKey)}
                              </div>
                            </div>
                            <div className="lo-item-side">
                              {item.sizeBytes !== undefined && <span className="lo-item-size">{formatBytes(item.sizeBytes)}</span>}
                              <Badge tone={item.risk === 'safe' ? 'green' : item.risk === 'caution' ? 'amber' : 'red'}>{t(`lo.risk.${item.risk}` as TKey)}</Badge>
                            </div>
                          </li>
                        ))}
                      </ul>
                    </div>
                  );
                })}
              </div>

              <div className="callout callout--plain callout--plain-sm">
                <ShieldCheck className="callout-icon--plain callout-icon--success" />
                {t('lo.protectNote')}
              </div>
            </>
          )}
        </div>
      )}

      {status === 'done' && deleteResult && (
        <div className="stack-16">
          <div className="lo-done-row">
            {deleteResult.failed.length === 0 ? <CheckCircle2 className="i32 c-success" /> : <AlertTriangle className="i32 c-warning" />}
            <div>
              <div className="lo-done-title">{t('lo.doneTitle')}</div>
              <div className="lo-done-desc">
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
            <div className="dialog-card-box">
              <div className="c-fg2">{t('lo.backupSaved')}</div>
              <div className="dialog-card-box-mono">{deleteResult.backup.path}</div>
            </div>
          )}
          {deleteResult.failed.length > 0 && (
            <ul className="lo-failed-list stack-4">
              {deleteResult.failed.map((f) => (
                <li key={f.id} className="lo-failed-item">
                  <XCircle className="lo-failed-icon" />
                  <div className="lo-failed-body">
                    <div className="lo-failed-path">{f.path}</div>
                    <div className="lo-failed-reason">{f.reason}</div>
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
