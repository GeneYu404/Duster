package exporter

import (
	"encoding/json"
	"strings"
	"testing"

	"duster/internal/model"
)

func sample() []model.InstalledApp {
	return []model.InstalledApp{{
		ID:           "abc",
		Name:         `Foo, "Bar" <Pro>`,
		Version:      model.Str("1.2.3"),
		Publisher:    model.Str("Foo Software"),
		RegistryPath: `HKLM\SOFTWARE\Foo\Bar`,
		Hive:         model.HiveHKLM,
		View:         model.ViewX64,
		Arch:         model.ArchX64,
		Kind:         model.KindProgram,
		Source:       model.SourceRegistry,
		EstimatedKB:  model.U32(1024),
	}}
}

// CSV 的转义与 BOM 是最容易静默出错的地方：引号错了 Excel 会把一列
// 拆成两列，BOM 少了中文全是乱码，而且都不会报错。
func TestBuildCSV_EscapingAndBOM(t *testing.T) {
	out := Build(sample(), model.ExportCSV, []string{"name", "version"}, nil)
	if !strings.HasPrefix(out, "\uFEFF") {
		t.Error("CSV 必须以 UTF-8 BOM 开头，否则 Excel 会乱码")
	}
	if !strings.Contains(out, `"Foo, ""Bar"" <Pro>"`) {
		t.Errorf("CSV 转义不正确: %q", out)
	}
	lines := strings.Split(strings.TrimPrefix(out, "\uFEFF"), "\r\n")
	if lines[0] != "name,version" {
		t.Errorf("表头 = %q", lines[0])
	}
	if lines[1] != `"Foo, ""Bar"" <Pro>",1.2.3` {
		t.Errorf("数据行 = %q", lines[1])
	}
}

// 本地化表头必须覆盖字段名。
func TestBuildCSV_LocalizedHeaders(t *testing.T) {
	labels := map[string]string{"name": "名称"}
	out := Build(sample(), model.ExportCSV, []string{"name", "version"}, labels)
	first := strings.SplitN(strings.TrimPrefix(out, "\uFEFF"), "\r\n", 2)[0]
	if first != "名称,version" {
		t.Errorf("本地化表头 = %q", first)
	}
}

// 未知字段要被静默丢弃，而不是让整个导出失败。
func TestBuild_DropsUnknownFields(t *testing.T) {
	out := Build(sample(), model.ExportJSON, []string{"name", "bogusField"}, nil)
	var doc map[string]any
	if err := json.Unmarshal([]byte(out), &doc); err != nil {
		t.Fatalf("JSON 不合法: %v\n%s", err, out)
	}
	fields, _ := doc["fields"].([]any)
	if len(fields) != 1 || fields[0] != "name" {
		t.Errorf("fields = %v, 期望只剩 name", fields)
	}
}

// 空值在 JSON 里是 null，不是空串。
func TestBuildJSON_NullForEmpty(t *testing.T) {
	out := Build(sample(), model.ExportJSON, []string{"name", "installDate"}, nil)
	var doc struct {
		Apps []map[string]any `json:"apps"`
	}
	if err := json.Unmarshal([]byte(out), &doc); err != nil {
		t.Fatalf("JSON 不合法: %v", err)
	}
	v, present := doc.Apps[0]["installDate"]
	if !present || v != nil {
		t.Errorf("空值应为 null，实际 %#v", v)
	}
}

// HTML 必须转义，否则产品名里的尖括号会破坏表格结构。
func TestBuildHTML_Escapes(t *testing.T) {
	out := Build(sample(), model.ExportHTML, []string{"name"}, nil)
	if strings.Contains(out, "<td>Foo, \"Bar\" <Pro></td>") {
		t.Error("HTML 未转义尖括号")
	}
	if !strings.Contains(out, "&lt;Pro&gt;") {
		t.Errorf("HTML 转义不正确:\n%s", out)
	}
	if !strings.HasPrefix(out, "<!doctype html>") {
		t.Error("HTML 缺少 doctype")
	}
}

// 未选字段的列不应出现。
func TestBuild_RespectsFieldSelection(t *testing.T) {
	out := Build(sample(), model.ExportHTML, []string{"name"}, nil)
	if strings.Contains(out, "<th>version</th>") {
		t.Error("未选中的字段不应出现在表头")
	}
}
