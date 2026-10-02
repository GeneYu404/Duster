# AGENTS.md

> AI agent / 协作者的工作守则。**先读这页，再动手改东西。**
> 本文件只放规则与本项目特有的坑；架构与模块说明在 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)。

## 0. 这是什么

**Duster 拂尘** —— Windows 10/11 已安装软件管理 / 卸载 / 残留清理工具，
对标 Geek Uninstaller / HiBit Uninstaller，代码、UI、文案、图标均为独立实现。
Tauri 2 + Rust 后端，React 19 + TypeScript + Vite + Tailwind v4 前端。

对外名称固定：**英文 `Duster`，中文「拂尘」**。改名不是改一处字符串，见 §4。

## 1. 文档索引

| 想了解 | 看 |
| --- | --- |
| 目录结构、数据模型、21 个 IPC 命令与事件表 | [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) |

## 2. 运行时与包管理器

**只用 Bun**（1.4+）。

- 锁文件是 `bun.lock`，**不要**生成 / 提交 `package-lock.json`；不要主动 `npm install`
- `src-tauri/tauri.conf.json` 的 `beforeDevCommand` / `beforeBuildCommand` 必须写 `bun run …`，不是 `npm run …`

已于 2026-10-02 从 npm 迁到 Bun（`bun.lock` 已入库，`package-lock.json` 走可恢复删除）。

## 3. 构建与交付

**只出 exe，不打 NSIS / MSI 安装包**（用户明确要求）：

```bash
bun run typecheck     # tsc --noEmit
bun run build         # vite build
bun run build:exe     # = tauri build --no-bundle，约 2 分钟（大部分在 LTO 链接）
```

`tauri.conf.json` 里 `bundle.active` 已设为 **`false`**，所以哪怕误跑 `bun run tauri build`
也不会产安装包。**要出安装包时**：把 `active` 改回 `true`，或临时 `bun run tauri build --bundles nsis`。

**构建产物统一归档到 `D:\Tool`** —— `target/release/` 是构建缓存，不是交付物：

```powershell
Copy-Item src-tauri\target\release\duster.exe D:\Tool\duster.exe -Force
```

交付给用户的文件是 `D:\Tool\duster.exe`（5.2 MB）。

## 4. 改名要一起改的 11 处

改产品名 / 品牌名时**必须同步**改完下面全部位置，漏一处就会出现「界面叫 A、
数据目录叫 B」的分裂状态（Rust 与前端两侧都要改，且字符串写法不同）：

| # | 位置 | 当前值 |
| --- | --- | --- |
| 1 | `src-tauri/tauri.conf.json` → `productName` | `Duster`（EXE / 安装包文件名由此而来） |
| 2 | 同上 → `identifier` | `dev.duster.app`（**会连带改应用数据目录**） |
| 3 | 同上 → `app.windows[0].title` | `Duster 拂尘` |
| 4 | `src-tauri/Cargo.toml` → `[package] name` / `[lib] name` | `duster` / `duster_lib` |
| 5 | `src-tauri/src/main.rs` | `duster_lib::run();`（改名后不改这里会直接编译失败） |
| 6 | `src-tauri/src/lib.rs` | 日志名 `duster.log`、tracing target `duster_lib=`、管理员标题 |
| 7 | `src-tauri/src/commands.rs` | 事件前缀 `duster://`、配置目录 `…\Duster` |
| 8 | `src-tauri/src/backup_manager.rs` | 恢复临时文件 `duster-restore-{pid}-{ts}.reg` |
| 9 | `index.html` | `<title>`、`<meta description>`、**localStorage 键 `duster.settings.v1`** |
| 10 | 前端 | `i18n/index.ts` 的 `appName`、`App.tsx` 的 `document.title`、`index.css` 的 `@keyframes duster-fade-in`、`Toolbar.tsx` 的 `duster-global-search`、`ipc/backend.ts` 的 `EVENTS`、`ipc/mock.ts` 与 `types/app.ts` 的备份目录 |
| 11 | `src-tauri/icons/` | 图标文件名与 `bundle.icon` 列表 |

