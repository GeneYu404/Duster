import type { ExportField, ExportFormat, InstalledApp } from '../types/app';
import { formatKb } from './format';

const MIME: Record<ExportFormat, string> = {
  csv: 'text/csv;charset=utf-8',
  json: 'application/json;charset=utf-8',
  html: 'text/html;charset=utf-8',
};

function cell(app: InstalledApp, field: ExportField, pretty: boolean): string {
  const v = app[field];
  if (v === undefined || v === null) return '';
  if (field === 'estimatedSizeKb') return pretty ? formatKb(v as number) : String(v);
  return String(v);
}

function csvEscape(s: string): string {
  if (/[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function htmlEscape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function buildExport(
  apps: InstalledApp[],
  format: ExportFormat,
  fields: ExportField[],
  labels: Record<ExportField, string>,
): { content: string; mimeType: string; fileName: string } {
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  const fileName = `installed-software-${stamp}.${format}`;
  let content = '';

  if (format === 'csv') {
    const lines = [fields.map((f) => csvEscape(labels[f])).join(',')];
    for (const app of apps) lines.push(fields.map((f) => csvEscape(cell(app, f, false))).join(','));
    // UTF-8 BOM so Excel opens Chinese text correctly.
    content = `\ufeff${lines.join('\r\n')}`;
  } else if (format === 'json') {
    const rows = apps.map((app) => {
      const o: Record<string, string | number | null> = {};
      for (const f of fields) {
        const v = app[f];
        o[f] = v === undefined ? null : (v as string | number);
      }
      return o;
    });
    content = JSON.stringify({ generatedAt: new Date().toISOString(), count: apps.length, fields, apps: rows }, null, 2);
  } else {
    const head = fields.map((f) => `<th>${htmlEscape(labels[f])}</th>`).join('');
    const body = apps
      .map((app) => `<tr>${fields.map((f) => `<td>${htmlEscape(cell(app, f, true))}</td>`).join('')}</tr>`)
      .join('\n');
    content = `<!doctype html>
<html><head><meta charset="utf-8"><title>Installed software</title>
<style>
body{font-family:Segoe UI,system-ui,sans-serif;margin:24px;color:#1f2937}
h1{font-size:20px;margin:0 0 4px}p{color:#6b7280;margin:0 0 16px;font-size:13px}
table{border-collapse:collapse;width:100%;font-size:13px}
th,td{border:1px solid #e5e7eb;padding:6px 8px;text-align:left;vertical-align:top;word-break:break-all}
th{background:#f3f4f6;position:sticky;top:0}tr:nth-child(even) td{background:#fafafa}
</style></head><body>
<h1>Installed software</h1>
<p>${apps.length} entries · generated ${htmlEscape(new Date().toLocaleString())}</p>
<table><thead><tr>${head}</tr></thead><tbody>
${body}
</tbody></table></body></html>`;
  }

  return { content, mimeType: MIME[format], fileName };
}
