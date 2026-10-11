// Package exporter 把软件列表导出成 CSV / JSON / HTML。
//
// 对应原 Rust 的 src-tauri/src/exporter.rs。字段集与表头文案由前端传入，
// 所以同一个导出器既能服务「用户选了哪些列」，也能服务中文/英文表头。
package exporter

import (
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"duster/internal/model"
)

// Fields 是全部可导出的字段（前端 ALL_EXPORT_FIELDS 的后端对应）。
var Fields = []string{
	"name", "version", "publisher", "installDate", "estimatedSizeKb",
	"installLocation", "uninstallString", "quietUninstallString",
	"registryPath", "architecture", "kind",
}

// Mime 返回导出内容的 MIME 类型。
func Mime(format model.ExportFormat) string {
	switch format {
	case model.ExportCSV:
		return "text/csv;charset=utf-8"
	case model.ExportJSON:
		return "application/json;charset=utf-8"
	case model.ExportHTML:
		return "text/html;charset=utf-8"
	}
	return "text/plain;charset=utf-8"
}

// Extension 返回文件扩展名（不含点）。
func Extension(format model.ExportFormat) string {
	switch format {
	case model.ExportCSV:
		return "csv"
	case model.ExportJSON:
		return "json"
	case model.ExportHTML:
		return "html"
	}
	return "txt"
}

// FileName 生成带时间戳的默认文件名。
func FileName(format model.ExportFormat, now time.Time) string {
	return fmt.Sprintf("installed-software-%s.%s", now.Format("20060102-150405"), Extension(format))
}

// field 取一个字段的字符串值（导出只关心文本表示）。
func field(app model.InstalledApp, name string) string {
	switch name {
	case "name":
		return app.Name
	case "version":
		return deref(app.Version)
	case "publisher":
		return deref(app.Publisher)
	case "installDate":
		return deref(app.InstallDate)
	case "estimatedSizeKb":
		if app.EstimatedKB == nil {
			return ""
		}
		return fmt.Sprint(*app.EstimatedKB)
	case "installLocation":
		return deref(app.InstallLoc)
	case "uninstallString":
		return deref(app.UninstallStr)
	case "quietUninstallString":
		return deref(app.QuietStr)
	case "registryPath":
		return app.RegistryPath
	case "architecture":
		return string(app.Arch)
	case "kind":
		return string(app.Kind)
	}
	return ""
}

// deref 解引用可选字符串。
func deref(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}

// csvEscape 按 RFC 4180 转义 CSV 单元格。
func csvEscape(s string) string {
	if strings.ContainsAny(s, ",\"\n\r") {
		return `"` + strings.ReplaceAll(s, `"`, `""`) + `"`
	}
	return s
}

// htmlEscape 转义 HTML 文本节点内容。
func htmlEscape(s string) string {
	r := strings.NewReplacer("&", "&amp;", "<", "&lt;", ">", "&gt;", `"`, "&quot;")
	return r.Replace(s)
}

// Build 按格式生成导出内容。
//
// fields 里不在白名单内的名字会被**静默丢弃**：前端可能传旧版本的
// 字段名，一个未知字段不该让整个导出失败。
func Build(apps []model.InstalledApp, format model.ExportFormat, fields []string, labels map[string]string) string {
	selected := make([]string, 0, len(fields))
	for _, f := range fields {
		if contains(Fields, f) {
			selected = append(selected, f)
		}
	}
	now := time.Now()

	switch format {
	case model.ExportCSV:
		return buildCSV(apps, selected, labels)
	case model.ExportJSON:
		return buildJSON(apps, selected, labels, now)
	default:
		return buildHTML(apps, selected, labels, now)
	}
}

func buildCSV(apps []model.InstalledApp, fields []string, labels map[string]string) string {
	var sb strings.Builder
	// BOM：没有它 Excel 打开 UTF-8 CSV 会按本地代码页解码，中文全变乱码。
	sb.WriteRune('\uFEFF')
	sb.WriteString(strings.Join(csvCells(headerLabels(fields, labels)), ","))
	sb.WriteString("\r\n")
	for _, app := range apps {
		cells := make([]string, 0, len(fields))
		for _, f := range fields {
			cells = append(cells, csvEscape(field(app, f)))
		}
		sb.WriteString(strings.Join(cells, ","))
		sb.WriteString("\r\n")
	}
	return sb.String()
}

// headerLabels 返回表头文案：优先用调用方给的本地化标签，否则用字段名本身。
func headerLabels(fields []string, labels map[string]string) []string {
	out := make([]string, 0, len(fields))
	for _, f := range fields {
		if v, ok := labels[f]; ok && v != "" {
			out = append(out, v)
		} else {
			out = append(out, f)
		}
	}
	return out
}

// csvCells 批量转义表头。
func csvCells(values []string) []string {
	out := make([]string, 0, len(values))
	for _, v := range values {
		out = append(out, csvEscape(v))
	}
	return out
}

func buildJSON(apps []model.InstalledApp, fields []string, labels map[string]string, now time.Time) string {
	rows := make([]map[string]any, 0, len(apps))
	for _, app := range apps {
		row := make(map[string]any, len(fields))
		for _, f := range fields {
			v := field(app, f)
			// 空值序列化成 null 而不是 ""：JSON 里空串和「没有值」不该混淆。
			if v == "" {
				row[f] = nil
			} else {
				row[f] = v
			}
		}
		rows = append(rows, row)
	}
	doc := map[string]any{
		"generatedAt": now.Format(time.RFC3339),
		"count":       len(apps),
		"fields":      fields,
		"apps":        rows,
	}
	raw, err := json.MarshalIndent(doc, "", "  ")
	if err != nil {
		return "{}"
	}
	return string(raw)
}

func buildHTML(apps []model.InstalledApp, fields []string, labels map[string]string, now time.Time) string {
	var head strings.Builder
	for _, f := range headerLabels(fields, labels) {
		head.WriteString("<th>" + htmlEscape(f) + "</th>")
	}
	var body strings.Builder
	for _, app := range apps {
		body.WriteString("<tr>")
		for _, f := range fields {
			body.WriteString("<td>" + htmlEscape(field(app, f)) + "</td>")
		}
		body.WriteString("</tr>\n")
	}
	// 样式单独抽出来：CSS 里的 `%`（如 word-break:break-all 没有，但
	// 百分号宽度写法有）会被 fmt 当成格式动词，整段塞进 Sprintf 迟早炸。
	const style = "<style>body{font-family:Segoe UI,system-ui,sans-serif;margin:24px;color:#1f2937}" +
		"table{border-collapse:collapse;width:100%;font-size:13px}" +
		"th,td{border:1px solid #e5e7eb;padding:6px 8px;text-align:left;vertical-align:top;word-break:break-all}" +
		"th{background:#f3f4f6;position:sticky;top:0}</style>"
	return "<!doctype html><html><head><meta charset=\"utf-8\"><title>Installed software</title>" +
		style + "</head><body><h1>Installed software</h1><p>" +
		fmt.Sprintf("%d entries · %s", len(apps), now.Format("2006-01-02 15:04")) +
		"</p><table><thead><tr>" + head.String() + "</tr></thead><tbody>\n" +
		body.String() + "</tbody></table></body></html>"
}

// contains 报告 slice 里是否有 target。
func contains(list []string, target string) bool {
	for _, v := range list {
		if v == target {
			return true
		}
	}
	return false
}