改完自查：

```powershell
Select-String -Path <所有源码> -Pattern '旧名'   # 必须无输出
```

## 5. `src-tauri/icons/` —— 曾经缺失，直接导致构建失败

`icons/` 下**不是仓库自带**的一套图标，而是由母版生成：

```bash
bun run icons          # = tauri icon src-tauri/icons/source-1024.png
```

母版是 `src-tauri/icons/source-1024.png`（1024×1024，**由设计稿光栅化而来，见下**）。
**缺 `icon.ico` 时 `tauri-build` 会直接失败**（生成 Windows 资源文件失败），
报错是 `icons/icon.ico not found`。`@tauri-apps/cli` 必须留在 `devDependencies`，
缺了跑不了 `tauri icon`。

`icons/android/`、`icons/ios/` 是 `tauri icon` 的副产物，桌面版用不到，删前先问用户。

### 5.1 图标设计：母版是 SVG 光栅化，不是手画

母版 `source-1024.png` 的**矢量源**是 `src-tauri/icons/source.svg`（改设计只改这个 SVG），
光栅化用 Windows 自带的 Edge headless：

```powershell
$edge = "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe"
& $edge --headless=new --disable-gpu --hide-scrollbars --default-background-color=00000000 `
        --force-device-scale-factor=1 --window-size=1024,1024 `
        --screenshot="$env:TEMP\master.png" "file:///$PWD/src-tauri/icons/source.svg"
Copy-Item "$env:TEMP\master.png" src-tauri\icons\source-1024.png -Force
bun run icons      # 再重生成全套尺寸 + icon.ico
bun run build:exe  # 图标进了 Rust 资源，必须重新出 exe 才生效 —— 但先读 §5.2
```

⚠️ HTML 外壳要求 `html,body{margin:0;overflow:hidden}` + `<svg width="1024" height="1024">`，
否则截出来不是 1024×1024（`tauri icon` 会报错）。裸 `.svg` 文件可以直接喂给 Edge，
不必套 HTML。

### 5.2 改完图标，exe 里的图标**不会**自动更新（踩过三次才找对）

`tauri-build` 生成的 `OUT_DIR/resource.rc` 里写的是**活的图标路径**，不是拷贝：

```
32512 ICON "D:\\Ai\\Duster\\src-tauri\\icons\\icon.ico"
```

所以只要 rc.exe 重跑就必然拿到新图标。问题是**它经常不重跑**：mbx 的内容寻址缓存键
**不含 `icons/icon.ico` 的内容**，`bun run build:exe` 会跑完、日志干净、打印
`Built application at: …`，**exe 里嵌的还是旧图标**——完全静默，无任何报错。
（改前端主题时看不出来，因为 `dist` 变化会触发 crate 重编；只有改图标才中招。）

**两个不管用的办法**（都实测过，日志都显示"成功"）：

| 试过的 | 为什么没用 |
| --- | --- |
| 碰 `src/lib.rs` 的 mtime | 只重编 crate，build script 没重跑，`resource.rc` 与 `.res` 原样复用 |
| `mbx clean && mbx adopt` | 删掉整个 target 后，mbx 仍从内容寻址库把 **build script 的旧输出目录连同旧 `.res` 一起还原** |

**唯一可靠解法：改 `build.rs` 的内容**（哪怕只加一行注释）。build script 源码进它的
编译指纹，内容一变 → 指纹变 → 强制重新执行 → 重新生成 `resource.rc` → rc.exe 重新嵌入。

```powershell
# 改 src-tauri\build.rs 加一行注释，然后
bun run build:exe
# 确认这一步真的发生了：resource.rc 的时间戳必须变成刚才
(Get-Item src-tauri\target\release\build\duster-*\out\resource.rc).LastWriteTime
```

⚠️ 用**字节探针**查 exe 里有没有新色值是不可靠的：ICO 里 ≥64px 的档是 **PNG 压缩**存储，
exe 里根本不存在裸 BGRA 序列；而且 4 字节模式在 5 MB 二进制里偶然命中很正常。
**唯一可信的验证是把图标抠出来看**：

