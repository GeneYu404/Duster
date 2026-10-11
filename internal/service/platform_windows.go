//go:build windows

package service

import (
	"syscall"

	"golang.org/x/sys/windows/registry"
)

// regeditLastKeyPath 是 regedit 记住「上次打开哪个键」的位置。
const regeditLastKeyPath = `Software\Microsoft\Windows\CurrentVersion\Applets\Regedit`

// registryCreateLastKey 打开（或创建）regedit 的 LastKey 所在键。
func registryCreateLastKey() (registry.Key, error) {
	k, _, err := registry.CreateKey(registry.CURRENT_USER, regeditLastKeyPath, registry.SET_VALUE)
	return k, err
}

// hiddenProcAttr 返回「不弹控制台窗口」的进程属性。
func hiddenProcAttr() *syscall.SysProcAttr {
	return &syscall.SysProcAttr{HideWindow: true}
}
