// Package winreg 是 Duster 用到的注册表能力的最小封装。
//
// 原 Rust 版用 winreg crate，这里换成 golang.org/x/sys/windows/registry +
// 少量 LazyDLL 补齐（原始值读写、递归删除）。选它而不是自己声明
// RegOpenKeyEx 等一整套，是因为 WOW64 视图标志（WOW64_64KEY / WOW64_32KEY）
// 是 Duster 扫描逻辑的核心，交给经过验证的封装更稳妥。
//
// 路径表示沿用 Rust 版的显示形式（"HKLM\SOFTWARE\...\Uninstall\{GUID}"），
// 由 SplitPath 解析成「根键 + 子路径 + 视图」。
package winreg

import (
	"strings"

	"golang.org/x/sys/windows/registry"
)

// View 表示注册表的 32/64 位视图。
type View uint32

const (
	// View64 是 KEY_WOW64_64KEY：未重定向的 64 位视图。
	View64 View = registry.WOW64_64KEY
	// View32 是 KEY_WOW64_32KEY：WOW6432Node 视图（32 位程序看到的那一半）。
	View32 View = registry.WOW64_32KEY
)

// Flags 暴露视图标志本身，供需要自己拼访问掩码的调用点使用
// （例如直接调 registry.OpenKey 时）。
func (v View) Flags() uint32 { return uint32(v) }

// accessFlags 把视图标志并进访问掩码。
func (v View) accessFlags(base uint32) uint32 { return base | uint32(v) }

// RootRef 是一对「根键 + 子路径」，子路径可能为空（指根键本身）。
type RootRef struct {
	Root registry.Key
	Path string
	View View
}

