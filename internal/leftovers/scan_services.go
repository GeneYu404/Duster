package leftovers

import (
	"os"
	"path/filepath"
	"strings"

	"golang.org/x/sys/windows/registry"

	"duster/internal/model"
	"duster/internal/winreg"
)

// servicesKey 是服务注册表位置。
const servicesKey = `HKLM\SYSTEM\CurrentControlSet\Services`

// scanServicesAndTasks 阶段 4：服务与计划任务。
//
// 两条规则都要求「路径里出现完整的安装目录」：服务的 ImagePath 与
// 计划任务文件里的 Action 串。共享的 svchost.exe 之类不会命中，
// 因为它们的 ImagePath 里不含本软件的安装目录。
func scanServicesAndTasks(c *collector, installDir string, locations *int) {
	if installDir == "" {
		return
	}
	needle := norm(installDir)

	*locations++
	services, err := winreg.OpenPath(servicesKey, registry.QUERY_VALUE|registry.ENUMERATE_SUB_KEYS)
	if err != nil {
		services = registry.Key(0)
	} else {
		defer services.Close()
	}
	if services != registry.Key(0) {
		if names, err := winreg.SubKeyNames(services); err == nil {
			// 排序保证同一台机器上每次扫描的结果顺序一致，
			// 否则 UI 里服务列表会每次刷新都重排。
			sortStrings(names)
			for _, svc := range names {
				sub, err := registry.OpenKey(services, svc, registry.QUERY_VALUE)
				if err != nil {
					continue
				}
				v, err := winreg.ReadValue(sub, "ImagePath")
				sub.Close()
				if err != nil {
					continue
				}
				image, ok := regValueText(v)
				if !ok {
					continue
				}
				if !strings.Contains(strings.ToLower(image), needle) {
					continue
				}
				// caution：服务可能正被别的进程依赖，误删会留下半死的依赖链。
				c.add(model.CatService, servicesKey+`\`+svc, nil, model.RiskCaution, "serviceImagePath", true)
			}
		}
	}

	if root := envDir("SystemRoot"); root != "" {
		taskRoot := filepath.Join(root, `System32\Tasks`)
		if isDir(taskRoot) {
			*locations++
			walkTasks(taskRoot, needle, c, 0)
		}
	}
}

// walkTasks 在计划任务目录里递归找「内容包含安装目录」的任务文件。
//
// 深度上限 4：Task Scheduler 的实际层级远浅于此，设上限是为了防
// 目录里有异常深的结构把扫描拖住。
func walkTasks(dir, needle string, c *collector, depth int) {
	if depth > 4 {
		return
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		return
	}
	for _, e := range entries {
		full := filepath.Join(dir, e.Name())
		if e.IsDir() {
			walkTasks(full, needle, c, depth+1)
			continue
		}
		data, err := os.ReadFile(full)
		if err != nil {
			continue
		}
		hit := strings.Contains(strings.ToLower(utf16String(data)), needle) ||
			strings.Contains(strings.ToLower(string(data)), needle)
		if !hit {
			continue
		}
		// caution：计划任务可能被别的产品共用。
		c.add(model.CatTask, full, nil, model.RiskCaution, "taskAction", true)
	}
}

// regValueText 把注册表值解成字符串（只处理字符串类类型）。
func regValueText(v winreg.Value) (string, bool) {
	switch v.Type {
	case registry.SZ, registry.EXPAND_SZ:
		return utf16String(v.Bytes), true
	case registry.MULTI_SZ:
		return strings.ReplaceAll(utf16String(v.Bytes), "\x00", " | "), true
	}
	return "", false
}

// ForceRemoveKeys 列出「强制删除」时应当一并清掉的注册表键。
//
// 与残留扫描的规则同源（厂商/产品键、App Paths、文件关联、MSI 产品键），
// 但**不做存在性检查** —— 强制删除要的是「该删的都删掉」，
// 而扫描结果只报告实际存在的键。
func ForceRemoveKeys(app model.InstalledApp) []string {
	keys := make([]string, 0, 8)
	if app.RegistryPath != "" {
		keys = append(keys, app.RegistryPath)
	}
	name := BaseName(app.Name)
	vendor, hasVendor := VendorName(deref(app.Publisher))
	if hasVendor {
		keys = append(keys,
			`HKCU\Software\`+vendor+`\`+name,
			`HKLM\SOFTWARE\`+vendor+`\`+name,
			`HKLM\SOFTWARE\WOW6432Node\`+vendor+`\`+name,
		)
	} else {
		keys = append(keys, `HKCU\Software\`+name)
	}

	if app.DisplayIcon != nil {
		if exe, ok := ExeFromDisplayIcon(*app.DisplayIcon); ok {
			stem := strings.TrimSuffix(filepath.Base(exe), filepath.Ext(exe))
			if stem != "" {
				keys = append(keys,
					`HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\`+stem+".exe",
					`HKLM\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\App Paths\`+stem+".exe",
					`HKCU\Software\Classes\Applications\`+stem+".exe",
				)
			}
		}
	}
	if app.MSIProduct != nil && *app.MSIProduct != "" {
		keys = append(keys,
			`HKLM\SOFTWARE\Classes\Installer\Products\`+PackGUID(*app.MSIProduct))
	}
	return keys
}
