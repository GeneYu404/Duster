// Package service 是绑定给前端的服务层：一个导出方法对应一个原 Tauri command。
//
// MyGo 按 Go 类型名给 JS 客户端命名，所以页面里调的是 `Duster.listInstalledApps(...)`。
// 调用方（App.tsx / 各 dialog）看不到本文件的存在 —— 对外契约由
// src/ipc/backend.ts 的 Backend 接口与 src/ipc/commands.ts 的桥接层保持不变。
//
// 命名约定：Rust 的 list_installed_apps → Go 的 ListInstalledApps →
// JS 的 Duster.listInstalledApps。
package service

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/egoist/mygo"

	"duster/internal/apperr"
	"duster/internal/appstate"
	"duster/internal/backup"
	"duster/internal/exporter"
	"duster/internal/icon"
	"duster/internal/leftovers"
	"duster/internal/model"
	"duster/internal/uninstaller"
	"duster/internal/winos"
)

// 事件名。MyGo 的事件是单向的（只有 Go → JS），所以前端要往别的窗口发消息
// 必须绕回绑定方法由 Go 代发；Duster 只有一个窗口，暂时用不到。
const (
	EventUninstallLog = "duster://uninstall-log"
	EventScanProgress = "duster://scan-progress"
	EventForceProgres = "duster://force-progress"
)

// 载荷信封：事件里带上 appId，前端据此把并发调用的进度分开。
type envelope[T any] struct {
	AppID   string `json:"appId"`
	Payload T      `json:"payload"`
}

var (
	uninstallLogEvent = mygo.NewEvent[envelope[string]]("uninstall-log")
	scanProgressEvent = mygo.NewEvent[envelope[model.ScanProgress]]("scan-progress")
	forceProgressEvt  = mygo.NewEvent[envelope[forceProgress]]("force-progress")
)

// forceProgress 是强制删除过程中的进度载荷。
type forceProgress struct {
	AppID    string `json:"appId"`
	Phase    string `json:"phase"`
	Percent  uint8  `json:"percent"`
	Deleted  int    `json:"deleted"`
	Recycled int    `json:"recycled"`
}

// Duster 是被 MyGo 绑定的服务。
type Duster struct {
	state *appstate.State
}

// New 建服务。
func New() *Duster { return &Duster{state: appstate.New(appstate.LoadSettings())} }

/* ---------------- 列表 ---------------- */

// ListInstalledApps 扫描注册表并返回列表。
func (d *Duster) ListInstalledApps(opts model.ListOptions) ([]model.InstalledApp, error) {
	apps := d.state.Rescan(opts)
	if apps == nil {
		// 前端把 nil 当空数组用，返回空切片更省心。
		return []model.InstalledApp{}, nil
	}
	return apps, nil
}

// RefreshApps 与 ListInstalledApps 同义：两套 UI 语义不同，但后端行为一致。
func (d *Duster) RefreshApps(opts model.ListOptions) ([]model.InstalledApp, error) {
	return d.ListInstalledApps(opts)
}

// GetAppDetail 返回条目详情（安装目录是否存在、规范化命令、原始注册表值）。
func (d *Duster) GetAppDetail(appID string) (model.AppDetail, error) {
	app, ok := d.state.Find(appID)
	if !ok {
		return model.AppDetail{}, apperr.AppNotFound(appID)
	}
	raw := d.state.Raw(appID)

	var parsed *model.ParsedCommand
	if app.UninstallStr != nil {
		if p, err := uninstaller.ParseCommand(*app.UninstallStr, false); err == nil {
			parsed = &p
		}
	}

	// uninstallerExists 的判定：绝对路径必须在磁盘上存在；
	// 裸名（msiexec.exe）交给 PATH 判断（Rust 版同理）。
	uninstallerExists := false
	if parsed != nil {
		if filepath.IsAbs(parsed.Program) {
			if st, err := os.Stat(parsed.Program); err == nil && !st.IsDir() {
				uninstallerExists = true
			}
		} else {
			uninstallerExists = uninstaller.ProgramExists(parsed.Program)
		}
	}

	installLocExists := false
	if app.InstallLoc != nil {
		if st, err := os.Stat(*app.InstallLoc); err == nil && st.IsDir() {
			installLocExists = true
		}
	}

	var executable *string
	if app.DisplayIcon != nil {
		if exe, ok := leftovers.ExeFromDisplayIcon(*app.DisplayIcon); ok {
			executable = model.Str(exe)
		}
	}

	values := raw.Values
	if values == nil {
		values = map[string]string{}
	}
	return model.AppDetail{
		InstalledApp:      app,
		ExecutablePath:    executable,
		InstallLocExists:  installLocExists,
		UninstallerExists: uninstallerExists,
		Parsed:            parsed,
		ModifyPath:        optFrom(values, "ModifyPath"),
		Comments:          optFrom(values, "Comments"),
		Contact:           optFrom(values, "Contact"),
		Language:          optFrom(values, "Language"),
		RegistryValues:    values,
	}, nil
}

