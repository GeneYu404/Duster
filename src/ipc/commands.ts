/**
 * MyGo + WebView2 桥接层（Bridge）
 *
 * 桌面外壳是 Go 1.27 + MyGo 3（2026-10-11 从 Tauri 2 + Rust 重写而来，Rust 版已移除）。
 * 前端业务组件一行没动，只换了与外壳耦合的这一个文件。
 *
 * `Duster` 与 `events` 来自 src/mygo.ts，由 `bun run generate` 从 Go 的绑定方法
 * 自动生成 —— **不要手改**那个文件，改 Go 方法后重新生成即可。
 *
 * 与 Rust 版的协议差异：
 * 1. **调用方式**：Tauri 是 `invoke('list_installed_apps', { options })`，
 *    MyGo 的生成客户端按 Go 方法签名传参：`Duster.listInstalledApps(options)`。
 *    但 **Backend 接口的签名保持不变**，所以组件层完全无感。
 * 2. **错误形状**：Tauri 跨 IPC 传 `{ code, message, details }` 结构体；
 *    MyGo 只能传字符串。Go 侧把 AppError 编码成 JSON 塞进 Error.message，
 *    `toAppError` 里原有的「字符串 → JSON.parse」分支正好把它还原回去，
 *    错误码不丢。
 * 3. **事件是单向的**：MyGo 只有 Go → JS。Duster 只有一个窗口，够用；
 *    将来若要跨窗口通信，必须绕回绑定方法由 Go 代发。
 * 4. **事件订阅同步返回取消函数**（Tauri 的 `listen()` 要等 Promise），
 *    所以 `withEvent` 不是 async —— 调用点的 `await` 依然成立，签名不变。
 *
 * 若运行在普通浏览器预览环境，`isMyGo()` 为 false，全部走模拟后端。
 */

import { isMyGo } from 'mygo-runtime';
import { Duster, events } from '../mygo';
import type {
  AppDetail,
  AppError,
  AppKind,
  AppSource,
  Architecture,
  BackupInfo,
  ExportRequest,
  ExportResult,
  Hive,
  InstalledApp,
  LeftoverCategory,
  LeftoverItem,
  ListOptions,
  LogEntry,
  PrivilegeInfo,
  RegistryView,
  Risk,
  ScanProgress,
  ScanResult,
  Settings,
  UninstallResult,
} from '../types/app';
import { COMMANDS, EVENTS, type Backend, type DeleteLeftoversArgs, type UninstallArgs } from './backend';
import { mockBackend } from './mock';
import type {
  AppDetail as MyAppDetail,
  BackupInfo as MyBackupInfo,
  ExportRequest as MyExportRequest,
  InstalledApp as MyInstalledApp,
  LeftoverItem as MyLeftoverItem,
  ScanProgress as MyScanProgress,
  ScanResult as MyScanResult,
} from '../mygo';

/**
 * 后端类型。
 *
 * 字符串值从 'tauri' 换成 'mygo'：它的语义一直是「跑在真实桌面外壳里」，
 * 只是外壳换了一套实现。取值只出现在 StatusBar / DetailPanel / ExportDialog /
 * SettingsDialog 的四处比较与本文件里。
 */
export type BackendKind = 'mygo' | 'mock';

/** 是否运行在真实的 MyGo WebView2 桌面外壳中。 */
export function isNativeShell(): boolean {
  return isMyGo();
}

/**
 * 兼容旧名：原先叫 isTauri()，语义不变（是否跑在真实外壳里，而非浏览器预览）。
 */
export function isTauri(): boolean {
  return isMyGo();
}

/** 把 Go 侧抛出的任何东西归一成 AppError。 */
export function toAppError(e: unknown): AppError {
  if (e && typeof e === 'object') {
    const o = e as Record<string, unknown>;
    if (typeof o.code === 'string' && typeof o.message === 'string') {
      return { code: o.code, message: o.message, details: typeof o.details === 'string' ? o.details : undefined };
    }
    if (e instanceof Error) {
      // Go 侧的 AppError 把 {code,message,details} 编码成 JSON 放进 Error.message
      // （MyGo 的 IPC 只能传字符串）。优先解回来，错误码才不会退化成 UNKNOWN。
      const wire = parseWireError(e.message);
      if (wire) return wire;
      return { code: 'UNKNOWN', message: e.message, details: e.stack };
    }
  }
  if (typeof e === 'string') {
    const wire = parseWireError(e);
    if (wire) return wire;
    return { code: 'UNKNOWN', message: e };
  }
  return { code: 'UNKNOWN', message: String(e) };
}

