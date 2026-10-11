//go:build windows

package winreg

import (
	"fmt"
	"syscall"
	"unsafe"

	"golang.org/x/sys/windows/registry"
)

var (
	advapi32           = syscall.NewLazyDLL("advapi32.dll")
	procRegSetValueExW = advapi32.NewProc("RegSetValueExW")
	procRegDeleteTreeW = advapi32.NewProc("RegDeleteTreeW")
)

// utf16Ptr 把 Go 字符串转成 Win32 需要的 UTF-16 指针。
func utf16Ptr(s string) (*uint16, error) { return syscall.UTF16PtrFromString(s) }

// unsafePointerOf 取切片的第一个字节地址，供 RegSetValueExW 传裸缓冲区。
//
// 用 unsafe.Pointer(&b[0]) 而不是切片头：RegSetValueExW 要的是
// 「缓冲区起始地址 + 长度」两个独立参数，Go 切片头里还混着 len/cap。
func unsafePointerOf(b byte) unsafe.Pointer { return unsafe.Pointer(&b) }

// uint32ptrFromPtr 把指针转成可传给 Syscall 的整数。
//
// ⚠️ 不能直接 uintptr(p)：那是一次「整数转换」，Go 内存模型不保证它仍然
// 指向同一块内存。必须走 unsafe.Pointer 中转，这也是所有 syscall 封装的
// 标准写法。本项目只需要在调用栈上活着的那一瞬间取值（Syscall 之前），
// 不存到任何结构体里，所以这个用法是安全的。
func uint32ptrFromPtr[T any](p *T) uintptr { return uintptr(unsafe.Pointer(p)) }

// errnoFromRet 把 Win32 的非零返回码翻成 error。
func errnoFromRet(ret uintptr) error {
	if ret == uintptr(syscall.ERROR_FILE_NOT_FOUND) {
		return registry.ErrNotExist
	}
	return syscall.Errno(ret)
}

func errBadPath(path string) error { return fmt.Errorf("注册表路径无法解析: %s", path) }

var errShortBuffer = fmt.Errorf("注册表值缓冲区不足")
