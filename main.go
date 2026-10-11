// Command duster 是 Duster 拂尘 的桌面外壳（Go 1.27 + MyGo 3）。
//
// 2026-10-11 从 Tauri 2 + Rust 重写而来，Rust 版已移除。React 前端一行没动，
// 只换了与外壳耦合的桥接层（src/ipc/commands.ts）。
//
//	bun run dev        # mygo dev：窗口 + 热更新
//	bun run build:exe  # → build/portable/duster.exe（只出 exe，不打安装包）
//	go test ./...      # 纯逻辑：命令解析、残留匹配、导出
//
// 提权语义（AGENTS.md §7，迁移后逐条保留）：
//   - 默认以普通用户运行；只有「卸载 / 删除条目 / 清理残留」三类操作走 runas 提权，
//     提权的是**窄范围的辅助进程**（reg.exe / sc.exe / schtasks.exe / powershell.exe），
//     UI 主进程始终存活，不重启自身；
//   - 设置里的「启动时请求管理员」是唯一一处以 runas 重启自身的地方。
package main

import (
	"log"
	"log/slog"
	"path/filepath"

	"github.com/egoist/mygo"

	"duster/internal/appstate"
	"duster/internal/logging"
	"duster/internal/service"
	"duster/internal/winos"
)

// 窗口参数，与原 tauri.conf.json 的 app.windows[0] 逐项对应。
const (
	appTitle  = "Duster 拂尘"
	winWidth  = 1240
	winHeight = 780
	minWidth  = 900
	minHeight = 560
)

func main() {
	// 日志必须在任何其他初始化之前就位：扫描/删除路径上的报错全靠它留痕。
	settings := appstate.LoadSettings()
	closeLog, err := logging.Init(filepath.Join(appstate.DataDir(), "logs"), settings.LogLevel)
	if err != nil {
		// 日志目录写不了（比如 %APPDATA% 被重定向到只读位置）不该让程序起不来。
		log.Printf("初始化文件日志失败，改用标准日志: %v", err)
		closeLog = func() {}
	}
	defer closeLog()

	slog.Info("Duster 启动",
		"portable", settings.PortableMode,
		"elevated", winos.IsElevated(),
		"data_dir", appstate.DataDir())

	// 单例：第二个实例直接退出。
	//
	// Duster 是「看一眼就关」的列表工具，同时开两个实例会让两边各自
	// 缓存一份列表，其中一个卸载之后另一个还显示着幽灵条目。
	if !mygo.App.RequestSingleInstanceLock() {
		return
	}

	svc := service.New()
	mygo.Bind(svc)

	mygo.App.WhenReady(func() {
		createWindow()
		// 第二个实例启动时把已有窗口叫到前台，而不是静默退出。
		mygo.App.OnSecondInstance(func(_ []string, _ string) {
			if w := mainWindow(); w != nil {
				w.Show()
				w.Focus()
			}
		})
	})

	if err := mygo.App.Run(); err != nil {
		log.Fatalf("Duster 启动失败: %v", err)
	}
}

// mainWindow 是本进程唯一窗口的注册位。
//
// MyGo 的 WindowOptions 没有 Tauri 那套 label 字段，窗口身份由我们自己维护
// （PickScreen 也是这么做的）。
var mainWindowVar *mygo.Window

// mainWindow 返回主窗口（尚未创建时为 nil）。
func mainWindow() *mygo.Window { return mainWindowVar }

// createWindow 建主窗口。
func createWindow() {
	// 提权后标题加后缀：用户一眼就能看出当前窗口有没有管理员权限，
	// 这在「HKLM 键删不掉」这类问题上能省掉一轮排查。
	title := appTitle
	if winos.IsElevated() {
		title = appTitle + " (Administrator)"
	}

	w := mygo.NewWindow(mygo.WindowOptions{
		Title:    title,
		URL:      "/",
		Width:    winWidth,
		Height:   winHeight,
		MinWidth: minWidth,
		// MinHeight 与 MinWidth 一起给：只给一半会让窗口被拖到极小高度。
		MinHeight:       minHeight,
		BackgroundColor: "light-dark(#f3f3f6, #202020)",
	})
	mainWindowVar = w

	// 页面就绪后立刻把窗口显示出来。
	//
	// 为什么不用 Hidden + 前端通知：原 Rust 版没有这个问题（Tauri 会等
	// 首帧），而 MyGo 默认是同步显示。这里不做特殊处理，保持与参考实现
	// （PickScreen / lumina）一致的简单路径。
	w.OnReadyToShow(func() { w.Show() })
}
