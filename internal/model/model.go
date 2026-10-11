// Package model 是 Duster 的软件数据模型，必须与 src/types/app.ts 保持一致。
//
// 对应原 Rust 的 src-tauri/src/app_model.rs。所有字段在 JSON 上都是 camelCase，
// 枚举序列化成小写字符串（Go 侧用带类型的字符串常量表达「字面量联合」）。
//
// 可选字段一律用指针 + `omitempty`：Rust 版的 Option<T> 序列化成 null，
// 而前端的类型声明是 `field?: string`（即「可能不存在」）。Go 的 omitempty
// 在指针为 nil 时直接省略该键，正好落在 undefined 上，语义比 null 更贴。
package model

import (
	"fmt"
	"strings"
	"unicode/utf16"
)

// 分类。Rust 侧是 #[serde(rename_all = "lowercase")] 的枚举。
type AppKind string

const (
	KindProgram AppKind = "program"
	KindMSI     AppKind = "msi"
	KindStore   AppKind = "store"
	KindSystem  AppKind = "system"
	KindUpdate  AppKind = "update"
	KindGame    AppKind = "game"
)

type Architecture string

const (
	ArchX64     Architecture = "x64"
	ArchX86     Architecture = "x86"
	ArchArm64   Architecture = "arm64"
	ArchUnknown Architecture = "unknown"
)

// RegistryView 记录该条目是从哪个注册表视图读出来的
// （KEY_WOW64_64KEY 还是 KEY_WOW64_32KEY）。
type RegistryView string

const (
	ViewX64 RegistryView = "x64"
	ViewX86 RegistryView = "x86"
)

type Hive string

const (
	HiveHKLM Hive = "HKLM"
	HiveHKCU Hive = "HKCU"
)

type AppSource string

const (
	SourceRegistry AppSource = "registry"
	SourceMSI      AppSource = "msi"
	SourceStore    AppSource = "store"
	SourceSteam    AppSource = "steam"
	SourceEpic     AppSource = "epic"
)

// InstalledApp 是列表里的一行。
type InstalledApp struct {
	ID           string  `json:"id"`
	Name         string  `json:"name"`
	Version      *string `json:"version,omitempty"`
	Publisher    *string `json:"publisher,omitempty"`
	InstallDate  *string `json:"installDate,omitempty"`     // 已规范化为 YYYY-MM-DD
	EstimatedKB  *uint32 `json:"estimatedSizeKb,omitempty"` // 注册表里存的是 KB
	InstallLoc   *string `json:"installLocation,omitempty"`
	UninstallStr *string `json:"uninstallString,omitempty"`
	QuietStr     *string `json:"quietUninstallString,omitempty"`
	DisplayIcon  *string `json:"displayIcon,omitempty"`
	// 例如 HKLM\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\{GUID}
	RegistryPath string       `json:"registryPath"`
	Hive         Hive         `json:"hive"`
	View         RegistryView `json:"registryView"`
	Arch         Architecture `json:"architecture"`
	Kind         AppKind      `json:"kind"`
	IsMSI        bool         `json:"isMsi"`
	IsSystem     bool         `json:"isSystemComponent"`
	IsUpdate     bool         `json:"isUpdate"`
	MSIProduct   *string      `json:"msiProductCode,omitempty"`
	HelpLink     *string      `json:"helpLink,omitempty"`
	AboutURL     *string      `json:"aboutUrl,omitempty"`
	UpdateURL    *string      `json:"updateInfoUrl,omitempty"`
	PackageName  *string      `json:"packageFullName,omitempty"`
	Source       AppSource    `json:"source"`
}

// ParsedCommand 是后端打算真正执行的卸载命令。
type ParsedCommand struct {
	Program    string `json:"program"`
	Args       string `json:"args"`
	IsMSI      bool   `json:"isMsi"`
	Normalized string `json:"normalized"` // msiexec 规范化之后真正会跑的命令行
}

