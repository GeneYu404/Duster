// Package apperr 是统一错误类型，对应原 Rust 的 src-tauri/src/error.rs。
//
// 协议差异（重要）：Rust 侧把 AppError 序列化成 `{ code, message, details }`
// 结构体跨 IPC；MyGo 只会把 Go 的 error 变成**一个字符串**（err.Error()）。
// 为了不让前端的 toAppError 丢掉错误码，这里让 Error() 返回一段 JSON，
// 前端桥接层再解析回来 —— 这样 AppError 的结构化契约原样保留，
// 而不是退化成一句看不懂的英文。
package apperr

import (
	"encoding/json"
	"errors"
	"fmt"
)

// 错误码。取值与 Rust 的 `AppError::code()` 完全一致，前端按字符串比对。
const (
	CodeAppNotFound     = "APP_NOT_FOUND"
	CodeRegistry        = "REGISTRY"
	CodePathNotFound    = "PATH_NOT_FOUND"
	CodeProtectedPath   = "PROTECTED_PATH"
	CodeElevationNeeded = "ELEVATION_REQUIRED"
	CodeInvalidCommand  = "INVALID_COMMAND"
	CodeBackup          = "BACKUP"
	CodeBackupNotFound  = "BACKUP_NOT_FOUND"
	CodeProcess         = "PROCESS"
	CodeIO              = "IO"
	CodeJSON            = "JSON"
	CodeUnknown         = "UNKNOWN"
)

// Error 是一条带错误码的应用错误。
type Error struct {
	Code    string
	Message string
	Details string
}

func (e *Error) Error() string {
	// 返回 JSON 而不是纯文案：MyGo 的 IPC 只能传字符串，而前端的
	// toAppError 对字符串会先尝试 JSON.parse —— 这条路径已经存在，
	// 解析成功就能拿回 code / message / details 三件套。
	wire := struct {
		Code    string `json:"code"`
		Message string `json:"message"`
		Details string `json:"details,omitempty"`
	}{e.Code, e.Message, e.Details}
	raw, err := json.Marshal(wire)
	if err != nil {
		// 理论上不可达（三个都是 string），但宁可退回纯文案也不能 panic。
		return e.Message
	}
	return string(raw)
}

// New 构造一条带错误码的错误。message 面向用户，details 只在排障时用。
func New(code, message string) *Error { return &Error{Code: code, Message: message} }

// Newf 是 New 的格式化版本。
func Newf(code, format string, args ...any) *Error {
	return &Error{Code: code, Message: fmt.Sprintf(format, args...)}
}

// WithDetails 挂上排障细节，返回同一条错误（链式调用）。
func (e *Error) WithDetails(format string, args ...any) *Error {
	e.Details = fmt.Sprintf(format, args...)
	return e
}

// 下面这组是与 Rust 的 enum AppError 逐个对应的构造器。

func AppNotFound(v string) *Error { return New(CodeAppNotFound, "application not found: "+v) }
func Registry(v string) *Error    { return New(CodeRegistry, "registry error: "+v) }
func Registryf(f string, a ...any) *Error {
	return New(CodeRegistry, "registry error: "+fmt.Sprintf(f, a...))
}
func PathNotFound(v string) *Error { return New(CodePathNotFound, "path not found: "+v) }
func ProtectedPath(v string) *Error {
	return New(CodeProtectedPath, "refusing to touch protected path: "+v)
}
func ElevationRequired(v string) *Error {
	return New(CodeElevationNeeded, "administrator rights required: "+v)
}
func InvalidCommand(v string) *Error { return New(CodeInvalidCommand, "invalid uninstall command: "+v) }
func Backup(v string) *Error         { return New(CodeBackup, "backup failed: "+v) }
func BackupNotFound(v string) *Error { return New(CodeBackupNotFound, "backup not found: "+v) }
func Process(v string) *Error        { return New(CodeProcess, "process error: "+v) }
func IO(err error) *Error {
	// Rust 版对 Io 单独带 details（Debug 格式），这里保留同样的信息量。
	return (&Error{Code: CodeIO, Message: "I/O error: " + err.Error()}).WithDetails("%v", err)
}
func JSON(err error) *Error {
	return (&Error{Code: CodeJSON, Message: "serialisation error: " + err.Error()}).WithDetails("%v", err)
}
func Other(v string) *Error { return New(CodeUnknown, v) }

// CodeOf 从任意 error 里取出错误码；不是 AppError 时返回 UNKNOWN。
func CodeOf(err error) string {
	var ae *Error
	if errors.As(err, &ae) {
		return ae.Code
	}
	return CodeUnknown
}