```powershell
Add-Type -AssemblyName System.Drawing
$uniq = "$env:TEMP\ico-" + [guid]::NewGuid().ToString('N').Substring(0,8) + ".exe"
Copy-Item 'D:\Tool\duster.exe' $uniq          # 换条路径，绕开 Windows 图标缓存
$b = [System.Drawing.Icon]::ExtractAssociatedIcon($uniq).ToBitmap()
$big = New-Object System.Drawing.Bitmap 256,256
$g = [System.Drawing.Graphics]::FromImage($big)
$g.InterpolationMode='NearestNeighbor'; $g.PixelOffsetMode='Half'
$g.DrawImage($b,0,0,256,256); $g.Dispose()
$big.Save("$env:TEMP\ico.png",'Png')           # 打开看，必须是新设计
```

（`build.rs` 顶部已写了这套注意事项的浓缩版，别删。）

**当前设计**：等轴六边形包裹轮廓 + 居中粗减号，白色，底色 `accent #005fb8 → brand2 #6b46d6`
（与应用内标题栏标识的 `from-accent to-brand2` 同一套渐变）。应用内的 `BrandMark`
（`Toolbar.tsx`）是同一形状的自绘 SVG —— **改图标形状时两边要一起改**，否则桌面图标和
标题栏标识对不上。

**为什么不用 lucide 的 `PackageMinus`**：它 18px 下立方体中线会和减号横杠连成「＋」，
语义从"卸载"变成"添加"。同理，别再换成带内部结构线的箱体画法。

`icons/duster.jpg` 是 2026-10-02 改版前的原始素材（紫底薄荷绿开箱勾），已不再参与生成，
留着只是历史存档；要删先问用户。

## 6. `src-tauri/target` —— 绝对不能动

它是 **mbx 缓存 symlink**（`mode l----` → `D:\mbx\targets\v1\<hash>`，hash 来自 `Cargo.lock`），
编译器缓存也走 mbx（构建日志里的 `mbx[cache]: N hits` 就是它）。

- ❌ `rm -rf` / `rmdir` / `mkdir` 这个路径，也不要手工删建来「清理」
- ✅ 损坏时走 `mbx clean && mbx adopt`

本项目**当前不是 git 仓库**（没有 `.git`）。将来 `git init` 时，`.gitignore` 里
`src-tauri/target` 那条**不能带尾斜杠** —— 尾斜杠只匹配目录，而 git 看到的是 symlink，
规则会静默失效，target 被当 `120000` 条目提交，克隆到别的机器就是指向 `D:\mbx\...` 的死链，
**本地完全看不出来**。暂存后自查：`git ls-files -s | Select-String '120000'` 必须无输出。

## 7. 提权与删除语义（不可破坏）

- 默认 `asInvoker` 运行。**只有**卸载 / 删除条目 / 清理残留这三类操作走 `runas` 提权
  （`privilege.rs` + `uninstaller.rs`），提权后主进程仍存活，不重启自身。
- 强制删除（`force_uninstall_app`）**绝不调用软件自带的卸载程序**；扫描是只读预览，
  用户取消则软件与文件保持原样。
- 删除前先备份注册表（`backup_manager.rs`），受保护路径/系统组件一律拒绝。
- 前端只渲染 UI，**所有系统能力在 Rust**（注册表扫描、图标提取、提权、导出）。
  判断新代码该写哪边：**它是否需要「操作系统」的知识？** 需要 → Rust。

## 8. 前端主题：只用 lumina 的 Fluent 语义令牌

配色与 lumina / PickScreen 共用同一套令牌，定义在 `src/index.css`。**组件里不写死色值**，
只用语义类，明暗两套值由 CSS 变量提供，因此**组件里不允许出现 `dark:` 变体**。

