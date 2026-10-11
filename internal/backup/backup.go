// Package backup 负责「任何破坏性操作之前先备份」，以及删除 / 恢复原语。
//
// 对应原 Rust 的 src-tauri/src/backup_manager.rs。
//
//   - 注册表键递归导出成 JSON 文档（无损：原始字节 + 类型），
//     同时再导出一份人可读的 .reg；
//   - 文件 / 目录进回收站（可在设置里关掉）；
//   - restore() 从 JSON 快照重建键。
//
// ⚠️ 顺序不可调换：**先备份成功，才允许删除**。
// delete_app_entry 就是靠这一点保证「要么都发生，要么都没发生」。
package backup

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
	"unicode/utf16"

	"duster/internal/apperr"
	"duster/internal/model"
)

// ValueSnapshot 是一个注册表值的快照：名字 + 类型 + 原始字节。
type ValueSnapshot struct {
	Name string `json:"name"`
	Type uint32 `json:"vtype"`
	Data []byte `json:"data"`
}

// KeySnapshot 是一个注册表键（含全部子键）的快照。
type KeySnapshot struct {
	Path    string          `json:"path"`
	Values  []ValueSnapshot `json:"values"`
	Subkeys []KeySnapshot   `json:"subkeys"`
}

// BackupFile 是落盘的备份文件结构（.json）。
type BackupFile struct {
	Info model.BackupInfo `json:"info"`
	Keys []KeySnapshot    `json:"keys"`
}

// BackupKeys 把 keys 递归导出到 <dir>/<时间戳>_<appID>.json（外加同名 .reg）。
//
// 不存在的键直接跳过而不是报错：删除流程常常一次性给出一堆键，
// 其中几个早就没了，让整个操作因为「键不存在」而中止毫无意义。
func BackupKeys(dir, appID, appName string, kind model.BackupKind, keys []string) (model.BackupInfo, error) {
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return model.BackupInfo{}, apperr.IO(err)
	}

	snapshots := make([]KeySnapshot, 0, len(keys))
	for _, k := range keys {
		snap, err := SnapshotKey(k)
		if err != nil {
			// 键不存在 → 跳过；其余错误要报（权限问题意味着备份不完整）。
			if isNotExist(err) {
				continue
			}
			return model.BackupInfo{}, err
		}
		snapshots = append(snapshots, snap)
	}

	now := time.Now()
	jsonPath := backupFileName(dir, appID, "json", now)
	paths := make([]string, 0, len(snapshots))
	for _, s := range snapshots {
		paths = append(paths, s.Path)
	}
	info := model.BackupInfo{
		ID:         strings.TrimSuffix(filepath.Base(jsonPath), ".json"),
		CreatedAt:  now.Format(time.RFC3339),
		AppID:      appID,
		AppName:    appName,
		Kind:       kind,
		Path:       jsonPath,
		Keys:       paths,
		Restorable: len(snapshots) > 0,
	}

	file := BackupFile{Info: info, Keys: snapshots}
	raw, err := json.MarshalIndent(file, "", "  ")
	if err != nil {
		return model.BackupInfo{}, apperr.JSON(err)
	}
	if err := os.WriteFile(jsonPath, raw, 0o644); err != nil {
		return model.BackupInfo{}, apperr.IO(err)
	}
	// .reg 是给人看的（可以双击导入），.json 才是恢复用的。
	if err := writeRegFile(trimExt(jsonPath), snapshots); err != nil {
		return model.BackupInfo{}, err
	}
	return info, nil
}

// backupFileName 生成 <时间戳>_<appID>.<ext>。
//
// 时间戳精确到秒：同一秒内对同一个 app 做两次备份会撞名，
// 那时后写的会覆盖前写的 —— 用户两份都恢复不了。
func backupFileName(dir, appID, ext string, now time.Time) string {
	return filepath.Join(dir, fmt.Sprintf("%s_%s.%s", now.Format("20060102-150405"), appID, ext))
}

func trimExt(p string) string { return strings.TrimSuffix(p, filepath.Ext(p)) }

// ListBackups 列出备份目录里全部可读的备份，按创建时间倒序。
func ListBackups(dir string) []model.BackupInfo {
	out := make([]model.BackupInfo, 0, 8)
	entries, err := os.ReadDir(dir)
	if err != nil {
		return out
	}
	for _, e := range entries {
		p := filepath.Join(dir, e.Name())
		if !strings.EqualFold(filepath.Ext(p), ".json") {
			continue
		}
		raw, err := os.ReadFile(p)
		if err != nil {
			continue
		}
		var file BackupFile
		if err := json.Unmarshal(raw, &file); err != nil {
			continue
		}
		out = append(out, file.Info)
	}
	// RFC3339 字符串的字典序就是时间序，可以直接比。
	sortByCreatedDesc(out)
	return out
}

// sortByCreatedDesc 按创建时间倒序（新的在前）。
func sortByCreatedDesc(list []model.BackupInfo) {
	for i := 1; i < len(list); i++ {
		for j := i; j > 0 && list[j].CreatedAt > list[j-1].CreatedAt; j-- {
			list[j], list[j-1] = list[j-1], list[j]
		}
	}
}

