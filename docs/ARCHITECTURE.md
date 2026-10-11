# Duster 拂尘 — 架构说明

> Windows 已安装软件管理 / 卸载 / 残留清理工具。功能对标同类卸载工具，**所有代码、UI、文案、图标均为独立实现**。
> 技术栈：**Go 1.27 + MyGo 3** 后端（跑在系统 WebView2 上），
> React 19 + TypeScript + Vite + 手写原生 CSS 前端。
> 外壳细节与命令映射见 [go-shell.md](go-shell.md)。

## 1. 项目结构

```
├── index.html                      # 入口（含首帧主题预处理脚本）
├── main.go                         # Go 外壳入口：日志、单例、窗口、提权标题
├── mygo.config.ts                  # MyGo 打包配置
├── icon.png                        # 1024×1024 图标母版
├── src/                            # 前端（可独立在浏览器中以“模拟数据”运行 → 主界面原型）
│   ├── App.tsx                     # 布局：工具栏 / 侧栏 / 虚拟表格 / 详情面板 / 状态栏
│   ├── mygo.ts                     # ★ 由 `bun run generate` 生成，勿手改
│   ├── types/app.ts                # ★ 前端数据模型 + IPC 载荷类型（与 Go 的 model 包一一对应）
│   ├── ipc/
│   │   ├── backend.ts              # ★ Backend 接口 + 原 Tauri 命令名 (COMMANDS) + 事件名 (EVENTS)
│   │   ├── commands.ts             # ★ 桥接层：MyGo 调用 → Backend 接口（枚举收窄 / 错误归一 / 事件订阅）
│   │   ├── mock.ts                 # 模拟后端：卸载退出码、残留扫描、备份、提权（浏览器预览用）
│   │   └── mockData.ts             # ~450 条确定性生成的注册表风格数据
│   ├── store/useAppStore.ts        # zustand：列表 / 搜索排序筛选 / 多选 / 对话框 / 设置 / 日志
│   ├── store/hooks.ts              # useT / useVisibleApps / useSelectedApps / useAppIcon
│   ├── i18n/index.ts               # zh-CN / en-US 词典
│   ├── utils/command.ts            # UninstallString 解析（与 Go uninstaller 包同逻辑）
│   ├── utils/exporter.ts           # CSV / JSON / HTML（浏览器预览用的本地实现）
│   └── components/
│       ├── AppTable.tsx            # @tanstack/react-virtual 虚拟滚动表格、排序、Ctrl/Shift 多选、键盘导航
│       ├── Sidebar.tsx / Toolbar.tsx / DetailPanel.tsx / StatusBar.tsx / ContextMenu.tsx / Toasts.tsx
│       └── dialogs/                # 卸载(含批量) / 残留扫描&强制删除 / 删除条目 / 导出 / 设置 / 备份 / 日志 / 属性 / 错误
└── internal/                       # Go 后端（详见 go-shell.md 的目录表）
    ├── service/                    # ★ 绑定给前端的 22 个方法
    ├── model/  apperr/  appstate/  # 数据模型 / 错误 / 进程状态
    ├── scanner/  leftovers/        # 枚举已装软件 / 残留扫描
    ├── uninstaller/  backup/       # 卸载执行 / 备份与删除
    ├── icon/  exporter/            # 图标提取 / 导出
    ├── winreg/  winos/  logging/   # 注册表 / UAC 与进程 / 文件日志
```

## 2. 注册表扫描模块设计（`internal/scanner`）

1. 以**未重定向路径** `SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall` 打开四次：
   `HKLM + WOW64_64KEY`、`HKLM + WOW64_32KEY`、`HKCU + WOW64_64KEY`、`HKCU + WOW64_32KEY`。
   **两个视图都不用显示路径里的 `WOW6432Node`** —— 那只是 64 位注册表里给 32 位程序看的
   映射，与 `KEY_WOW64_32KEY` 不是一回事。
2. 枚举子键 → `readEntry` 把所有值转成字符串
   （REG_SZ/EXPAND_SZ/MULTI_SZ/DWORD/QWORD/BINARY），供详情页“原始注册表值”。
3. `BuildApp` 分类：
   - 无 `DisplayName` → 跳过（与控制面板一致）
   - `SystemComponent=1` → 系统组件；`ParentKeyName` / `ReleaseType` 含 Update|Hotfix / `KB` 开头 → 更新
   - `WindowsInstaller=1` 或命令含 msiexec → MSI，产品代码取自键名或命令中的 `{GUID}`
   - `Steam App <id>` → 游戏（source=steam）；`InstallDate` `YYYYMMDD` → `YYYY-MM-DD`
