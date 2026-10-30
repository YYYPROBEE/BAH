/**
 * 窗口安全选项（桌面端 02 §2.4 / I-DT-03）。**纯常量 + 工厂**，不 import electron：
 * 这份文件要能被单测直接断言（T-DTB-004），而"单测里 import electron 会拿到一个
 * 需要 GUI 运行时的壳"是本项目明确禁止的形状（R-DT-10）。
 *
 * 七个值都是**硬值**，不是"默认值可覆盖"：门禁 G1 逐字比对四个关键项
 * （contextIsolation / nodeIntegration / sandbox / webSecurity），任何一处改宽即红。
 */

/** 窗口 webPreferences 的硬化部分（不含 `preload`，因为它是路径、随构建变化）。 */
export interface HardenedFlags {
  /** 渲染进程与 preload 分处两个 JS 上下文：**唯一**能安全暴露 API 的机制。 */
  readonly contextIsolation: true
  /** 渲染进程**没有** `require`/`process`：页面里的任意脚本都拿不到 Node。 */
  readonly nodeIntegration: false
  /** Worker 里同样没有 Node（`nodeIntegration` 的兄弟开关，默认值是 false 但显式钉住）。 */
  readonly nodeIntegrationInWorker: false
  /** 渲染进程跑在 OS 级沙箱里：即使 Chromium 被攻破也拿不到用户权限。 */
  readonly sandbox: true
  /** 不关同源策略（关掉 = 任意页面可读同源响应，token 直接泄漏）。 */
  readonly webSecurity: true
  /** 不允许在 https 页面里跑 http 子资源（混合内容）。 */
  readonly allowRunningInsecureContent: false
  /** 禁用 `<webview>`：它是第二个"页面里开页面"的入口，绕过 will-navigate 白名单。 */
  readonly webviewTag: false
}

/** 七个硬化值（唯一落点）。 */
export const HARDENED_FLAGS: HardenedFlags = {
  contextIsolation: true,
  nodeIntegration: false,
  nodeIntegrationInWorker: false,
  sandbox: true,
  webSecurity: true,
  allowRunningInsecureContent: false,
  webviewTag: false,
}

/** 窗口可用的完整 webPreferences（硬化七项 + preload 绝对路径）。 */
export interface HardenedWebPreferences extends HardenedFlags {
  /** `contextBridge` 的最小面（编译产物 `preload.cjs` 的绝对路径）。 */
  readonly preload: string
}

/**
 * 造一份 webPreferences。
 *
 * 刻意写成工厂而不是对象常量：`preload` 在 dev（`apps/desktop/dist/preload.cjs`）与
 * packaged（`resources/app/dist/preload.cjs`）下是**不同绝对路径**，写死一份必然有一边错。
 */
export function hardenedWebPreferences(preloadPath: string): HardenedWebPreferences {
  return { ...HARDENED_FLAGS, preload: preloadPath }
}

/** 窗口尺寸（单窗口、无记忆、无最小化还原策略——非目标里明确不做多窗口）。 */
export const WINDOW_SIZE = { width: 1280, height: 860 } as const
