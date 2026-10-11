//go:build !windows

package icon

import "duster/internal/model"

// 非 Windows 上没有 ExtractIconExW，取不到图标（Rust 版同样只支持 Windows）。
// 返回空串表示「没有图标」，前端会回退到自绘的字母色块。
func ExtractPNGDataURL(model.InstalledApp) string { return "" }
