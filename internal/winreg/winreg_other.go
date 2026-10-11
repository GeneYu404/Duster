//go:build !windows

package winreg

import (
	"errors"

	"golang.org/x/sys/windows/registry"
)

// 非 Windows 的空实现：整个程序只面向 Windows（AGENTS.md §0），
// 但保留这些桩函数让 `go vet ./...` / `go build ./...` 在任何平台上都干净通过。

var errUnsupported = errors.New("注册表操作仅支持 Windows")

type View uint32

const (
	View64 View = 0x100
	View32 View = 0x200
)

type RootRef struct{}

func (r RootRef) HiveName() string { return "" }
func (r RootRef) LongName() string { return "" }
func (r RootRef) Open(uint32) (registry.Key, error) {
	return registry.Key(0), errUnsupported
}

func SplitPath(string) (RootRef, bool)              { return RootRef{}, false }
func OpenPath(string, uint32) (registry.Key, error) { return registry.Key(0), errUnsupported }
func CreatePath(string, uint32) (registry.Key, error) {
	return registry.Key(0), errUnsupported
}
func Exists(string) bool                         { return false }
func SubKeyNames(registry.Key) ([]string, error) { return nil, errUnsupported }
func ValueNames(registry.Key) ([]string, error)  { return nil, errUnsupported }

type Value struct {
	Name  string
	Type  uint32
	Bytes []byte
}

func ReadValues(registry.Key) ([]Value, error) { return nil, errUnsupported }
func ReadValue(registry.Key, string) (Value, error) {
	return Value{}, errUnsupported
}
func WriteValue(registry.Key, Value) error  { return errUnsupported }
func DeleteTree(registry.Key, string) error { return errUnsupported }
