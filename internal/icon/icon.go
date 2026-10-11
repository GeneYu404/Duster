// Package icon 提取程序图标并返回 PNG data URL。
//
// 对应原 Rust 的 src-tauri/src/icon_extractor.rs。取值顺序：
// DisplayIcon 指向的可执行文件 → 安装目录下名字像产品名的 exe（最多 3 个）。
//
// 懒加载：图标由命令层按 app id 缓存，列表渲染不触发提取，
// 否则几百个条目各抽一次图标会让首屏慢到不可用。
package icon

import (
	"encoding/base64"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"duster/internal/leftovers"
	"duster/internal/model"
)

// Candidates 返回按优先级排序的 (路径, 图标索引) 候选列表。
func Candidates(app model.InstalledApp) [][2]any {
	type cand struct {
		path  string
		index int32
	}
	var out []cand

	if app.DisplayIcon != nil && *app.DisplayIcon != "" {
		icon := *app.DisplayIcon
		// "path,3" 里的 3 是图标索引；没有逗号就是 0。
		index := int32(0)
		if i := strings.LastIndex(icon, ","); i >= 0 {
			if n, err := parseInt32(strings.TrimSpace(icon[i+1:])); err == nil {
				index = n
			}
		}
		if exe, ok := leftovers.ExeFromDisplayIcon(icon); ok {
			out = append(out, cand{exe, index})
		}
	}

	if app.InstallLoc != nil && *app.InstallLoc != "" {
		dir := *app.InstallLoc
		if entries, err := os.ReadDir(dir); err == nil {
			var exes []string
			for _, e := range entries {
				if strings.EqualFold(filepath.Ext(e.Name()), ".exe") {
					exes = append(exes, filepath.Join(dir, e.Name()))
				}
			}
			name := strings.ToLower(app.Name)
			// 排序键：先「像不像卸载器」，再「像不像产品名」。
			// 反过来排会让 unins000.exe 排在 Foo.exe 前面，
			// 于是列表里全是卸载器的图标。
			sort.SliceStable(exes, func(i, j int) bool {
				return exeRank(exes[i], name) < exeRank(exes[j], name)
			})
			for i, e := range exes {
				if i >= 3 {
					break
				}
				out = append(out, cand{e, 0})
			}
		}
	}

	res := make([][2]any, 0, len(out))
	for _, c := range out {
		res = append(res, [2]any{c.path, c.index})
	}
	return res
}

// exeRank 给候选 exe 排序打分（越小越优先）。
func exeRank(path, appNameLower string) int {
	stem := strings.ToLower(strings.TrimSuffix(filepath.Base(path), filepath.Ext(path)))
	rank := 0
	if strings.Contains(stem, "unins") || strings.Contains(stem, "setup") {
		rank += 2
	}
	if !strings.Contains(appNameLower, stem) {
		rank++
	}
	return rank
}

// parseInt32 解析一个 int32（不引 strconv 以免与调用点混淆）。
func parseInt32(s string) (int32, error) {
	if s == "" {
		return 0, errBadIndex
	}
	var n int32
	neg := false
	for i, c := range s {
		if i == 0 && (c == '-' || c == '+') {
			neg = c == '-'
			continue
		}
		if c < '0' || c > '9' {
			return 0, errBadIndex
		}
		n = n*10 + int32(c-'0')
	}
	if neg {
		n = -n
	}
	return n, nil
}

// PNGDataURL 把 PNG 字节包成 data URL。
func PNGDataURL(png []byte) string {
	return "data:image/png;base64," + base64.StdEncoding.EncodeToString(png)
}
