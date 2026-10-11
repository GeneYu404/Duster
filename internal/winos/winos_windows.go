//go:build windows

// Package winos 封装 Duster 用到的 Windows 专有能力：UAC 提权与 ShellExecuteEx。
//
// 分文件约定：
//   - winos_windows.go  本文件，真正的实现
//   - winos_other.go    非 Windows 的空实现
//
// ⚠️ 本机 Go 1.27.2 的 cmd/compile/internal/types/universe.go 被改坏过 ——
// 预声明类型表里缺了 `{"intptr", TINTPTR, TINT32, TINT64}` 那一行，导致任何用到
// intptr 的 Go 代码都编译失败，标准库与第三方模块一样中招。所以这里一律用
// uintptr / int32 与内核交互：SHELLEXECUTEINFOW 里的 hProcess 本来就是 HANDLE
// （uintptr），nShow 是 32 位 int32。
package winos

import (
	"strings"
	"syscall"
	"unsafe"

	"golang.org/x/sys/windows"
)

var (
	shell32 = syscall.NewLazyDLL("shell32.dll")

	procShellExecuteExW = shell32.NewProc("ShellExecuteExW")
)

// SHELLEXECUTEINFOW 与 Win32 的结构体布局一致。
type shellExecuteInfo struct {
	CBSize     uint32
	FMask      uint32
	Hwnd       uintptr
	Verb       *uint16
	File       *uint16
	Parameters *uint16
	Directory  *uint16
	NShow      int32
	InstApp    uintptr
	IDList     uintptr
	Class      *uint16
	KeyClass   uintptr // HKEY；这里只做透传，取值恒为 0（NULL）
	HotKey     uint32
	Icon       uintptr
	Process    uintptr
}

const (
	seeMaskNoAsync           = 0x00000010
	seeMaskNoCloseProc       = 0x00000040
	swShowNormal       int32 = 1
	swHide             int32 = 0

	// ERROR_CANCELLED：用户点了 UAC 对话框的「否」。这是「用户主动放弃」，
	// 不是失败 —— 卸载流程要把它翻译成 cancelled 而不是报错。
	errorCancelled = 1223
)

// utf16Ptr 把 Go 字符串转成 Win32 需要的 UTF-16 指针。
func utf16Ptr(s string) *uint16 {
	buf, err := syscall.UTF16FromString(s)
	if err != nil {
		return nil
	}
	return &buf[0]
}

// IsElevated 报告当前进程是否以管理员身份运行。
//
// 用 x/sys 的 Token.IsElevated（GetTokenInformation + TokenElevation），
// 与 Rust 版 privilege::is_elevated 是同一个 API。
func IsElevated() bool {
	tok, err := windows.OpenCurrentProcessToken()
	if err != nil {
		return false
	}
	defer tok.Close()
	return tok.IsElevated()
}

// CanElevate 报告本平台是否支持 UAC 提权。Windows 恒为 true。
func CanElevate() bool { return true }

// shellExecuteExW 是三个提权路径共用的底层调用。
//
// 注意错误判定：ShellExecuteExW 的**返回值**才是真正的错误码，
// GetLastError 只在返回值 <= 32 时才有意义。Rust 版读 GetLastError，
// 这里读返回值 —— 两者在实践中一致，但返回值是文档规定的口径。
func shellExecuteExW(verb, file, params string, mask uint32, nShow int32) (windows.Handle, error) {
	info := shellExecuteInfo{
		CBSize:     uint32(unsafe.Sizeof(shellExecuteInfo{})),
		FMask:      mask,
		Verb:       utf16Ptr(verb),
		File:       utf16Ptr(file),
		Parameters: utf16Ptr(params),
		NShow:      nShow,
	}
	ret, _, _ := syscall.SyscallN(procShellExecuteExW.Addr(), uintptr(unsafe.Pointer(&info)))
	if ret > 32 {
		return windows.Handle(info.Process), nil
	}
	// 返回值 <= 32 即错误：ShellExecuteEx 把 Win32 错误码直接放在返回值里，
	// 只有返回 0 时才需要回落到 GetLastError。
	if ret == 0 {
		if e := syscall.GetLastError(); e != nil {
			if errno, ok := e.(syscall.Errno); ok {
				return 0, errno
			}
		}
		return 0, syscall.EINVAL
	}
	return 0, syscall.Errno(uint32(ret))
}