// optFrom 从原始值表里取一个可选字符串。
func optFrom(values map[string]string, key string) *string {
	if v, ok := values[key]; ok && v != "" {
		return model.Str(v)
	}
	return nil
}

// GetAppIcon 返回 PNG data URL；取不到返回空串（前端回退到字母色块）。
func (d *Duster) GetAppIcon(appID string) (string, error) {
	if cached, ok := d.state.Icon(appID); ok {
		return cached, nil
	}
	app, ok := d.state.Find(appID)
	if !ok {
		return "", apperr.AppNotFound(appID)
	}
	dataURL := icon.ExtractPNGDataURL(app)
	// 连「取不到」也缓存：否则虚拟表格滚动时会对同一个条目反复重试。
	d.state.PutIcon(appID, dataURL)
	return dataURL, nil
}

/* ---------------- 卸载 ---------------- */

// UninstallArgs 是卸载命令的入参。
type UninstallArgs = model.UninstallArgs

// UninstallApp 执行卸载器，把日志逐行推给前端。
func (d *Duster) UninstallApp(args UninstallArgs) (model.UninstallResult, error) {
	app, ok := d.state.Find(args.AppID)
	if !ok {
		return model.UninstallResult{}, apperr.AppNotFound(args.AppID)
	}
	// 系统组件与更新条目一律拒绝：它们不是用户装的，卸掉会破坏系统更新链。
	if app.IsSystem || app.IsUpdate {
		return model.UninstallResult{}, apperr.ProtectedPath("refusing to uninstall system component/update " + app.Name)
	}

	elevated := winos.IsElevated()
	result, err := uninstaller.Run(app, args.Quiet, elevated, func(line string) {
		_ = uninstallLogEvent.Broadcast(envelope[string]{AppID: app.ID, Payload: line})
	})
	if err != nil {
		return model.UninstallResult{}, err
	}

	level := "warn"
	if result.Success {
		level = "info"
	}
	d.state.PushLog(level, fmt.Sprintf("Uninstall %s: %s", args.AppID, result.Message))
	if result.Success {
		d.state.Archive(args.AppID)
	}
	return result, nil
}

/* ---------------- 残留 ---------------- */

// ScanLeftovers 扫描某个条目的残留（只读，绝不删除）。
func (d *Duster) ScanLeftovers(appID string) (model.ScanResult, error) {
	if !d.state.Settings().EnableLeftoverScan {
		return model.ScanResult{}, apperr.Other("leftover scanning is disabled in settings")
	}
	app, ok := d.state.Find(appID)
	if !ok {
		return model.ScanResult{}, apperr.AppNotFound(appID)
	}
	return d.runScan(app, d.state.Contains(appID))
}

// ForceUninstallApp 是「强制删除」的**预览**阶段。
//
// 关键约束（AGENTS.md §7）：绝不调用软件自带的卸载程序，只做只读扫描。
// 用户在最终确认框点「取消」时，软件与文件必须原封不动。
func (d *Duster) ForceUninstallApp(appID string) (model.ScanResult, error) {
	app, ok := d.state.Find(appID)
	if !ok {
		return model.ScanResult{}, apperr.AppNotFound(appID)
	}
	if app.IsSystem || app.IsUpdate {
		return model.ScanResult{}, apperr.ProtectedPath("refusing force removal of " + app.Name)
	}
	if app.InstallLoc == nil && app.RegistryPath == "" {
		return model.ScanResult{}, apperr.Other("no install directory or Uninstall key for " + app.Name)
	}
	if !d.state.Settings().EnableLeftoverScan {
		return model.ScanResult{}, apperr.Other("leftover scanning is disabled in settings")
	}
	return d.runScan(app, true)
}

