//go:build !windows

package winos

import "errors"

// 非 Windows 的空实现：整个程序只面向 Windows（AGENTS.md §0），
// 但保留这些桩函数让 `go vet ./...` / `go build ./...` 在任何平台上都干净通过。

var errUnsupported = errors.New("该功能仅支持 Windows")

// IsElevated 在非 Windows 上恒为 false。
func IsElevated() bool { return false }

// CanElevate 在非 Windows 上恒为 false（没有 UAC）。
func CanElevate() bool { return false }

// ElevateAndWait 在非 Windows 上无法提权。
func ElevateAndWait(program, params string) (int32, error) { return 0, errUnsupported }

// LaunchAndWait 在非 Windows 上不支持卸载（Rust 版同样只支持 Windows）。
func LaunchAndWait(program, args string) (int32, error) { return 0, errUnsupported }

// IsCancelled 在非 Windows 上恒为 false。
func IsCancelled(error) bool { return false }

// HideNoWindow 仅 Windows 有意义，这里给 0 免得调用点编译不过。
const HideNoWindow = 0