// ExitCodeOf 等待进程结束并取回退出码。调用方负责 Close。
func ExitCodeOf(h windows.Handle) (int32, error) {
	if _, err := syscall.WaitForSingleObject(syscall.Handle(h), syscall.INFINITE); err != nil {
		return 0, err
	}
	var code uint32
	if err := syscall.GetExitCodeProcess(syscall.Handle(h), &code); err != nil {
		return 0, err
	}
	return int32(code), nil
}

// ElevateAndWait 以 runas 启动一个进程、等它结束并返回退出码。
//
// 这是「窄范围提权助手」的通用入口：注册表导入、reg delete、sc delete、
// schtasks delete、提权回收站、提权删除都走它。UI 主进程始终存活，
// 不需要为了改一个键就重启自己。
func ElevateAndWait(program, params string) (int32, error) {
	h, err := shellExecuteExW("runas", program, params, seeMaskNoAsync|seeMaskNoCloseProc, swHide)
	if err != nil {
		if errno, ok := err.(syscall.Errno); ok && uint32(errno) == errorCancelled {
			return 0, ErrCancelled
		}
		return 0, err
	}
	defer windows.CloseHandle(h)
	return ExitCodeOf(h)
}

// LaunchAndWait 以普通权限启动卸载器并等它结束，返回退出码。
//
// 卸载器走 CreateProcess 而不是 ShellExecute：ShellExecute 会把请求转交给
// explorer.exe 之类的 DDE 宿主再启动，退出码与真正的卸载进程对不上，
// 而 Duster 的结果判定完全依赖退出码。
//
// 命令行按 Win32 规则整体拼一个可变的 UTF-16 缓冲区传给 CreateProcessW
// （lpApplicationName 传 nil，表示由解析器从命令行里取程序名）。
// 参数串**原样**拼接、不做二次转义：卸载器对引号极其敏感，
// 任何「更安全」的重新转义都可能把命令行改坏。
func LaunchAndWait(program, args string) (int32, error) {
	commandLine, err := buildCommandLine(program, args)
	if err != nil {
		return 0, err
	}
	si := syscall.StartupInfo{}
	si.Cb = uint32(unsafe.Sizeof(si))
	pi := syscall.ProcessInformation{}
	if err := syscall.CreateProcess(
		nil, &commandLine[0], nil, nil, false,
		uint32(syscall.CREATE_UNICODE_ENVIRONMENT), nil, nil, &si, &pi,
	); err != nil {
		return 0, err
	}
	defer windows.CloseHandle(windows.Handle(pi.Thread))
	defer windows.CloseHandle(windows.Handle(pi.Process))
	return ExitCodeOf(windows.Handle(pi.Process))
}

// buildCommandLine 拼出 NUL 结尾的 UTF-16 命令行。
func buildCommandLine(program, args string) ([]uint16, error) {
	// 程序名含空格时必须加引号，否则 CreateProcess 只会截到第一个空格。
	quoted := program
	if strings.ContainsAny(program, " \t") {
		quoted = `"` + program + `"`
	}
	line, err := syscall.UTF16FromString(quoted)
	if err != nil {
		return nil, err
	}
	if args != "" {
		line = append(line, ' ')
		line, err = syscall.UTF16FromString(args)
		if err != nil {
			return nil, err
		}
	}
	return append(line, 0), nil
}

// ErrCancelled 表示用户在 UAC 对话框点了「否」（ERROR_CANCELLED / 1223）。
var ErrCancelled = syscall.Errno(errorCancelled)

// IsCancelled 判断一个错误是不是「用户拒绝了 UAC」。
func IsCancelled(err error) bool {
	if err == nil {
		return false
	}
	if errno, ok := err.(syscall.Errno); ok {
		return uint32(errno) == errorCancelled
	}
	return false
}

// HideNoWindow 是 CREATE_NO_WINDOW：启动 PowerShell / sc.exe 等辅助进程时
// 不闪一个黑框。与 Rust 版的 CREATE_NO_WINDOW 常量同义。
const HideNoWindow = 0x08000000
