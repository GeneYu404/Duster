import type { TKey } from '../i18n';
import type { AppDetail, InstalledApp } from '../types/app';
import { formatKb } from './format';

type T = (key: TKey, params?: Record<string, string | number>) => string;

/** Human readable multi-line summary used by "Copy info" / "Copy details". */
export function formatAppInfo(app: InstalledApp | AppDetail, t: T): string {
  const lines: [string, string | undefined][] = [
    [t('name'), app.name],
    [t('version'), app.version],
    [t('publisher'), app.publisher],
    [t('installDate'), app.installDate],
    [t('size'), app.estimatedSizeKb ? `${formatKb(app.estimatedSizeKb)} (${app.estimatedSizeKb} KB)` : undefined],
    [t('architecture'), app.architecture],
    [t('kind'), t(`kind.${app.kind}` as TKey)],
    [t('installLocation'), app.installLocation],
    [t('uninstallString'), app.uninstallString],
    [t('quietUninstallString'), app.quietUninstallString],
    [t('registryPath'), app.registryPath],
    [t('displayIcon'), app.displayIcon],
    [t('msiProductCode'), app.msiProductCode],
    [t('helpLink'), app.helpLink],
    [t('aboutUrl'), app.aboutUrl],
    [t('updateInfoUrl'), app.updateInfoUrl],
  ];
  if ('executablePath' in app && app.executablePath) lines.splice(8, 0, [t('executable'), app.executablePath]);
  return lines
    .filter(([, v]) => v !== undefined && v !== '')
    .map(([k, v]) => `${k}: ${v}`)
    .join('\n');
}

export function formatAppList(apps: InstalledApp[]): string {
  return apps.map((a) => [a.name, a.version ?? '', a.publisher ?? '', a.installLocation ?? ''].join('\t')).join('\n');
}
