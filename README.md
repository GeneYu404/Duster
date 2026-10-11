# Duster · 拂尘

> ⚠️ **本项目由 AI 协助完成，状态不稳定。** 可能存在尚未发现的缺陷，请自行评估使用风险。

Windows 已安装软件管理 / 卸载 / 残留清理工具。**Go 1.27 + MyGo 3** 负责注册表扫描、
卸载执行与残留匹配，MyGo 承载 React 前端（跑在系统自带的 WebView2 上）。
功能对标同类卸载工具，**所有代码、UI、文案、图标均为独立实现**。

## 功能

| 区域 | 说明 |
| --- | --- |
| **分类浏览** | 全部软件 / 应用程序 / MSI 安装包 / 商店应用 / 游戏 / 系统组件 / 更新补丁 |
| **快捷筛选** | 大于 500 MB / 最近 30 天安装 / 卸载程序缺失 |
| **虚拟表格** | `@tanstack/react-virtual` 虚拟滚动、列排序、Ctrl/Shift 多选、键盘导航、悬停显示完整路径 |
| **详情面板** | 规范化卸载命令、原始注册表值、路径存在性、发布者 / 版本 / 大小 / 安装日期 |
| **卸载** | 支持批量；`msiexec` 命令规范化；退出码逐条解释；失败自动回落到打开卸载程序对话框 |
| **强制删除** | 仅移除 Uninstall 注册表键，**绝不自动卸载或删除任何文件**，删前自动备份 `.json` + `.reg` |
| **残留清理** | 六类匹配：安装目录 / 厂商+产品目录 / 注册表键 / 快捷方式 / 服务 / 计划任务；先扫描后勾选删除 |
| **导出** | CSV / JSON / HTML，可选字段与导出范围 |
| **备份与恢复** | 列出历史备份，一键回写 JSON 快照 |
| **提权** | 检测当前是否为管理员；卸载 / 删除条目 / 清理残留这三类操作走 `runas` 窄范围提权助手，**UI 主进程不重启** |
| **便携模式** | 设置、日志、备份全部落在 exe 同目录（放个 `portable.flag` 即可免配置启用） |

## 扫描机制

**已安装软件**来自四个卸载键视图 + 商店包，以**未重定向路径**打开，避开 WOW64 重定向：

- `HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall`（`KEY_WOW64_64KEY`）
- 同上路径 + `KEY_WOW64_32KEY`（WOW6432Node 视图）
- `HKCU\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall`（两个视图）
- 商店应用：`Get-AppxPackage`（过滤 Framework / System），失败时静默返回空

> 两个视图都用**未重定向**的路径 + WOW64 标志，而不是直接写 `WOW6432Node` ——
> 后者只是 64 位注册表里给 32 位程序看的映射，语义不是一回事。

分类规则与控制面板一致：无 `DisplayName` 跳过；`SystemComponent=1` 归系统组件；
`ParentKeyName` / `ReleaseType` 含 Update|Hotfix 或 `KB` 开头归更新；`WindowsInstaller=1`
或命令含 `msiexec` 归 MSI。同名同版本同产品代码的多视图重复项只保留信息更完整的一条。

**残留匹配不做纯名称通配**，必须基于安装目录、厂商+产品名、Uninstall 键、快捷方式目标、
服务 `ImagePath` 这类可验证的锚点；共享厂商目录（Microsoft、NVIDIA 等）标记为受保护。

## 安全策略

删除是这条链路上风险最高的操作，所以设了四道闸：

- 所有删除均二次确认；残留删除前导出 `.json` + `.reg` 备份；文件默认进**回收站**而非永久删除。
- `leftovers.IsProtected()` / `leftovers.IsProtectedKey()`：驱动器根、Program Files、
  Windows、WindowsApps、用户目录、浅层注册表键一律拒绝。目录还会先 `Lstat`，
  符号链接 / 联接点永不自动删。
- `deleteLeftovers` **只接受后端缓存过的扫描结果 id**，前端无法注入任意路径。
- 取消路径有回归约定：扫描结束点「取消」、最终确认框点「取消」，都必须保证软件仍在列表、
  安装目录与 Uninstall 键均无变化。

## 环境要求

