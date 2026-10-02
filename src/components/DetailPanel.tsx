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
  if (!value) return <span className="c-fg3">—</span>;
  return (
    <span className={cn('copy-value', className)}>
      <span className={cn('copy-value-text', mono && 'copy-value-text--mono')}>{value}</span>
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
        className="copy-btn t-opacity"
      >
        {ok ? <Check className="i12 c-success" /> : <ClipboardCopy className="i12" />}
      </button>
    </span>
  );
}

function Link({ href }: { href?: string }) {
  const backend = useAppStore((s) => s.backend);
  const reportError = useAppStore((s) => s.reportError);
  if (!href) return <span className="c-fg3">—</span>;
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
      className="detail-link"
    >
      {href}
      <ExternalLink className="i12 shrink-0" />
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
        <div className="callout callout--warning callout--mb">
          <AlertTriangle className="callout-icon" />
          {t('detail.noUninstaller')}
        </div>
      )}
      {hasCommand && d && !d.uninstallerExists && (
        <div className="callout callout--warning callout--mb">
          <AlertTriangle className="callout-icon" />
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
            {formatKb(app.estimatedSizeKb)} <span className="c-fg3">({app.estimatedSizeKb.toLocaleString()} KB)</span>
          </span>
        ) : (
          '—'
        )}
      </Field>
      <Field label={t('kind')}>
        <span className="badge-row">
          <Badge tone={KIND_TONE[app.kind]}>{t(`kind.${app.kind}` as TKey)}</Badge>
          {app.isMsi && <Badge tone="sky">{t('msiPackage')}</Badge>}
          {app.isSystemComponent && <Badge tone="amber">{t('systemComponent')}</Badge>}
          {app.isUpdate && <Badge tone="green">{t('updateItem')}</Badge>}
          <Badge>{app.architecture}</Badge>
          <Badge>{app.source}</Badge>
        </span>
      </Field>
      <Field label={t('installLocation')}>
        <span className="value-stack">
          <CopyValue value={app.installLocation} />
          {d && app.installLocation && (
            <span className={cn('badge-extra', d.installLocationExists ? 'badge-extra--ok' : 'badge-extra--missing')}>
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
          <div className="raw-table-shell">
            <table className="raw-table">
              <tbody>
                {Object.entries(d.registryValues).map(([k, v]) => (
                  <tr key={k} className="raw-row">
                    <td className="raw-key">{k}</td>
                    <td className="raw-val">{v}</td>
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
      <div className="detail-empty">
        <div className="detail-empty-mark">
          <MousePointerClick className="i20 c-fg3" />
        </div>
        <div className="detail-empty-text">{t('detail.empty')}</div>
        <div className="detail-empty-hint">{t('detail.emptyHint')}</div>
      </div>
    );
  }

  if (!app) {
    const total = selected.reduce((s, a) => s + (a.estimatedSizeKb ?? 0), 0);
    return (
      <div className="detail-multi">
        <div className="detail-multi-title">{t('detail.multi', { count: selected.length })}</div>
        <div className="detail-multi-sub">{t('detail.multiSize', { size: formatKb(total) })}</div>
        <div className="detail-multi-actions">
          <Button variant="danger" size="sm" icon={<Trash2 className="i14" />} onClick={() => openDialog({ type: 'uninstall', appIds: selected.map((a) => a.id), quiet: false })}>
            {t('detail.batchUninstall')}
          </Button>
          <Button size="sm" icon={<Download className="i14" />} onClick={() => openDialog({ type: 'export', scope: 'selected' })}>
            {t('detail.exportSelected')}
          </Button>
        </div>
        <ul className="detail-multi-list stack-4">
          {selected.map((a) => (
            <li key={a.id} className="detail-multi-item">
              <AppIcon appId={a.id} name={a.name} size={16} />
              <span className="truncate">{a.name}</span>
              <span className="detail-multi-size">{formatKb(a.estimatedSizeKb)}</span>
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
    <div className="detail-panel">
      <div className="detail-head">
        <div className="detail-title-row">
          <AppIcon appId={app.id} name={app.name} size={40} />
          <div className="min-w-0 flex-1">
            <div className="detail-title" title={app.name}>
              {app.name}
            </div>
            <div className="detail-subtitle">
              {[app.version, app.publisher].filter(Boolean).join(' · ') || '—'}
            </div>
          </div>
          {loading && <Spinner className="spinner--detail" />}
        </div>
        <div className="detail-actions">
          <Button variant="primary" size="sm" icon={<Trash2 className="i14" />} disabled={!app.uninstallString && !app.quietUninstallString} onClick={() => openDialog({ type: 'uninstall', appIds: [app.id], quiet: false })}>
            {t('detail.uninstall')}
          </Button>
          <Button variant="danger" size="sm" icon={<Eraser className="i14" />} onClick={() => openDialog({ type: 'leftovers', appId: app.id, appName: app.name, mode: 'force' })}>
            {t('detail.force')}
          </Button>
          <IconButton label={t('detail.openFolder')} disabled={!app.installLocation} onClick={() => void act(() => ipc.openInstallLocation(app.id), t('toast.opened'))} className="icon-btn--sm">
            <FolderOpen className="i16" />
          </IconButton>
          <IconButton label={t('menu.revealExe')} disabled={!detail?.executablePath} onClick={() => void act(() => ipc.revealPath(detail!.executablePath!), t('toast.opened'))} className="icon-btn--sm">
            <Locate className="i16" />
          </IconButton>
          <IconButton label={t('menu.openRegistry')} onClick={() => void act(() => ipc.openRegistryKey(app.registryPath), t('toast.opened'))} className="icon-btn--sm">
            <Regex className="i16" />
          </IconButton>
          <IconButton
            label={t('detail.copyAll')}
            onClick={() => void copyText(formatAppInfo(detail ?? app, t)).then((ok) => pushToast(ok ? 'success' : 'error', t(ok ? 'copied' : 'copyFailed')))}
            className="icon-btn--sm"
          >
            <ClipboardCopy className="i16" />
          </IconButton>
        </div>
      </div>
      <div className="win-scroll detail-body">
        <DetailBody app={app} detail={detail} />
      </div>
    </div>
  );
}