// AppDetail = InstalledApp + 按需补齐的详情。
//
// Rust 侧用 #[serde(flatten)]，Go 侧对应「匿名内嵌」：encoding/json 与 MyGo 的
// TS 代码生成器都会把内嵌结构体的字段平铺到外层，所以前端看到的形状不变。
type AppDetail struct {
	InstalledApp
	ExecutablePath    *string           `json:"executablePath,omitempty"`
	InstallLocExists  bool              `json:"installLocationExists"`
	UninstallerExists bool              `json:"uninstallerExists"`
	Parsed            *ParsedCommand    `json:"parsedCommand,omitempty"`
	ModifyPath        *string           `json:"modifyPath,omitempty"`
	Comments          *string           `json:"comments,omitempty"`
	Contact           *string           `json:"contact,omitempty"`
	Language          *string           `json:"language,omitempty"`
	RegistryValues    map[string]string `json:"registryValues"`
}

type LeftoverCategory string

const (
	CatFolder   LeftoverCategory = "folder"
	CatFile     LeftoverCategory = "file"
	CatRegistry LeftoverCategory = "registry"
	CatShortcut LeftoverCategory = "shortcut"
	CatService  LeftoverCategory = "service"
	CatTask     LeftoverCategory = "task"
)

type Risk string

const (
	RiskSafe      Risk = "safe"
	RiskCaution   Risk = "caution"
	RiskProtected Risk = "protected"
)

// LeftoverItem 是扫描到的一条残留。
type LeftoverItem struct {
	ID              string           `json:"id"`
	Category        LeftoverCategory `json:"category"`
	Path            string           `json:"path"`
	SizeBytes       *uint64          `json:"sizeBytes,omitempty"`
	Risk            Risk             `json:"risk"`
	Reason          string           `json:"reason"` // 机器可读的匹配原因：installDir / publisherName / uninstallKey ...
	DefaultSelected bool             `json:"defaultSelected"`
}

// ScanProgress 是扫描过程中的进度事件载荷。
type ScanProgress struct {
	Phase   string `json:"phase"`
	Percent uint8  `json:"percent"`
	Found   int    `json:"found"`
}

type ScanResult struct {
	AppID            string         `json:"appId"`
	AppName          string         `json:"appName"`
	Items            []LeftoverItem `json:"items"`
	DurationMS       uint64         `json:"durationMs"`
	ScannedLocations int            `json:"scannedLocations"`
}

type UninstallResult struct {
	AppID        string   `json:"appId"`
	Success      bool     `json:"success"`
	ExitCode     *int32   `json:"exitCode,omitempty"`
	RebootNeeded bool     `json:"rebootRequired"`
	Cancelled    bool     `json:"cancelled"`
	Message      string   `json:"message"`
	CommandLine  string   `json:"commandLine"`
	DurationMS   uint64   `json:"durationMs"`
	Log          []string `json:"log"`
}

type BackupKind string

const (
	BackupRegistry BackupKind = "registry"
	BackupLeftover BackupKind = "leftovers"
)

type BackupInfo struct {
	ID         string     `json:"id"`
	CreatedAt  string     `json:"createdAt"`
	AppID      string     `json:"appId"`
	AppName    string     `json:"appName"`
	Kind       BackupKind `json:"kind"`
	Path       string     `json:"path"`
	Keys       []string   `json:"keys"`
	Restorable bool       `json:"restorable"`
}

type FailedItem struct {
	ID     string `json:"id"`
	Path   string `json:"path"`
	Reason string `json:"reason"`
}

type DeleteLeftoversResult struct {
	Deleted  []string     `json:"deleted"`
	Failed   []FailedItem `json:"failed"`
	Recycled int          `json:"recycled"`
	Backup   *BackupInfo  `json:"backup,omitempty"`
}

type ExportFormat string

const (
	ExportCSV  ExportFormat = "csv"
	ExportJSON ExportFormat = "json"
	ExportHTML ExportFormat = "html"
)

// ExportRequest 的 Labels / AppIDs / Path 都是可选的：Go 侧用指针表达「字段缺席」
// 与「字段存在但为空」的区别（Rust 的 Option<T> 同理）。
type ExportRequest struct {
	Format ExportFormat      `json:"format"`
	Fields []string          `json:"fields"`
	Labels map[string]string `json:"labels,omitempty"`
	AppIDs []string          `json:"appIds,omitempty"`
	// Path 非空时后端直接落盘；缺席时把内容原样返回，由前端触发下载。
	Path *string `json:"path,omitempty"`
}