4. `dedupe`：同名同版本同产品代码的多视图重复项仅保留信息更完整的一条，
   并按名称排序（map 迭代顺序随机，不排序会让虚拟表格每次刷新都重排）。
5. 可选 `ScanStoreApps`：`Get-AppxPackage | ConvertTo-Json`（过滤 Framework/System），
   失败时**静默返回空**——这是可选功能，绝不能拖垮主列表。
6. 性能：纯注册表读取 + 一次性序列化；图标 (`getAppIcon`) 与详情 (`getAppDetail`) 均按需懒加载，
   且**连「取不到」也缓存**，避免虚拟表格滚动时反复重试。

## 3. 数据模型与 IPC 接口

错误统一为 `{ code, message, details }`（跨 IPC 时编码成 JSON 字符串，见 go-shell.md）。

| Go bound method | 参数 | 返回 | 说明 |
|---|---|---|---|
| `listInstalledApps` / `refreshApps` | `ListOptions` | `InstalledApp[]` | 普通权限可用 |
| `getAppDetail` | `appId` | `AppDetail` | 含规范化命令、路径存在性、原始值 |
| `getAppIcon` | `appId` | `string`（空串 = 无） | PNG data URL，后端缓存 |
| `uninstallApp` | `UninstallArgs` | `UninstallResult` | 进度事件 `uninstall-log` |
| `forceUninstallApp` | `appId` | `ScanResult` | 进度事件 `scan-progress`；**仅扫描，绝不自动卸载或删除** |
| `scanLeftovers` | `appId` | `ScanResult` | 进度事件 `scan-progress` |
| `deleteLeftovers` | `DeleteLeftoversArgs` | `DeleteLeftoversResult` | 仅接受缓存扫描结果中的 id；先备份注册表，文件进回收站 |
| `deleteAppEntry` | `appId` | `BackupInfo` | 仅删 Uninstall 键，HKLM 需管理员，自动备份 |
| `openInstallLocation` / `revealPath` / `openRegistryKey` | … | `void` | explorer / regedit |
| `openExternal` | `url` | `void` | 协议白名单：`https/http/mailto/tel/ms-windows-store` |
| `exportApps` | `ExportRequest` | `ExportResult` | CSV/JSON/HTML，可选字段与范围 |
| `isAdmin` / `requestElevation` | — | `PrivilegeInfo` / `boolean` | 提权 = 以 runas 重启自身 |
| `getSettings` / `saveSettings` | … | `Settings` | 便携模式：exe 同目录 `settings.json` |
| `listBackups` / `restoreBackup` | … | `BackupInfo[]` / `void` | 恢复 = 回写 JSON 快照 |
| `getLogs` | — | `LogEntry[]` | 环形缓冲（上限 1000），文件日志由 `internal/logging` 写 |
| `pickBackupDir` / `pickExportPath` | … | `string` | 系统对话框，替代原 Tauri dialog 插件 |

## 4. 安全策略

- 所有删除均二次确认；残留删除前导出 `.json` + `.reg`；文件默认进回收站。
- `leftovers.IsProtected()` / `leftovers.IsProtectedKey()`：驱动器根、Windows、
  WindowsApps、用户目录、浅层注册表键（深度 < 3）等一律拒绝。
- 残留匹配必须基于 **安装目录 / 厂商+产品名 / Uninstall 键 / 快捷方式目标 / 服务 ImagePath**，
  不做纯名称通配；共享厂商目录（Microsoft、NVIDIA…）标记为“受保护”。
- 目录在判定受保护前会先 `Lstat`：**符号链接 / 联接点一律不自动删**，
  并对 `EvalSymlinks` 解析出的真实路径再判一次。
- `deleteLeftovers` 仅接受后端缓存的扫描结果 id，前端无法注入任意路径；
  `Risk::Protected` 的条目在这里被硬过滤。
- 回归步骤：选一个已安装软件，点击“强制删除”，等待扫描结束后点击“取消”；软件必须仍在列表、
  安装目录与 Uninstall 注册表键不能变化。再次扫描并点击“删除所选”后，在最终确认框点击“取消”，
  同样不能删除。只有最终点击“确认”才调用 `deleteLeftovers`。

## 5. 运行方式

```bash
bun run dev             # mygo dev：Windows 桌面调试，真实 Go IPC
bun run dev:web         # 浏览器预览：自动使用模拟后端
bun run build           # mygo build
bun run build:exe       # 只出 exe（见 AGENTS.md §3 与 §3.1 的杀软阻塞）
go test ./...           # 纯逻辑单测
```

> 需要 Windows 10/11 与 Go 1.27（**零 CGO**）。`bun run build:web` 只构建前端，不碰 Go。