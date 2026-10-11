# AGENTS.md

> AI agent / 协作者的工作守则。**先读这页，再动手改东西。**
>
> 本文件只放规则与本项目特有的坑；架构与模块说明在 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)。

## 0. 这是什么

**Duster 拂尘** —— Windows 10/11 已安装软件管理 / 卸载 / 残留清理工具，
对标 Geek Uninstaller / HiBit Uninstaller，代码、UI、文案、图标均为独立实现。
**Go 1.27 + MyGo 3** 后端（跑在系统自带的 WebView2 上），
React 19（跑在 **Preact 兼容层**上）+ TypeScript + Vite 前端，
样式是**手写原生 CSS**（不再用 Tailwind，见 §8）。

> 2026-10-11 从 **Tauri 2 + Rust** 整体改写为 Go + MyGo，Rust 版（含 `src-tauri/`）已删除。
> React 组件一行没动，只换了与外壳耦合的桥接层 `src/ipc/commands.ts`。
> 改名对照见 [docs/go-shell.md](docs/go-shell.md) 的命令映射表。

对外名称固定：**英文 `Duster`，中文「拂尘」**。改名不是改一处字符串，见 §4。

## 1. 文档索引

| 想了解 | 看 |
| --- | --- |
| 目录结构、数据模型、22 个 IPC 命令与事件表 | [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) |
| Go 外壳（为什么是 MyGo、命令映射、协议差异、已知边界） | [docs/go-shell.md](docs/go-shell.md) |

## 2. 运行时与包管理器

**只用 Bun**（1.4+）。

- 锁文件是 `bun.lock`，**不要**生成 / 提交 `package-lock.json`；不要主动 `npm install`
- `mygo.config.ts` 的 `devCommand` / `buildCommand` 必须写 `bun run …`，不是 `npm run …`

## 3. 构建与交付

**只出 exe，不打 NSIS / MSI 安装包**（用户明确要求）：

```bash
bun run typecheck     # tsc --noEmit
bun run build         # mygo build（含 NSIS，脚本会剔除安装包）
bun run build:exe     # = tools\build-exe.ps1，约 10 秒
go test ./...         # 纯逻辑：命令解析、残留匹配、导出
```

`tools\build-exe.ps1` 跑完 `mygo build` 后把 `*Setup*.exe` 剔除，
再把 exe 汇总到 `build\portable\`。要连安装包一起留：
`powershell -File tools\build-exe.ps1 -KeepInstaller`。

**构建产物统一归档到 `D:\Tool`** —— `build\` 是构建缓存，不是交付物：

```powershell
Copy-Item build\portable\Duster.exe D:\Tool\duster.exe -Force
```

### 3.1 ⚠️ 本机杀软会吃掉 `mygo build` 的产物（当前已知阻塞）

**Kaspersky 21.26 对 `Duster.exe` 做启发式误报**：`mygo build` 正常返回 `exit=0`
并打印 `Duster.exe 0 KB`，随后产物被实时防护删除，`build\windows-amd64\` 变成空目录。

- **这不是代码缺陷。** 同一台机器上 `mygo build` 对只读文件系统的 DiskLens 完全正常。
- 差异在 API 画像：读写注册表 + 枚举/结束进程 + 递归删除 + 拉起提权进程 + 枚举服务，
  正是杀软对「清理工具」的标准启发式特征。
- mygo **不给二进制签名**（只生成 icon + manifest + VS_VERSIONINFO），无法靠签名放行。
- **处理办法由用户决定**：加 Kaspersky 排除项 / 从隔离区恢复。不要为了绕过它删功能。
- 验证 Go 代码是否可编译**用 `CGO_ENABLED=0 go build ./...`，不要反复试 `mygo build`** ——
  试多少次都是 0 KB。`go build` 产物放 `%TEMP%` 实测能存活。

## 4. 改名要一起改的 11 处

改产品名 / 品牌名时**必须同步**改完下面全部位置，漏一处就会出现「界面叫 A、
数据目录叫 B」的分裂状态（Go 侧与前端两侧都要改，且字符串写法不同）：

| # | 位置 | 当前值 |
| --- | --- | --- |
| 1 | `mygo.config.ts` → `name` | `Duster`（EXE / 安装包文件名由此而来） |
| 2 | 同上 → `identifier` | `dev.duster.app`（**会连带改应用数据目录**） |
| 3 | `main.go` → `appTitle` | `Duster 拂尘` |
| 4 | `go.mod` → `module` | `duster` |
| 5 | `main.go` → `mygo.App.SetName` / 窗口标题 | 见 §3 的 admin 后缀逻辑 |
| 6 | `internal/logging` → 日志前缀 | `duster`（文件 `duster-<日期>.log`） |
| 7 | `internal/service` → 事件名 | `uninstall-log` / `scan-progress`（Rust 版曾用 `duster://` 前缀） |
| 8 | `internal/backup` → 恢复临时文件 | `duster-restore-<pid>-<ns>.reg` |
| 9 | `index.html` | `<title>`、`<meta description>`、**localStorage 键 `duster.settings.v1`** |
| 10 | 前端 | `i18n/index.ts` 的 `appName`、`App.tsx` 的 `document.title`、`index.css` 的 `@keyframes duster-fade-in`、`Toolbar.tsx` 的 `duster-global-search`、`ipc/backend.ts` 的 `EVENTS`、`ipc/mock.ts` 与 `types/app.ts` 的备份目录 |
| 11 | `icon.png` + `mygo.config.ts` → `icon` | 桌面图标与 exe 资源 |

