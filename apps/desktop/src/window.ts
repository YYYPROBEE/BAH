/**
 * BrowserWindow 装配（桌面端 02 §2.4）。这是**唯一**允许 import `electron` 的三处之一
 * （另两处：`main.ts` 生命周期、`menu.ts` 菜单）。纯逻辑一律不放这里——这里的每行
 * 都无法在 vitest 里跑（没有 GUI 运行时）。
 *
 * 六道闸，缺一条就能被页面里的任意脚本利用：
 *   ① `will-navigate` 白名单（同源 loopback 全等）；
 *   ② `setWindowOpenHandler` 一律 deny（不偷偷开系统浏览器——那等于把 URL 交给外部程序）；
 *   ③ `will-attach-webview` 一律拦（`webviewTag:false` 之外的二道保险）；
 *   ④ `setPermissionRequestHandler` 全拒（摄像头/麦克风/通知/剪贴板/地理位置…）；
 *   ⑤ `setPermissionCheckHandler` 全拒（同步查询路径，④ 只管请求）；
 *   ⑥ `webContents.session` 上的 deny 是**按分区**生效的：必须在 `loadURL` 之前装。
 */

import { BrowserWindow, type WebContents } from 'electron'

import { isAllowedNavigation, loopbackOrigin } from './navigation.ts'
import { hardenedWebPreferences, WINDOW_SIZE } from './window-options.ts'
import { logJson } from '@bah/util'

/** 创建窗口的输入。 */
export interface MainWindowOptions {
  /** 本次启动的实际端口（`port:0` ⇒ 调用方必须从 `DESKTOP_SERVER` 取）。 */
  readonly port: number
  /** `preload.cjs` 的绝对路径。 */
  readonly preloadPath: string
  /** 窗口图标（可选；缺省用 Electron 默认图标）。 */
  readonly iconPath?: string
}

/**
 * 把六道闸装到某个 webContents 上。
 *
 * 单独抽出来是为了让"装闸"与"造窗口"分成两个可读步骤：造窗口的参数（尺寸/图标）
 * 与安全闸不是同一种变化原因。
 */
export function installSecurityHandlers(contents: WebContents, port: number): void {
  // ① 导航白名单：唯一判据是 `isAllowedNavigation`（解析 + origin + 端口全等）
  contents.on('will-navigate', (event, url) => {
    if (isAllowedNavigation(url, port)) return
    event.preventDefault()
    logJson('warn', 'desktop.navigation-blocked', { url: redactUrl(url) })
  })

  // ② 新窗口一律拒绝（含 `target=_blank` 与 `window.open`）
  contents.setWindowOpenHandler(({ url }) => {
    logJson('warn', 'desktop.window-open-blocked', { url: redactUrl(url) })
    return { action: 'deny' }
  })

  // ③ `<webview>` 二道保险（`webviewTag:false` 已经关掉，但配置可能被后人放宽）
  contents.on('will-attach-webview', (event) => {
    event.preventDefault()
    logJson('warn', 'desktop.webview-blocked', {})
  })

  // ④ 权限请求全拒：桌面壳不需要摄像头/麦克风/通知/剪贴板读/地理位置
  contents.session.setPermissionRequestHandler((_wc, permission, callback) => {
    logJson('warn', 'desktop.permission-denied', { permission })
    callback(false)
  })

  // ⑤ 权限**查询**路径同样全拒（有些 API 先 check 再 request，只拦 ④ 会漏）
  contents.session.setPermissionCheckHandler(() => false)
}

/**
 * 造主窗口并装上六道闸。
 *
 * `show:false` + `ready-to-show` 是刻意的：先渲染再显示，避免"白屏一闪"被当成启动失败。
 */
export function createMainWindow(options: MainWindowOptions): BrowserWindow {
  const window = new BrowserWindow({
    ...WINDOW_SIZE,
    show: false,
    title: 'BAH 桌面端',
    backgroundColor: '#0f1115',
    autoHideMenuBar: false,
    ...(options.iconPath === undefined ? {} : { icon: options.iconPath }),
    webPreferences: hardenedWebPreferences(options.preloadPath),
  })

  installSecurityHandlers(window.webContents, options.port)

  window.once('ready-to-show', () => {
    window.show()
  })

  // 关闭即退出（非目标：托盘常驻 / 多窗口）。`main.ts` 也监听 window-all-closed。
  window.on('closed', () => {
    logJson('info', 'desktop.window-closed', {})
  })

  return window
}

/**
 * 把 URL 里的敏感部分抹掉再进日志。
 *
 * SSE 的 `?token=` 是**唯一**会把凭证放进 URL 的地方（`EventSource` 不能设请求头）。
 * 日志里出现它就等于把 token 落盘。
 */
export function redactUrl(raw: string): string {
  try {
    const url = new URL(raw)
    for (const key of ['token', 'access_token', 'auth']) {
      if (url.searchParams.has(key)) url.searchParams.set(key, '***')
    }
    return url.toString()
  } catch {
    // 解析不了的串（`javascript:` 等）只保留前缀，防止把整段脚本写进日志
    return describeUnparsable(raw)
  }
}

/** 解析不了的串兜底：只保留前缀，防止把整段 JavaScript 写进日志。 */
export function describeUnparsable(raw: string): string {
  return raw.length > 120 ? `${raw.slice(0, 120)}…` : raw
}
