import { useEffect, useState } from 'react';
import { AlertTriangle, Check, ClipboardCopy, Download, Eraser, ExternalLink, FolderOpen, Locate, MousePointerClick, Regex, Trash2 } from 'lucide-react';
import { ipc } from '../ipc/commands';
import { useSelectedApps, useT } from '../store/hooks';
import { useAppStore } from '../store/useAppStore';
import type { AppDetail, InstalledApp } from '../types/app';
import type { TKey } from '../i18n';
import { cn } from '../utils/cn';
import { copyText, formatKb } from '../utils/format';
import { formatAppInfo } from '../utils/appInfo';
import { AppIcon } from './AppIcon';
import { Badge, Button, Field, IconButton, KIND_TONE, SectionTitle, Spinner } from './ui';

export function useAppDetail(appId: string | undefined) {
  const [detail, setDetail] = useState<AppDetail | undefined>();
  const [loading, setLoading] = useState(false);
  const apps = useAppStore((s) => s.apps);
  useEffect(() => {
    if (!appId) {
      setDetail(undefined);
      return;
    }
    let cancelled = false;
    setLoading(true);
    const timer = setTimeout(() => {
      ipc
        .getAppDetail(appId)
        .then((d) => {
          if (!cancelled) setDetail(d);
        })
        .catch(() => {
          if (!cancelled) setDetail(undefined);
        })
        .finally(() => {
          if (!cancelled) setLoading(false);
        });
    }, 120);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [appId, apps]);
  return { detail: detail && detail.id === appId ? detail : undefined, loading };
}

function CopyValue({ value, mono = true, className }: { value?: string; mono?: boolean; className?: string }) {
  const t = useT();
  const pushToast = useAppStore((s) => s.pushToast);
  const [ok, setOk] = useState(false);
  if (!value) return <span className="text-fg3">—</span>;
  return (
    <span className={cn('group/cv inline-flex max-w-full items-start gap-1', className)}>
      <span className={cn('min-w-0 break-all', mono && 'font-mono text-[12px]')}>{value}</span>
      <button
        type="button"
        title={t('copy')}
        onClick={() =>
          void copyText(value).then((done) => {
            setOk(done);
            if (!done) pushToast('error', t('copyFailed'));
            setTimeout(() => setOk(false), 1200);
          })
        }
        className="mt-px shrink-0 rounded p-0.5 text-fg3 opacity-0 transition-opacity group-hover/cv:opacity-100 hover:text-accent focus:opacity-100"
      >
        {ok ? <Check className="h-3 w-3 text-success" /> : <ClipboardCopy className="h-3 w-3" />}
      </button>
    </span>
  );
}

function Link({ href }: { href?: string }) {
  const backend = useAppStore((s) => s.backend);
  const reportError = useAppStore((s) => s.reportError);
  if (!href) return <span className="text-fg3">—</span>;
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      onClick={(event) => {
        if (backend === 'tauri') {
          event.preventDefault();
          void ipc.openExternal(href).catch(reportError);
        }
      }}
      className="inline-flex items-center gap-1 break-all text-accent hover:underline"
    >
      {href}
      <ExternalLink className="h-3 w-3 shrink-0" />
    </a>
  );
}