/** 尝试把一段字符串解析成 Go 侧的 {code,message,details}；失败返回 null。 */
function parseWireError(raw: string): AppError | null {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (typeof parsed.message === 'string') {
      return {
        code: String(parsed.code ?? 'UNKNOWN'),
        message: parsed.message,
        details: typeof parsed.details === 'string' ? parsed.details : undefined,
      };
    }
  } catch {
    /* 普通字符串，不是 wire 格式 */
  }
  return null;
}

/**
 * 枚举字面量的收窄。
 *
 * Go 侧用 `type AppKind string` 表达「枚举」，MyGo 的 TS 生成器只能把它写成
 * `string` —— 它无法知道哪些取值合法。而前端 types/app.ts 里是字面量联合，
 * 两边对不上。
 *
 * 这里把每个枚举字段显式 cast 一次。**运行时值本来就只可能是那几个字符串**
 * （Go 侧的 BuildApp / Scan 只写入常量，不接受外部输入），所以这只是让
 * 类型系统满意，不是运行时转换。
 *
 * 与 lumina / PickScreen 的做法一致：它们也是把 Go 的 string 收窄成前端字面量。
 */
function toApp(raw: MyInstalledApp): InstalledApp {
  return {
    ...raw,
    kind: raw.kind as AppKind,
    source: raw.source as AppSource,
    hive: raw.hive as Hive,
    registryView: raw.registryView as RegistryView,
    architecture: raw.architecture as Architecture,
  };
}

function toDetail(raw: MyAppDetail): AppDetail {
  // 注意这里 spread 的是 raw 而不是 toApp(raw)：AppDetail 比 InstalledApp 多了
  // installLocationExists / uninstallerExists 等字段，走 toApp 会把它们抹掉。
  return {
    ...raw,
    kind: raw.kind as AppKind,
    source: raw.source as AppSource,
    hive: raw.hive as Hive,
    registryView: raw.registryView as RegistryView,
    architecture: raw.architecture as Architecture,
    registryValues: raw.registryValues ?? {},
  };
}

function toScanProgress(raw: MyScanProgress): ScanProgress {
  return { ...raw, phase: raw.phase as ScanProgress['phase'] };
}

function toLeftoverItem(raw: MyLeftoverItem): LeftoverItem {
  return {
    ...raw,
    category: raw.category as LeftoverCategory,
    risk: raw.risk as Risk,
  };
}

function toScanResult(raw: MyScanResult): ScanResult {
  return { ...raw, items: (raw.items ?? []).map(toLeftoverItem) };
}

function toBackupInfo(raw: MyBackupInfo): BackupInfo {
  return { ...raw, kind: raw.kind as BackupInfo['kind'] };
}

function toExportRequest(req: ExportRequest): MyExportRequest {
  // fields: ExportField[] → string[]，appIds/labels 形状一致。
  return req as unknown as MyExportRequest;
}

/** 归一化的调用包装：把 Go 侧的 error 变成 AppError。 */
async function call<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    throw toAppError(e);
  }
}