type ExportResult struct {
	FileName string  `json:"fileName"`
	Path     *string `json:"path,omitempty"`
	Content  *string `json:"content,omitempty"`
	MimeType string  `json:"mimeType"`
	Count    int     `json:"count"`
}

type Settings struct {
	Theme                 string `json:"theme"`
	Language              string `json:"language"`
	PortableMode          bool   `json:"portableMode"`
	LogLevel              string `json:"logLevel"`
	RequestAdminOnStartup bool   `json:"requestAdminOnStartup"`
	ShowSystemComponents  bool   `json:"showSystemComponents"`
	ShowUpdates           bool   `json:"showUpdates"`
	ShowStoreApps         bool   `json:"showStoreApps"`
	EnableLeftoverScan    bool   `json:"enableLeftoverScan"`
	ScanAfterUninstall    bool   `json:"scanAfterUninstall"`
	UseRecycleBin         bool   `json:"useRecycleBin"`
	BackupDirectory       string `json:"backupDirectory"`
}

// DefaultSettings 与 Rust 的 `impl Default for Settings` 逐字段对应。
//
// ShowStoreApps 默认 **false**：商店应用扫描要在启动路径上拉起
// `powershell.exe -ExecutionPolicy Bypass`（还带隐藏窗口）——
// 「GUI 程序一启动就偷偷执行 PowerShell」是反病毒启发式里权重最高的 IOC 之一。
// 本工具未签名 + Go 构建 + 清理类能力（枚举/结束进程、递归删除、提权），
// 正好整体撞上 Backdoor/Agent 的通用画像（实测 VirusTotal 3/71：
// Huorong Backdoor/Agent.sa、Bkav W32.Malware.*、Trapmine ML score）。
// 默认关掉可让启动路径上一个子进程都不产生；用户要用时在设置里打开，
// 打开即扫（useAppStore 的 updateSettings 已在开关变化时重扫），功能不变。
func DefaultSettings() Settings {
	return Settings{
		Theme:              "system",
		Language:           "zh-CN",
		PortableMode:       false,
		LogLevel:           "info",
		ShowStoreApps:      false,
		EnableLeftoverScan: true,
		ScanAfterUninstall: true,
		UseRecycleBin:      true,
	}
}

type ListOptions struct {
	IncludeSystemComponents bool `json:"includeSystemComponents"`
	IncludeUpdates          bool `json:"includeUpdates"`
	IncludeStoreApps        bool `json:"includeStoreApps"`
}

type PrivilegeInfo struct {
	IsAdmin    bool `json:"isAdmin"`
	CanElevate bool `json:"canElevate"`
}

type LogEntry struct {
	TS      string `json:"ts"`
	Level   string `json:"level"`
	Message string `json:"message"`
}

// UninstallArgs / DeleteLeftoversArgs 是前端传来的具名参数包。
// Rust 侧是靠 Tauri 的 serde 按字段名反序列化，MyGo 走位置参数，
// 所以前端桥接层会包成 { appId, ... } 这样形状相同的对象。
type UninstallArgs struct {
	AppID string `json:"appId"`
	Quiet bool   `json:"quiet"`
}

type DeleteLeftoversArgs struct {
	AppID   string   `json:"appId"`
	ItemIDs []string `json:"itemIds"`
}

// Str 返回一个指向 s 的可选字符串，用于填充上面那些 *string 字段。
func Str(s string) *string { return &s }

// U32 返回一个指向 v 的可选数值。
func U32(v uint32) *uint32 { return &v }

// I32 返回一个指向 v 的可选退出码。
func I32(v int32) *int32 { return &v }

// StableID 是条目的稳定 id：对小写化后的注册表路径做 FNV-1a，
// 与前端用的算法一致（Rust 版是 app_model::stable_id）。
func StableID(registryPath string) string {
	h := uint32(0x811c9dc5)
	// Rust 版遍历的是 to_lowercase().encode_utf16()，即按 UTF-16 码元喂进哈希。
	// 这里必须保持一致，否则同一个键在前端与后端会算出两个 id。
	for _, u := range utf16.Encode([]rune(strings.ToLower(registryPath))) {
		h ^= uint32(u)
		h *= 0x01000193
	}
	return fmt.Sprintf("%08x", h)
}
