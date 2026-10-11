// Package uninstaller 解析并执行 UninstallString / QuietUninstallString。
//
// 对应原 Rust 的 src-tauri/src/uninstaller.rs，行为逐条对齐：
//   - MsiExec.exe /I{GUID} 与 /X{GUID} 统一规范成 msiexec.exe /x {GUID}，
//     静默模式再补 /qn /norestart；
//   - 处理带引号的路径、不带引号但含空格的路径、以及尾部参数；
//   - 未提权时走 ShellExecuteExW("runas") 弹 UAC，已提权时直接 CreateProcess；
//   - 退出码 0/3010 成功、1602/1223 用户取消、1605 已卸载 ……
//
// 本文件是**纯逻辑**部分（解析），不含任何系统调用，所以可以脱离 Windows
// 单测；真正 spawn 进程的部分在 spawn_windows.go / spawn_other.go。
package uninstaller

import (
	"os"
	"path/filepath"
	"regexp"
	"strings"

	"duster/internal/apperr"
	"duster/internal/model"
)

var (
	// msiRe 匹配 msiexec 的 /i 或 /x 调用。
	//
	// 写成 (?i) 内联大小写不敏感，而不是 (?i:...)，是因为 RE2 不支持
	// Rust 那种「按捕获组拼回原文」的写法，这里也不需要拼回。
	//
	// 前缀用了非贪婪的 `.*?`，让 `"C:\Windows\System32\MsiExec.exe" /I{...}`
	// 这种带引号带路径的写法也能命中。
	msiRe = regexp.MustCompile(`(?i)^\s*"?[^"\r\n]*?msiexec(?:\.exe)?"?\s+[/-]\s*([ix])\s*(\{[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}\})(.*)$`)

	// envRe 匹配 %VAR%。注册表里的路径经常是未展开的 %ProgramFiles%\...。
	envRe = regexp.MustCompile(`%([^%]+)%`)
)

// ExpandEnvironment 展开命令里的 %VAR%。
//
// 展开失败（变量不存在）时**原样保留** `%VAR%`：删掉它会让路径变成
// 一个看起来正常、实际指向不存在目录的命令，比留着 %VAR% 危险得多。
func ExpandEnvironment(command string) string {
	return envRe.ReplaceAllStringFunc(command, func(m string) string {
		name := m[1 : len(m)-1]
		if v, ok := os.LookupEnv(name); ok {
			return v
		}
		return m
	})
}

// ParseCommand 解析一条卸载命令，返回程序、参数与规范化命令行。
func ParseCommand(command string, quiet bool) (model.ParsedCommand, error) {
	expanded := ExpandEnvironment(command)
	s := strings.TrimSpace(expanded)
	if s == "" {
		return model.ParsedCommand{}, apperr.InvalidCommand("empty command")
	}

	if m := msiRe.FindStringSubmatch(s); m != nil {
		code := strings.ToUpper(m[2])
		extra := strings.TrimSpace(m[3])
		parts := []string{"/x", code}
		if extra != "" {
			parts = append(parts, extra)
		}
		if quiet {
			// 已经有静默/不重启标志就别重复加 —— msiexec 对重复开关会告警。
			lower := strings.ToLower(extra)
			if !strings.Contains(lower, "/qn") && !strings.Contains(lower, "/quiet") {
				parts = append(parts, "/qn")
			}
			if !strings.Contains(lower, "/norestart") {
				parts = append(parts, "/norestart")
			}
		}
		args := strings.Join(parts, " ")
		return model.ParsedCommand{
			Program:    "msiexec.exe",
			Args:       args,
			IsMSI:      true,
			Normalized: "msiexec.exe " + args,
		}, nil
	}

	program, args := splitProgram(s)
	if program == "" {
		return model.ParsedCommand{}, apperr.InvalidCommand(command)
	}
	quoted := program
	if strings.Contains(program, " ") {
		quoted = `"` + program + `"`
	}
	normalized := quoted
	if args != "" {
		normalized = quoted + " " + args
	}
	lowerProg := strings.ToLower(program)
	return model.ParsedCommand{
		Program:    program,
		Args:       args,
		IsMSI:      strings.HasSuffix(lowerProg, "msiexec.exe") || lowerProg == "msiexec",
		Normalized: normalized,
	}, nil
}