// runScan 跑一次残留扫描并把结果缓存下来。
func (d *Duster) runScan(app model.InstalledApp, stillRegistered bool) (model.ScanResult, error) {
	ctx := leftovers.ScanContext{App: app, StillRegistered: stillRegistered}
	result := leftovers.Scan(ctx, func(p model.ScanProgress) {
		_ = scanProgressEvent.Broadcast(envelope[model.ScanProgress]{AppID: app.ID, Payload: p})
	})
	d.state.PushLog("info", fmt.Sprintf("Leftover scan %s: %d items", app.Name, len(result.Items)))
	d.state.PutScan(app.ID, result)
	return result, nil
}

// DeleteLeftoversArgs 是删除残留的入参。
type DeleteLeftoversArgs = model.DeleteLeftoversArgs

// DeleteLeftovers 删除选中的残留。
//
// **只接受上一次缓存的扫描结果里的 id**，前端传来的路径一律不认。
// 这样即使前端被注入了一个任意路径，也无法删到扫描之外的东西。
// 受保护项（Risk=Protected）在这里被硬过滤掉。
func (d *Duster) DeleteLeftovers(args DeleteLeftoversArgs) (model.DeleteLeftoversResult, error) {
	app, ok := d.state.Find(args.AppID)
	if !ok {
		return model.DeleteLeftoversResult{}, apperr.AppNotFound(args.AppID)
	}
	if app.IsSystem || app.IsUpdate {
		return model.DeleteLeftoversResult{}, apperr.ProtectedPath("refusing to delete leftovers of system component/update " + app.Name)
	}
	scan, ok := d.state.Scan(args.AppID)
	if !ok {
		return model.DeleteLeftoversResult{}, apperr.Other("no scan result cached; run a scan first")
	}

	wanted := make(map[string]bool, len(args.ItemIDs))
	for _, id := range args.ItemIDs {
		wanted[id] = true
	}
	items := make([]model.LeftoverItem, 0, len(args.ItemIDs))
	for _, it := range scan.Items {
		if wanted[it.ID] && it.Risk != model.RiskProtected {
			items = append(items, it)
		}
	}

	result, err := backup.DeleteLeftovers(d.state.BackupDir(), app.ID, app.Name, items,
		d.state.Settings().UseRecycleBin)
	if err != nil {
		return model.DeleteLeftoversResult{}, err
	}

	// Uninstall 键被删掉了 → 这个条目从列表里归档（详情仍然能看）。
	deletedSet := make(map[string]bool, len(result.Deleted))
	for _, id := range result.Deleted {
		deletedSet[id] = true
	}
	for _, it := range items {
		if strings.EqualFold(it.Path, app.RegistryPath) && deletedSet[it.ID] {
			d.state.Archive(app.ID)
			break
		}
	}
	d.state.PushLog("warn", fmt.Sprintf("Deleted %d leftovers of %s (%d failed, %d recycled)",
		len(result.Deleted), app.Name, len(result.Failed), result.Recycled))
	return result, nil
}

// DeleteAppEntry 只删 Uninstall 注册表键（条目从列表消失，文件保留）。
func (d *Duster) DeleteAppEntry(appID string) (model.BackupInfo, error) {
	app, ok := d.state.Find(appID)
	if !ok {
		return model.BackupInfo{}, apperr.AppNotFound(appID)
	}
	if app.Kind == model.KindStore || app.IsSystem || app.IsUpdate {
		return model.BackupInfo{}, apperr.ProtectedPath("refusing to remove the installed-list entry for " + app.Name)
	}
	// 先备份成功才删：备份失败必须中止，不能「先删了再说」。
	info, err := backup.BackupKeys(d.state.BackupDir(), app.ID, app.Name,
		model.BackupRegistry, []string{app.RegistryPath})
	if err != nil {
		return model.BackupInfo{}, err
	}
	if err := backup.DeleteKey(app.RegistryPath); err != nil {
		return model.BackupInfo{}, err
	}
	d.state.Archive(appID)
	d.state.PushLog("warn", "Deleted registry entry "+app.RegistryPath+" (backup "+info.Path+")")
	return info, nil
}

