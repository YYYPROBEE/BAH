/**
 * Electron 应用入口（桌面端 02 §2.1/§2.4/§2.5）。**唯一处理生命周期的文件**：
 * 单实例、boot、窗口、四消息、退出 dispose。纯逻辑都在 `paths` / `ipc` / `navigation` /
 * `window-options` 里（可单测），这里只负责"按顺序把它们接起来"。
 *
 * ## 为什么 boot 失败要 `app.exit(1)` 而不是留一个空窗口
 *
 * 空窗口在演示现场与"页面白屏"无法区分，而白屏的常见原因是**配置错**（缺 profile、
 * 静态根不对），一句话就能修。留空窗口会把这类错误伪装成"前端 bug"。所以：
 * `dialog.showErrorBox` 给出结构化 code + 原因 → 退出码 1（03 的 smoke 脚本据此判成败）。
 *
 * ## `bah:boot/fatal` 的诚实边界
 *
 * 窗口在 boot **成功之后**才创建（避免 about:blank 一闪）。因此**boot 阶段**的失败
 * 没有渲染进程可投递 `fatal`——那一段只有 `showErrorBox` + 日志 + 退出码。
 * 窗口之后的失败（`loadURL` 拒绝、页面加载失败）才会真的走 `bah:boot/fatal`。
 * 这条边界写在这里，而不是在文档里含糊成"失败会发消息"。
 */

import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { app, BrowserWindow, dialog, ipcMain, Menu } from 'electron'

import { logJson } from '@bah/util'

import {
  sessionsDirOf,
  startDesktopHost,
  stopDesktopHost,
  webDirOf,
  type DesktopBoot,
} from './boot.ts'
import { IPC, assertNoCredentialKeys, parseBootReady, toBootFatal, type BootFatal } from './ipc.ts'
import { installMenu } from './menu.ts'
import { resolveBahRoot, resolveUserData } from './paths.ts'
import { createMainWindow } from './window.ts'

/** 主进程所在目录（dev：`apps/desktop/dist`；packaged：`resources/app/dist`）。 */
const MAIN_DIR = dirname(fileURLToPath(import.meta.url))

/** 应用目录（dev：`apps/desktop`）。packaged 不用它——那里一切都在 `resources/app` 下。 */
const APP_DIR = resolve(MAIN_DIR, '..')

/** 本次运行的宿主实例（boot 成功后赋值；退出时据此 dispose）。 */
let host: DesktopBoot | undefined

/** 主窗口（单窗口；非目标里明确不做多窗口与托盘常驻）。 */
let mainWindow: BrowserWindow | undefined

/** shutdown 只发一条（`before-quit` 可能被触发多次）。 */
let shutdownSent = false

/** 是否已进入"真正退出"的第二阶段（防止 `app.quit()` 递归拦截自己）。 */
let quitting = false

/**
 * 单实例锁（I-DT-11）。
 *
 * WHY：`port: 0` 让每个进程都能起，两个进程会各自写同一个 `userData/sessions`，
 * 第二个窗口还会显示**另一份**会话状态。第二次启动只聚焦已有窗口，不新建。
 */
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWindow === undefined) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
  })
  void main()
}

/** 主流程。 */
async function main(): Promise<void> {
  await app.whenReady()

  const bahRoot = resolveBahRoot({
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    appDir: APP_DIR,
  })
  const userData = resolveUserData(app.getPath('appData'))

  logJson('info', 'desktop.starting', {
    root: bahRoot,
    userData,
    packaged: app.isPackaged,
    node: process.versions.node,
    electron: process.versions.electron,
    web: webDirOf(bahRoot),
  })

  let instance: DesktopBoot
  try {
    instance = await startDesktopHost({
      root: bahRoot,
      userData,
      isPackaged: app.isPackaged,
      now: () => Date.now(),
      env: process.env,
    })
  } catch (error) {
    const fatal = toBootFatal(error, 'desktop-boot-failed')
    logJson('error', 'desktop.boot-failed', { code: fatal.code, reason: fatal.message })
    // 此阶段还没有窗口 ⇒ 没有渲染进程可收 `bah:boot/fatal`（见文件头"诚实边界"）
    dialog.showErrorBox('BAH 启动失败', `${fatal.code}\n\n${fatal.message}`)
    app.exit(1)
    return
  }

  host = instance

  const window = createMainWindow({
    port: instance.port,
    preloadPath: join(MAIN_DIR, 'preload.cjs'),
  })
  mainWindow = window

  installMessageHandlers(window, instance)

  try {
    await window.loadURL(instance.url)
    logJson('info', 'desktop.window-loaded', { url: instance.url })
  } catch (error) {
    // 这一段**有**窗口 ⇒ 走真正的 fatal 投递
    fail(window, toBootFatal(error, 'desktop-load-failed'))
    return
  }

  installMenu({
    isPackaged: app.isPackaged,
    sessionsDir: sessionsDirOf(userData),
    getWindow: () => mainWindow ?? null,
    newConversation: () => {
      void restartForNewConversation()
    },
  })

  window.on('closed', () => {
    mainWindow = undefined
  })

  /**
   * 关闭窗口 = 退出应用，但**必须先拦一次**。
   *
   * 实测（02 第一次跑）：`WM_CLOSE` → 窗口 `closed`（渲染进程已销毁）→ `window-all-closed`
   * → `app.quit()` → `before-quit`。等到 `before-quit` 再发 `bah:boot/shutdown` 时
   * `mainWindow` 已是 `undefined`，消息**永远发不出去**——四消息少一条，而且没有任何报错。
   *
   * 所以在 `close` 阶段拦下（此时 webContents 还活着）：dispose → 发 shutdown → 再 quit。
   * `quitting` 标志保证第二轮不再拦（否则 `app.quit()` 会自己拦住自己）。
   */
  window.on('close', (event) => {
    if (quitting || host === undefined) return
    event.preventDefault()
    quitting = true
    void shutdown('window-close')
  })

  app.on('window-all-closed', () => {
    app.quit()
  })

  // 菜单"退出"/系统退出走这里（窗口还活着时同样能发 shutdown）
  app.on('before-quit', (event) => {
    if (quitting || host === undefined) return
    event.preventDefault()
    quitting = true
    void shutdown('app-quit')
  })

  // 未捕获异常走同一条收尾路径：否则会话日志会留下半条记录
  process.on('uncaughtException', (error) => {
    logJson('error', 'desktop.uncaught', { reason: error.message })
    void shutdown('uncaught-exception')
  })
}

