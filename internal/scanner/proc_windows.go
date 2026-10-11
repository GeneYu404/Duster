//go:build windows

package scanner

import "syscall"

// createNoWindow 是 CREATE_NO_WINDOW：启动子进程时不为其分配控制台窗口。
// 与 Rust 版 scanner 里的同名常量同义。
const createNoWindow = 0x08000000

// hiddenProcAttr 返回「不要为子进程开控制台窗口」的进程属性。
//
// 扫商店应用要拉起 powershell.exe，不加这个会闪一个黑框，
// 桌面应用里尤其难看。
func hiddenProcAttr() *syscall.SysProcAttr {
	return &syscall.SysProcAttr{HideWindow: true, CreationFlags: createNoWindow}
}
