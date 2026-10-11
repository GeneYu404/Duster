// Package leftovers 找出安装程序留下的东西。
//
// 对应原 Rust 的 src-tauri/src/leftover_scanner.rs。**核心不变量**：
// 每一项候选都必须被「验证」过，绝不按名称通配就删：
//
//   - 安装目录本身（且不在受保护根下）；
//   - %ProgramData% / %APPDATA% / %LOCALAPPDATA% / %ProgramFiles%(x86) 下的
//     <厂商>\<产品名> 目录 —— 用规范化后的厂商名 + 产品名匹配；
//   - 注册表：HK(CU|LM)\Software[\WOW6432Node]\<厂商>\<产品名>、Uninstall 键本身、
//     App Paths\<exe>、MSI 的 Installer\Products\<打包 GUID>；
//   - 开始菜单 / 桌面上目标指向安装目录的 .lnk；
//   - ImagePath / 计划任务 Action 指向安装目录的服务与任务。
//
// 落在受保护根里的条目一律标 Risk=Protected 且永不删除。
package leftovers

import (
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"
	"unicode/utf16"

	"duster/internal/model"
	"duster/internal/scanner"
)

// sharedVendors 是「不能整目录删除」的共享厂商名。
//
// 命中它们时，<厂商> 目录被视为受保护：Microsoft / NVIDIA 这类厂商目录里
// 住着几十个不相关的产品，把整个目录删掉等于卸载半个系统。
var sharedVendors = []string{
	"microsoft", "google", "nvidia", "intel", "adobe",
	"apple", "valve", "oracle", "common files",
}

// ScanContext 是一次扫描的输入。
type ScanContext struct {
	App model.InstalledApp
	// StillRegistered 表示这个条目当前还在注册表里。
	// 已经卸载（键没了）的软件不把自己的 Uninstall 键算成残留。
	StillRegistered bool
}

// BaseName 是规范化的产品名：去掉括号片段、架构后缀与尾部版本号。
//
// 例：「Adobe Photoshop (x64) 23.5.1」→「Adobe Photoshop」。
// 去掉版本号是关键：安装目录常常带版本（…\Photoshop 23.5），
// 留着版本就永远匹配不上。
func BaseName(name string) string {
	s := name
	// 反复删掉成对的括号，直到没有为止（名字里可能有嵌套括号）。
	for {
		a := strings.Index(s, "(")
		b := strings.Index(s, ")")
		if a < 0 || b < 0 || b <= a {
			break
		}
		s = s[:a] + " " + s[b+1:]
	}

	lower := strings.ToLower(s)
	for _, tag := range []string{" x64", " x86", " 64-bit", " 32-bit", " amd64", " release"} {
		if i := strings.Index(lower, tag); i >= 0 {
			s = s[:i]
			break
		}
	}

	words := strings.Fields(s)
	keep := make([]string, 0, len(words))
	for _, w := range words {
		// 遇到「以数字或 v 开头且含数字」的词就停：那是版本号的起点。
		// 例：… 3.5.1、v2、2024。
		first := w[0]
		if (first >= '0' && first <= '9') || first == 'v' {
			if containsDigit(w) {
				break
			}
		}
		keep = append(keep, w)
	}
	if len(keep) == 0 {
		keep = words
	}
	return strings.TrimSpace(strings.Join(keep, " "))
}

// VendorName 是规范化厂商名：发布者的第一段，去掉法律后缀。
//
// 「Foo Software, Inc.」→ 「Foo」。法律后缀对目录名毫无信息量，
// 却会让 <厂商>\<产品> 的匹配全部落空。
func VendorName(publisher string) (string, bool) {
	if publisher == "" {
		return "", false
	}
	first, _, _ := strings.Cut(publisher, ",")
	first = strings.TrimSpace(first)

	legal := map[string]bool{
		"inc": true, "llc": true, "ltd": true, "gmbh": true, "corp": true,
		"corporation": true, "co": true, "s.r.o": true, "s.r.o.": true,
		"foundation": true, "team": true, "software": true,
	}
	kept := make([]string, 0, 4)
	for _, w := range strings.Fields(first) {
		key := strings.ToLower(strings.TrimRight(w, "."))
		if key == "s.r.o" {
			key = "s.r.o"
		}
		if !legal[key] {
			kept = append(kept, w)
		}
	}
	out := strings.TrimSpace(strings.Join(kept, " "))
	if out == "" {
		return "", false
	}
	return out, true
}

