//go:build !windows

package uninstaller

import (
	"duster/internal/apperr"
	"duster/internal/model"
)

// 非 Windows 上卸载无从谈起（AGENTS.md §0：本程序只面向 Windows）。
// 保留桩函数让跨平台 `go build ./...` / `go vet ./...` 干净通过。

func spawnAndWait(model.ParsedCommand) (int32, error) {
	return 0, apperr.Other("uninstall is only supported on Windows")
}

func spawnElevatedAndWait(model.ParsedCommand) (int32, error) {
	return spawnAndWait(model.ParsedCommand{})
}
