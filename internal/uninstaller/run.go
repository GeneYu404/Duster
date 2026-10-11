package uninstaller

import (
	"log/slog"
	"os"
	"strconv"
	"time"

	"duster/internal/apperr"
	"duster/internal/model"
)

// isRegularFile 是 os.Stat 的薄封装，唯一目的是让 splitProgram /
// ProgramExists 读起来像一句话，并且集中处理「打不开就当不存在」。
func isRegularFile(p string) bool {
	st, err := os.Stat(p)
	return err == nil && !st.IsDir()
}

// Run 执行卸载器，把每一行日志通过 onLog 推给调用方（前端用来滚动显示）。
//
// 返回 UninstallResult 而不是 error：绝大多数「没卸载成功」的情况
// （用户取消、卸载器自己报错、文件已经不在了）都是**正常的业务结果**，
// 不是异常。只有命令行根本无法解析、进程根本起不来这类才真的返回 error。
func Run(app model.InstalledApp, quiet, elevated bool, onLog func(string)) (model.UninstallResult, error) {
	started := time.Now()
	log := make([]string, 0, 8)

	emit := func(line string) {
		stamped := "[" + time.Now().Format("15:04:05") + "] " + line
		log = append(log, stamped)
		if onLog != nil {
			onLog(stamped)
		}
	}

	fail := func(msg string, exit *int32, cmdLine string) model.UninstallResult {
		return model.UninstallResult{
			AppID: app.ID, Success: false, ExitCode: exit,
			Message: msg, CommandLine: cmdLine,
			DurationMS: uint64(time.Since(started).Milliseconds()), Log: log,
		}
	}

	// 静默优先用 QuietUninstallString；没有就退回普通卸载串。
	source := app.UninstallStr
	if quiet {
		if app.QuietStr != nil {
			source = app.QuietStr
		}
	}

	emit("Resolving uninstall command for \"" + app.Name + "\"…")
	if source == nil || *source == "" {
		emit("No UninstallString / QuietUninstallString in the registry key.")
		return fail("No uninstall command available", nil, ""), nil
	}

	parsed, err := ParseCommand(*source, quiet)
	if err != nil {
		return model.UninstallResult{}, err
	}
	emit("Command: " + parsed.Normalized)

	if !ProgramExists(parsed.Program) {
		emit("Uninstaller not found on disk: " + parsed.Program)
		// 退出码 2 与 Windows 的「找不到文件」对齐，前端会照常显示退出码。
		code := int32(2)
		return fail("Uninstaller executable is missing", &code, parsed.Normalized), nil
	}

	var exitCode int32
	if elevated {
		emit("Launching process…")
		exitCode, err = spawnAndWait(parsed)
	} else {
		emit("Not elevated — launching through ShellExecute(runas), UAC prompt expected…")
		exitCode, err = spawnElevatedAndWait(parsed)
	}
	if err != nil {
		return model.UninstallResult{}, err
	}

	verdict := DescribeExitCode(exitCode)
	emit("Process exited with code " + strconv.FormatInt(int64(exitCode), 10) + ": " + verdict.Message)
	slog.Info("卸载结束",
		"app", app.Name, "exit_code", exitCode, "success", verdict.Success,
		"cancelled", verdict.Cancelled, "reboot", verdict.RebootNeeded)

	code := exitCode
	return model.UninstallResult{
		AppID:        app.ID,
		Success:      verdict.Success,
		ExitCode:     &code,
		RebootNeeded: verdict.RebootNeeded,
		Cancelled:    verdict.Cancelled,
		Message:      verdict.Message,
		CommandLine:  parsed.Normalized,
		DurationMS:   uint64(time.Since(started).Milliseconds()),
		Log:          log,
	}, nil
}

// spawnErr 统一 spawn 失败的错误类型，便于边界处判断。
func spawnErr(msg string, err error) error { return apperr.Process(msg + ": " + err.Error()) }
