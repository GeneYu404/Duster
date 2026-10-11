package leftovers

import (
	"os"
	"path/filepath"
	"strings"

	"duster/internal/model"
	"duster/internal/winreg"
)

// scanRegistry 阶段 2：注册表残留。
//
// 三类键：厂商/产品键、App Paths 与文件关联、MSI 产品键。
// 只有**确实存在**的键才会被记录 —— 报告一堆不存在的键会让用户
// 以为自己没清干净。
func scanRegistry(
	ctx ScanContext, c *collector,
	name, vendor string, hasVendor bool,
	locations *int,
) {
	if ctx.StillRegistered && ctx.App.RegistryPath != "" {
		c.add(model.CatRegistry, ctx.App.RegistryPath, nil, model.RiskSafe, "uninstallKey", true)
	}

	exeName := ""
	if ctx.App.DisplayIcon != nil {
		if exe, ok := ExeFromDisplayIcon(*ctx.App.DisplayIcon); ok {
			exeName = filepath.Base(exe)
		}
	}

	type keySpec struct {
		path string // 显示路径
		view winreg.View
		// reason 是机器可读的匹配原因，直接显示在 UI 上。
		reason string
	}

	var specs []keySpec
	if hasVendor && vendor != "" {
		specs = append(specs,
			keySpec{`HKCU\Software\` + vendor + `\` + name, winreg.View64, "publisherName"},
			keySpec{`HKLM\SOFTWARE\` + vendor + `\` + name, winreg.View64, "publisherName"},
			keySpec{`HKLM\SOFTWARE\` + vendor + `\` + name, winreg.View32, "publisherName"},
		)
	} else {
		specs = append(specs, keySpec{`HKCU\Software\` + name, winreg.View64, "publisherName"})
	}
	if exeName != "" {
		specs = append(specs,
			keySpec{`HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\` + exeName, winreg.View64, "appPaths"},
			keySpec{`HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\` + exeName, winreg.View32, "appPaths"},
			keySpec{`HKCU\Software\Classes\Applications\` + exeName, winreg.View64, "fileAssociation"},
		)
	}

	for _, spec := range specs {
		*locations++
		if !winreg.Exists(spec.path) {
			continue
		}
		c.add(model.CatRegistry, spec.path, nil, model.RiskSafe, spec.reason, true)
	}

	// MSI 产品键删错了会让「修复/卸载」菜单里的条目消失但文件还在，
	// 所以风险级别是 caution —— 用户能看见、能自己判断。
	if ctx.App.MSIProduct != nil && *ctx.App.MSIProduct != "" {
		packed := PackGUID(*ctx.App.MSIProduct)
		p := `HKLM\SOFTWARE\Classes\Installer\Products\` + packed
		*locations++
		if winreg.Exists(p) {
			c.add(model.CatRegistry, p, nil, model.RiskCaution, "msiProduct", true)
		}
	}
}

// scanShortcuts 阶段 3：开始菜单 / 桌面的快捷方式。
//
// 两种命中方式：
//   - 整个文件夹以产品名命名（开始菜单里很常见的「Adobe »」结构）；
//   - 散落的 .lnk，其目标指向安装目录。
func scanShortcuts(c *collector, name, installDir string, locations *int) {
	var dirs []string
	if a := envDir("APPDATA"); a != "" {
		dirs = append(dirs, filepath.Join(a, `Microsoft\Windows\Start Menu\Programs`))
	}
	if p := envDir("ProgramData"); p != "" {
		dirs = append(dirs, filepath.Join(p, `Microsoft\Windows\Start Menu\Programs`))
	}
	if u := envDir("USERPROFILE"); u != "" {
		dirs = append(dirs, filepath.Join(u, "Desktop"))
	}
	if pd := envDir("PUBLIC"); pd != "" {
		dirs = append(dirs, filepath.Join(pd, "Desktop"))
	}

	for _, dir := range dirs {
		*locations++
		folder := filepath.Join(dir, name)
		if isDir(folder) {
			c.addDir(folder, "shortcutTarget", model.RiskSafe)
		}
		if installDir == "" {
			continue
		}
		needle := norm(installDir)
		entries, err := os.ReadDir(dir)
		if err != nil {
			continue
		}
		for i, e := range entries {
			if i >= 2000 {
				break
			}
			full := filepath.Join(dir, e.Name())
			if !strings.EqualFold(filepath.Ext(full), ".lnk") {
				continue
			}
			if !lnkPointsInto(full, needle) {
				continue
			}
			var size *uint64
			if st, err := os.Lstat(full); err == nil {
				n := uint64(st.Size())
				size = &n
			}
			c.add(model.CatShortcut, full, size, model.RiskSafe, "shortcutTarget", true)
		}
	}
}

// lnkPointsInto 判断 .lnk 的目标是否落在 needle 目录里。
//
// 用「整份文件字节里找子串」这种粗暴办法，而不是解析 LNK 的
// IDList / LinkInfo 结构 —— 目标路径在 .lnk 里以 UTF-16 或 ANSI
// 明文出现，子串匹配足够可靠，且不会因为某个厂商写出畸形 LNK 而漏判。
// 误判风险由「必须同时匹配完整安装目录路径」来兜底。
func lnkPointsInto(lnkPath, needleLower string) bool {
	data, err := os.ReadFile(lnkPath)
	if err != nil {
		return false
	}
	if strings.Contains(strings.ToLower(string(data)), needleLower) {
		return true
	}
	return strings.Contains(strings.ToLower(utf16String(data)), needleLower)
}
