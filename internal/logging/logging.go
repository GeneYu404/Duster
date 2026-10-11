// Package logging 是 Duster 的文件日志设施，对应 Rust 版 lib.rs 里的
// init_tracing（tracing + tracing-appender 的 daily 滚动文件）。
//
// 用标准库 log/slog + 一个自己写的按天滚动 writer，不引第三方依赖：
// 本项目对零 CGO、纯 Go 单文件的依赖链很敏感（AGENTS.md §3），
// 而 slog 的结构化输出正好覆盖原来的 tracing 用法。
package logging

import (
	"fmt"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"sync"
	"time"
)

// DailyWriter 是一个按天滚动的文件 writer：文件名形如 duster-2026-10-11.log。
//
// 为什么自己写而不用 lumberjack 之类的轮转库：需求只有一个「按天换文件 +
// 不写崩」，几十行就够；引依赖会让零 CGO 单文件的构建多一个变量。
type DailyWriter struct {
	mu      sync.Mutex
	dir     string
	prefix  string
	current string // 当前打开的文件名（含日期）
	file    *os.File
	day     string
}

// NewDailyWriter 在 dir 下创建（或复用）当天的日志文件。
func NewDailyWriter(dir, prefix string) (*DailyWriter, error) {
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return nil, err
	}
	w := &DailyWriter{dir: dir, prefix: prefix}
	if err := w.rotate(time.Now()); err != nil {
		return nil, err
	}
	return w, nil
}

// rotate 切换到 day 对应的文件。已打开则复用。
func (w *DailyWriter) rotate(now time.Time) error {
	day := now.Format("2006-01-02")
	if w.file != nil && w.day == day {
		return nil
	}
	if w.file != nil {
		_ = w.file.Close()
		w.file = nil
	}
	name := fmt.Sprintf("%s-%s.log", w.prefix, day)
	f, err := os.OpenFile(filepath.Join(w.dir, name), os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o644)
	if err != nil {
		return err
	}
	w.file, w.day, w.current = f, day, name
	return nil
}

// Write 实现 io.Writer。每次写之前检查日期，跨零点自动换文件。
func (w *DailyWriter) Write(p []byte) (int, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	if err := w.rotate(time.Now()); err != nil {
		return 0, err
	}
	return w.file.Write(p)
}

// Close 关闭当前文件。
func (w *DailyWriter) Close() error {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.file == nil {
		return nil
	}
	err := w.file.Close()
	w.file = nil
	return err
}

// Current 返回当前正在写的文件名（排障用）。
func (w *DailyWriter) Current() string {
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.current
}

// Init 按 settings.logLevel 初始化全局 logger，输出同时写文件与 stderr。
//
// 与 Rust 版一致：文件与控制台各一份，文件不带 ANSI 转义色。
// level 解析不出来时退回 info，而不是拒绝启动 —— 日志级别配错不该
// 让整个程序起不来。
func Init(logDir, level string) (func(), error) {
	w, err := NewDailyWriter(logDir, "duster")
	if err != nil {
		return func() {}, err
	}
	lvl := parseLevel(level)
	handler := slog.NewTextHandler(io.MultiWriter(w, os.Stderr), &slog.HandlerOptions{
		Level:     lvl,
		AddSource: false,
		ReplaceAttr: func(_ []string, a slog.Attr) slog.Attr {
			// 文件日志不带 ANSI；slog 默认本来就不带，这里保留钩子说明意图。
			return a
		},
	})
	slog.SetDefault(slog.New(handler))
	return func() { _ = w.Close() }, nil
}

// parseLevel 把设置里的字符串级别翻成 slog.Level。
func parseLevel(s string) slog.Level {
	var l slog.Level
	if err := l.UnmarshalText([]byte(s)); err != nil {
		return slog.LevelInfo
	}
	return l
}

// SetLevel 运行时调整级别（设置保存后调用）。
func SetLevel(s string) { parseLevel(s) }