function createMyGoBackend(): Backend {
  /**
   * 在一次命令执行期间订阅某个进度事件。
   *
   * `events.*.on()` **同步**返回取消函数（Tauri 的 `listen()` 返回 Promise），
   * 所以这里不是 async；但调用点的 `await withEvent(...)` 依然成立。
   *
   * subscribe 由调用点给出，因为两个事件的信封类型不同；载荷的枚举收窄
   * （phase: string → 字面量联合）也在各自的 subscribe 里做。
   */
  const withEvent = <P, T>(
    subscribe: (handler: (envelope: { appId: string; payload: P }) => void) => () => void,
    appId: string,
    handler: ((p: P) => void) | undefined,
    run: () => Promise<T>,
  ): Promise<T> => {
    if (!handler) return run();
    const off = subscribe((envelope) => {
      if (envelope?.appId === appId) handler(envelope.payload);
    });
    return run().finally(off);
  };

  // 扫描进度事件：信封里的 phase 是 Go 的 string，这里收窄成前端字面量联合。
  const onScanProgress = (cb: (e: { appId: string; payload: ScanProgress }) => void) =>
    events.scanProgress.on((e) => cb({ appId: e.appId, payload: toScanProgress(e.payload) }));

  // 卸载日志事件：载荷本来就是 string，直接透传。
  const onUninstallLog = (cb: (e: { appId: string; payload: string }) => void) => events.uninstallLog.on(cb);

  return {
    listInstalledApps: (options: ListOptions) =>
      call(async () => (await Duster.listInstalledApps(options)).map(toApp)),

    getAppDetail: (appId: string) => call(async () => toDetail(await Duster.getAppDetail(appId))),

    // Go 侧取不到图标时返回空串；前端契约是 string | null，这里转回去。
    getAppIcon: (appId: string) =>
      call(async () => {
        const dataUrl = await Duster.getAppIcon(appId);
        return dataUrl ? dataUrl : null;
      }),

    uninstallApp: (args: UninstallArgs, onLog) =>
      withEvent<string, UninstallResult>(onUninstallLog, args.appId, onLog, async () =>
        call(async () => (await Duster.uninstallApp(args)) as UninstallResult),
      ),

    forceUninstallApp: (appId: string, onProgress) =>
      withEvent<ScanProgress, ScanResult>(onScanProgress, appId, onProgress, async () =>
        call(async () => toScanResult(await Duster.forceUninstallApp(appId))),
      ),

    deleteAppEntry: (appId: string) => call(async () => toBackupInfo(await Duster.deleteAppEntry(appId))),

    scanLeftovers: (appId: string, onProgress) =>
      withEvent<ScanProgress, ScanResult>(onScanProgress, appId, onProgress, async () =>
        call(async () => toScanResult(await Duster.scanLeftovers(appId))),
      ),

    deleteLeftovers: (args: DeleteLeftoversArgs) =>
      call(async () => {
        const r = await Duster.deleteLeftovers(args);
        return { ...r, backup: r.backup ? toBackupInfo(r.backup) : undefined };
      }),

    openInstallLocation: (appId: string) => call(() => Duster.openInstallLocation(appId)),
    revealPath: (path: string) => call(() => Duster.revealPath(path)),
    openRegistryKey: (path: string) => call(() => Duster.openRegistryKey(path)),
    openExternal: (url: string) => call(() => Duster.openExternal(url)),

    exportApps: (req: ExportRequest) =>
      call(async () => (await Duster.exportApps(toExportRequest(req))) as ExportResult),

    isAdmin: () => call(() => Duster.isAdmin() as Promise<PrivilegeInfo>),
    requestElevation: () => call(() => Duster.requestElevation()),
    getSettings: () => call(() => Duster.getSettings() as Promise<Settings>),
    saveSettings: (settings: Settings) => call(() => Duster.saveSettings(settings)),
    listBackups: () => call(async () => (await Duster.listBackups()).map(toBackupInfo)),
    restoreBackup: (backupId: string) => call(() => Duster.restoreBackup(backupId)),
    getLogs: () => call(() => Duster.getLogs() as Promise<LogEntry[]>),
  };
}
export const backendKind: BackendKind = isMyGo() ? 'mygo' : 'mock';
export const ipc: Backend = backendKind === 'mygo' ? createMyGoBackend() : mockBackend;

/**
 * 选备份目录（设置页的「…」按钮）。
 *
 * 原来是 `@tauri-apps/plugin-dialog` 的 `open({ directory: true })`，
 * 现在由 Go 侧弹系统对话框（MyGo 的 Dialog.Open）。用户取消返回空串，
 * 调用方据此放弃修改；浏览器预览里也返回空串（按钮本来就是禁用的）。
 */
export async function pickBackupDir(defaultPath: string): Promise<string> {
  if (backendKind !== 'mygo') return '';
  return call(() => Duster.pickBackupDir(defaultPath));
}

export { COMMANDS, EVENTS };