- Windows 10 / 11
- [Bun](https://bun.sh) 1.4+（包管理与脚本）
- Go 1.27+（**零 CGO**，`CGO_ENABLED=0 go build ./...` 必须通过）
- WebView2 Runtime（Windows 11 自带；Windows 10 需从微软安装）
- 写 HKLM 需管理员；其余功能普通权限可用

## 构建与运行

```bash
bun install

bun run dev          # mygo dev：桌面调试，真实 Go IPC
bun run dev:web      # 浏览器预览（自动使用模拟后端，无需桌面壳）
bun run typecheck    # tsc --noEmit
bun run build:exe    # 只出 exe → build\portable\Duster.exe
go test ./...        # 纯逻辑单测
```

单独验证 Go 侧：

```bash
go vet ./...
gofmt -l .                      # 必须无输出
CGO_ENABLED=0 go build ./...    # 零 CGO 是硬要求
```

**只出 exe，不打安装包**。需要安装包时用 `bun run build`，或
`powershell -File tools\build-exe.ps1 -KeepInstaller`。

> ⚠️ **已知阻塞**：本机 Kaspersky 21.26 会对 `Duster.exe` 做启发式误报，
> `mygo build` 返回 `exit=0` 并打印 `Duster.exe 0 KB`，产物随后被实时防护删除。
> 这不是代码缺陷（同机的只读工具能正常出包），处理办法是加杀软排除项。详见 AGENTS.md §3.1。

## 目录结构

```
main.go                      Go 外壳入口：日志初始化、单例、窗口、提权标题
mygo.config.ts               MyGo 打包配置（名字 / 图标 / 构建命令）
icon.png                     1024×1024 图标母版
internal/
├── service/                 ★ 绑定给前端的 22 个方法（对应原 22 个 Tauri command）
├── model/                   数据模型（对应原 app_model.rs）+ StableID
├── apperr/                  统一错误 { code, message, details }
├── appstate/                进程级状态：列表 / 归档 / 图标缓存 / 设置 / 日志环 / 扫描结果
├── scanner/                 ★ Uninstall 键扫描（64/32 位 + HKCU）与商店应用
├── leftovers/               ★ 残留扫描（目录 / 厂商目录 / 注册表 / 快捷方式 / 服务 / 计划任务）
├── uninstaller/             命令解析、msiexec 规范化、runas 提权、退出码解释
├── backup/                  删除前备份、回收站删除、恢复、受保护路径校验
├── icon/                    ExtractIconExW → PNG data URL
├── exporter/                CSV / JSON / HTML
├── winreg/                  注册表封装（WOW64 视图 / 原始值 / 递归删除）
├── winos/                   UAC 提权、ShellExecuteEx、CreateProcess
└── logging/                 按天滚动的文件日志

src/                          React 前端
├── App.tsx                   布局：工具栏 / 侧栏 / 虚拟表格 / 详情面板 / 状态栏
├── mygo.ts                   由 `bun run generate` 生成，勿手改
├── types/app.ts              软件数据模型 + IPC 载荷（与 internal/model 一一对应）
├── ipc/
│   ├── backend.ts            Backend 接口 + 原 Tauri 命令名 + 事件名
│   ├── commands.ts           ★ 桥接层：MyGo 调用 → Backend 接口
│   └── mock.ts               模拟后端（浏览器预览用）
├── store/                    zustand：列表 / 搜索排序筛选 / 多选 / 对话框 / 设置 / 日志
├── i18n/                     zh-CN / en-US
├── components/               AppTable（虚拟滚动）/ Sidebar / Toolbar / DetailPanel / dialogs/
└── index.css                 Windows 11 Fluent 设计令牌（明暗两套）

docs/ARCHITECTURE.md          # 模块设计与 IPC 接口全表
docs/go-shell.md              # Go 外壳：命令映射、协议差异、已知边界
```

## 设计说明

界面走 Windows 11 Fluent 设计体系，与 [lumina](https://github.com/GeneYu404/lumina)、
[DiskLens](https://github.com/GeneYu404/DiskLens)、
[PickScreen](https://github.com/GeneYu404/PickScreen) 共用同一套语义令牌
（`src/index.css`），自动跟随系统深浅色。组件里只写语义类（`.btn` / `.nav-item` / `.dialog-*`），
**不写 `dark:` 变体** —— 明暗切换统一由 `<html data-theme="dark">` 属性驱动。

前端可以脱离桌面壳独立在浏览器里跑：`ipc/commands.ts` 运行时检测 `isMyGo()`，
检测不到就切到模拟后端，因此 UI 改动可以不开 Go 外壳就验证。

Go 侧与前端的**唯一**耦合点是 `src/ipc/commands.ts`：它把 MyGo 的返回值转成
`types/app.ts` 的类型（主要是枚举字面量收窄）并归一错误形状。
`Backend` 接口的签名保持不变，所以组件层零改动。

## 隐私

所有扫描、卸载与清理均在本机完成，**不上传任何数据**。导出的 CSV / JSON / HTML 只会写到
你选择的路径。卸载过程调起的是各软件自己的卸载程序，Duster 不代替它们执行任何删除。

## 相关

- `docs/ARCHITECTURE.md` —— 每个 Go 包的设计细节与完整 IPC 命令表
- `docs/go-shell.md` —— Go 外壳架构、原 Tauri command ↔ Go 方法的完整映射、协议差异与已知边界