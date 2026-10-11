// Package scanner 从注册表的 Uninstall 键枚举已安装软件。
//
// 对应原 Rust 的 src-tauri/src/registry_scanner.rs。数据源（全部读取后去重）：
//
//	HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall            (64 位视图)
//	HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall            (32 位视图)
//	HKCU\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall            (64 位视图)
//	HKCU\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall            (32 位视图)
//	可选：AppX / MSIX 商店应用（PowerShell Get-AppxPackage）
//
// 注意**两个视图都用未重定向的路径**打开，靠 WOW64 标志选视图。
// 如果路径里直接写 WOW6432Node，那只是 64 位注册表里给 32 位程序看的映射，
// 与 KEY_WOW64_32KEY 的语义不是一回事 —— Rust 版也是这样处理的。
//
// 这里只做读取；删除全部在 backup 包里。
package scanner

import (
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"unicode/utf16"

	"golang.org/x/sys/windows/registry"

	"duster/internal/model"
	"duster/internal/uninstaller"
	"duster/internal/winreg"
)

const (
	// UninstallSubkey 是未重定向的 64 位视图路径。
	UninstallSubkey = `SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall`
)

var guidRe = regexp.MustCompile(`\{[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}\}`)

// RawEntry 是一个 Uninstall 子键的原始值，全部转成字符串留给详情页
// 「原始注册表值」那一栏用。
type RawEntry struct {
	Values map[string]string
}

// Get 取一个值并去掉首尾空白；空串按「没有」处理（与 Rust 的
// `filter(|s| !s.is_empty())` 一致）。
func (e RawEntry) Get(name string) (string, bool) {
	v, ok := e.Values[name]
	if !ok {
		return "", false
	}
	v = strings.TrimSpace(v)
	if v == "" {
		return "", false
	}
	return v, true
}

// Dword 取一个 DWORD 形式的值。
func (e RawEntry) Dword(name string) (uint32, bool) {
	raw, ok := e.Values[name]
	if !ok {
		return 0, false
	}
	v, err := strconv.ParseUint(strings.TrimSpace(raw), 10, 32)
	if err != nil {
		return 0, false
	}
	return uint32(v), true
}

// ScanResultHolder 是 ScanAll 的返回值：去重后的列表 + 按 id 索引的原始值。
type ScanResultHolder struct {
	Apps []model.InstalledApp
	Raw  map[string]RawEntry
}