// Restore 从备份重建键。
//
// backupID 会先做字符白名单校验再拼进路径 —— 这里是唯一一处
// 「用户输入 → 文件路径」的转换，必须挡住 ../ 与路径分隔符。
func Restore(dir, backupID string) error {
	if backupID == "" || !isSafeBackupID(backupID) {
		return apperr.BackupNotFound(backupID)
	}
	path := filepath.Join(dir, backupID+".json")
	raw, err := os.ReadFile(path)
	if err != nil {
		return apperr.BackupNotFound(backupID)
	}
	var file BackupFile
	if err := json.Unmarshal(raw, &file); err != nil {
		return apperr.JSON(err)
	}
	for _, snap := range file.Keys {
		if err := restoreSnapshot(snap); err != nil {
			return err
		}
	}
	return nil
}

// isSafeBackupID 只允许字母数字与 - _（与 Rust 版 is_ascii_alphanumeric || '-' || '_' 一致）。
func isSafeBackupID(id string) bool {
	for _, c := range id {
		ok := (c >= '0' && c <= '9') || (c >= 'a' && c <= 'z') ||
			(c >= 'A' && c <= 'Z') || c == '-' || c == '_'
		if !ok {
			return false
		}
	}
	return true
}

// regText 把一个键快照渲染成 .reg 文本。
func regText(snap KeySnapshot, out *strings.Builder) {
	out.WriteString("\r\n[" + longKeyName(snap.Path) + "]\r\n")
	for _, v := range snap.Values {
		name := "@"
		if v.Name != "" {
			name = `"` + strings.NewReplacer(`\`, `\\`, `"`, `\"`).Replace(v.Name) + `"`
		}
		switch {
		case v.Type == 1 && len(v.Data) >= 2: // REG_SZ
			s := strings.TrimRight(decodeUTF16(v.Data), "\x00")
			s = strings.NewReplacer(`\`, `\\`, `"`, `\"`).Replace(s)
			out.WriteString(name + `="` + s + `"` + "\r\n")
		case v.Type == 4 && len(v.Data) >= 4: // REG_DWORD
			d := uint32(v.Data[0]) | uint32(v.Data[1])<<8 | uint32(v.Data[2])<<16 | uint32(v.Data[3])<<24
			out.WriteString(fmt.Sprintf("%s=dword:%08x\r\n", name, d))
		default:
			hexParts := make([]string, 0, len(v.Data))
			for _, b := range v.Data {
				hexParts = append(hexParts, hex2(b))
			}
			out.WriteString(fmt.Sprintf("%s=hex(%x):%s\r\n", name, v.Type, strings.Join(hexParts, ",")))
		}
	}
	for _, sub := range snap.Subkeys {
		regText(sub, out)
	}
}

// longKeyName 把 HKLM\ 展开成 HKEY_LOCAL_MACHINE\，供 .reg 文件使用。
func longKeyName(path string) string {
	path = strings.Replace(path, `HKLM\`, `HKEY_LOCAL_MACHINE\`, 1)
	path = strings.Replace(path, `HKCU\`, `HKEY_CURRENT_USER\`, 1)
	path = strings.Replace(path, `HKCR\`, `HKEY_CLASSES_ROOT\`, 1)
	return path
}

// writeRegFile 写 UTF-16LE 的 .reg 文件（regedit 只认带 BOM 的 UTF-16）。
func writeRegFile(path string, keys []KeySnapshot) error {
	var sb strings.Builder
	sb.WriteString("Windows Registry Editor Version 5.00\r\n")
	for _, k := range keys {
		regText(k, &sb)
	}
	units := utf16.Encode([]rune(sb.String()))
	buf := make([]byte, 0, len(units)*2+2)
	buf = append(buf, 0xFF, 0xFE) // UTF-16LE BOM
	for _, u := range units {
		buf = append(buf, byte(u), byte(u>>8))
	}
	if err := os.WriteFile(path, buf, 0o644); err != nil {
		return apperr.IO(err)
	}
	return nil
}

// decodeUTF16 把 UTF-16LE 字节解码成字符串。
func decodeUTF16(b []byte) string {
	n := len(b) / 2
	units := make([]uint16, n)
	for i := 0; i < n; i++ {
		units[i] = uint16(b[i*2]) | uint16(b[i*2+1])<<8
	}
	return string(utf16.Decode(units))
}

// isNotExist 判断错误是不是「东西不存在」。
func isNotExist(err error) bool {
	return err != nil && os.IsNotExist(err)
}

// itoa 是 strconv.Itoa 的短别名（这个包里到处都要把退出码拼进错误消息）。
func itoa(n int) string { return strconv.Itoa(n) }

// hex2 是单字节的十六进制表示（两位小写）。
func hex2(b byte) string {
	const digits = "0123456789abcdef"
	return string([]byte{digits[b>>4], digits[b&0x0f]})
}