/* ---------------- 打开外部程序 ---------------- */

// OpenInstallLocation 用资源管理器打开安装目录。
func (d *Duster) OpenInstallLocation(appID string) error {
	app, ok := d.state.Find(appID)
	if !ok {
		return apperr.AppNotFound(appID)
	}
	if app.InstallLoc == nil || *app.InstallLoc == "" {
		return apperr.PathNotFound("no install location")
	}
	loc := *app.InstallLoc
	if st, err := os.Stat(loc); err != nil || !st.IsDir() {
		return apperr.PathNotFound(loc)
	}
	return runHidden("explorer.exe", loc)
}

// RevealPath 在资源管理器里定位并选中一个路径。
func (d *Duster) RevealPath(path string) error {
	if _, err := os.Stat(path); err != nil {
		return apperr.PathNotFound(path)
	}
	return runHidden("explorer.exe", "/select,"+path)
}

// OpenRegistryKey 打开 regedit 并定位到指定键。
//
// 手法是给 regedit 的 LastKey 写值再启动它 —— regedit 只认这个值，
// 没有「命令行传路径」的官方方式（Rust 版 same）。
func (d *Duster) OpenRegistryKey(path string) error {
	full := strings.Replace(path, `HKLM\`, `HKEY_LOCAL_MACHINE\`, 1)
	full = strings.Replace(full, `HKCU\`, `HKEY_CURRENT_USER\`, 1)
	if err := setRegeditLastKey(full); err != nil {
		return err
	}
	return runHidden("regedit.exe", "/m")
}

// OpenExternal 用系统默认程序打开一个 URL。
//
// 协议白名单是硬约束：这个方法的前端调用点会渲染注册表里的
// HelpLink / URLInfoAbout，那些值来自第三方安装包，等同于用户输入。
func (d *Duster) OpenExternal(url string) error {
	trimmed := strings.TrimSpace(url)
	lower := strings.ToLower(trimmed)
	allowed := []string{"https://", "http://", "mailto:", "tel:", "ms-windows-store://"}
	ok := trimmed != "" && len(trimmed) <= 4096
	for _, r := range trimmed {
		if r < 0x20 || r == 0x7f {
			ok = false
			break
		}
	}
	if ok {
		matched := false
		for _, scheme := range allowed {
			if strings.HasPrefix(lower, scheme) {
				matched = true
				break
			}
		}
		ok = matched
	}
	if !ok {
		return apperr.InvalidCommand("unsupported external URL scheme")
	}
	if err := mygo.Shell.OpenExternal(trimmed); err != nil {
		return apperr.Other("could not open URL: " + err.Error())
	}
	return nil
}

// PickBackupDir 弹目录选择框（设置页的「…」按钮）。
// 用户取消返回空串。
func (d *Duster) PickBackupDir(defaultPath string) (string, error) {
	paths, err := mygo.Dialog.Open(mygo.OpenDialogOptions{
		Title:       "选择备份目录",
		DefaultPath: defaultPath,
		Directory:   true,
		Multiple:    false,
	})
	if err != nil || len(paths) == 0 {
		return "", nil
	}
	return paths[0], nil
}

// PickExportPath 弹「另存为」对话框，返回用户选定的完整路径。
func (d *Duster) PickExportPath(suggestedName string) (string, error) {
	return mygo.Dialog.Save(mygo.SaveDialogOptions{
		Title:       "导出软件列表",
		DefaultPath: suggestedName,
		Filters:     []mygo.FileFilter{{Name: "导出文件", Extensions: []string{"csv", "json", "html"}}},
	})
}

/* ---------------- 导出 ---------------- */

// ExportApps 导出列表。path 非空时后端落盘，否则把内容原样返回。
func (d *Duster) ExportApps(req model.ExportRequest) (model.ExportResult, error) {
	all := d.state.Apps()
	selected := all
	if req.AppIDs != nil {
		wanted := make(map[string]bool, len(req.AppIDs))
		for _, id := range req.AppIDs {
			wanted[id] = true
		}
		selected = make([]model.InstalledApp, 0, len(req.AppIDs))
		for _, a := range all {
			if wanted[a.ID] {
				selected = append(selected, a)
			}
		}
	}

	content := exporter.Build(selected, req.Format, req.Fields, req.Labels)
	fileName := exporter.FileName(req.Format, time.Now())

	var pathPtr, contentPtr *string
	if req.Path != nil && *req.Path != "" {
		if err := os.WriteFile(*req.Path, []byte(content), 0o644); err != nil {
			return model.ExportResult{}, apperr.IO(err)
		}
		pathPtr = model.Str(*req.Path)
	} else {
		contentPtr = model.Str(content)
	}

	d.state.PushLog("info", fmt.Sprintf("Exported %d entries", len(selected)))
	return model.ExportResult{
		FileName: fileName,
		Path:     pathPtr,
		Content:  contentPtr,
		MimeType: exporter.Mime(req.Format),
		Count:    len(selected),
	}, nil
}

/* ---------------- 提权 ---------------- */

// IsAdmin 返回当前提权状态。
func (d *Duster) IsAdmin() model.PrivilegeInfo {
	return model.PrivilegeInfo{IsAdmin: winos.IsElevated(), CanElevate: winos.CanElevate()}
}

// RequestElevation 以 runas 重启自身。
//
// 成功时**当前进程直接退出**，由提权后的实例接管 —— 这是唯一一处
// 「重启自己」的场景（卸载/删条目都走窄范围提权助手，不重启 UI）。
func (d *Duster) RequestElevation() (bool, error) {
	if winos.IsElevated() {
		return true, nil
	}
	return relaunchElevated()
}

// relaunchElevated 以 runas 启动自身的新实例。
func relaunchElevated() (bool, error) {
	exe, err := os.Executable()
	if err != nil {
		return false, apperr.IO(err)
	}
	args := strings.Join(os.Args[1:], " ")
	code, err := winos.ElevateAndWait(exe, args)
	if err != nil {
		if winos.IsCancelled(err) {
			// 用户点了 UAC 的「否」：不算失败，返回 false 让 UI 弹个提示。
			return false, nil
		}
		return false, apperr.Process("elevation failed: " + err.Error())
	}
	if code != 0 {
		return false, apperr.Process("elevated instance exited with " + strconv.Itoa(int(code)))
	}
	return true, nil
}

/* ---------------- 设置 ---------------- */

// GetSettings 返回当前设置。
func (d *Duster) GetSettings() model.Settings { return d.state.Settings() }

// SaveSettings 落盘设置。
func (d *Duster) SaveSettings(settings model.Settings) error {
	if err := appstate.SaveSettings(settings); err != nil {
		return apperr.IO(err)
	}
	d.state.SetSettings(settings)
	return nil
}

// ListBackups 列出全部备份。
func (d *Duster) ListBackups() ([]model.BackupInfo, error) {
	return backup.ListBackups(d.state.BackupDir()), nil
}

// RestoreBackup 从备份恢复注册表键。
func (d *Duster) RestoreBackup(backupID string) error {
	if err := backup.Restore(d.state.BackupDir(), backupID); err != nil {
		return err
	}
	d.state.PushLog("info", "Restored backup "+backupID)
	return nil
}

// GetLogs 返回内存里的日志环。
func (d *Duster) GetLogs() ([]model.LogEntry, error) { return d.state.Logs(), nil }

/* ---------------- 内部辅助 ---------------- */

// runHidden 启动一个外部程序且不弹控制台窗口。
func runHidden(program string, args ...string) error {
	cmd := exec.Command(program, args...)
	cmd.SysProcAttr = hiddenProcAttr()
	if err := cmd.Start(); err != nil {
		return apperr.IO(err)
	}
	// 不 Wait：explorer.exe / regedit.exe 是「启动即退出」的语义，
	// 等它反而会拖住 IPC 调用。
	go func() { _ = cmd.Wait() }()
	return nil
}

// setRegeditLastKey 写 regedit 的 LastKey 值。
func setRegeditLastKey(fullKey string) error {
	k, err := registryCreateLastKey()
	if err != nil {
		return apperr.Registry(err.Error())
	}
	defer k.Close()
	if err := k.SetStringValue("LastKey", fullKey); err != nil {
		return apperr.Registry(err.Error())
	}
	return nil
}