// ScanAll 扫描全部数据源，返回去重后的列表与原始值表。
//
// 失败是**软失败**：某个视图打不开（32 位视图在纯 64 位系统上可能不存在）
// 只跳过该视图，不影响其余结果 —— Rust 版用 `else { continue }` 同样处理。
func ScanAll(includeStore bool) ScanResultHolder {
	apps := make([]model.InstalledApp, 0, 512)
	raw := make(map[string]RawEntry, 512)

	type source struct {
		root  registry.Key
		view  winreg.View
		hive  model.Hive
		label string
	}
	// 四组：HKLM/HKCU × 64/32 位视图。路径统一用未重定向的那条。
	sources := []source{
		{registry.LOCAL_MACHINE, winreg.View64, model.HiveHKLM, "HKLM"},
		{registry.LOCAL_MACHINE, winreg.View32, model.HiveHKLM, "HKLM"},
		{registry.CURRENT_USER, winreg.View64, model.HiveHKCU, "HKCU"},
		{registry.CURRENT_USER, winreg.View32, model.HiveHKCU, "HKCU"},
	}

	for _, src := range sources {
		root, err := registry.OpenKey(src.root, UninstallSubkey, src.view.Flags()|accessRead)
		if err != nil {
			continue
		}
		names, err := winreg.SubKeyNames(root)
		if err != nil {
			root.Close()
			continue
		}
		for _, keyName := range names {
			sub, err := registry.OpenKey(src.root, UninstallSubkey+`\`+keyName, src.view.Flags()|accessRead)
			if err != nil {
				continue
			}
			entry := readEntry(sub)
			sub.Close()
			registryPath := src.label + `\` + UninstallSubkey + `\` + keyName
			if app, ok := BuildApp(keyName, registryPath, src.hive, viewRegistryName(src.view), entry); ok {
				raw[app.ID] = entry
				apps = append(apps, app)
			}
		}
		root.Close()
	}

	if includeStore {
		apps = append(apps, ScanStoreApps()...)
	}
	return ScanResultHolder{Apps: dedupe(apps), Raw: raw}
}

// accessRead 是 RegOpenKeyEx 的访问掩码：读值 + 枚举子键。
// 与 KEY_READ(0x20019) 等价，写成显式组合是为了让「只读」这件事在代码里可见。
const accessRead = registry.QUERY_VALUE | registry.ENUMERATE_SUB_KEYS | registry.NOTIFY

// readEntry 把一个键的全部值转成字符串。
func readEntry(k registry.Key) RawEntry {
	values := make(map[string]string, 16)
	raw, err := winreg.ReadValues(k)
	if err != nil {
		return RawEntry{Values: values}
	}
	for _, v := range raw {
		s, ok := regValueToString(v)
		if !ok {
			continue
		}
		name := v.Name
		if name == "" {
			// 匿名值在控制台里显示为「(Default)」，Rust 版也是这么改名的。
			name = "(Default)"
		}
		values[name] = s
	}
	return RawEntry{Values: values}
}

// regValueToString 把原始注册表值转成可读字符串。
//
// REG_BINARY 只取前 32 字节并转成十六进制 —— 详情页只是给人看一眼，
// 整块 dump 会把界面撑爆（Rust 版 same）。
func regValueToString(v winreg.Value) (string, bool) {
	switch v.Type {
	case registry.SZ, registry.EXPAND_SZ, registry.MULTI_SZ:
		units := bytesToUTF16Units(v.Bytes)
		s := string(utf16.Decode(units))
		s = strings.TrimRight(s, "\x00")
		// MULTI_SZ 用 NUL 分隔，Rust 版把内部分隔符换成 " | " 便于阅读。
		return strings.ReplaceAll(s, "\x00", " | "), true
	case registry.DWORD:
		if len(v.Bytes) < 4 {
			return "", false
		}
		return strconv.FormatUint(uint64(uint32(v.Bytes[0])|uint32(v.Bytes[1])<<8|
			uint32(v.Bytes[2])<<16|uint32(v.Bytes[3])<<24), 10), true
	case registry.QWORD:
		if len(v.Bytes) < 8 {
			return "", false
		}
		var n uint64
		for i := 7; i >= 0; i-- {
			n = n<<8 | uint64(v.Bytes[i])
		}
		return strconv.FormatUint(n, 10), true
	case registry.BINARY:
		limit := len(v.Bytes)
		if limit > 32 {
			limit = 32
		}
		parts := make([]string, 0, limit)
		for _, b := range v.Bytes[:limit] {
			parts = append(parts, hex2(b))
		}
		return strings.Join(parts, " "), true
	}
	return "", false
}

// BuildApp 从原始值构造类型化模型。没有 DisplayName 就跳过 ——
// 控制面板同样不显示这类条目。
func BuildApp(keyName, registryPath string, hive model.Hive, view model.RegistryView, e RawEntry) (model.InstalledApp, bool) {
	name, ok := e.Get("DisplayName")
	if !ok {
		return model.InstalledApp{}, false
	}

	isSystem := false
	if v, ok := e.Dword("SystemComponent"); ok && v == 1 {
		isSystem = true
	}
	releaseType := strings.ToLower(mustGet(e, "ReleaseType"))
	upperKey := strings.ToUpper(keyName)
	isUpdate := false
	if _, has := e.Get("ParentKeyName"); has {
		isUpdate = true
	}
	if strings.Contains(releaseType, "update") || strings.Contains(releaseType, "hotfix") {
		isUpdate = true
	}
	if strings.HasPrefix(upperKey, "KB") || strings.Contains(name, "(KB") {
		isUpdate = true
	}

	uninstallStr := expandOpt(e, "UninstallString")
	quietStr := expandOpt(e, "QuietUninstallString")
	isMSI := false
	if v, ok := e.Dword("WindowsInstaller"); ok && v == 1 {
		isMSI = true
	}
	if uninstallStr != nil && strings.Contains(strings.ToLower(*uninstallStr), "msiexec") {
		isMSI = true
	}

	// 产品代码优先取键名里的 GUID（MSI 安装的标准形态），
	// 否则从卸载命令里找；两者都没有时不要凭空造一个。
	msiCode := ""
	if m := guidRe.FindString(keyName); m != "" {
		msiCode = strings.ToUpper(m)
	} else if uninstallStr != nil {
		if m := guidRe.FindString(*uninstallStr); m != "" {
			msiCode = strings.ToUpper(m)
		}
	}

	kind := model.KindProgram
	switch {
	case isUpdate:
		kind = model.KindUpdate
	case isSystem:
		kind = model.KindSystem
	case strings.HasPrefix(keyName, "Steam App "):
		kind = model.KindGame
	case isMSI:
		kind = model.KindMSI
	}

	source := model.SourceRegistry
	switch {
	case strings.HasPrefix(keyName, "Steam App "):
		source = model.SourceSteam
	case isMSI:
		source = model.SourceMSI
	}

	app := model.InstalledApp{
		ID:           model.StableID(registryPath),
		Name:         name,
		InstallDate:  normaliseInstallDate(e),
		RegistryPath: registryPath,
		Hive:         hive,
		View:         view,
		Arch:         archFor(view),
		Kind:         kind,
		IsMSI:        isMSI,
		IsSystem:     isSystem,
		IsUpdate:     isUpdate,
		UninstallStr: uninstallStr,
		QuietStr:     quietStr,
		Source:       source,
	}

	if v, ok := e.Get("DisplayVersion"); ok {
		app.Version = model.Str(v)
	}
	if v, ok := e.Get("Publisher"); ok {
		app.Publisher = model.Str(v)
	}
	if v, ok := e.Dword("EstimatedSize"); ok && v > 0 {
		app.EstimatedKB = model.U32(v)
	}
	if v, ok := e.Get("InstallLocation"); ok {
		// 注册表里常见的两种脏写法：整体带引号、结尾多个反斜杠。
		cleaned := strings.TrimRight(strings.Trim(v, `"`), `\`)
		if cleaned != "" {
			app.InstallLoc = model.Str(cleaned)
		}
	}
	if v, ok := e.Get("DisplayIcon"); ok {
		app.DisplayIcon = model.Str(uninstaller.ExpandEnvironment(v))
	}
	if msiCode != "" {
		app.MSIProduct = model.Str(msiCode)
	}
	if v, ok := e.Get("HelpLink"); ok {
		app.HelpLink = model.Str(v)
	}
	if v, ok := e.Get("URLInfoAbout"); ok {
		app.AboutURL = model.Str(v)
	}
	if v, ok := e.Get("URLUpdateInfo"); ok {
		app.UpdateURL = model.Str(v)
	}
	return app, true
}

// archFor 从注册表视图推出架构。Win11/10 的 x64 上 64 位视图即 x64。
func archFor(view model.RegistryView) model.Architecture {
	if view == model.ViewX86 {
		return model.ArchX86
	}
	return model.ArchX64
}

// normaliseInstallDate 把 20240517 规范成 2024-05-18；
// 已经带横线或斜杠的写法也接受（先滤出数字再拼）。
func normaliseInstallDate(e RawEntry) *string {
	raw, ok := e.Get("InstallDate")
	if !ok {
		return nil
	}
	var digits strings.Builder
	for _, c := range raw {
		if c >= '0' && c <= '9' {
			digits.WriteRune(c)
		}
	}
	d := digits.String()
	if len(d) != 8 {
		return nil
	}
	return model.Str(d[0:4] + "-" + d[4:6] + "-" + d[6:8])
}

// dedupe 去掉多视图下的重复条目。
//
// 同一个产品可能同时出现在 WOW6432Node 与父键（注册表重定向所致）。
// 键 = 名称 + 版本 + 产品代码；保留信息更完整的那条。
func dedupe(apps []model.InstalledApp) []model.InstalledApp {
	type slot struct {
		app   model.InstalledApp
		score int
	}
	best := make(map[string]slot, len(apps))
	for _, app := range apps {
		version := ""
		if app.Version != nil {
			version = strings.ToLower(*app.Version)
		}
		identity := strings.ToLower(app.RegistryPath)
		if app.MSIProduct != nil {
			identity = strings.ToLower(*app.MSIProduct)
		}
		key := strings.ToLower(app.Name) + "|" + version + "|" + identity

		cur, exists := best[key]
		if exists && cur.score >= richness(app) {
			continue
		}
		best[key] = slot{app: app, score: richness(app)}
	}

	out := make([]model.InstalledApp, 0, len(best))
	for _, s := range best {
		out = append(out, s.app)
	}
	// 排序保证每次扫描的列表顺序稳定（map 迭代顺序是随机的）。
	sortByName(out)
	return out
}

// richness 给条目打分：有安装目录/体积/图标/静默卸载串的更「完整」。
func richness(a model.InstalledApp) int {
	n := 0
	for _, present := range []bool{
		a.InstallLoc != nil, a.EstimatedKB != nil, a.DisplayIcon != nil, a.QuietStr != nil,
	} {
		if present {
			n++
		}
	}
	return n
}

// ScanStoreApps 通过 PowerShell 枚举 Microsoft Store / UWP 应用。
//
// 用 PowerShell 而不是 WinRT 投影，是为了零 CGO、不引额外依赖。
// 任何失败都**静默吞掉**返回空：这个功能是可选的，绝不能拖垮主列表
// （Rust 版注释里明确写了这一点）。
func ScanStoreApps() []model.InstalledApp {
	const createNoWindow = 0x08000000
	const script = `Get-AppxPackage | Where-Object { -not $_.IsFramework -and -not $_.NonRemovable -and $_.SignatureKind -ne 'System' } | ` +
		`Select-Object Name, PackageFullName, PackageFamilyName, Publisher, Version, InstallLocation, Architecture | ConvertTo-Json -Compress`

	cmd := exec.Command("powershell.exe",
		"-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script)
	cmd.SysProcAttr = hiddenProcAttr()
	out, err := cmd.Output()
	if err != nil {
		return nil
	}
	items, err := parseStoreAppsJSON(out)
	if err != nil {
		return nil
	}

	apps := make([]model.InstalledApp, 0, len(items))
	for _, it := range items {
		full := it["PackageFullName"]
		if full == "" {
			continue
		}
		family := it["PackageFamilyName"]
		registryPath := `HKCU\SOFTWARE\Classes\Local Settings\Software\Microsoft\Windows\CurrentVersion\AppModel\Repository\Packages\` + full

		name := it["Name"]
		if name == "" {
			name = full
		}
		arch := model.ArchX64
		switch it["Architecture"] {
		case "X86", "0":
			arch = model.ArchX86
		case "Arm64", "12":
			arch = model.ArchArm64
		}

		app := model.InstalledApp{
			ID:           model.StableID(registryPath),
			Name:         name,
			RegistryPath: registryPath,
			Hive:         model.HiveHKCU,
			View:         model.ViewX64,
			Arch:         arch,
			Kind:         model.KindStore,
			Source:       model.SourceStore,
			// 商店应用的卸载走 Remove-AppxPackage；静默版多一个 -NonInteractive。
			UninstallStr: model.Str(`powershell.exe -NoProfile -Command "Remove-AppxPackage -Package '` + full + `'"`),
			QuietStr: model.Str(`powershell.exe -NoProfile -NonInteractive -Command "Remove-AppxPackage -Package '` +
				full + `'"`),
			PackageName: model.Str(full),
			AboutURL:    model.Str("ms-windows-store://pdp/?PFN=" + family),
			// Publisher 形如 "CN=Microsoft Corporation, O=..., C=US"，
			// 只取 CN= 后面那段（Rust 版 find_map(|part| part.strip_prefix("CN="))）。
			Publisher: model.Str(cnOf(it["Publisher"])),
		}
		if v := it["Version"]; v != "" {
			app.Version = model.Str(v)
		}
		if v := it["InstallLocation"]; v != "" {
			app.InstallLoc = model.Str(v)
		}
		// EstimatedSize 故意留空：遍历每个 WindowsApps 包要几分钟，
		// 首屏列表不能被它拖住（Rust 版同样留空并写了注释）。
		apps = append(apps, app)
	}
	return apps
}

// DirSize 递归求目录体积，带 20 万个条目的上限且不跟随符号链接/联接点。
//
// 两个限制都是必要的：跟着联接点走进用户目录会把体积算到天上，
// 而 WindowsApps 动辄几十万文件，不设上限会卡住界面。
func DirSize(path string) (uint64, error) {
	var total uint64
	stack := []string{path}
	visited := 0
	for len(stack) > 0 {
		dir := stack[len(stack)-1]
		stack = stack[:len(stack)-1]

		entries, err := os.ReadDir(dir)
		if err != nil {
			return total, err
		}
		for _, e := range entries {
			visited++
			if visited > 200_000 {
				return total, nil
			}
			full := filepath.Join(dir, e.Name())
			fi, err := os.Lstat(full) // Lstat：不跟随符号链接
			if err != nil {
				continue
			}
			if fi.Mode()&os.ModeSymlink != 0 {
				continue
			}
			if fi.IsDir() {
				stack = append(stack, full)
			} else {
				total += uint64(fi.Size())
			}
		}
	}
	return total, nil
}

// bytesToUTF16Units 把小端字节流解成 UTF-16 码元（奇数长度时丢弃尾字节）。
func bytesToUTF16Units(b []byte) []uint16 {
	n := len(b) / 2
	units := make([]uint16, n)
	for i := 0; i < n; i++ {
		units[i] = uint16(b[i*2]) | uint16(b[i*2+1])<<8
	}
	return units
}

// mustGet 取值并把「没有」折叠成空串，供 Contains 系列判断使用。
func mustGet(e RawEntry, name string) string {
	v, _ := e.Get(name)
	return v
}

// expandOpt 取值并展开环境变量变量；值缺失时返回 nil。
func expandOpt(e RawEntry, name string) *string {
	v, ok := e.Get(name)
	if !ok {
		return nil
	}
	return model.Str(uninstaller.ExpandEnvironment(v))
}

// hex2 是单字节的十六进制表示（两位小写）。
func hex2(b byte) string {
	const digits = "0123456789abcdef"
	return string([]byte{digits[b>>4], digits[b&0x0f]})
}
