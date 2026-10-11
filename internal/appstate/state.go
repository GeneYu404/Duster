// Package appstate 持有 Duster 的进程级状态：扫描结果缓存、设置、日志环、扫描结果缓存。
//
// 对应原 Rust 的 commands.rs 里的 AppState（tauri::manage 的那个结构体）。
// 单独成包是为了让「状态」与「绑定给前端的命令」分开：状态没有导出方法，
// 不会不小心被 MyGo 绑成 IPC。
package appstate

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"time"

	"duster/internal/model"
	"duster/internal/scanner"
)

// maxLogs 是内存日志环的上限。
const maxLogs = 1000

// State 是全进程共享的状态。
type State struct {
	mu sync.Mutex

	apps []model.InstalledApp
	// archive 保存「已经从注册表消失、但残留扫描还需要」的条目。
	// 软件卸载后它的 Uninstall 键就没了，此时详情/残留扫描仍要能拿到元数据。
	archive map[string]model.InstalledApp
	raw     map[string]scanner.RawEntry
	icons   map[string]string
	// scanResults 缓存扫描结果，delete_leftovers 靠它把 item id 还原成路径 ——
	// 前端提交的永远是 id 而不是路径，路径注入因此不可能发生。
	scanResults map[string]model.ScanResult

	settings model.Settings
	logs     []model.LogEntry
}

// New 建一份默认状态。
func New(settings model.Settings) *State {
	return &State{
		archive:     map[string]model.InstalledApp{},
		raw:         map[string]scanner.RawEntry{},
		icons:       map[string]string{},
		scanResults: map[string]model.ScanResult{},
		settings:    settings,
		logs:        make([]model.LogEntry, 0, 64),
	}
}

/* ---------------- 列表与查找 ---------------- */

// Apps 返回当前列表的副本。
func (s *State) Apps() []model.InstalledApp {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]model.InstalledApp(nil), s.apps...)
}

// Find 按 id 找条目，先查当前列表再查归档。
func (s *State) Find(appID string) (model.InstalledApp, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, a := range s.apps {
		if a.ID == appID {
			return a, true
		}
	}
	a, ok := s.archive[appID]
	return a, ok
}

// Archive 把一个条目移进归档（软件已卸载 / 条目已删除，但详情还要能看）。
func (s *State) Archive(appID string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for i, a := range s.apps {
		if a.ID == appID {
			s.archive[a.ID] = a
			s.apps = append(s.apps[:i], s.apps[i+1:]...)
			return
		}
	}
}

// Contains 报告条目当前是否还在列表里。
func (s *State) Contains(appID string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, a := range s.apps {
		if a.ID == appID {
			return true
		}
	}
	return false
}

// Raw 返回某个条目的原始注册表值。
func (s *State) Raw(appID string) scanner.RawEntry {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.raw[appID]
}

// Rescan 重新扫描注册表并刷新列表与原始值。
func (s *State) Rescan(opts model.ListOptions) []model.InstalledApp {
	started := time.Now()
	result := scanner.ScanAll(opts.IncludeStoreApps)

	list := make([]model.InstalledApp, 0, len(result.Apps))
	for _, a := range result.Apps {
		if !opts.IncludeSystemComponents && a.IsSystem {
			continue
		}
		if !opts.IncludeUpdates && a.IsUpdate {
			continue
		}
		list = append(list, a)
	}

	s.mu.Lock()
	s.raw = result.Raw
	s.apps = list
	s.mu.Unlock()

	s.PushLog("info", sprintf("Enumerated %d entries in %d ms", len(list), time.Since(started).Milliseconds()))
	return list
}

/* ---------------- 图标 ---------------- */

// Icon 返回缓存的图标 data URL；第二个返回值表示「是否已有缓存」。
func (s *State) Icon(appID string) (string, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	v, ok := s.icons[appID]
	return v, ok
}

// PutIcon 缓存图标结果（包括「取不到」这个结论，避免反复重试）。
func (s *State) PutIcon(appID, dataURL string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.icons[appID] = dataURL
}

/* ---------------- 扫描结果 ---------------- */

// PutScan 缓存一次扫描结果。
func (s *State) PutScan(appID string, r model.ScanResult) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.scanResults[appID] = r
}

// Scan 取回缓存的扫描结果。
func (s *State) Scan(appID string) (model.ScanResult, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	r, ok := s.scanResults[appID]
	return r, ok
}

/* ---------------- 设置 ---------------- */

// Settings 返回当前设置。
func (s *State) Settings() model.Settings {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.settings
}

