//! Export the software list as CSV / JSON / HTML with a user-selected field set.

use crate::app_model::{ExportFormat, InstalledApp};
use std::collections::BTreeMap;

pub const FIELDS: &[&str] = &["name", "version", "publisher", "installDate", "estimatedSizeKb", "installLocation", "uninstallString", "quietUninstallString", "registryPath", "architecture", "kind"];

fn field(app: &InstalledApp, name: &str) -> String {
    match name {
        "name" => app.name.clone(),
        "version" => app.version.clone().unwrap_or_default(),
        "publisher" => app.publisher.clone().unwrap_or_default(),
        "installDate" => app.install_date.clone().unwrap_or_default(),
        "estimatedSizeKb" => app.estimated_size_kb.map(|v| v.to_string()).unwrap_or_default(),
        "installLocation" => app.install_location.clone().unwrap_or_default(),
        "uninstallString" => app.uninstall_string.clone().unwrap_or_default(),
        "quietUninstallString" => app.quiet_uninstall_string.clone().unwrap_or_default(),
        "registryPath" => app.registry_path.clone(),
        "architecture" => serde_json::to_value(app.architecture).ok().and_then(|v| v.as_str().map(str::to_string)).unwrap_or_default(),
        "kind" => serde_json::to_value(app.kind).ok().and_then(|v| v.as_str().map(str::to_string)).unwrap_or_default(),
        _ => String::new(),
    }
}

fn csv_escape(s: &str) -> String {
    if s.chars().any(|c| matches!(c, ',' | '"' | '\n' | '\r')) {
        format!("\"{}\"", s.replace('"', "\"\""))
    } else {
        s.to_string()
    }
}

fn html_escape(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;")
}

pub fn mime(format: ExportFormat) -> &'static str {
    match format {
        ExportFormat::Csv => "text/csv;charset=utf-8",
        ExportFormat::Json => "application/json;charset=utf-8",
        ExportFormat::Html => "text/html;charset=utf-8",
    }
}

pub fn extension(format: ExportFormat) -> &'static str {
    match format {
        ExportFormat::Csv => "csv",
        ExportFormat::Json => "json",
        ExportFormat::Html => "html",
    }
}

/// Column header text: the caller's custom label when present, otherwise the raw field name.
///
/// Takes both arguments with one lifetime so a label stored in the map can be returned
/// alongside a shorter-lived field name (a closure cannot unify the two borrows).
fn label<'a>(labels: Option<&'a BTreeMap<String, String>>, field: &'a str) -> &'a str {
    labels.and_then(|all| all.get(field)).map(String::as_str).unwrap_or(field)
}

pub fn build(apps: &[InstalledApp], format: ExportFormat, fields: &[String], labels: Option<&BTreeMap<String, String>>) -> String {
    let fields: Vec<&str> = fields.iter().map(String::as_str).filter(|f| FIELDS.contains(f)).collect();
    match format {
        ExportFormat::Csv => {
            let mut out = String::from("\u{feff}");
            out.push_str(&fields.iter().map(|f| csv_escape(label(labels, f))).collect::<Vec<_>>().join(","));
            out.push_str("\r\n");
            for app in apps {
                out.push_str(&fields.iter().map(|f| csv_escape(&field(app, f))).collect::<Vec<_>>().join(","));
                out.push_str("\r\n");
            }
            out
        }
        ExportFormat::Json => {
            let rows: Vec<serde_json::Value> = apps
                .iter()
                .map(|app| {
                    let mut o = serde_json::Map::new();
                    for f in &fields {
                        let v = field(app, f);
                        o.insert((*f).to_string(), if v.is_empty() { serde_json::Value::Null } else { serde_json::Value::String(v) });
                    }
                    serde_json::Value::Object(o)
                })
                .collect();
            serde_json::to_string_pretty(&serde_json::json!({
                "generatedAt": chrono::Local::now().to_rfc3339(),
                "count": apps.len(),
                "fields": fields,
                "apps": rows,
            }))
            .unwrap_or_default()
        }
        ExportFormat::Html => {
            let head: String = fields.iter().map(|f| format!("<th>{}</th>", html_escape(label(labels, f)))).collect();
            let body: String = apps
                .iter()
                .map(|app| format!("<tr>{}</tr>", fields.iter().map(|f| format!("<td>{}</td>", html_escape(&field(app, f)))).collect::<String>()))
                .collect::<Vec<_>>()
                .join("\n");
            format!(
                "<!doctype html><html><head><meta charset=\"utf-8\"><title>Installed software</title>\
<style>body{{font-family:Segoe UI,system-ui,sans-serif;margin:24px;color:#1f2937}}table{{border-collapse:collapse;width:100%;font-size:13px}}\
th,td{{border:1px solid #e5e7eb;padding:6px 8px;text-align:left;vertical-align:top;word-break:break-all}}th{{background:#f3f4f6;position:sticky;top:0}}</style>\
</head><body><h1>Installed software</h1><p>{} entries · {}</p><table><thead><tr>{}</tr></thead><tbody>\n{}\n</tbody></table></body></html>",
                apps.len(),
                chrono::Local::now().format("%Y-%m-%d %H:%M"),
                head,
                body
            )
        }
    }
}
