import { defineConfig } from "mygo-cli";

/**
 * Duster 拂尘 —— Go 1.27 + MyGo 3 外壳的配置。
 *
 * MyGo 自己没有窗口配置文件（窗口在 main.go 里用 mygo.NewWindow 创建），
 * 这里只管打包：名字、图标、构建命令、前端产物路径。
 *
 * 对应原 Tauri 的 tauri.conf.json：productName / identifier / version /
 * build.frontendDist / bundle.icon 全部一一对应（AGENTS.md §4 的改名清单）。
 */
export default defineConfig({
  name: "Duster",
  // ⚠️ 改了 identifier 就等于改了 %APPDATA% 下的数据目录，属于数据迁移
  // （AGENTS.md §4 #2）。保持 dev.duster.app 与 Rust 版一致。
  identifier: "dev.duster.app",
  version: "0.1.0",
  icon: "icon.png",

  // 前端是原有的 Vite 应用，未改动（只有 src/ipc/commands.ts 换了桥接实现）。
  devUrl: "http://localhost:5173",
  devCommand: "bun run dev:web",
  buildCommand: "bun run build:web",
  frontendDist: "dist",
  // 由 `bun run generate`（mygo generate）从 Go 的绑定方法自动生成，**不要手改**。
  bindings: "src/mygo.ts",
  out: "build",
});