//go:build windows

package uninstaller

import (
	"duster/internal/model"
	"duster/internal/winos"
)

// spawnAndWait 在**已提权**的当前进程里直接 CreateProcess 卸载器。
func spawnAndWait(cmd model.ParsedCommand) (int32, error) {
	code, err := winos.LaunchAndWait(cmd.Program, cmd.Args)
	if err != nil {
		return 0, spawnErr("CreateProcess failed for "+cmd.Program, err)
	}
	return code, nil
}

// spawnElevatedAndWait 未提权时用 ShellExecuteExW("runas") 启动卸载器，
// 于是 UAC 对话框由系统弹出，而 Duster 主进程全程存活、界面不闪。
func spawnElevatedAndWait(cmd model.ParsedCommand) (int32, error) {
	code, err := winos.ElevateAndWait(cmd.Program, cmd.Args)
	if err != nil {
		// 用户在 UAC 上点了「否」：这是取消，不是故障。
		// 返回 1223 让上层走 cancelled 分支，与 Windows Installer 的 1602 一致。
		if winos.IsCancelled(err) {
			return 1223, nil
		}
		return 0, spawnErr("ShellExecuteEx failed", err)
	}
	return code, nil
}