// SetSettings 替换当前设置（写盘由调用方负责）。
func (s *State) SetSettings(v model.Settings) {
	s.mu.Lock()
	s.settings = v
	s.mu.Unlock()
}

// BackupDir 返回备份目录。
func (s *State) BackupDir() string { return s.Settings().BackupDirectory }

/* ---------------- 日志 ---------------- */

// PushLog 往内存日志环里追加一条，超出上限就丢最老的。
func (s *State) PushLog(level, message string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.logs = append(s.logs, model.LogEntry{
		TS:      time.Now().Format(time.RFC3339),
		Level:   level,
		Message: message,
	})
	if len(s.logs) > maxLogs {
		s.logs = s.logs[len(s.logs)-maxLogs:]
	}
}

// Logs 返回日志副本。
func (s *State) Logs() []model.LogEntry {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]model.LogEntry(nil), s.logs...)
}

/* ---------------- 路径与便携模式 ---------------- */

// AppDir 是常规安装下的配置目录：%APPDATA%\Duster。
//
// 与 Rust 版 dirs::config_dir().join("Duster") 保持一致 —— 换壳不能
// 换数据目录，否则老用户的设置/备份全都「丢了」。
func AppDir() string {
	base := os.Getenv("APPDATA")
	if base == "" {
		base = "."
	}
	return filepath.Join(base, "Duster")
}

// PortableDir 是便携模式下的目录：exe 所在目录。
func PortableDir() string {
	if exe, err := os.Executable(); err == nil {
		return filepath.Dir(exe)
	}
	return "."
}

// IsPortable 报告是否运行在便携模式。
//
// 两种触发方式：exe 同目录有 portable.flag，或同目录的 settings.json 里
// portableMode 为 true。后者让「在设置里勾上便携模式」这件事能持久化，
// 前者给的是「放个标记文件就能整体搬走」的免配置体验。
func IsPortable() bool {
	dir := PortableDir()
	if _, err := os.Stat(filepath.Join(dir, "portable.flag")); err == nil {
		return true
	}
	raw, err := os.ReadFile(filepath.Join(dir, "settings.json"))
	if err != nil {
		return false
	}
	var s model.Settings
	if json.Unmarshal(raw, &s) != nil {
		return false
	}
	return s.PortableMode
}

// DataDir 返回数据目录（便携模式下是 exe 目录，否则是 %APPDATA%\Duster）。
func DataDir() string {
	if IsPortable() {
		return PortableDir()
	}
	return AppDir()
}

// LoadSettings 读回设置，补齐默认值与备份目录。
func LoadSettings() model.Settings {
	raw, err := os.ReadFile(filepath.Join(DataDir(), "settings.json"))
	s := model.DefaultSettings()
	if err == nil {
		// 读失败就用默认值继续：设置损坏不该让程序起不来。
		_ = json.Unmarshal(raw, &s)
	}
	s.PortableMode = IsPortable()
	if s.BackupDirectory == "" {
		s.BackupDirectory = filepath.Join(DataDir(), "backups")
	}
	return s
}

// SaveSettings 落盘设置。
//
// 便携模式的语义是「配置跟着 exe 走」：从常规模式切到便携模式时要把
// exe 目录下的旧 settings.json 删掉，反之亦然，否则下次启动会读到两份
// 互相矛盾的配置。
func SaveSettings(next model.Settings) error {
	previous := LoadSettings()
	dir := AppDir()
	if next.PortableMode {
		dir = PortableDir()
	}
	defaultBackup := filepath.Join(DataDir(), "backups")
	// 只有当旧值本来就是默认目录时，才跟着模式切换而搬家；
	// 用户自定义过的备份目录不能被偷偷改掉。
	if previous.BackupDirectory == defaultBackup {
		next.BackupDirectory = filepath.Join(dir, "backups")
	}

	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	raw, err := json.MarshalIndent(next, "", "  ")
	if err != nil {
		return err
	}
	if err := os.WriteFile(filepath.Join(dir, "settings.json"), raw, 0o644); err != nil {
		return err
	}
	if !next.PortableMode {
		portableSettings := filepath.Join(PortableDir(), "settings.json")
		if portableSettings != filepath.Join(dir, "settings.json") {
			_ = os.Remove(portableSettings)
		}
	}
	return nil
}

// sprintf 是 fmt.Sprintf 的短别名（这个文件里日志消息拼得很勤）。
func sprintf(format string, args ...any) string { return fmt.Sprintf(format, args...) }
