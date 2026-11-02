/**
 * 应用菜单（桌面端 02 §2.6）。import `electron` 的三处之一。
 *
 * 只放五项：新对话 / 审计视图 / 打开会话目录 / 重新载入 / 退出（+ dev 才有的 DevTools）。
 * "新对话"是零载荷的生命周期动作（重启进程），不是业务入口；其余每一项也必须能在
 * 页面或宿主的既有能力里找到对应，所以"打开外部链接""另存为""打印"一律不做。
 */

import { app, Menu, shell, type BrowserWindow, type MenuItemConstructorOptions } from 'electron'

import { auditTabClickScript } from './audit-tab.ts'
import { logJson } from '@bah/util'

/** 建菜单的输入。 */
export interface MenuOptions {
  /** 是否打包运行（决定是否出现 DevTools）。 */
  readonly isPackaged: boolean
  /** 会话目录（"打开会话目录"的目标）。 */
  readonly sessionsDir: string
  /** 取当前窗口（可能为 `null`：窗口已关但应用还未退出）。 */
  readonly getWindow: () => BrowserWindow | null
  /** 重新载入（默认 `window.reload()`；抽出便于测试替身）。 */
  readonly reload?: (window: BrowserWindow) => void
  /** 退出（默认 `app.quit()`）。 */
  readonly quit?: () => void
  /** 开始新对话（重启进程；缺省不挂菜单项）。 */
  readonly newConversation?: () => void
}

/**
 * 点审计 tab 并区分"命中"与"静默失效"。
 *
 * `executeJavaScript` 的返回值来自 `audit-tab.ts` 的脚本：`true` = 点到了，
 * `false` = 页面里没有这个 id（Web 重构改名了）。后者必须留痕——否则现场表现是
 * "点了没反应"，而日志里什么都没有。
 */
async function openAuditView(window: BrowserWindow): Promise<void> {
  try {
    const hit = (await window.webContents.executeJavaScript(auditTabClickScript())) as unknown
    if (hit === true) {
      logJson('info', 'desktop.audit-view-opened', {})
      return
    }
    logJson('warn', 'desktop.audit-view-missing', {
      reason: '页面里没有 id="tab-audit" 的元素（apps/web 可能重构过；门禁 G8 会拦这种情况）',
    })
  } catch (error) {
    logJson('warn', 'desktop.audit-view-failed', {
      reason: error instanceof Error ? error.message : String(error),
    })
  }
}

/** 造菜单并设到应用上。 */
export function installMenu(options: MenuOptions): Menu {
  const reload = options.reload ?? ((window: BrowserWindow) => window.reload())
  const quit = options.quit ?? (() => app.quit())

  const viewItems: MenuItemConstructorOptions[] = [
    {
      label: '审计视图',
      accelerator: 'CmdOrCtrl+Shift+A',
      click: () => {
        const window = options.getWindow()
        if (window === null) return
        void openAuditView(window)
      },
    },
    { type: 'separator' },
    {
      label: '重新载入',
      accelerator: 'CmdOrCtrl+R',
      click: () => {
        const window = options.getWindow()
        if (window !== null) reload(window)
      },
    },
  ]

  // DevTools 只在开发态出现：打包后暴露它等于给现场一个"能改页面状态"的入口
  if (!options.isPackaged) {
    viewItems.push({
      label: '开发者工具',
      accelerator: 'CmdOrCtrl+Shift+I',
      click: () => {
        options.getWindow()?.webContents.toggleDevTools()
      },
    })
  }

  const fileItems: MenuItemConstructorOptions[] = [
    ...(options.newConversation === undefined
      ? []
      : [
          {
            label: '新对话',
            accelerator: 'CmdOrCtrl+N',
            click: () => options.newConversation?.(),
          },
          { type: 'separator' as const },
        ]),
    {
      label: '打开会话目录',
      click: () => {
        // `openPath` 只接受**目录/文件路径**，不接受 URL：外部链接一律不交给系统
        void shell.openPath(options.sessionsDir).then((error) => {
          if (error !== '') logJson('warn', 'desktop.open-sessions-failed', { reason: error })
        })
      },
    },
    { type: 'separator' },
    { label: '退出', accelerator: 'Alt+F4', click: quit },
  ]

  const template: MenuItemConstructorOptions[] = [
    { label: '文件', submenu: fileItems },
    { label: '视图', submenu: viewItems },
  ]

  const menu = Menu.buildFromTemplate(template)
  Menu.setApplicationMenu(menu)
  return menu
}
