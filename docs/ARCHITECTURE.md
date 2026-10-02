# Duster 拂尘 — 架构说明

> Windows 已安装软件管理 / 卸载 / 残留清理工具。功能对标同类卸载工具，**所有代码、UI、文案、图标均为独立实现**。
> 技术栈：Tauri 2 + Rust 后端，React 19 + TypeScript + Vite + Tailwind v4 前端。

## 1. 项目结构

```
├── index.html                      # 入口（含首帧主题预处理脚本）
├── src/                            # 前端（可独立在浏览器中以“模拟数据”运行 → 主界面原型）
│   ├── App.tsx                     # 布局：工具栏 / 侧栏 / 虚拟表格 / 详情面板 / 状态栏
│   ├── types/app.ts                # ★ 软件数据模型 + IPC 载荷类型（与 Rust 端 app_model.rs 一一对应）
│   ├── ipc/
│   │   ├── backend.ts              # ★ Backend 接口 + Tauri 命令名 (COMMANDS) + 事件名 (EVENTS)
│   │   ├── commands.ts             # 运行时检测 __TAURI_INTERNALS__：真实 invoke/listen 或模拟后端
│   │   ├── mock.ts                 # 模拟后端：卸载退出码、残留扫描、备份、提权（浏览器预览用）
│   │   └── mockData.ts             # ~450 条确定性生成的注册表风格数据
│   ├── store/useAppStore.ts        # zustand：列表 / 搜索排序筛选 / 多选 / 对话框 / 设置 / 日志
│   ├── store/hooks.ts              # useT / useVisibleApps / useSelectedApps / useAppIcon
│   ├── i18n/index.ts               # zh-CN / en-US 词典
│   ├── utils/command.ts            # UninstallString 解析（与 Rust uninstaller.rs 同逻辑）
│   ├── utils/exporter.ts           # CSV / JSON / HTML
│   └── components/
│       ├── AppTable.tsx            # @tanstack/react-virtual 虚拟滚动表格、排序、Ctrl/Shift 多选、键盘导航
│       ├── Sidebar.tsx / Toolbar.tsx / DetailPanel.tsx / StatusBar.tsx / ContextMenu.tsx / Toasts.tsx
│       └── dialogs/                # 卸载(含批量) / 残留扫描&强制删除 / 删除条目 / 导出 / 设置 / 备份 / 日志 / 属性 / 错误
└── src-tauri/
    ├── Cargo.toml  tauri.conf.json
    └── src/
        ├── main.rs / lib.rs        # Builder、命令注册、tracing 初始化（文件日志 + 便携模式目录）
        ├── error.rs                # AppError → {code,message,details}
        ├── app_model.rs            # ★ 数据模型（serde camelCase）
        ├── registry_scanner.rs     # ★ Uninstall 键扫描（KEY_WOW64_64KEY / KEY_WOW64_32KEY / HKCU）+ AppX
        ├── uninstaller.rs          # 命令解析、msiexec 规范化、runas 提权执行、退出码解释
        ├── leftover_scanner.rs     # 残留扫描（安装目录 / 厂商+产品目录 / 注册表 / 快捷方式 / 服务 / 计划任务）
        ├── backup_manager.rs       # 删除前备份 (.json + .reg)、回收站删除、恢复、受保护路径校验
        ├── icon_extractor.rs       # ExtractIconExW → PNG data URL
        ├── privilege.rs            # TokenElevation 检测、ShellExecuteEx("runas") 重启提权
        ├── exporter.rs             # CSV / JSON / HTML
        └── commands.rs             # #[tauri::command] + AppState（缓存、设置、日志、扫描结果）
```

## 2. 注册表扫描模块设计（registry_scanner.rs）

1. 以 **未重定向路径** `SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall` 打开三次：
   `HKLM + KEY_WOW64_64KEY`、`HKLM + KEY_WOW64_32KEY`（= WOW6432Node 视图）、`HKCU`。
2. 枚举子键 → `read_entry` 把所有值转成字符串（REG_SZ/EXPAND_SZ/MULTI_SZ/DWORD/QWORD/BINARY），供详情页“原始注册表值”。
3. `build_app` 分类：
   - 无 `DisplayName` → 跳过（与控制面板一致）
   - `SystemComponent=1` → 系统组件；`ParentKeyName` / `ReleaseType` 含 Update|Hotfix / `KB` 开头 → 更新
   - `WindowsInstaller=1` 或命令含 msiexec → MSI，产品代码取自键名或命令中的 `{GUID}`
   - `Steam App <id>` → 游戏（source=steam）；`InstallDate` `YYYYMMDD` → `YYYY-MM-DD`
