// 注意：改这个文件的内容（哪怕只是注释）会改变 build script 的指纹，
// 强制它重新执行 → 重新生成 OUT_DIR/resource.rc → rc.exe 重新嵌入图标。
//
// 这是唯一能可靠刷新 exe 内嵌图标的办法：mbx 的内容寻址缓存键**不含**
// `icons/icon.ico` 的内容，所以哪怕 `mbx clean` 删掉整个 target，
// 也会把这个 build script 的旧输出目录连同旧 `.res` 原样还原，
// 表现为「build 成功、日志干净、exe 图标却还是旧的」。
// 详见 AGENTS.md §5.2。
fn main() {
    tauri_build::build();
}
