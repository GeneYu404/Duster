//go:build !windows

package scanner

import (
	"os/exec"
	"syscall"
)

// createNoWindow 仅 Windows 有意义，这里给 0 免得调用点编译不过。
const createNoWindow = 0

// 非 Windows 上没有「不要控制台窗口」这回事，返回 nil 让 exec 用默认值。
func hiddenProcAttr() *syscall.SysProcAttr { return nil }
