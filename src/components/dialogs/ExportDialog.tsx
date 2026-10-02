import { useState } from 'react';
import { Download, FileJson, FileSpreadsheet, FileText } from 'lucide-react';
import { ipc } from '../../ipc/commands';
import { useT, useVisibleApps } from '../../store/hooks';
import { useAppStore } from '../../store/useAppStore';
import { ALL_EXPORT_FIELDS, type ExportField, type ExportFormat } from '../../types/app';
import type { TKey } from '../../i18n';
import { cn } from '../../utils/cn';
import { downloadText } from '../../utils/format';
import { buildExport } from '../../utils/exporter';
import { Button, Checkbox, Modal } from '../ui';

type Scope = 'all' | 'view' | 'selected';

const FIELD_LABEL: Record<ExportField, TKey> = {
  name: 'name',
  version: 'version',
  publisher: 'publisher',
  installDate: 'installDate',
  estimatedSizeKb: 'size',
  installLocation: 'installLocation',
  uninstallString: 'uninstallString',
  quietUninstallString: 'quietUninstallString',
  registryPath: 'registryPath',
  architecture: 'architecture',
  kind: 'kind',
};

const DEFAULT_FIELDS: ExportField[] = ['name', 'version', 'publisher', 'installDate', 'estimatedSizeKb', 'installLocation', 'uninstallString', 'registryPath'];

const FORMATS: { value: ExportFormat; label: string; icon: typeof FileText; hint: string }[] = [
  { value: 'csv', label: 'CSV', icon: FileSpreadsheet, hint: 'Excel / WPS' },
  { value: 'json', label: 'JSON', icon: FileJson, hint: 'API / scripts' },
  { value: 'html', label: 'HTML', icon: FileText, hint: 'Report' },
];

export function ExportDialog({ scope: minimalScope }: { scope: Scope }) {
  const t = useT();
  const closeDialog = useAppStore((s) => s.closeDialog);
  const pushToast = useAppStore((s) => s.pushToast);
  const reportError = useAppStore((s) => s.reportError);
  const log = useAppStore((s) => s.log);
  const backend = useAppStore((s) => s.backend);
  const apps = useAppStore((s) => s.apps);
  const selectedIds = useAppStore((s) => s.selectedIds);
  const visible = useVisibleApps();

  const [format, setFormat] = useState<ExportFormat>('csv');
  const [fields, setFields] = useState<ExportField[]>(DEFAULT_FIELDS);
  const [scope, setScope] = useState<Scope>(minimalScope === 'selected' && selectedIds.length === 0 ? 'view' : minimalScope);
  const [working, setWorking] = useState(false);

  const scopeApps = scope === 'all' ? apps : scope === 'view' ? visible : apps.filter((a) => selectedIds.includes(a.id));

  const toggleField = (f: ExportField, on: boolean) => setFields((prev) => (on ? ALL_EXPORT_FIELDS.filter((x) => prev.includes(x) || x === f) : prev.filter((x) => x !== f)));

  const run = async () => {
    if (fields.length === 0) {
      pushToast('error', t('ex.noFields'));
      return;
    }
    setWorking(true);
    try {
      const labels = Object.fromEntries(ALL_EXPORT_FIELDS.map((f) => [f, t(FIELD_LABEL[f])])) as Record<ExportField, string>;
      if (backend === 'tauri') {
        const res = await ipc.exportApps({ format, fields, labels, appIds: scope === 'all' ? undefined : scopeApps.map((a) => a.id) });
        if (res.content) downloadText(res.fileName, res.content, res.mimeType);
        pushToast('success', t('ex.success', { count: res.count, file: res.path ?? res.fileName }));
      } else {
        // Browser preview: build locally with localised headers and trigger a download.
        const built = buildExport(scopeApps, format, fields, labels);
        downloadText(built.fileName, built.content, built.mimeType);
        pushToast('success', t('ex.success', { count: scopeApps.length, file: built.fileName }));
      }
      log('info', `Exported ${scopeApps.length} entries as ${format.toUpperCase()} (${scope})`);
      closeDialog();
    } catch (e) {
      reportError(e);
    } finally {
      setWorking(false);
    }
  };

  const scopeOptions: { value: Scope; label: string; disabled?: boolean }[] = [
    { value: 'view', label: t('ex.scopeView', { count: visible.length }) },
    { value: 'selected', label: t('ex.scopeSelected', { count: selectedIds.length }), disabled: selectedIds.length === 0 },
    { value: 'all', label: t('ex.scopeAll', { count: apps.length }) },
  ];

  return (
    <Modal
      title={t('ex.title')}
      icon={<Download className="h-5 w-5 text-accent" />}
      onClose={closeDialog}
      busy={working}
      footer={
        <>
          <Button onClick={closeDialog}>{t('cancel')}</Button>
          <Button variant="primary" icon={<Download className="h-3.5 w-3.5" />} loading={working} disabled={scopeApps.length === 0 || fields.length === 0} onClick={() => void run()}>
            {t('ex.button')} ({scopeApps.length})
          </Button>
        </>
      }
    >
      <div className="space-y-5 text-[13px]">
        <section>
          <div className="mb-2 text-[11px] font-semibold tracking-wider text-fg3 uppercase">{t('ex.format')}</div>
          <div className="grid grid-cols-3 gap-2">
            {FORMATS.map((f) => (
              <button
                key={f.value}
                type="button"
                onClick={() => setFormat(f.value)}
                className={cn(
                  'flex flex-col items-start gap-1 rounded-lg border p-3 text-left transition-colors',
                  format === f.value ? 'border-accent bg-accent-soft' : 'border-stroke hover:border-stroke-strong',
                )}
              >
                <f.icon className={cn('h-5 w-5', format === f.value ? 'text-accent' : 'text-fg3')} />
                <span className="font-semibold">{f.label}</span>
                <span className="text-[11px] text-fg2">{f.hint}</span>
              </button>
            ))}
          </div>
        </section>

        <section>
          <div className="mb-2 text-[11px] font-semibold tracking-wider text-fg3 uppercase">{t('ex.scope')}</div>
          <div className="space-y-1.5">
            {scopeOptions.map((o) => (
              <label key={o.value} className={cn('flex cursor-pointer items-center gap-2', o.disabled && 'cursor-not-allowed opacity-50')}>
                <input type="radio" name="scope" className="accent-accent" checked={scope === o.value} disabled={o.disabled} onChange={() => setScope(o.value)} />
                {o.label}
              </label>
            ))}
          </div>
        </section>

        <section>
          <div className="mb-2 flex items-center justify-between">
            <span className="text-[11px] font-semibold tracking-wider text-fg3 uppercase">{t('ex.fields')}</span>
            <div className="flex gap-2 text-xs">
              <button type="button" className="text-accent hover:underline" onClick={() => setFields(ALL_EXPORT_FIELDS)}>
                {t('selectAll')}
              </button>
              <button type="button" className="text-fg2 hover:underline" onClick={() => setFields(['name'])}>
                {t('clearSelection')}
              </button>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-x-4 gap-y-1.5">
            {ALL_EXPORT_FIELDS.map((f) => (
              <Checkbox key={f} checked={fields.includes(f)} onChange={(on) => toggleField(f, on)} label={t(FIELD_LABEL[f])} />
            ))}
          </div>
        </section>
      </div>
    </Modal>
  );
}