4. `dedupe`：同名同版本同产品代码的多视图重复项仅保留信息更完整的一条。
5. 可选 `scan_store_apps`：`Get-AppxPackage | ConvertTo-Json`（过滤 Framework/System），失败时静默返回空。
6. 性能：纯注册表读取 + 一次性序列化；图标 (`get_app_icon`) 与详情 (`get_app_detail`) 均按需懒加载。

## 3. 数据模型与 IPC 接口

| 命令 | 参数 | 返回 | 说明 |
|---|---|---|---|
| `list_installed_apps` / `refresh_apps` | `{ options: ListOptions }` | `InstalledApp[]` | 普通权限可用 |
| `get_app_detail` | `{ appId }` | `AppDetail` | 含规范化命令、路径存在性、原始值 |
| `get_app_icon` | `{ appId }` | `string \| null` | PNG data URL，后端缓存 |
| `uninstall_app` | `{ args: { appId, quiet } }` | `UninstallResult` | 进度事件 `duster://uninstall-log` |
| `force_uninstall_app` | `{ appId }` | `ScanResult` | 仅扫描、绝不自动卸载或删除；取消后软件与文件保持不变 |
| `scan_leftovers` | `{ appId }` | `ScanResult` | 进度事件 `duster://scan-progress` |
| `delete_leftovers` | `{ args: { appId, itemIds } }` | `DeleteLeftoversResult` | 仅接受缓存扫描结果中的 id；先备份注册表，文件进回收站 |
| `delete_app_entry` | `{ appId }` | `BackupInfo` | 仅删 Uninstall 键，HKLM 需管理员，自动备份 |
| `open_install_location` / `reveal_path` / `open_registry_key` | … | `void` | explorer / regedit |
| `export_apps` | `{ request: ExportRequest }` | `ExportResult` | CSV/JSON/HTML，可选字段与范围 |
| `is_admin` / `request_elevation` | — | `PrivilegeInfo` / `boolean` | 提权 = 以 runas 重启自身 |
| `get_settings` / `save_settings` | … | `Settings` | 便携模式：exe 同目录 `settings.json` |
| `list_backups` / `restore_backup` | … | `BackupInfo[]` / `void` | 恢复 = 回写 JSON 快照 |
| `get_logs` | — | `LogEntry[]` | 环形缓冲，文件日志由 tracing 写入 |

错误统一为 `{ code: 'APP_NOT_FOUND' | 'ELEVATION_REQUIRED' | 'PROTECTED_PATH' | …, message, details? }`。

## 4. 安全策略

- 所有删除均二次确认；残留删除前导出 `.json` + `.reg`；文件默认进回收站。
- `is_protected()` / `is_protected_key()`：驱动器根、Program Files、Windows、用户目录、浅层注册表键等一律拒绝。
- 残留匹配必须基于 **安装目录 / 厂商+产品名 / Uninstall 键 / 快捷方式目标 / 服务 ImagePath**，不做纯名称通配；共享厂商目录（Microsoft、NVIDIA…）标记为“受保护”。
- `delete_leftovers` 仅接受后端缓存的扫描结果 id，前端无法注入任意路径。
- 回归步骤：选一个已安装软件，点击“强制删除”，等待扫描结束后点击“取消”；软件必须仍在列表、安装目录与 Uninstall 注册表键不能变化。再次扫描并点击“删除所选”后，在最终确认框点击“取消”，同样不能删除。只有最终点击“确认”才调用 `delete_leftovers`。

## 5. 运行方式

```bash
bun run dev                             # 浏览器预览：自动使用模拟后端
bun run tauri dev                       # Windows 桌面调试，真实 Rust IPC
bun run tauri build                     # 生成 NSIS / MSI 安装包
bun run tauri build --features portable # 便携模式（配置、日志、备份置于程序目录）
```

> 需要 Windows 10/11、Rust MSVC 工具链及 WebView2。运行 `cargo check --manifest-path src-tauri/Cargo.toml` 可单独验证 Rust；`bun run build` 只构建前端，不会编译 Rust。