// SplitPath 把 "HKLM\SOFTWARE\Foo\WOW6432Node\Bar" 解析成根键与子路径。
//
// 关键点：显示路径里的 WOW6432Node 表示「未重定向路径的 32 位视图」，
// 所以必须把它从子路径里摘掉并转成视图标志 —— 否则会去找一个真实存在的
// \WOW6432Node 子键，而那只是 64 位注册表里为了给 32 位程序看的映射。
// Rust 版 backup_manager::split_path 同样处理这一点。
func SplitPath(path string) (RootRef, bool) {
	hive, rest, ok := strings.Cut(path, `\`)
	if !ok {
		return RootRef{}, false
	}
	var root registry.Key
	switch strings.ToUpper(hive) {
	case "HKLM", "HKEY_LOCAL_MACHINE":
		root = registry.LOCAL_MACHINE
	case "HKCU", "HKEY_CURRENT_USER":
		root = registry.CURRENT_USER
	case "HKCR", "HKEY_CLASSES_ROOT":
		root = registry.CLASSES_ROOT
	default:
		return RootRef{}, false
	}
	view := View64
	if i := indexFold(rest, "WOW6432Node\\"); i >= 0 {
		rest = rest[:i] + rest[i+len("WOW6432Node\\"):]
		view = View32
	}
	return RootRef{Root: root, Path: rest, View: view}, true
}

// indexFold 是大小写不敏感的 strings.Index。
func indexFold(s, sub string) int { return strings.Index(strings.ToLower(s), strings.ToLower(sub)) }

// HiveName 返回根键的显示名（HKLM / HKCU / HKCR）。
func (r RootRef) HiveName() string {
	switch r.Root {
	case registry.LOCAL_MACHINE:
		return "HKLM"
	case registry.CURRENT_USER:
		return "HKCU"
	case registry.CLASSES_ROOT:
		return "HKCR"
	}
	return "HKLM"
}

// LongName 返回 regedit 风格的全名（HKEY_LOCAL_MACHINE\...），供 .reg 导出用。
func (r RootRef) LongName() string {
	switch r.Root {
	case registry.LOCAL_MACHINE:
		return "HKEY_LOCAL_MACHINE\\" + r.Path
	case registry.CURRENT_USER:
		return "HKEY_CURRENT_USER\\" + r.Path
	case registry.CLASSES_ROOT:
		return "HKEY_CLASSES_ROOT\\" + r.Path
	}
	return r.Path
}

// Open 按解析出的视图打开子键。子路径为空时返回根键本身的句柄副本。
func (r RootRef) Open(access uint32) (registry.Key, error) {
	if r.Path == "" {
		return registry.OpenKey(r.Root, "", r.View.accessFlags(access))
	}
	return registry.OpenKey(r.Root, r.Path, r.View.accessFlags(access))
}

// ViewOf 返回一个显示路径所隐含的视图（从路径里解出来的那个）。
func ViewOf(path string) View {
	if ref, ok := SplitPath(path); ok {
		return ref.View
	}
	return View64
}

// OpenKeyInView 在已打开的父键下按指定视图打开子键。
//
// 快照/恢复递归时要**带着视图往下走**：父键用 KEY_WOW64_32KEY 打开时，
// 子键若不带这个标志就会跳到 64 位视图里去，导出的树就是错的。
func OpenKeyInView(parent registry.Key, name string, view View) (registry.Key, error) {
	return registry.OpenKey(parent, name, registry.QUERY_VALUE|registry.ENUMERATE_SUB_KEYS|view.Flags())
}

// OpenPath 打开 "HKLM\SOFTWARE\..." 形式的键。
func OpenPath(path string, access uint32) (registry.Key, error) {
	ref, ok := SplitPath(path)
	if !ok {
		return registry.Key(0), errBadPath(path)
	}
	return ref.Open(access)
}

// CreatePath 按 "HKLM\SOFTWARE\..." 形式创建键（缺失的中间层一并创建）。
func CreatePath(path string, access uint32) (registry.Key, error) {
	ref, ok := SplitPath(path)
	if !ok {
		return registry.Key(0), errBadPath(path)
	}
	if ref.Path == "" {
		k, _, err := registry.CreateKey(ref.Root, "", ref.View.accessFlags(access))
		return k, err
	}
	k, _, err := registry.CreateKey(ref.Root, ref.Path, ref.View.accessFlags(access))
	return k, err
}

// Exists 报告键是否存在（只读打开成功即存在）。
func Exists(path string) bool {
	k, err := OpenPath(path, registry.QUERY_VALUE)
	if err != nil {
		return false
	}
	k.Close()
	return true
}

// SubKeyNames 列出直接子键名。n 传 0 表示全部。
func SubKeyNames(k registry.Key) ([]string, error) { return k.ReadSubKeyNames(0) }

// ValueNames 列出全部值名。n 传 0 表示全部。
func ValueNames(k registry.Key) ([]string, error) { return k.ReadValueNames(0) }

// Value 是「原始字节 + 类型」的注册表值。
//
// 快照与恢复必须保留原始字节：把 REG_BINARY 当 UTF-16 字符串读回来再写回去
// 会损坏数据，Rust 版的 KeySnapshot/ValueSnapshot 也是这么设计的。
type Value struct {
	Name  string
	Type  uint32
	Bytes []byte
}

// ReadValues 读出键下全部值；读取失败的值直接跳过（与 Rust 的
// `enum_values().flatten()` 一致：坏值不该让整次扫描失败）。
func ReadValues(k registry.Key) ([]Value, error) {
	names, err := ValueNames(k)
	if err != nil {
		// 没有任何值的键返回的是 ERROR_FILE_NOT_FOUND，不是错误。
		return nil, nil
	}
	out := make([]Value, 0, len(names))
	for _, name := range names {
		v, err := ReadValue(k, name)
		if err != nil {
			continue
		}
		out = append(out, v)
	}
	return out, nil
}

// ReadValue 读单个值的原始字节与类型。
func ReadValue(k registry.Key, name string) (Value, error) {
	// 第一次传 nil 只为拿长度与类型，第二次按长度取字节 ——
	// RegQueryValueEx 的标准两段式用法。
	n, valType, err := k.GetValue(name, nil)
	if err != nil {
		return Value{}, err
	}
	if n < 0 {
		return Value{}, errShortBuffer
	}
	buf := make([]byte, n)
	if n > 0 {
		if _, _, err := k.GetValue(name, buf); err != nil {
			return Value{}, err
		}
	}
	return Value{Name: name, Type: valType, Bytes: buf}, nil
}

// WriteValue 写回一个原始值（类型与字节都原样保留）。
func WriteValue(k registry.Key, v Value) error {
	p, err := utf16Ptr(v.Name)
	if err != nil {
		return err
	}
	var data uintptr
	if len(v.Bytes) > 0 {
		data = uintptr(unsafePointerOf(v.Bytes[0]))
	}
	// RegSetValueExW(hKey, lpValueName, Reserved, dwType, lpData, cbData)
	ret, _, _ := procRegSetValueExW.Call(
		uintptr(k),
		uintptr(uint32ptrFromPtr(p)),
		0,
		uintptr(v.Type),
		data,
		uintptr(len(v.Bytes)),
	)
	if ret != 0 {
		return errnoFromRet(ret)
	}
	return nil
}

// DeleteTree 连同所有子键删除一个键（等价于 Rust 的 delete_subkey_all）。
//
// x/sys 的 registry.DeleteKey 只删空键，删不掉有子键的条目，
// 所以这里直接调 RegDeleteTreeW（lumina 的 winos 包也是这么绕过去的）。
func DeleteTree(root registry.Key, path string) error {
	p, err := utf16Ptr(path)
	if err != nil {
		return err
	}
	ret, _, _ := procRegDeleteTreeW.Call(uintptr(root), uintptr(uint32ptrFromPtr(p)))
	if ret != 0 {
		return errnoFromRet(ret)
	}
	return nil
}