改完自查：

```powershell
Select-String -Path <所有源码> -Pattern '旧名'   # 必须无输出
```

## 5. `icon.png` —— 母版与生成链

`icon.png` 是 **1024×1024** 母版，由原 Tauri 的 `src-tauri/icons/source.svg` 光栅化而来
（`src-tauri/` 已删，SVG 母版随 Tauri 目录一起移除；PNG 母版保留在仓库根）。

改图标形状时改 SVG 母版并重新光栅化：

```powershell
$edge = "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe"
& $edge --headless=new --disable-gpu --hide-scrollbars --default-background-color=00000000 `
        --force-device-scale-factor=1 --window-size=1024,1024 `
        --screenshot="$env:TEMP\master.png" "file:///$PWD\icon-source.svg"
Copy-Item "$env:TEMP\master.png" icon.png -Force
```

⚠️ HTML 外壳要求 `html,body{margin:0;overflow:hidden}` + `<svg width="1024" height="1024">`，
否则截出来不是 1024×1024。裸 `.svg` 文件可以直接喂给 Edge，不必套 HTML。

**当前设计**：等轴六边形包裹轮廓 + 居中粗减号，白色，底色 `accent #005fb8 → brand2 #6b46d6`
（与应用内标题栏标识的 `from-accent to-brand2` 同一套渐变）。应用内的 `BrandMark`
（`Toolbar.tsx`）是同一形状的自绘 SVG —— **改图标形状时两边要一起改**，
否则桌面图标和标题栏标识对不上。

**为什么不用 lucide 的 `PackageMinus`**：它 18px 下立方体中线会和减号横杠连成「＋」，
语义从「卸载」变成「添加」。同理，别再换成带内部结构线的箱体画法。

## 6. Go 侧的硬约束

### 6.1 零 CGO

```bash
CGO_ENABLED=0 go build ./...   # 必须通过
```

不要引任何需要 cgo 的依赖（`go-sqlite3`、`go-git` 之类一律拉黑）。
交付物必须是单个纯 Go exe。

### 6.2 ⚠️ 本机 Go 1.27.2 的 `intptr` 是坏的

`C:\Program Files\Go\src\cmd\compile\internal\types\universe.go` 的预声明类型表里
缺了 `{"intptr", TINTPTR, TINT32, TINT64}` 那一行，导致**任何用到 `intptr` 的 Go 代码
都编译失败**，标准库与第三方模块一样中招。

- 与内核交互一律用 `uintptr` / `int32` / `uint32`。`GWL_EXSTYLE` 这类本来就是 32 位 LONG，
  用 `int32` 反而更贴切。
- **不要**尝试修 GOROOT，那是 `C:\Program Files` 下的系统文件。
- `internal/winos`、`internal/icon`、`internal/winreg`、`internal/backup` 里的
  `syscall.SyscallN` 调用全部遵守这条；`unsafe.Pointer` 中转是允许的（`uintptr(p)`
  直转不行，见 `internal/winreg/syscall_windows.go` 的注释）。

### 6.3 `golang.org/x/sys/windows` v0.49 的限制

- **没有导出 `POINT` / `RECT`**。自己定义（`internal/winreg` 里没有用到，
  需要时照 Win32 原样写：`X, Y int32`）。
- 只提供 `IsWindowVisible` / `EnumWindows` / `DwmGetWindowAttribute` /
  `DwmSetWindowAttribute` 等少数几个，其余 Win32 调用一律
  `syscall.NewLazyDLL` + `syscall.SyscallN`（见 `internal/winos/winos_windows.go`）。

### 6.4 跨平台文件

