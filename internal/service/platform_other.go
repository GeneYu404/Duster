//go:build !windows

package service

import (
	"errors"
	"syscall"

	"golang.org/x/sys/windows/registry"
)

// 非 Windows 的空实现。整个程序只面向 Windows（AGENTS.md §0）。

func registryCreateLastKey() (registry.Key, error) {
	return registry.Key(0), errors.New("regedit is only available on Windows")
}

func hiddenProcAttr() *syscall.SysProcAttr { return nil }
