//go:build !windows

package backup

import (
	"os"

	"duster/internal/apperr"
	"duster/internal/model"
)

// 非 Windows 的空实现。整个程序只面向 Windows（AGENTS.md §0），
// 但保留桩函数让 `go vet ./...` / `go build ./...` 在任何平台上都干净通过。

func SnapshotKey(string) (KeySnapshot, error) {
	return KeySnapshot{}, apperr.Other("registry backups are only supported on Windows")
}

func DeleteKey(string) error { return apperr.Other("registry deletion is only supported on Windows") }

func DeleteService(string) (bool, error) {
	return false, apperr.Other("service deletion is only supported on Windows")
}

func DeleteTask(string) (bool, error) {
	return false, apperr.Other("scheduled task deletion is only supported on Windows")
}

// DeletePath 非 Windows 上仍然可以删普通文件，只是没有回收站概念。
func DeletePath(path string, useRecycleBin bool) (bool, error) {
	st, err := os.Lstat(path)
	if err != nil {
		return false, apperr.IO(err)
	}
	if st.IsDir() {
		return false, apperr.IO(os.RemoveAll(path))
	}
	return false, apperr.IO(os.Remove(path))
}

var _ = model.BackupInfo{}
