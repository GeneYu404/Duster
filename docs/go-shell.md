# Go 外壳（MyGo）

> 桌面外壳是 **Go 1.27 + MyGo 3**（2026-10-11 从 Tauri 2 + Rust 重写而来，
> Rust 版已移除，`src-tauri/` 整个删除）。React 前端业务组件一行没动，
> 只换了与外壳耦合的桥接层 `src/ipc/commands.ts`。

## 为什么是 MyGo

两边跑在同一个运行时上：Windows 上都是系统自带的 **WebView2**，页面是同一份
Vite 构建产物。所以这不是「换一个 UI 框架」，而是把外壳那 2893 行 Rust 换成
等价的 Go，编译期合成进同一个二进制，交付物仍然是单个 exe。

| | Tauri 2（已移除） | MyGo（当前） |
| --- | --- | --- |
| 外壳语言 | Rust 2893 行 / 12 文件 | Go 4916 行 / 33 文件 |
| 前后端通信 | `@tauri-apps/api` 的 `invoke` | 类型化 IPC，Go 绑定 → 生成的 TS 客户端 |
| 命令寻址 | 字符串命令名 | Go 方法签名 → `Duster.xxx(...)` |
| 构建 | `bun run tauri build` | `bun run build`（即 `mygo build`） |
| 依赖的运行库 | Rust std + crates | 纯 Go，**零 CGO** |

## 目录

```
main.go                  应用入口：日志初始化、单例、窗口、提权标题
mygo.config.ts           MyGo 配置（名字、图标、构建命令、前端产物路径）
icon.png                 1024×1024 图标母版（exe 资源 + 桌面图标）
go.mod / go.sum          Go 1.27，依赖只有 mygo + x/sys
internal/
  model/                 数据模型（对应原 app_model.rs）+ StableID
  apperr/                统一错误类型 { code, message, details }
  appstate/              进程级状态：列表 / 归档 / 图标缓存 / 设置 / 日志环 / 扫描结果
  service/               ★ 绑定给前端的服务层（对应原 22 个已注册 Tauri command）
  scanner/               注册表 Uninstall 键扫描 + 商店应用（PowerShell）
  leftovers/             残留扫描（文件系统 / 注册表 / 快捷方式 / 服务 / 计划任务）
  uninstaller/           UninstallString 解析、msiexec 规范化、退出码解释、进程启动
  backup/                删除前备份（.json + .reg）、回收站、恢复、删除原语
  icon/                  ExtractIconExW → GDI → PNG data URL
  exporter/              CSV / JSON / HTML 导出
  winreg/                注册表封装（含 WOW64 视图、原始值读写、递归删除）
  winos/                 UAC 提权、ShellExecuteEx、CreateProcess
  logging/               按天滚动的文件日志（对应 tracing + tracing-appender）
```

## 命令映射

前端调用的名字变了，能力一一对应。`src/ipc/commands.ts` 和 `src/ipc/backend.ts`
是需要改的桥接层，**`Backend` 接口的签名保持不变**，所以调用方无感。

| 原 Tauri command | MyGo bound method | 备注 |
| --- | --- | --- |
| `list_installed_apps` | `Duster.listInstalledApps` | |
| `refresh_apps` | `Duster.refreshApps` | 与上面同义，两套 UI 语义 |
| `get_app_detail` | `Duster.getAppDetail` | |
| `get_app_icon` | `Duster.getAppIcon` | 取不到时 Go 返回 `""`，桥接层转 `null` |
| `uninstall_app` | `Duster.uninstallApp` | 进度事件 `uninstall-log` |
| `force_uninstall_app` | `Duster.forceUninstallApp` | 进度事件 `scan-progress`；**只读预览** |
| `scan_leftovers` | `Duster.scanLeftovers` | 进度事件 `scan-progress` |
| `delete_leftovers` | `Duster.deleteLeftovers` | 只接受缓存 id |
| `delete_app_entry` | `Duster.deleteAppEntry` | |
| `open_install_location` | `Duster.openInstallLocation` | |
| `reveal_path` | `Duster.revealPath` | |
| `open_registry_key` | `Duster.openRegistryKey` | |
| `open_external` | `Duster.openExternal` | 协议白名单不变 |
| `export_apps` | `Duster.exportApps` | |
| `is_admin` | `Duster.isAdmin` | |
| `request_elevation` | `Duster.requestElevation` | 唯一一处重启自身 |
| `get_settings` | `Duster.getSettings` | |
| `save_settings` | `Duster.saveSettings` | |
| `list_backups` | `Duster.listBackups` | |
| `restore_backup` | `Duster.restoreBackup` | |
| `get_logs` | `Duster.getLogs` | |
| `force_remove_app` | — | **未移植**，见 AGENTS.md §11 |