// ProtectedRoots 列出「绝不能删」的根目录。
func ProtectedRoots() []string {
	roots := make([]string, 0, 16)
	// SystemDrive 特殊处理：环境变量给的是 "C:"，要补上反斜杠才是 "C:\"。
	for _, v := range []string{"ProgramFiles", "ProgramFiles(x86)", "ProgramW6432",
		"ProgramData", "SystemRoot", "USERPROFILE", "APPDATA", "LOCALAPPDATA",
		"PUBLIC", "ALLUSERSPROFILE"} {
		if p := os.Getenv(v); p != "" {
			roots = append(roots, p)
		}
	}
	if drive := os.Getenv("SystemDrive"); drive != "" {
		roots = append(roots, drive+`\`)
		if st, err := os.Stat(filepath.Join(drive, "Users")); err == nil && st.IsDir() {
			roots = append(roots, filepath.Join(drive, "Users"))
		}
	}
	if pf := envDir("ProgramFiles"); pf != "" {
		roots = append(roots,
			filepath.Join(pf, "WindowsApps"),
			filepath.Join(pf, "Common Files"))
	}
	return roots
}

// IsProtected 报告一个路径是否落在受保护根内（或本身就是驱动器根）。
func IsProtected(path string) bool {
	n := norm(path)
	if len(n) <= 3 {
		return true // 驱动器根，如 "c:"
	}
	if windir := os.Getenv("SystemRoot"); windir != "" {
		root := norm(windir)
		if n == root || strings.HasPrefix(n, root+`\`) {
			return true
		}
	}
	if pf := envDir("ProgramFiles"); pf != "" {
		wa := norm(filepath.Join(pf, "WindowsApps"))
		if n == wa || strings.HasPrefix(n, wa+`\`) {
			return true
		}
	}
	for _, r := range ProtectedRoots() {
		if norm(r) == n {
			return true
		}
	}
	return false
}

// IsProtectedKey 报告一个注册表路径是否属于「无论扫描器怎么说都不许删」的清单。
//
// 这是删除路径上最硬的一道闸，判据与 Rust 版 backup_manager::is_protected_key 逐条对齐：
//   - 层级 < 3 的键（HKLM\SOFTWARE、HKCU\Software\Foo 这种）一律拒绝 ——
//     浅层键下面可能挂着别的软件的数据；
//   - Uninstall 根键本身、Windows NT、Control、Software\Classes 同理。
func IsProtectedKey(path string) bool {
	p := strings.ToLower(path)
	_, sub, _ := strings.Cut(p, `\`)
	depth := 0
	for _, s := range strings.Split(sub, `\`) {
		if s != "" {
			depth++
		}
	}
	switch {
	case depth < 3:
		return true
	case sub == `software\microsoft\windows\currentversion\uninstall`:
		return true
	case sub == `software\wow6432node\microsoft\windows\currentversion\uninstall`:
		return true
	case strings.HasPrefix(sub, `software\microsoft\windows nt`):
		return true
	case strings.HasPrefix(sub, `system\currentcontrolset\control`):
		return true
	case sub == `software\microsoft`:
		return true
	case sub == `software\classes`:
		return true
	}
	return false
}

// norm 归一化路径用于比较：去掉末尾分隔符并转小写。
func norm(p string) string {
	return strings.ToLower(strings.TrimRight(p, `\/`))
}

// envDir 读一个必须是目录的环境变量。
func envDir(name string) string {
	p := os.Getenv(name)
	if p == "" {
		return ""
	}
	if st, err := os.Stat(p); err != nil || !st.IsDir() {
		return ""
	}
	return p
}

// ExeFromDisplayIcon 从 DisplayIcon（"path,index"）里取出可执行文件路径。
//
// DisplayIcon 的形状很脏：可能带引号、可能没有扩展名、可能带 ,0 后缀、
// 也可能是 .dll / .ico。这里取**第一个**能识别的扩展名结束位置，
// 去掉后面的 ",0"。
func ExeFromDisplayIcon(displayIcon string) (string, bool) {
	s := strings.TrimSpace(displayIcon)
	s = strings.Trim(s, `"`)
	lower := strings.ToLower(s)
	end := -1
	for _, ext := range []string{".exe", ".dll", ".ico"} {
		if i := strings.Index(lower, ext); i >= 0 {
			if e := i + len(ext); end < 0 || e < end {
				end = e
			}
		}
	}
	if end < 0 {
		return "", false
	}
	return s[:end], true
}

// collector 累积扫描到的条目并按路径去重。
type collector struct {
	items []model.LeftoverItem
	seen  map[string]bool
	appID string
}

func newCollector(appID string) *collector {
	return &collector{seen: map[string]bool{}, appID: appID}
}

// add 记录一条残留。重复路径直接丢弃 —— 同一目录可能同时被
// 「安装目录」「厂商目录」「名称匹配」三条规则命中，重复展示会让用户困惑。
//
// defaultSelected 会被 risk 强制压成 false：受保护项即使用户勾了也不删。
func (c *collector) add(cat model.LeftoverCategory, path string, size *uint64, risk model.Risk, reason string, selected bool) {
	key := strings.ToLower(path)
	if c.seen[key] {
		return
	}
	c.seen[key] = true

	selected = selected && risk != model.RiskProtected
	c.items = append(c.items, model.LeftoverItem{
		ID:              c.appID + "-lo" + itoa(len(c.items)),
		Category:        cat,
		Path:            path,
		SizeBytes:       size,
		Risk:            risk,
		Reason:          reason,
		DefaultSelected: selected,
	})
}

// addDir 记录一个目录，安全检查更严：符号链接与受保护根一律降级为 Protected。
func (c *collector) addDir(dir, reason string, riskHint model.Risk) {
	st, err := os.Lstat(dir)
	if err != nil || !st.IsDir() {
		return
	}
	// 符号链接 / 联接点：删它可能删掉整个目标树，所以永远不自动选。
	if st.Mode()&os.ModeSymlink != 0 {
		c.add(model.CatFolder, dir, nil, model.RiskProtected, reason, false)
		return
	}
	if IsProtected(dir) {
		c.add(model.CatFolder, dir, nil, model.RiskProtected, reason, false)
		return
	}
	var size *uint64
	if n, err := scanner.DirSize(dir); err == nil {
		size = &n
	}
	c.add(model.CatFolder, dir, size, riskHint, reason, riskHint == model.RiskSafe)
}

// Scan 执行扫描，progress 逐阶段回调。
func Scan(ctx ScanContext, progress func(model.ScanProgress)) model.ScanResult {
	started := time.Now()
	app := ctx.App
	c := newCollector(app.ID)
	name := BaseName(app.Name)
	vendor, hasVendor := VendorName(deref(app.Publisher))
	vendorShared := false
	if hasVendor {
		v := strings.ToLower(vendor)
		for _, s := range sharedVendors {
			if strings.Contains(v, s) {
				vendorShared = true
				break
			}
		}
	}
	locations := 0

	/* ---------- 阶段 1：文件系统 ---------- */
	progress(model.ScanProgress{Phase: "files", Percent: 5})

	installDir := ""
	if app.InstallLoc != nil && *app.InstallLoc != "" {
		installDir = *app.InstallLoc
	} else if app.DisplayIcon != nil {
		if exe, ok := ExeFromDisplayIcon(*app.DisplayIcon); ok {
			installDir = filepath.Dir(exe)
		}
	}

	if installDir != "" {
		locations++
		c.addDir(installDir, "installDir", model.RiskSafe)
	}

	// 用户级根在前、机器级根在后：用户目录里的残留更可能是纯垃圾。
	userRoots := []string{envDir("APPDATA"), envDir("LOCALAPPDATA"), envDir("LOCALAPPDATA") + `\Programs`}
	machineRoots := []string{envDir("ProgramData"), envDir("ProgramFiles"), envDir("ProgramFiles(x86)")}
	for _, root := range append(append([]string{}, userRoots...), machineRoots...) {
		if root == "" {
			continue
		}
		locations++
		if hasVendor && vendor != "" {
			vendorDir := filepath.Join(root, vendor)
			productDir := filepath.Join(vendorDir, name)
			if isDir(productDir) {
				c.addDir(productDir, "publisherName", model.RiskSafe)
			}
			// 光秃秃的厂商目录只在「里面只有这一个产品」时才敢删。
			if isDir(vendorDir) && !vendorShared && onlyContains(vendorDir, name) {
				c.addDir(vendorDir, "publisherName", model.RiskSafe)
			} else if vendorShared && isDir(productDir) {
				c.add(model.CatFolder, vendorDir, nil, model.RiskProtected, "sharedVendorDir", false)
			}
		}
		direct := filepath.Join(root, name)
		if isDir(direct) && !samePath(direct, installDir) {
			c.addDir(direct, "nameMatch", model.RiskSafe)
		}
	}

	// TEMP 下按去空格后的产品名做子串匹配。这是唯一一处「按名字匹配」，
	// 限定在临时目录、最多看 5000 项、且要求至少 4 个字符 ——
	// 临时目录里的东西本来就是垃圾，且不进回收站也无所谓。
	if temp := envDir("TEMP"); temp != "" {
		needle := strings.ReplaceAll(strings.ToLower(name), " ", "")
		if len(needle) >= 4 {
			if entries, err := os.ReadDir(temp); err == nil {
				for i, e := range entries {
					if i >= 5000 {
						break
					}
					fname := strings.ReplaceAll(strings.ToLower(e.Name()), " ", "")
					if !strings.Contains(fname, needle) {
						continue
					}
					full := filepath.Join(temp, e.Name())
					st, err := os.Lstat(full)
					if err != nil || !st.Mode().IsRegular() {
						continue
					}
					size := uint64(st.Size())
					c.add(model.CatFile, full, &size, model.RiskSafe, "nameMatch", true)
				}
			}
		}
	}
	progress(model.ScanProgress{Phase: "files", Percent: 40, Found: len(c.items)})

	/* ---------- 阶段 2：注册表 ---------- */
	progress(model.ScanProgress{Phase: "registry", Percent: 45, Found: len(c.items)})
	scanRegistry(ctx, c, name, vendor, hasVendor, &locations)
	progress(model.ScanProgress{Phase: "registry", Percent: 70, Found: len(c.items)})

	/* ---------- 阶段 3：快捷方式 ---------- */
	progress(model.ScanProgress{Phase: "shortcuts", Percent: 75, Found: len(c.items)})
	scanShortcuts(c, name, installDir, &locations)
	progress(model.ScanProgress{Phase: "shortcuts", Percent: 85, Found: len(c.items)})

	/* ---------- 阶段 4：服务与计划任务 ---------- */
	progress(model.ScanProgress{Phase: "services", Percent: 88, Found: len(c.items)})
	scanServicesAndTasks(c, installDir, &locations)
	progress(model.ScanProgress{Phase: "services", Percent: 100, Found: len(c.items)})

	result := model.ScanResult{
		AppID:            app.ID,
		AppName:          app.Name,
		Items:            c.items,
		DurationMS:       uint64(time.Since(started).Milliseconds()),
		ScannedLocations: locations,
	}
	return result
}

// onlyContains 报告 dir 里是否至多只有一项，且名字等于 name。
func onlyContains(dir, name string) bool {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return false
	}
	if len(entries) > 1 {
		return false
	}
	for _, e := range entries {
		if !strings.EqualFold(e.Name(), name) {
			return false
		}
	}
	return true
}

// isDir 是 os.Stat 的 IsDir 短路版，找不到就当不存在。
func isDir(p string) bool {
	st, err := os.Stat(p)
	return err == nil && st.IsDir()
}

// samePath 比较两个路径是否指向同一目录（大小写不敏感）。
func samePath(a, b string) bool {
	if b == "" {
		return false
	}
	return strings.EqualFold(norm(a), norm(b))
}

// deref 解引用可选字符串。
func deref(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}

// PackGUID 把 Windows Installer 的「打包 GUID」算法实现出来：
// 去掉花括号与横线后，按 8-4-4-4-12 的分组**逐组倒序**拼接。
//
// 例：{8A69D345-D564-463C-AFF1-A69D9E530F96}
//
//	→ 543D9 6A8 → "543D96A8" + "465D" + "3646" + "1AFF" + "695E9E035F69"
//
// 得到的字符串正是 HKLM\SOFTWARE\Classes\Installer\Products 下的键名。
//
// 算法来自 Windows Installer 自己（msi.dll 反向工程出的公开算法），
// Rust 版 pack_guid 完全一致。不对的话 MSI 残留就一个都找不到。
func PackGUID(guid string) string {
	var hexed strings.Builder
	for _, c := range guid {
		if isHexDigit(c) {
			hexed.WriteRune(c)
		}
	}
	g := hexed.String()
	if len(g) != 32 {
		return g
	}
	var out strings.Builder
	out.WriteString(reverse(g[0:8]))
	out.WriteString(reverse(g[8:12]))
	out.WriteString(reverse(g[12:16]))
	for i := 16; i < 32; i += 2 {
		out.WriteString(reverse(g[i : i+2]))
	}
	return out.String()
}

// reverse 反转一个 ASCII 串。
func reverse(s string) string {
	b := []byte(s)
	for i, j := 0, len(b)-1; i < j; i, j = i+1, j-1 {
		b[i], b[j] = b[j], b[i]
	}
	return string(b)
}

// isHexDigit 报告 c 是否是十六进制数字（ASCII）。
func isHexDigit(c rune) bool {
	return (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F')
}

// containsDigit 报告 s 里是否含 ASCII 数字。
func containsDigit(s string) bool {
	for _, c := range s {
		if c >= '0' && c <= '9' {
			return true
		}
	}
	return false
}

// utf16String 把字节流按 UTF-16LE 解码，容忍奇数长度（丢掉尾字节）。
//
// .lnk 文件里目标路径以 UTF-16 或 ANSI 存放，两种都要试（Rust 版 same）。
func utf16String(b []byte) string {
	n := len(b) / 2
	units := make([]uint16, n)
	for i := 0; i < n; i++ {
		units[i] = uint16(b[i*2]) | uint16(b[i*2+1])<<8
	}
	return string(utf16.Decode(units))
}

// itoa 是 strconv.Itoa 的短别名（这个文件里到处都要转数字下标）。
func itoa(n int) string { return strconv.Itoa(n) }

// sortStrings 排序辅助（服务名排序用，保证输出稳定）。
func sortStrings(s []string) { sort.Strings(s) }
