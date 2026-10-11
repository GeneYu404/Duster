//go:build windows

package backup

import (
	"os"
	"os/exec"
	"strings"
	"syscall"
	"time"
	"unsafe"

	"github.com/egoist/mygo"

	"duster/internal/apperr"
	"duster/internal/winos"
)

var shell32 = syscall.NewLazyDLL("shell32.dll")

var procSHFileOperationW = shell32.NewProc("SHFileOperationW")

// unsafePointerTo 把结构体指针转成可传给 Syscall 的整数。
//
// 必须走 unsafe.Pointer 中转：uintptr(p) 是一次纯整数转换，
// Go 内存模型不保证它之后仍指向那块内存。
func unsafePointerTo[T any](p *T) uintptr { return uintptr(unsafe.Pointer(p)) }

// timeNowNano 是 time.Now().UnixNano 的短别名。
func timeNowNano() int64 { return time.Now().UnixNano() }

// pathExists 报告路径是否还在。
func pathExists(p string) bool { _, err := os.Lstat(p); return err == nil }

// isPermissionDenied 判断是不是权限不足。
func isPermissionDenied(err error) bool {
	return err != nil && os.IsPermission(err)
}

// quoteWindowsArg 按 Windows 的命令行规则给参数加引号。
//
// 反斜杠加倍、引号前补反斜杠 —— 这是 CommandLineToArgvW 的解析规则，
// 少一个转义就会让带空格的路径被切成两半（Rust 版 quote_windows_arg 同算法）。
func quoteWindowsArg(value string) string {
	if !strings.ContainsAny(value, " \t\"") {
		return value
	}
	var sb strings.Builder
	sb.WriteByte('"')
	slashes := 0
	for _, c := range value {
		switch c {
		case '\\':
			slashes++
		case '"':
			sb.WriteString(strings.Repeat(`\`, slashes*2+1))
			sb.WriteByte('"')
			slashes = 0
		default:
			sb.WriteString(strings.Repeat(`\`, slashes))
			sb.WriteRune(c)
			slashes = 0
		}
	}
	sb.WriteString(strings.Repeat(`\`, slashes*2))
	sb.WriteByte('"')
	return sb.String()
}

// runHidden 跑一个辅助进程并等它结束，返回退出码。不弹控制台窗口。
func runHidden(program string, args ...string) (int, error) {
	cmd := exec.Command(program, args...)
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: winos.HideNoWindow}
	err := cmd.Run()
	if err == nil {
		return cmd.ProcessState.ExitCode(), nil
	}
	var exitErr *exec.ExitError
	if ok := asExitError(err, &exitErr); ok {
		return exitErr.ExitCode(), nil
	}
	return 0, err
}

// asExitError 是 errors.As 的薄封装。
func asExitError(err error, target **exec.ExitError) bool {
	if e, ok := err.(*exec.ExitError); ok {
		*target = e
		return true
	}
	return false
}

// shellTrashItem 走 MyGo 的 Shell 模块（SHFileOperation + FOF_ALLOWUNDO）。
func shellTrashItem(path string) error { return mygo.Shell.TrashItem(path) }

// shellFileOperation 是自己声明的 SHFileOperation 兜底实现：
// 某些路径（超长路径、UNC）下 MyGo 那层会失败，这里再试一次原始 API。
func shellFileOperation(path string, isDir bool) bool {
	from, err := syscall.UTF16PtrFromString(path)
	if err != nil {
		return false
	}
	type fileOp struct {
		Hwnd                 uintptr
		Func                 uint32
		From                 *uint16
		To                   *uint16
		Flags                uint16
		AnyOperationsAborted int32
		NameMappings         uintptr
		ProgressTitle        *uint16
	}
	op := fileOp{
		Func:  3, // FO_DELETE
		From:  from,
		Flags: 0x0004 | 0x0010 | 0x0040 | 0x0400, // SILENT | NOCONFIRMATION | ALLOWUNDO | NOERRORUI
	}
	ret, _, _ := syscall.SyscallN(procSHFileOperationW.Addr(), uintptr(unsafePointerTo(&op)))
	if ret != 0 {
		return false
	}
	return op.AnyOperationsAborted == 0
}

// elevatedRecycle 提权后送回收站。
//
// 用 Microsoft.VisualBasic.FileIO 而不是 Remove-Item：前者才是真正的
// 「进回收站」，后者是永久删除 —— 垃圾清理工具把用户的文件永久删掉
// 是不可接受的。
func elevatedRecycle(path string, isDir bool) error {
	operation := "DeleteFile"
	if isDir {
		operation = "DeleteDirectory"
	}
	escaped := strings.ReplaceAll(path, "'", "''")
	script := "Add-Type -AssemblyName Microsoft.VisualBasic; " +
		"[Microsoft.VisualBasic.FileIO.FileSystem]::" + operation + "('" + escaped +
		"', [Microsoft.VisualBasic.FileIO.UIOption]::OnlyErrorDialogs, " +
		"[Microsoft.VisualBasic.FileIO.RecycleOption]::SendToRecycleBin)"
	code, err := winos.ElevateAndWait("powershell.exe",
		"-NoProfile -NonInteractive -Command "+quoteWindowsArg(script))
	if err != nil {
		return apperr.Other("elevation failed: " + err.Error())
	}
	if code != 0 {
		return apperr.Other("elevated recycle helper exited with " + itoa(int(code)) + ": " + path)
	}
	return nil
}

// elevatedRemove 提权后永久删除。
func elevatedRemove(path string, recursive bool) error {
	escaped := strings.ReplaceAll(path, "'", "''")
	recursiveArg := ""
	if recursive {
		recursiveArg = " -Recurse"
	}
	script := "$ErrorActionPreference='Stop'; Remove-Item -LiteralPath '" + escaped + "'" + recursiveArg + " -Force"
	code, err := winos.ElevateAndWait("powershell.exe",
		"-NoProfile -NonInteractive -Command "+quoteWindowsArg(script))
	if err != nil {
		if winos.IsCancelled(err) {
			return apperr.ElevationRequired("UAC request was cancelled")
		}
		return apperr.Process("elevated delete helper failed: " + err.Error())
	}
	if code != 0 {
		return apperr.Other("elevated delete helper exited with " + itoa(int(code)) + ": " + path)
	}
	return nil
}
