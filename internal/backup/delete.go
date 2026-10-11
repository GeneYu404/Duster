package backup

import (
	"duster/internal/model"
)

// DeleteLeftovers 在写完备份之后才删除选中的残留条目。
//
// 顺序不可调换：先导出全部涉及的注册表键，再逐项删除。
// 万一中途失败，已删除的部分仍能从备份里恢复。
//
// 删除顺序按路径长度**倒序**（最深的先删）：同级目录下父目录必须
// 排在子目录之后，否则父目录被删掉后子目录的路径就失效了
// （Rust 版 sort_by_key(Reverse(path.len())) 同理）。
func DeleteLeftovers(
	backupDir, appID, appName string, items []model.LeftoverItem, useRecycleBin bool,
) (model.DeleteLeftoversResult, error) {
	// 只有注册表类与服务类需要备份；文件删除不需要。
	regKeys := make([]string, 0, len(items))
	for _, it := range items {
		if it.Category == model.CatRegistry || it.Category == model.CatService {
			regKeys = append(regKeys, it.Path)
		}
	}

	var backupInfo *model.BackupInfo
	if len(regKeys) > 0 {
		info, err := BackupKeys(backupDir, appID, appName, model.BackupLeftover, regKeys)
		if err != nil {
			return model.DeleteLeftoversResult{}, err
		}
		backupInfo = &info
	}

	result := model.DeleteLeftoversResult{
		Deleted: make([]string, 0, len(items)),
		Failed:  make([]model.FailedItem, 0),
		Backup:  backupInfo,
	}

	ordered := sortedByDepthDesc(items)
	for _, item := range ordered {
		recycled, err := deleteOne(item, useRecycleBin)
		if err != nil {
			result.Failed = append(result.Failed, model.FailedItem{
				ID: item.ID, Path: item.Path, Reason: err.Error(),
			})
			continue
		}
		if recycled {
			result.Recycled++
		}
		result.Deleted = append(result.Deleted, item.ID)
	}
	return result, nil
}

// deleteOne 按类别分发到对应的删除原语。
func deleteOne(item model.LeftoverItem, useRecycleBin bool) (bool, error) {
	switch item.Category {
	case model.CatRegistry:
		return false, DeleteKey(item.Path)
	case model.CatService:
		return DeleteService(item.Path)
	case model.CatTask:
		return DeleteTask(item.Path)
	default:
		return DeletePath(item.Path, useRecycleBin)
	}
}

// sortedByDepthDesc 返回按路径长度倒序排列的副本（不改动入参切片）。
func sortedByDepthDesc(items []model.LeftoverItem) []model.LeftoverItem {
	out := make([]model.LeftoverItem, len(items))
	copy(out, items)
	for i := 1; i < len(out); i++ {
		for j := i; j > 0 && len(out[j].Path) > len(out[j-1].Path); j-- {
			out[j], out[j-1] = out[j-1], out[j]
		}
	}
	return out
}