/**
 * 装四条 IPC 的处理（①与②需要窗口；③④在别处发）。
 *
 * 顺序有讲究：`did-finish-load` 的监听必须在 `loadURL` **之前**注册，否则首屏加载太快时
 * 会漏发 injections（本地 loopback 上这完全可能发生）。
 */
function installMessageHandlers(window: BrowserWindow, instance: DesktopBoot): void {
  window.webContents.on('did-finish-load', () => {
    const payload = {
      channel: 'desktop' as const,
      sessionId: instance.sessionId,
      profile: 'desktop' as const,
      port: instance.port,
      version: app.getVersion(),
    }
    // 双保险：即使将来有人往载荷里加字段，凭证类键也过不去（I-DT-06）
    assertNoCredentialKeys(payload)
    window.webContents.send(IPC.injections, payload)
    logJson('info', 'desktop.ipc-sent', { message: IPC.injections, port: instance.port })
  })

  ipcMain.on(IPC.ready, (_event, payload: unknown) => {
    if (!parseBootReady(payload)) {
      logJson('warn', 'desktop.ipc-invalid', { message: IPC.ready })
      return
    }
    logJson('info', 'desktop.ipc-received', { message: IPC.ready })
  })

  // 零载荷重启：页面只能"请求新对话"，不能指定会话/身份；真正的会话由新进程重新生成。
  ipcMain.on(IPC.newConversation, () => {
    logJson('info', 'desktop.new-conversation', {})
    void restartForNewConversation()
  })
}

/** 把 fatal 投给渲染进程并退出（只在窗口存在时调用）。 */
function fail(window: BrowserWindow, fatal: BootFatal): void {
  logJson('error', 'desktop.fatal', { code: fatal.code, reason: fatal.message })
  if (!window.isDestroyed()) {
    window.webContents.send(IPC.fatal, fatal)
  }
  dialog.showErrorBox('BAH 运行失败', `${fatal.code}\n\n${fatal.message}`)
  app.exit(1)
}

/**
 * 收尾：dispose 宿主 → 发 shutdown → 退出（或重启）。
 *
 * `shutdown` 在 dispose **之后**发（此时窗口通常还活着）；窗口已销毁时用
 * `isDestroyed()` 兜底，宁可少发一条也不向已销毁的 webContents 发消息。
 *
 * `relaunch: true` 走同一个 dispose 路径，但最后用 `app.relaunch()` + `app.exit(0)`
 * 而不是 `app.quit()`：新进程会重新执行 `startDesktopHost`，拿到一个新的 sessionId。
 * 这是桌面端唯一能真正"开新对话"的方式（单进程单会话，没有 in-process 换会话能力）。
 */
async function shutdown(reason: string, options: { readonly relaunch?: boolean } = {}): Promise<void> {
  if (host !== undefined) {
    await stopDesktopHost(host, reason)
    host = undefined
  }
  if (!shutdownSent && mainWindow !== undefined && !mainWindow.isDestroyed()) {
    shutdownSent = true
    mainWindow.webContents.send(IPC.shutdown, { reason })
    logJson('info', 'desktop.ipc-sent', { message: IPC.shutdown, reason })
  }
  Menu.setApplicationMenu(null)
  if (options.relaunch === true) {
    // 新进程重新生成访问 token：不可以把旧进程注入的 BAH_WEB_TOKEN 继承过去。
    delete process.env['BAH_WEB_TOKEN']
    logJson('info', 'desktop.relaunch', { reason })
    app.relaunch()
    app.exit(0)
    return
  }
  app.quit()
}

/** 用户请求新对话：走同一条收尾路径，dispose 完成后重启进程。 */
async function restartForNewConversation(): Promise<void> {
  if (quitting || host === undefined) return
  quitting = true
  await shutdown('new-conversation', { relaunch: true })
}