平台相关代码用构建标签分文件：`*_windows.go` / `*_other.go`。
本项目**只在 Windows 上实测**，但保留空实现让 `go vet` / `go build` 在任何平台干净通过。

### 6.5 交付前必跑

```bash
bun run typecheck          # tsc --noEmit
go vet ./...               # 必须无输出
gofmt -l .                 # 必须无输出
CGO_ENABLED=0 go build ./... # 必须通过
go test ./...              # 纯逻辑单测
```

## 7. 提权与删除语义（不可破坏）

- 默认 `asInvoker` 运行。**只有**卸载 / 删除条目 / 清理残留这三类操作走 `runas` 提权，
  提权的是**窄范围的辅助进程**（`reg.exe` / `sc.exe` / `schtasks.exe` / `powershell.exe`），
  **UI 主进程始终存活，不重启自身**（`internal/winos.ElevateAndWait`）。
- 设置里的「启动时请求管理员」是**唯一**一处以 `runas` 重启自身的地方（`Duster.requestElevation`）。
- 强制删除（`forceUninstallApp`）**绝不调用软件自带的卸载程序**；扫描是只读预览，
  用户取消则软件与文件保持原样。
- 删除前先备份注册表（`internal/backup`），受保护路径/系统组件一律拒绝
  （`leftovers.IsProtected` / `leftovers.IsProtectedKey`）。
- `delete_leftovers` **只接受后端缓存的扫描结果 id**，前端无法注入任意路径。
- 前端只渲染 UI，**所有系统能力在 Go**（注册表扫描、图标提取、提权、导出）。
  判断新代码该写哪边：**它是否需要「操作系统」的知识？** 需要 → Go。

## 8. 前端主题：只用 lumina 的 Fluent 语义令牌

配色与 lumina / PickScreen 共用同一套令牌，定义在 `src/index.css`。**组件里不写死色值**，
只用语义类，明暗两套值由 CSS 变量提供，因此**组件里不允许出现 `dark:` 变体**。

| 类别 | 变量 | 用途 |
| --- | --- | --- |
| 表面 | `--bg` `--layer` `--layer-solid` `--card` `--card-hover` `--acrylic` `--dialog` `--dialog-footer` | 窗口底 / 侧栏表头 / 卡片 / 浮层 / 对话框 |
| 描边 | `--stroke` `--stroke-strong` | 分隔线、控件边框 |
| 文字 | `--text` `--text-2` `--text-3` `--on-accent` | 主 / 次 / 三级文字 |
| 悬停 | `--subtle-hover` `--subtle-press` | hover / active 反馈面 |
| 强调 | `--accent` `--accent-hover` `--accent-soft` | 主按钮、选中态、单选 |
| 功能色 | `--success` `--warning` `--danger` `--info` `--brand` `--game`（各带 `-soft` 变体） | 状态提示、软件类型徽标、危险操作 |
| 投影 | `--shadow-flyout` `--shadow-dialog` | 浮出菜单 / 对话框 |

**2026-10-03 起样式层已从 Tailwind 改为手写原生 CSS**（`a7f8c62`）。`index.css` 现在
1,208 行，分 `@layer base`（从 Tailwind v4 preflight 抄来的重置）+ `@layer components`
（360 个手写语义类）。要点：

- **组件里写语义类**（`.nav-item` `.btn` `.dialog-*` `.checkbox-box--on` …），不写工具类。
  新增样式就往 `@layer components` 里加一条规则，不要引入构建期工具。
- 颜色一律 `var(--*)`；**不再有 `dark:` 变体**（明暗靠属性，见规则 2）。
- `cn()` 只是 `clsx`（`tailwind-merge` 已移除，它对语义类是空转）。

规则：

1. **改主题 = 改 `src/index.css` 的 `:root` / `:root[data-theme="dark"]`**，
   不要在组件里塞十六进制或 `zinc/indigo/amber/...` 这类调色板类。
2. **明暗切换是 `<html data-theme="dark">` 属性**（`App.tsx` 的 `useTheme`），
   不是 class。已删掉旧的 `@custom-variant dark`，别再加回来。
3. `Badge` 的 `tone` 与 `KIND_TONE` 的键名是**业务语义**（`'green' | 'amber' | 'red' |
   'sky' | 'violet' | 'pink' | 'indigo' | 'neutral'`），只映射到 `toneClass`，
   改颜色时改映射表，不要改调用点的字符串。
4. **两处刻意不随主题变**：`--console-*`（卸载日志 / 错误详情的终端式深底）、
   `AppIcon` 的 `TILE_COLORS`（12 色软件身份色块，在 `utils/format.ts`）。