// splitProgram 把命令行切成「程序 + 参数」。
//
// 带引号时取第一对引号；否则按「第一个真实存在的 .exe」切 —— 目录名里
// 可能有空格（`C:\Program Files\Foo\...`），只看第一个空格会把路径切碎。
// 磁盘上没有对应文件时（已经卸载了一半）退回到 .exe / .cmd / .bat 边界，
// 再退回第一个空格。
func splitProgram(s string) (string, string) {
	if rest, ok := strings.CutPrefix(s, `"`); ok {
		if end := strings.Index(rest, `"`); end >= 0 {
			return rest[:end], strings.TrimSpace(rest[end+1:])
		}
		return rest, ""
	}

	lower := strings.ToLower(s)
	firstBoundary := -1
	searchFrom := 0
	for {
		pos := strings.Index(lower[searchFrom:], ".exe")
		if pos < 0 {
			break
		}
		end := searchFrom + pos + 4
		if firstBoundary < 0 {
			firstBoundary = end
		}
		candidate := s[:end]
		if isRegularFile(candidate) {
			return candidate, strings.TrimSpace(s[end:])
		}
		searchFrom = end
		if searchFrom >= len(lower) {
			break
		}
	}
	if firstBoundary < 0 {
		for _, ext := range []string{".cmd", ".bat"} {
			if p := strings.Index(lower, ext); p >= 0 {
				firstBoundary = p + 4
				break
			}
		}
	}
	if firstBoundary > 0 {
		return s[:firstBoundary], strings.TrimSpace(s[firstBoundary:])
	}
	if i := strings.Index(s, " "); i >= 0 {
		return s[:i], strings.TrimSpace(s[i+1:])
	}
	return s, ""
}

// ProgramExists 报告卸载程序是否真的能在磁盘上找到。
//
// 绝对路径直接查；裸名（msiexec.exe / wusa.exe / powershell.exe）先查
// System32 再查 PATH —— PowerShell 实际住在 System32\WindowsPowerShell\v1.0。
func ProgramExists(program string) bool {
	if p := program; filepath.IsAbs(p) {
		return isRegularFile(p)
	}
	if windir := os.Getenv("SystemRoot"); windir != "" {
		if isRegularFile(filepath.Join(windir, "System32", program)) {
			return true
		}
		if strings.EqualFold(program, "powershell.exe") &&
			isRegularFile(filepath.Join(windir, `System32\WindowsPowerShell\v1.0`, program)) {
			return true
		}
	}
	for _, dir := range filepath.SplitList(os.Getenv("PATH")) {
		if isRegularFile(filepath.Join(dir, program)) {
			return true
		}
	}
	return false
}

// ExitVerdict 是对某个退出码的解释。
type ExitVerdict struct {
	Message      string
	Success      bool
	RebootNeeded bool
	Cancelled    bool
}

// DescribeExitCode 把卸载器退出码翻成给用户看的一句话。
//
// 表是照抄 Windows Installer 的语义（Rust 版 same）：0/1605 成功、3010/1641
// 成功但要重启、1602/1223 用户取消。1605 算成功是因为「已经卸载过了」
// 对用户而言就是达成了目的。
func DescribeExitCode(code int32) ExitVerdict {
	switch code {
	case 0:
		return ExitVerdict{Message: "Uninstalled successfully", Success: true}
	case 3010, 1641:
		return ExitVerdict{Message: "Uninstalled; a restart is required", Success: true, RebootNeeded: true}
	case 1602, 1223:
		return ExitVerdict{Message: "Cancelled by the user", Cancelled: true}
	case 1605:
		return ExitVerdict{Message: "Product is not installed (already removed)", Success: true}
	case 1603:
		return ExitVerdict{Message: "Fatal error during installation (1603)"}
	case 1618:
		return ExitVerdict{Message: "Another installation is already in progress (1618)"}
	case 2:
		return ExitVerdict{Message: "The system cannot find the file specified"}
	case 5:
		return ExitVerdict{Message: "Access denied"}
	default:
		return ExitVerdict{Message: "Uninstaller exited with a non-zero code"}
	}
}