Tauri dialog 插件（前端调用）→ `Duster.pickBackupDir` / `Duster.pickExportPath`。

### 四处签名上的差异

1. **错误跨 IPC 的形状变了。** Tauri 传的是 `{ code, message, details }` 结构体；
   MyGo 只能传字符串。`apperr.Error.Error()` 返回一段 JSON，
   `toAppError` 里原有的「字符串 → `JSON.parse`」分支正好把它还原回结构体，
   **错误码不丢**。

2. **可选字段是「缺席」不是 `null`。** Go 侧一律用 `*T` + `omitempty`：
   Rust 的 `Option<T>` 序列化成 `null`，而前端 `types/app.ts` 声明的是
   `field?: string`（即「可能不存在」）。`omitempty` 落在 `undefined` 上，语义更贴。

3. **枚举要收窄。** Go 的 `type AppKind string` 在 TS 生成器眼里只能写成 `string`，
   而前端是字面量联合。桥接层逐字段 cast 一次（运行时值本来就只可能是那几个常量）。

4. **事件订阅是同步的。** MyGo 的 `events.*.on()` **同步**返回取消函数，
   Tauri 的 `listen()` 返回 Promise。所以桥接层的 `withEvent` 不是 async
   —— 但调用点的 `await withEvent(...)` 依然成立，`Backend` 接口签名不变。

另外：MyGo 的事件是**单向的**（只有 Go → JS，没有 `emit()`）。Duster 只有一个窗口，
目前用不到；将来若要跨窗口通信，必须绕回绑定方法由 Go 代发（PickScreen 就是这么做的）。

## 纯逻辑与 Win32 的分界

解析、树构建、查询这类**纯逻辑**单独成包并配单元测试（20 个用例）：

| 包 | 测了什么 |
| --- | --- |
| `uninstaller` | msiexec 规范化、带引号 / 不带引号含空格的路径、`%VAR%` 展开、退出码表 |
| `leftovers` | `BaseName` / `VendorName` / `PackGUID` / `ExeFromDisplayIcon` / `IsProtectedKey` |
| `exporter` | CSV 转义与 BOM、JSON 空值为 null、HTML 转义、本地化表头、未知字段丢弃 |

Win32 相关全在带构建标签的文件里：`syscall.NewLazyDLL` + `syscall.SyscallN`
声明，**不用 cgo**（`internal/winos`、`internal/icon`、`internal/backup`、`internal/winreg`）。

## 本机环境的两个坑

1. **`intptr` 是坏的**（AGENTS.md §6.2）：Go 1.27.2 的预声明类型表缺了
   `{"intptr", ...}` 那一行，任何用到 `intptr` 的 Go 代码都编译失败。
   与内核交互一律用 `uintptr` / `int32` / `uint32`。
2. **`x/sys/windows` v0.49 没有导出 `POINT` / `RECT`**：需要时自己定义，字段布局照 Win32 原样。

## 开发与构建

```bash
bun install
bun run typecheck     # TS 全量类型检查
bun run dev           # mygo dev：窗口 + 热更新
go test ./...         # 纯逻辑单测
bun run build:exe     # → build\portable\Duster.exe（免安装，无安装包）
bun run build         # mygo build，另含 NSIS 安装包
```

改动 Go 侧方法后重新生成 TS 客户端（`mygo dev` / `mygo build` 也会自动做）：

```bash
bun run generate
```

## 已知边界

- **⚠️ 本机杀软会删掉 `mygo build` 的产物**（Kaspersky 21.26 启发式误报）。
  `mygo build` 返回 `exit=0` 并打印 `Duster.exe 0 KB`，产物随后被删。
  这不是代码缺陷，详见 AGENTS.md §3.1。验证编译用 `CGO_ENABLED=0 go build ./...`。
- mygo **不给 exe 签名**，首次运行 SmartScreen 会提示「未知发布者」。
- **MyGo 0.3.7 无法跳过 Windows 安装包**：`nsisCompiler()` 会无条件下载 NSIS
  （落到 `%LOCALAPPDATA%\mygo\nsis-3.13`）并生成 `<name> Setup <version>.exe`。
  `tools/build-exe.ps1` 的做法是跑完 `mygo build` 后把安装包剔除。
  要连安装包一起留：`-KeepInstaller`。
- **图标是 1024×1024**，存放在仓库根 `icon.png`。**不要**放进 `build\`——
  那是构建输出目录，每次 `mygo build` 会被覆盖。
- Go 侧只在 Windows 上验证过；`internal/*` 的 `*_other.go` 有非 Windows 空实现，
  但 macOS / Linux 未实测。