5. **Tailwind 已移除**（`tailwindcss` / `@tailwindcss/vite` / `tailwind-merge` 都不在依赖里，
   `vite.config.ts` 里也没有 `tailwindcss()` 插件）。**别再加回来**：它靠扫描源文件猜哪些类
   被用了，而本项目用 `vite-plugin-singlefile`，上次构建内联进 `dist/index.html` 的旧类名
   会被重新扫进去，已删的类死灰复燃（迁移前为此付过 30 KB 死 CSS 的代价）。手写 CSS 没有
   这个自反馈。
6. **改动界面后要复核**：`bun run build:web` 之后确认产物里没有工具类残留
   （`Select-String -Path dist\index.html -Pattern '@theme|@tailwind'` 应无输出），
   并且 `class` 串里用到的每个类在 `index.css` 都有定义 —— 写了类却漏了规则，
   是这类手写样式最常见的静默失败。

自查：

```powershell
# 1) 源码零调色板硬编码（应只命中 index.css 的注释）
Select-String -Path src\**\*.tsx,src\*.css -Pattern '(zinc|indigo|amber|emerald|sky|violet|pink)-\d{2,3}'
# 2) 源码零 dark: 变体
Select-String -Path src\**\*.tsx -Pattern 'dark:'
# 3) 产物零 Tailwind 指令
$d = Get-Content dist\index.html -Raw; ([regex]::Matches($d,'@theme|@tailwind')).Count   # 要 0
```

## 9. 验证步骤

```bash
bun run typecheck     # tsc --noEmit
bun run build:web    # vite build（只构建前端，不碰 Go）
```

改到 Go 时追加 §6.5 的四条。

**交付前必须查产物**（源码对 ≠ 打进包了）——Vite 会把 `index.html` 与 `src/**`
内联进单个 `dist/index.html`：

```powershell
$d = Get-Content dist\index.html -Raw
$d -match '要确认的文案'      # 确认改动进了产物
```

## 10. Go 侧与外壳的耦合点

改 Go 方法后必须重新生成 TS 客户端，否则前端拿不到新方法：

```bash
bun run generate      # = mygo generate，写 src\mygo.ts（**不要手改那个文件**）
```

`src/mygo.ts` 是生成物。`src/ipc/commands.ts` 是桥接层，负责把 Go 的返回值
转成 `types/app.ts` 的类型（主要是枚举字面量收窄）与错误归一。

## 11. 已知技术债

- `force_remove_app` 在 Rust 版是死代码（未注册进 `invoke_handler`）。Go 版**没有**保留
  它 —— `forceUninstallApp`（只读预览）+ `deleteLeftovers`（按缓存 id 删除）
  已经覆盖了「不调卸载器直接清理」这条路径，且更安全（前端无法传任意路径）。
  若要恢复成单条命令，需要重新设计它的参数面（它原本要接受前端传的 itemIds）。
- **`mygo build` 被杀软拦截**（§3.1），当前无法在本机产出可交付 exe。等用户决定放行方式。
- Go 侧只在 Windows 上验证过；`internal/*` 的 `*_other.go` 有非 Windows 空实现，
  但 macOS / Linux 未实测。
- 商店应用扫描依赖 PowerShell `Get-AppxPackage`，在禁用了 PowerShell 的策略环境下
  会静默返回空列表（这是**有意为之**：可选功能不该拖垮主列表）。

## 12. 改动前先核对清单

1. 改产品名了吗？→ §4 的 11 处，漏一处就分裂
2. 动了 `identifier` 吗？→ 会连带改 `%APPDATA%` 数据目录，属数据迁移
3. 动了图标吗？→ §5，注意图标文件在仓库根 `icon.png`，别放进 `build\`（会被构建覆盖）
4. 动了提权/删除路径吗？→ §7，三类操作以外一律不弹 UAC
5. 新的能力该写前端还是 Go？→ §7 末尾那条判据
6. 改了 Go 的绑定方法吗？→ §10，跑 `bun run generate`
7. 改了 Go 代码吗？→ §6.5 四条 + `go test ./...`
8. 要暂存/提交吗？→ 用户没明确要求就不要 commit / push（仓库已在 `main`）
9. 要删文件吗？→ 先问用户；删除走运行时可恢复删除，不要用永久删除命令
10. 改了界面颜色/主题吗？→ §8，只用 CSS 变量令牌 + 手写语义类；别加 `dark:` 变体、别把 Tailwind 加回来
11. 交付 exe 了吗？→ §3，放 `D:\Tool\Duster.exe`；**不要**出安装包；注意 §3.1 的杀软阻塞