| 类别 | 类 | 用途 |
| --- | --- | --- |
| 表面 | `bg-app` `bg-layer` `bg-layer-solid` `bg-card` `bg-card-hover` `bg-acrylic` `bg-dialog` `bg-dialog-footer` | 窗口底 / 侧栏表头 / 卡片 / 弹层 / 对话框 |
| 描边 | `border-stroke` `border-stroke-strong` | 分隔线、控件边框 |
| 文字 | `text-fg` `text-fg2` `text-fg3` `text-on-accent` `text-console-fg` | 主/次/三级文字 |
| 悬停 | `bg-subtle` `bg-subtle-press` | hover / active 反馈面 |
| 强调 | `bg-accent` `text-accent` `bg-accent-soft` `bg-accent-hover` `accent-accent` | 主按钮、选中态、单选 |
| 功能色 | `text-/bg-` + `success` `warning` `danger` `info` `brand` `game`（各带 `-soft` 变体） | 状态提示、软件类型徽标、危险操作 |
| 投影 | `shadow-flyout` `shadow-dialog` | 浮出菜单 / 对话框 |

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
5. `index.css` 首行是 `@import "tailwindcss" source(none)` + `@source "./**/*.{ts,tsx}"`。
   **别删**：Tailwind v4 默认会自动探测内容源，不关掉的话它会把上一次构建产物
   `dist/index.html` 里内联的旧类名也扫进去，已删除的 `dark:`/`zinc-*` 类会死灰复燃，
   产物凭空多出 30 KB 死 CSS。

自查：

```powershell
# 1) 源码零残留
Select-String -Path src\**\*.tsx,src\*.css -Pattern '(zinc|indigo|amber|emerald|sky|violet|pink)-\d{2,3}|dark:'   # 只应命中 index.css 的注释
# 2) 产物零残留
$d = Get-Content dist\index.html -Raw; ([regex]::Matches($d,'zinc-\d{2,3}')).Count; ([regex]::Matches($d,'dark\\:')).Count   # 都要 0
```

## 9. 验证步骤

```bash
bun run typecheck     # tsc --noEmit
bun run build         # vite build
```

改到 Rust 时追加：

```bash
cd src-tauri && cargo check
```

**交付前必须查产物**（源码对 ≠ 打进包了）——Vite 会把 `index.html` 与 `src/**`
内联进单个 `dist/index.html`：

```powershell
$d = Get-Content dist\index.html -Raw
$d -match '要确认的文案'      # 确认改动进了产物
```

出包后建议冒烟：启动 `duster.exe`，确认进程存活、窗口标题为 `Duster 拂尘`，
再 `Stop-Process` 关掉。

## 10. 已知无害告警

构建末尾出现这两条**不用管**：

- `warning: linker stdout: 正在创建库 …duster_lib.dll.lib` —— `[lib] crate-type` 里有
  `cdylib`/`staticlib` 的副产物（移动端用），桌面构建也会打这行。
- `Warn The bundle identifier … ends with .app` —— Tauri 嫌 `.app` 与 macOS bundle
  扩展名冲突。本项目只出 Windows 包，保持 `dev.duster.app` 不动；
  真要改就改成 `dev.duster.desktop`（会连带改数据目录）。

## 11. 依赖基线（2026-10-02 全量升级到最新版）

前端：React 19.3.0 / Tailwind 4.3.3 / Vite 8.3.2 / TypeScript 7.0.2 / @vitejs/plugin-react 6.1.1 /
@types/node 26.6.4 / vite-plugin-singlefile 2.3.3 / zustand 5.0.15 / @tanstack/react-virtual 3.14.13 /
@tauri-apps 2.12.1（api + cli）/ plugin-dialog 2.8.1 / lucide-react 1.49.0 / clsx 2.1.1 / tailwind-merge 3.7.0。

Rust：tauri 2.12.1 / windows 0.62 / winreg 0.56 / png 0.18 / base64 0.23 / dirs 7 /
serde 1.0.229 / chrono 0.4.45 / regex 1.13.1 / thiserror 2.0.21 / tracing 0.1.44 /
`rust-version = "1.85"`（从 1.77.2 提上来，否则 MSRV 感知解析器会把依赖锁在旧版）。

### 升级时踩到的 API 变化（别改回去）