export function DetailBody({ app, detail, showRaw = false }: { app: InstalledApp; detail?: AppDetail; showRaw?: boolean }) {
  const t = useT();
  const d = detail;
  const hasCommand = !!(app.uninstallString || app.quietUninstallString);
  return (
    <div>
      {!hasCommand && (
        <div className="mb-3 flex items-start gap-2 rounded-md border border-warning/30 bg-warning-soft px-3 py-2 text-xs text-warning">
          <AlertTriangle className="mt-px h-3.5 w-3.5 shrink-0" />
          {t('detail.noUninstaller')}
        </div>
      )}
      {hasCommand && d && !d.uninstallerExists && (
        <div className="mb-3 flex items-start gap-2 rounded-md border border-warning/30 bg-warning-soft px-3 py-2 text-xs text-warning">
          <AlertTriangle className="mt-px h-3.5 w-3.5 shrink-0" />
          {t('detail.brokenUninstaller')}
        </div>
      )}

      <SectionTitle>{t('detail.general')}</SectionTitle>
      <Field label={t('version')}><CopyValue value={app.version} mono={false} /></Field>
      <Field label={t('publisher')}><CopyValue value={app.publisher} mono={false} /></Field>
      <Field label={t('installDate')}>{app.installDate ?? '—'}</Field>
      <Field label={t('size')}>
        {app.estimatedSizeKb ? (
          <span>
            {formatKb(app.estimatedSizeKb)} <span className="text-fg3">({app.estimatedSizeKb.toLocaleString()} KB)</span>
          </span>
        ) : (
          '—'
        )}
      </Field>
      <Field label={t('kind')}>
        <span className="flex flex-wrap items-center gap-1">
          <Badge tone={KIND_TONE[app.kind]}>{t(`kind.${app.kind}` as TKey)}</Badge>
          {app.isMsi && <Badge tone="sky">{t('msiPackage')}</Badge>}
          {app.isSystemComponent && <Badge tone="amber">{t('systemComponent')}</Badge>}
          {app.isUpdate && <Badge tone="green">{t('updateItem')}</Badge>}
          <Badge>{app.architecture}</Badge>
          <Badge>{app.source}</Badge>
        </span>
      </Field>
      <Field label={t('installLocation')}>
        <span className="flex flex-col gap-0.5">
          <CopyValue value={app.installLocation} />
          {d && app.installLocation && (
            <span className={cn('text-[11px]', d.installLocationExists ? 'text-success' : 'text-warning')}>
              {d.installLocationExists ? t('pathExists') : t('pathMissing')}
            </span>
          )}
        </span>
      </Field>
      <Field label={t('executable')}><CopyValue value={d?.executablePath} /></Field>
      <Field label={t('displayIcon')}><CopyValue value={app.displayIcon} /></Field>

      <SectionTitle>{t('detail.commands')}</SectionTitle>
      <Field label={t('uninstallString')}><CopyValue value={app.uninstallString} /></Field>
      <Field label={t('quietUninstallString')}><CopyValue value={app.quietUninstallString} /></Field>
      {d?.parsedCommand && d.parsedCommand.normalized !== app.uninstallString && (
        <Field label="→ normalized"><CopyValue value={d.parsedCommand.normalized} /></Field>
      )}
      {d?.modifyPath && <Field label={t('modifyPath')}><CopyValue value={d.modifyPath} /></Field>}
      {app.msiProductCode && <Field label={t('msiProductCode')}><CopyValue value={app.msiProductCode} /></Field>}
      {app.packageFullName && <Field label="Package"><CopyValue value={app.packageFullName} /></Field>}

      <SectionTitle>{t('detail.registry')}</SectionTitle>
      <Field label={t('registryPath')}><CopyValue value={app.registryPath} /></Field>
      <Field label={t('registryView')}>
        {app.hive} · {app.registryView === 'x86' ? 'KEY_WOW64_32KEY' : 'KEY_WOW64_64KEY'}
      </Field>

      {(app.helpLink || app.aboutUrl || app.updateInfoUrl) && (
        <>
          <SectionTitle>{t('detail.links')}</SectionTitle>
          {app.helpLink && <Field label={t('helpLink')}><Link href={app.helpLink} /></Field>}
          {app.aboutUrl && <Field label={t('aboutUrl')}><Link href={app.aboutUrl} /></Field>}
          {app.updateInfoUrl && <Field label={t('updateInfoUrl')}><Link href={app.updateInfoUrl} /></Field>}
        </>
      )}

      {showRaw && d && (
        <>
          <SectionTitle>{t('rawValues')}</SectionTitle>
          <div className="overflow-hidden rounded-md border border-stroke">
            <table className="w-full text-[12px]">
              <tbody>
                {Object.entries(d.registryValues).map(([k, v]) => (
                  <tr key={k} className="border-b border-stroke last:border-0 odd:bg-layer-solid">
                    <td className="w-40 px-2 py-1 align-top font-medium text-fg2">{k}</td>
                    <td className="px-2 py-1 font-mono break-all text-fg">{v}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}

export function DetailPanel() {
  const t = useT();
  const selected = useSelectedApps();
  const openDialog = useAppStore((s) => s.openDialog);
  const pushToast = useAppStore((s) => s.pushToast);
  const reportError = useAppStore((s) => s.reportError);
  const app = selected.length === 1 ? selected[0] : undefined;
  const { detail, loading } = useAppDetail(app?.id);

  if (selected.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
        <div className="flex h-12 w-12 items-center justify-center rounded-full bg-subtle">
          <MousePointerClick className="h-5 w-5 text-fg3" />
        </div>
        <div className="text-sm text-fg2">{t('detail.empty')}</div>
        <div className="text-[11px] text-fg3">{t('detail.emptyHint')}</div>
      </div>
    );
  }

  if (!app) {
    const total = selected.reduce((s, a) => s + (a.estimatedSizeKb ?? 0), 0);
    return (
      <div className="flex h-full flex-col p-4">
        <div className="text-[15px] font-semibold">{t('detail.multi', { count: selected.length })}</div>
        <div className="text-xs text-fg2">{t('detail.multiSize', { size: formatKb(total) })}</div>
        <div className="mt-3 flex flex-wrap gap-2">
          <Button variant="danger" size="sm" icon={<Trash2 className="h-3.5 w-3.5" />} onClick={() => openDialog({ type: 'uninstall', appIds: selected.map((a) => a.id), quiet: false })}>
            {t('detail.batchUninstall')}
          </Button>
          <Button size="sm" icon={<Download className="h-3.5 w-3.5" />} onClick={() => openDialog({ type: 'export', scope: 'selected' })}>
            {t('detail.exportSelected')}
          </Button>
        </div>
        <ul className="mt-4 min-h-0 flex-1 space-y-1 overflow-auto text-[13px]">
          {selected.map((a) => (
            <li key={a.id} className="flex items-center gap-2 truncate">
              <AppIcon appId={a.id} name={a.name} size={16} />
              <span className="truncate">{a.name}</span>
              <span className="ml-auto shrink-0 text-xs text-fg3 tabular-nums">{formatKb(a.estimatedSizeKb)}</span>
            </li>
          ))}
        </ul>
      </div>
    );
  }

  const act = async (fn: () => Promise<void>, msg?: string) => {
    try {
      await fn();
      if (msg) pushToast('success', msg);
    } catch (e) {
      reportError(e);
    }
  };

  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-stroke p-4">
        <div className="flex items-start gap-3">
          <AppIcon appId={app.id} name={app.name} size={40} />
          <div className="min-w-0 flex-1">
            <div className="truncate text-[15px] font-semibold leading-tight text-fg" title={app.name}>
              {app.name}
            </div>
            <div className="mt-0.5 truncate text-xs text-fg2">
              {[app.version, app.publisher].filter(Boolean).join(' · ') || '—'}
            </div>
          </div>
          {loading && <Spinner className="mt-1 h-3.5 w-3.5" />}
        </div>
        <div className="mt-3 flex flex-wrap gap-1.5">
          <Button variant="primary" size="sm" icon={<Trash2 className="h-3.5 w-3.5" />} disabled={!app.uninstallString && !app.quietUninstallString} onClick={() => openDialog({ type: 'uninstall', appIds: [app.id], quiet: false })}>
            {t('detail.uninstall')}
          </Button>
          <Button variant="danger" size="sm" icon={<Eraser className="h-3.5 w-3.5" />} onClick={() => openDialog({ type: 'leftovers', appId: app.id, appName: app.name, mode: 'force' })}>
            {t('detail.force')}
          </Button>
          <IconButton label={t('detail.openFolder')} disabled={!app.installLocation} onClick={() => void act(() => ipc.openInstallLocation(app.id), t('toast.opened'))} className="h-7 w-7">
            <FolderOpen className="h-4 w-4" />
          </IconButton>
          <IconButton label={t('menu.revealExe')} disabled={!detail?.executablePath} onClick={() => void act(() => ipc.revealPath(detail!.executablePath!), t('toast.opened'))} className="h-7 w-7">
            <Locate className="h-4 w-4" />
          </IconButton>
          <IconButton label={t('menu.openRegistry')} onClick={() => void act(() => ipc.openRegistryKey(app.registryPath), t('toast.opened'))} className="h-7 w-7">
            <Regex className="h-4 w-4" />
          </IconButton>
          <IconButton
            label={t('detail.copyAll')}
            onClick={() => void copyText(formatAppInfo(detail ?? app, t)).then((ok) => pushToast(ok ? 'success' : 'error', t(ok ? 'copied' : 'copyFailed')))}
            className="h-7 w-7"
          >
            <ClipboardCopy className="h-4 w-4" />
          </IconButton>
        </div>
      </div>
      <div className="win-scroll min-h-0 flex-1 overflow-auto px-4 pt-3 pb-4">
        <DetailBody app={app} detail={detail} />
      </div>
    </div>
  );
}
