//go:build windows

package backup

import (
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"golang.org/x/sys/windows/registry"

	"duster/internal/apperr"
	"duster/internal/leftovers"
	"duster/internal/winos"
	"duster/internal/winreg"
)

// SnapshotKey 递归快照一个注册表键。
func SnapshotKey(path string) (KeySnapshot, error) {
	k, err := winreg.OpenPath(path, registry.QUERY_VALUE|registry.ENUMERATE_SUB_KEYS)
	if err != nil {
		return KeySnapshot{}, apperr.Registry(path + ": " + err.Error())
	}
	defer k.Close()
	return snapshotRec(k, path, winreg.ViewOf(path))
}

// snapshotRec 递归快照一个已打开的键。
func snapshotRec(k registry.Key, path string, view winreg.View) (KeySnapshot, error) {
	raw, err := winreg.ReadValues(k)
	if err != nil {
		return KeySnapshot{}, apperr.Registry(path + ": " + err.Error())
	}
	values := make([]ValueSnapshot, 0, len(raw))
	for _, v := range raw {
		// 复制字节：ReadValues 的缓冲区会被复用，快照必须自持一份。
		data := make([]byte, len(v.Bytes))
		copy(data, v.Bytes)
		values = append(values, ValueSnapshot{Name: v.Name, Type: v.Type, Data: data})
	}

	snap := KeySnapshot{Path: path, Values: values}
	names, err := winreg.SubKeyNames(k)
	if err == nil {
		for _, name := range names {
			sub, err := winreg.OpenKeyInView(k, name, view)
			if err != nil {
				continue
			}
			child, err := snapshotRec(sub, path+`\`+name, view)
			sub.Close()
			if err != nil {
				return KeySnapshot{}, err
			}
			snap.Subkeys = append(snap.Subkeys, child)
		}
	}
	return snap, nil
}

// restoreSnapshot 重建一个键树。
//
// HKLM 且当前进程未提权时，改走「导出 .reg → runas reg.exe import」：
// 直接调 RegCreateKeyEx 会因为权限不足失败，而 reg.exe import 在
// 提权的子进程里能把整棵树建回来。
//
// 之所以**逐键**导出而不是把整个备份合成一个 .reg 再导入：
// 用户可能在 UAC 里输入了另一个管理员账号，一次性导入会把本该写进
// HKCU（当前用户）的数据写进那个管理员账户去。
func restoreSnapshot(snap KeySnapshot) error {
	ref, ok := winreg.SplitPath(snap.Path)
	if !ok {
		return apperr.Registry("无法解析注册表路径: " + snap.Path)
	}
	if ref.HiveName() == "HKLM" && !winos.IsElevated() {
		return restoreViaRegExe(snap)
	}
	return restoreRec(snap)
}

// restoreRec 直接在当前进程里重建键。
func restoreRec(snap KeySnapshot) error {
	k, err := winreg.CreatePath(snap.Path, registry.ALL_ACCESS)
	if err != nil {
		return apperr.Registry(snap.Path + ": " + err.Error())
	}
	defer k.Close()
	for _, v := range snap.Values {
		if err := winreg.WriteValue(k, winreg.Value{Name: v.Name, Type: v.Type, Bytes: v.Data}); err != nil {
			return apperr.Registry(snap.Path + `\` + v.Name + ": " + err.Error())
		}
	}
	for _, sub := range snap.Subkeys {
		if err := restoreRec(sub); err != nil {
			return err
		}
	}
	return nil
}

// restoreViaRegExe 借助提权的 reg.exe import 重建 HKLM 键。
func restoreViaRegExe(snap KeySnapshot) error {
	tmp := filepath.Join(os.TempDir(),
		"duster-restore-"+strconv.Itoa(os.Getpid())+"-"+strconv.FormatInt(timeNowNano(), 10)+".reg")
	if err := writeRegFile(tmp, []KeySnapshot{snap}); err != nil {
		return err
	}
	defer os.Remove(tmp)

	args := "import " + quoteWindowsArg(tmp)
	code, err := winos.ElevateAndWait("reg.exe", args)
	if err != nil {
		if winos.IsCancelled(err) {
			return apperr.ElevationRequired("UAC request was cancelled")
		}
		return apperr.Process("reg.exe import failed: " + err.Error())
	}
	if code != 0 {
		return apperr.Registry("reg.exe import exited with " + itoa(int(code)))
	}
	return nil
}

// DeleteKey 删除一个注册表键树。受保护键一律拒绝。
func DeleteKey(path string) error {
	if leftovers.IsProtectedKey(path) {
		return apperr.ProtectedPath(path)
	}
	ref, ok := winreg.SplitPath(path)
	if !ok {
		return apperr.Registry("无法解析注册表路径: " + path)
	}

	// HKLM 未提权时同样借道 reg.exe —— RegDeleteKeyEx 会直接权限不足。
	if ref.HiveName() == "HKLM" && !winos.IsElevated() {
		view := " /reg:64"
		if ref.View == winreg.View32 {
			view = " /reg:32"
		}
		args := "delete " + quoteWindowsArg(ref.HiveName()+`\`+ref.Path) + " /f" + view
		code, err := winos.ElevateAndWait("reg.exe", args)
		if err != nil {
			if winos.IsCancelled(err) {
				return apperr.ElevationRequired("UAC request was cancelled")
			}
			return apperr.Process("reg.exe delete failed: " + err.Error())
		}
		if code != 0 {
			return apperr.Registry("reg.exe delete exited with " + itoa(int(code)) + ": " + path)
		}
		return nil
	}

	if err := winreg.DeleteTree(ref.Root, ref.Path); err != nil {
		return apperr.Registry(path + ": " + err.Error())
	}
	return nil
}

// DeletePath 删除一个文件或目录，优先送回收站。返回是否进了回收站。
func DeletePath(path string, useRecycleBin bool) (bool, error) {
	st, err := os.Lstat(path)
	if err != nil {
		if os.IsNotExist(err) {
			return false, apperr.PathNotFound(path)
		}
		return false, apperr.IO(err)
	}
	// 重解析点（符号链接 / 联接点）绝不自动删：删它可能删掉整个目标树。
	if st.Mode()&os.ModeSymlink != 0 {
		return false, apperr.ProtectedPath("refusing to remove a reparse point: " + path)
	}
	// 规范化之后再判一次：junction 能绕过字面量检查。
	if leftovers.IsProtected(path) {
		return false, apperr.ProtectedPath(path)
	}
	if real, err := filepath.EvalSymlinks(path); err == nil && leftovers.IsProtected(real) {
		return false, apperr.ProtectedPath(path)
	}

	if useRecycleBin {
		recycled, err := recycleBin(path, st.IsDir())
		if err == nil {
			return recycled, nil
		}
		if !winos.IsElevated() {
			// 非提权进程没有权限动 Program Files，交给提权助手重试一次。
			if !pathExists(path) {
				// 回收站 API 报错但东西确实没了 —— 视为成功。
				return true, nil
			}
			return true, elevatedRecycle(path, st.IsDir())
		}
		return false, apperr.Other("recycle failed: " + err.Error())
	}

	if st.IsDir() {
		if err := os.RemoveAll(path); err != nil {
			if isPermissionDenied(err) && !winos.IsElevated() {
				return false, elevatedRemove(path, true)
			}
			return false, apperr.IO(err)
		}
		return false, nil
	}
	if err := os.Remove(path); err != nil {
		if isPermissionDenied(err) && !winos.IsElevated() {
			return false, elevatedRemove(path, false)
		}
		return false, apperr.IO(err)
	}
	return false, nil
}

// recycleBin 送回收站。优先用 MyGo 的 Shell.TrashItem（内部走 SHFileOperation，
// 带 FOF_ALLOWUNDO）；失败再退回自己声明的 SHFileOperation。
func recycleBin(path string, isDir bool) (bool, error) {
	err := shellTrashItem(path)
	if err == nil {
		return true, nil
	}
	if shellFileOperation(path, isDir) {
		return true, nil
	}
	return false, err
}

// DeleteService 删除一个服务。path 必须是 HKLM\SYSTEM\CurrentControlSet\Services\<名>。
//
// 走 sc.exe delete 而不是直接删注册表：SCM 会把「正在运行的服务」
// 标记为待删除（重启后生效），比强行停服务安全得多。
func DeleteService(path string) (bool, error) {
	const prefix = `HKLM\SYSTEM\CurrentControlSet\Services\`
	name, ok := strings.CutPrefix(path, prefix)
	if !ok || !isValidServiceName(name) {
		return false, apperr.ProtectedPath(path)
	}
	if winos.IsElevated() {
		code, err := runHidden("sc.exe", "delete", name)
		if err != nil {
			return false, apperr.IO(err)
		}
		if code != 0 {
			return false, apperr.Process("sc.exe delete " + name + " exited with " + itoa(int(code)))
		}
		return false, nil
	}
	code, err := winos.ElevateAndWait("sc.exe", "delete "+quoteWindowsArg(name))
	if err != nil {
		if winos.IsCancelled(err) {
			return false, apperr.ElevationRequired("UAC request was cancelled")
		}
		return false, apperr.Process("elevated sc.exe delete failed: " + err.Error())
	}
	if code != 0 {
		return false, apperr.Process("elevated sc.exe delete " + name + " exited with " + itoa(int(code)))
	}
	return false, nil
}

// isValidServiceName 只允许字母数字与 _ - .，挡掉路径穿越。
func isValidServiceName(name string) bool {
	if name == "" || strings.Contains(name, `\`) {
		return false
	}
	for _, c := range name {
		ok := (c >= '0' && c <= '9') || (c >= 'a' && c <= 'z') ||
			(c >= 'A' && c <= 'Z') || c == '_' || c == '-' || c == '.'
		if !ok {
			return false
		}
	}
	return true
}

// DeleteTask 删除一个计划任务。path 必须落在 System32\Tasks 下。
func DeleteTask(path string) (bool, error) {
	lower := strings.ToLower(path)
	const marker = `\tasks\`
	idx := strings.Index(lower, marker)
	if idx < 0 {
		return false, apperr.ProtectedPath(path)
	}
	relative := path[idx+len(marker):]
	if relative == "" || containsDotDot(relative) {
		return false, apperr.ProtectedPath(path)
	}
	taskName := `\` + strings.ReplaceAll(relative, "/", `\`)

	if winos.IsElevated() {
		code, err := runHidden("schtasks.exe", "/Delete", "/TN", taskName, "/F")
		if err != nil {
			return false, apperr.IO(err)
		}
		if code != 0 {
			return false, apperr.Process("schtasks exited with " + itoa(int(code)))
		}
		return false, nil
	}
	code, err := winos.ElevateAndWait("schtasks.exe", "/Delete /TN "+quoteWindowsArg(taskName)+" /F")
	if err != nil {
		if winos.IsCancelled(err) {
			return false, apperr.ElevationRequired("UAC request was cancelled")
		}
		return false, apperr.Process("elevated schtasks failed: " + err.Error())
	}
	if code != 0 {
		return false, apperr.Process("elevated schtasks exited with " + itoa(int(code)))
	}
	return false, nil
}

// containsDotDot 检查相对路径里有没有 ".." 段。
func containsDotDot(rel string) bool {
	for _, part := range strings.FieldsFunc(rel, func(r rune) bool { return r == '\\' || r == '/' }) {
		if part == ".." {
			return true
		}
	}
	return false
}