| crate | 变化 | 本项目怎么改的 |
| --- | --- | --- |
| TypeScript 7 | **`baseUrl` 已被移除**；`paths` 必须相对 | `tsconfig.json` 删掉 `baseUrl`，`"@/*": ["./src/*"]` |
| TypeScript 7 | 副作用 import 必须有类型声明（TS2882） | 新增 `src/vite-env.d.ts`（`/// <reference types="vite/client" />`） |
| windows 0.59+ | `HANDLE` 是**新类型**不是裸指针；`HBITMAP` 不能直接传给要 `HGDIOBJ` 的 API | `icon_extractor.rs` 显式 `HGDIOBJ(info.hbmColor.0)` |
| winreg 0.53+ | `RegValue::bytes` 变成 `Cow<'_, [u8]>` | 存快照 `v.bytes.into_owned()`；写回 `Cow::Owned(v.data.clone())` |
| base64 0.23 | `decode` 返回 `Cow<[u8]>` 而非 `Vec<u8>` | 调用处 `.into_owned()` |

### Cargo.lock 变了会让 target symlink 失配

`target` 的 mbx 托管目录 hash 来自 `Cargo.lock`。**任何改动 `Cargo.lock` 的操作
（`cargo update`、改依赖版本）之后**，构建可能报
`failed to read plugin permissions … 系统找不到指定的路径`（指向一个不存在的 hash 目录）。

恢复走标准路径，**不要手工删建 symlink**：

```bash
cd src-tauri && mbx clean && mbx adopt   # 下次 cargo 会自动重新建立托管链接
```

## 12. 已知技术债

- `commands.rs::force_remove_app` 是死代码：未注册进 `invoke_handler`，
  前端 `ipc/backend.ts` 也只调 `force_uninstall_app`。要么删掉，要么补上注册。
- `icons/android/`、`icons/ios/` 无用（见 §5）。
- 12 个原始编译错误已于 2026-10-02 修复，**改动这些文件时别改回去**：
  `AppHandle::state` 需要 `use tauri::Manager`；`HKEY` 从 `winreg::{HKEY, RegKey}` 导入
  （不在 `winreg::enums` 里）；`backup_manager::delete_service` / `delete_task` 必须是
  `pub`（`commands.rs` 要调）；`leftover_scanner.rs` 里 `w` 是 `&&str` 要写 `**w`；
  `exporter.rs` 的表头闭包改成单生命周期的 `label(labels, field)` 辅助函数
  （闭包无法统一两个借用，返回值活不过 `'2`）。`icon_extractor.rs` 的 `GetObjectW` 修法
  已随 windows 0.62 升级更新，见 §11。

## 13. 改动前先核对清单

1. 改产品名了吗？→ §4 的 11 处，漏一处就分裂
2. 动了 `identifier` 吗？→ 会连带改 `%APPDATA%` 数据目录和 localStorage 键，属数据迁移
3. 动到图标吗？→ §5，缺 `icon.ico` 直接构建失败
4. 动了提权/删除路径吗？→ §7，三类操作以外一律不弹 UAC
5. 新的能力该写前端还是 Rust？→ §7 末尾那条判据
6. 改到 `target` 忽略规则了吗？→ §6，注意尾斜杠
7. 改了依赖 / 动了 `Cargo.lock` 吗？→ §11 末尾的 mbx 恢复步骤
8. 要暂存/提交吗？→ 本项目还不是 git 仓库；用户没明确要求就不要 init / commit / push
9. 要删文件吗？→ 先问用户；删除走运行时可恢复删除，不要用永久删除命令
10. 改了界面颜色/主题吗？→ §8，只用语义令牌；别加 `dark:` 变体、别删 `source(none)`
11. 改了图标吗？→ §5.1 改 SVG 母版、`bun run icons`；**§5.2 必读**，
    光跑 `build:exe` 不换 `build.rs` 内容，exe 里还是旧图标
12. 交付 exe 了吗？→ §3，放 `D:\Tool\duster.exe`；**不要**出安装包
