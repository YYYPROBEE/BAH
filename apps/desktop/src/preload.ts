/**
 * preload（桌面端 02 §2.5）。**源码是 ESM，产物必须是 CJS**——这两句看起来矛盾，
 * 其实是同一件事的两面：
 *
 * - Electron 的沙箱化 preload **没有 ESM loader**，加载到 ESM 产物 = preload 静默不执行
 *   （`window.bahDesktop` 是 `undefined`，页面正常、四消息一条没有、也没有报错）；
 * - 但**源码**用 ESM 写、由 `tsdown` 的 `format: ['cjs']` 产出 `dist/preload.cjs`，
 *   才是既能共享类型、又能拿到 CJS 产物的唯一写法。写成 `.cts` 反而在
 *   `verbatimModuleSyntax` 下不能 `import`（TS1286），也就无法共用 `./ipc.ts` 的常量。
 *
 * 判据落在**产物**上（门禁 G2 检查 `dist/preload.cjs` 存在且不是 ESM），不落在源文件后缀上。
 *
 * 暴露面只有四个方法，**不暴露** `ipcRenderer` / `require` / `process`：
 * 一旦把 `ipcRenderer` 交出去，页面就能对任意通道发消息（等于把主进程的 IPC 面全部开放）。
 */

import { contextBridge, ipcRenderer } from 'electron'

import { IPC, type BootFatal, type BootInjections, type BootShutdown } from './ipc.ts'

/**
 * preload 里的 `globalThis` 就是页面 window。
 *
 * 不把 `DOM` 加进本项目的 `lib`：那会让 `main.ts` 也能写 `document.*` 而检查不出来
 * （主进程里没有 DOM，写了就是运行期崩）。这里用一条窄声明表达"只有 preload 需要它"。
 */
interface PreloadGlobal {
  addEventListener(type: 'DOMContentLoaded', listener: () => void): void
}

const page = globalThis as unknown as PreloadGlobal

/**
 * `ready` 只发一次。
 *
 * 两个触发点（preload 的 `DOMContentLoaded` + 页面自己调 `sendReady`）都走这里：
 * 不去重的话主进程日志会出现两条 `bah:boot/ready`，"首屏到底几次"这个问题就再也答不准。
 */
let readySent = false

function sendReady(): void {
  if (readySent) return
  readySent = true
  ipcRenderer.send(IPC.ready, { at: Date.now() })
}

/** 渲染进程可用的最小面（`window.bahDesktop`）。 */
const api = {
  /** 订阅注入信息（`did-finish-load` 之后触发一次）。 */
  onInjections(callback: (payload: BootInjections) => void): void {
    ipcRenderer.on(IPC.injections, (_event, payload: BootInjections) => {
      callback(payload)
    })
  },

  /** 订阅启动失败（订阅后主进程才发；见 `main.ts` 的顺序）。 */
  onFatal(callback: (payload: BootFatal) => void): void {
    ipcRenderer.on(IPC.fatal, (_event, payload: BootFatal) => {
      callback(payload)
    })
  },

  /** 订阅关闭（`before-quit` dispose 完成后）。 */
  onShutdown(callback: (payload: BootShutdown) => void): void {
    ipcRenderer.on(IPC.shutdown, (_event, payload: BootShutdown) => {
      callback(payload)
    })
  },

  /** 上报"首屏完成"（幂等；`DOMContentLoaded` 已自动调用一次）。 */
  sendReady,
} as const

contextBridge.exposeInMainWorld('bahDesktop', api)

// 首屏完成即上报：`DOMContentLoaded` 早于 `did-finish-load`，主进程据此能区分
// "HTML 到了"与"页面脚本跑起来了"——两者之间正是最容易出问题的窗口。
page.addEventListener('DOMContentLoaded', () => {
  sendReady()
})
