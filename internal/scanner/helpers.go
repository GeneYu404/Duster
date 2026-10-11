package scanner

import (
	"bytes"
	"encoding/json"
	"sort"
	"strings"

	"duster/internal/model"
	"duster/internal/winreg"
)

// viewRegistryName 把 Win32 的视图标志翻成前端认识的字符串。
//
// 注意方向是单向的：32 位视图在**显示路径**里是
// `SOFTWARE\WOW6432Node\...`，但那是「64 位注册表里给 32 位程序看的映射」，
// 与真正的 WOW6432Node 子键不是一回事。所以这里只把视图**记成** x86，
// 绝不把它拼进 registryPath —— 否则 id 会和 64 位视图那条对不上，
// 去重逻辑会漏掉本该合并的重复项。
func viewRegistryName(v winreg.View) model.RegistryView {
	if v == winreg.View32 {
		return model.ViewX86
	}
	return model.ViewX64
}

// sortByName 按名称小写排序，让列表顺序在每次扫描之间保持稳定。
//
// 不排序的话 map 迭代顺序是随机的，虚拟表格会在每次刷新后重排，
// 用户正在看的那一行会莫名其妙跳走。
func sortByName(apps []model.InstalledApp) {
	sort.SliceStable(apps, func(i, j int) bool {
		return strings.ToLower(apps[i].Name) < strings.ToLower(apps[j].Name)
	})
}

// parseStoreAppsJSON 解析 `Get-AppxPackage | ConvertTo-Json` 的输出。
//
// ConvertTo-Json 在只有一个包时输出**对象**而不是数组，所以两种形状都要认；
// 非字符串字段（极少见的数组/对象）直接丢掉，不让它们污染模型。
func parseStoreAppsJSON(raw []byte) ([]map[string]string, error) {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 {
		return nil, nil
	}
	var decoded any
	if err := json.Unmarshal(trimmed, &decoded); err != nil {
		return nil, err
	}

	var rows []map[string]any
	switch v := decoded.(type) {
	case []any:
		for _, item := range v {
			if m, ok := item.(map[string]any); ok {
				rows = append(rows, m)
			}
		}
	case map[string]any:
		rows = append(rows, v)
	default:
		return nil, nil
	}

	out := make([]map[string]string, 0, len(rows))
	for _, row := range rows {
		m := make(map[string]string, len(row))
		for k, val := range row {
			if s, ok := val.(string); ok {
				m[k] = s
			}
		}
		out = append(out, m)
	}
	return out, nil
}

// cnOf 从 X.509 风格的 Publisher 里取出 CN= 的值。
//
// 取不到就原样返回完整 DN：宁可让发布者显示得长一点，也不要显示成空 ——
// 空字符串会让详情页和导出表里凭空多出一个无名发布者。
func cnOf(publisher string) string {
	if publisher == "" {
		return ""
	}
	for _, part := range strings.Split(publisher, ",") {
		part = strings.TrimSpace(part)
		if v, ok := strings.CutPrefix(part, "CN="); ok {
			return strings.TrimSpace(v)
		}
	}
	return publisher
}
