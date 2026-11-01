/**
 * 门禁：桌面壳的不变量（桌面端 02 §6 / 03 §6）。
 *
 * ## 为什么是逐条正向断言，不是"禁用词清单"
 *
 * 与本仓其它门禁同一条纪律（见 `verify-visual-line.ts:1-13` 的论证）：禁用词清单要把
 * 被禁字面量写进脚本，脚本自身永远是一次命中，而且"没写清单里的写法"照样能绕过。
 * 这里只认**唯一合法的形态**——例如"窗口必须用 `hardenedWebPreferences(...)` 造
 * webPreferences"，而不是"不许出现 `sandbox: false`"。
 *
 * ## 判据一览
 *
 * G1  窗口安全：四个硬值逐字 + 窗口必须用 `hardenedWebPreferences`
 * G2  preload 最小面：只 `contextBridge.exposeInMainWorld('bahDesktop', …)`，暴露键 ⊆ 五个方法
 * G3  IPC 五条消息：四条生命周期 + 零载荷重启；名字精确、无表外 `bah:` 通道、注入载荷不含凭证键
 * G4  导航拦截：`will-navigate` + `setWindowOpenHandler`→deny + `will-attach-webview` 拦
 * G5  只加载 loopback：`loadURL` 用 `DESKTOP_SERVER` 给的 `instance.url`，源码无远程/文件 URL
 * G6  无自动更新 / 无外链打开 / 无崩溃上报
 * G7  打包脚本不依赖 GitHub / electron-builder，且显式走 npmmirror
 * G8  审计入口：`apps/web/src/main.js` 仍有 `id: 'tab-audit'`，且与 `AUDIT_TAB_ID` 同值
 * G9  文档：`docs/desktop.md` 存在且含离线演示步骤
 * G10 打包清单含 bundle 的 `.js` 回退与 cli 声明清单；桌面端无第二份 bundle 数据；
 *     主进程产物体量护栏（>200 KB 说明 `@bah/*` 被内联了）
 */

import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

import { isMainModule, runStandalone, walk, type Gate, type GateResult } from './gate-lib.ts'

/** 桌面端源码目录（相对仓库根）。 */
const SRC = 'apps/desktop/src'
/** 关键文件。 */
const FILES = {
  windowOptions: `${SRC}/window-options.ts`,
  window: `${SRC}/window.ts`,
  preload: `${SRC}/preload.ts`,
  ipc: `${SRC}/ipc.ts`,
  navigation: `${SRC}/navigation.ts`,
  main: `${SRC}/main.ts`,
  boot: `${SRC}/boot.ts`,
  auditTab: `${SRC}/audit-tab.ts`,
  tsdown: 'apps/desktop/tsdown.config.ts',
  webMain: 'apps/web/src/main.js',
  doc: 'docs/desktop.md',
  pack: 'scripts/pack-desktop.mjs',
} as const

/** G1 钉死的四个硬值（连同冒号与空格，逐字比对）。 */
const HARD_VALUES = [
  'contextIsolation: true',
  'nodeIntegration: false',
  'sandbox: true',
  'webSecurity: true',
] as const

/** G2 允许暴露的方法名（多一个就是多一条 IPC 面；newConversation 是零载荷生命周期动作）。 */
const ALLOWED_BRIDGE_KEYS = ['onInjections', 'onFatal', 'onShutdown', 'sendReady', 'newConversation'] as const

/** G3 五条消息名（逐字）：四条生命周期 + 一条零载荷重启。 */
const IPC_NAMES = [
  'bah:boot/injections',
  'bah:boot/ready',
  'bah:boot/fatal',
  'bah:boot/shutdown',
  'bah:app/new-conversation',
] as const

/** 读文件；不存在返回空串（缺文件由调用方判为 finding）。 */
function read(root: string, rel: string): string {
  const path = join(root, rel)
  return existsSync(path) ? readFileSync(path, 'utf8') : ''
}

const gate: Gate = {
  name: 'desktop-shell',

  async run(root): Promise<GateResult> {
    const findings: string[] = []
    const notes: string[] = []

    const windowOptions = read(root, FILES.windowOptions)
    const windowTs = read(root, FILES.window)
    const preload = read(root, FILES.preload)
    const ipc = read(root, FILES.ipc)
    const navigation = read(root, FILES.navigation)
    const main = read(root, FILES.main)
    const tsdown = read(root, FILES.tsdown)
    const webMain = read(root, FILES.webMain)
    const doc = read(root, FILES.doc)

    // 缺文件 = 桌面壳根本没落地；后续判据全空转会假绿，所以先挡这一条
    for (const [label, rel] of Object.entries(FILES)) {
      if (label === 'doc') continue
      if (read(root, rel).length === 0) findings.push(`缺文件 ${rel}`)
    }
    const sources = walk(root, [SRC], (name) => name.endsWith('.ts') && !name.endsWith('.test.ts'))
    const sourceText = sources.map((file) => readFileSync(file, 'utf8')).join('\n')

    // ── G1 窗口安全 ────────────────────────────────────────────────────────
    // ⚠ 只在**常量对象块**里比对，不在整个文件里找子串：
    // 第一版用 `windowOptions.includes('sandbox: true')`，而同一个文件里
    // `readonly sandbox: true`（接口声明）也会命中它 —— 把常量改成 `sandbox: false`
    // 时门禁照样绿（负控实测）。判据必须落在"窗口实际拿到的值"上。
    const flagsBlock = /HARDENED_FLAGS\s*:\s*HardenedFlags\s*=\s*\{([\s\S]*?)\n\}/.exec(windowOptions)?.[1] ?? ''
    if (flagsBlock.length === 0) {
      findings.push(`G1 ${FILES.windowOptions} 里找不到 HARDENED_FLAGS 常量对象（结构已变，判据需同步）`)
    }
    for (const value of HARD_VALUES) {
      if (!flagsBlock.includes(value)) {
        findings.push(`G1 ${FILES.windowOptions} 的 HARDENED_FLAGS 缺硬值 '${value}'（窗口安全不许放宽）`)
      }
    }
    if (!/hardenedWebPreferences\(/.test(windowTs)) {
      findings.push(`G1 ${FILES.window} 必须用 hardenedWebPreferences(...) 造 webPreferences（不许就地写字面量）`)
    }
    if (!/webPreferences:\s*hardenedWebPreferences\(/.test(windowTs)) {
      findings.push(`G1 ${FILES.window} 的 BrowserWindow 必须把 hardenedWebPreferences(...) 传给 webPreferences`)
    }
    // 权限全拒：两个处理器都要在
    if (!preload.length) notes.push('G1 preload 缺失，跳过权限面断言')
    for (const handler of ['setPermissionRequestHandler', 'setPermissionCheckHandler']) {
      if (!windowTs.includes(handler)) {
        findings.push(`G1 ${FILES.window} 缺 ${handler}（权限必须全拒，缺一个就有一条旁路）`)
      }
    }

    // ── G2 preload 最小面 ─────────────────────────────────────────────────
    const expose = [...preload.matchAll(/contextBridge\.exposeInMainWorld\(\s*'([^']+)'/g)]
    if (expose.length !== 1) {
      findings.push(`G2 ${FILES.preload} 必须恰有 1 处 contextBridge.exposeInMainWorld（实际 ${String(expose.length)}）`)
    } else if (expose[0]?.[1] !== 'bahDesktop') {
      findings.push(`G2 暴露的全局名必须是 'bahDesktop'（实际 '${String(expose[0]?.[1])}'）`)
    }
    const apiBlock = /const api = \{([\s\S]*?)\n\} as const/.exec(preload)?.[1] ?? ''
    // 键名三种写法都要认：方法简写 `onInjections(`、属性 `sendReady,`、键值 `onFatal:`
    // —— 第一版只写了 `[,:]`，结果四个方法只认出 `sendReady`（1 个），却因为
    // `extraKeys` 为空而"通过"。这就是假绿：换个写法加方法就绕过。
    const apiKeys = [...apiBlock.matchAll(/^\s{2}(\w+)\s*[(:,]/gm)].map((match) => match[1] ?? '')
    const extraKeys = apiKeys.filter((key) => !(ALLOWED_BRIDGE_KEYS as readonly string[]).includes(key))
    // 正向计数：暴露面**恰为五个**。解析失败（0 个）与少写一个都要红，
    // 否则"少暴露一个"或"正则又漏了"都不会被发现。
    if (apiKeys.length !== ALLOWED_BRIDGE_KEYS.length) {
      findings.push(
        `G2 ${FILES.preload} 的暴露面应恰为 ${String(ALLOWED_BRIDGE_KEYS.length)} 个方法（实际 ${String(apiKeys.length)}：${apiKeys.join(',') || '解析失败'}）`,
      )
    }
    if (extraKeys.length > 0) {
      findings.push(`G2 ${FILES.preload} 暴露了表外方法 ${extraKeys.join(',')}（暴露面只能是五个）`)
    }
    // 不许把 ipcRenderer / require / process 交出去
    for (const leaked of ['ipcRenderer,', 'ipcRenderer:', 'require,', 'process,']) {
      if (apiBlock.includes(leaked)) {
        findings.push(`G2 ${FILES.preload} 把 '${leaked.replace(/[,:]$/, '')}' 放进了暴露面（页面就能对任意通道发消息）`)
      }
    }
    // preload 产物必须是 CJS（沙箱 preload 没有 ESM loader）
    const preloadBlock = /entry:\s*\{\s*preload:[^}]*\}[\s\S]*?\n  \}/.exec(tsdown)?.[0] ?? ''
    if (!/format:\s*\[\s*'cjs'\s*\]/.test(preloadBlock)) {
      findings.push(`G2 ${FILES.tsdown} 的 preload 段必须是 format: ['cjs']（沙箱 preload 只认 CJS，ESM 会静默不执行）`)
    }

    // ── G3 IPC 五条消息（四条生命周期 + 零载荷重启） ─────────────────────
    for (const name of IPC_NAMES) {
      const count = [...ipc.matchAll(new RegExp(`'${name.replace(/[/.:]/g, (ch) => `\\${ch}`)}'`, 'g'))].length
      if (count !== 1) {
        findings.push(`G3 ${FILES.ipc} 里 '${name}' 应恰出现 1 次（实际 ${String(count)}）`)
      }
    }
    // 除 ipc.ts 之外，源码里不许再出现 `bah:` 字面量（表外通道的入口）
    for (const file of sources) {
      const where = file.replace(/\\/g, '/').split('/').slice(-3).join('/')
      if (where.endsWith('ipc.ts')) continue
      const text = readFileSync(file, 'utf8')
      for (const match of text.matchAll(/['"](bah:[\w/]+)['"]/g)) {
        findings.push(`G3 ${where} 出现表外 IPC 通道 '${String(match[1])}'（五条之外不许加业务通道；新对话是零载荷重启）`)
      }
    }
    // 注入载荷不含凭证：键集常量必须存在且不含 token 字样
    const keysBlock = /BOOT_INJECTION_KEYS\s*=\s*\[([\s\S]*?)\]/.exec(ipc)?.[1] ?? ''
    if (keysBlock.length === 0) {
      findings.push(`G3 ${FILES.ipc} 缺 BOOT_INJECTION_KEYS（载荷键集是 I-DT-06 的机器判据）`)
    }
    if (/token/i.test(keysBlock)) {
      findings.push(`G3 ${FILES.ipc} 的 BOOT_INJECTION_KEYS 含 token 字样（凭证不进 IPC，I-DT-06）`)
    }
    if (!/FORBIDDEN_PAYLOAD_KEYS/.test(ipc)) {
      findings.push(`G3 ${FILES.ipc} 缺 FORBIDDEN_PAYLOAD_KEYS（载荷凭证键的黑名单）`)
    }

    // ── G4 导航拦截 ───────────────────────────────────────────────────────
    if (!/export function isAllowedNavigation/.test(navigation)) {
      findings.push(`G4 ${FILES.navigation} 缺 isAllowedNavigation（白名单判据的唯一实现处）`)
    }
    if (!/will-navigate/.test(windowTs)) {
      findings.push(`G4 ${FILES.window} 缺 will-navigate 监听（页面可导航到外域）`)
    }
    if (!/setWindowOpenHandler\(/.test(windowTs) || !/action:\s*'deny'/.test(windowTs)) {
      findings.push(`G4 ${FILES.window} 缺 setWindowOpenHandler → { action: 'deny' }（window.open 会开新窗口）`)
    }
    if (!/will-attach-webview/.test(windowTs)) {
      findings.push(`G4 ${FILES.window} 缺 will-attach-webview 拦截（webview 是第二个"页面里开页面"）`)
    }

    // ── G5 只加载 loopback ────────────────────────────────────────────────
    const loadUrl = /loadURL\(([^)]*)\)/.exec(main)?.[1]?.trim() ?? ''
    if (loadUrl !== 'instance.url') {
      findings.push(`G5 ${FILES.main} 的 loadURL 必须用 DESKTOP_SERVER 给的 instance.url（实际 '${loadUrl}'）`)
    }
    for (const file of sources) {
      const where = file.replace(/\\/g, '/').split('/').slice(-1)[0] ?? ''
      // navigation.ts 是唯一允许出现 `http://` 构造的地方（它负责拼回环源）
      if (where === 'navigation.ts') continue
      const text = readFileSync(file, 'utf8')
      for (const pattern of [/\bhttps?:\/\/(?!127\.0\.0\.1)/, /\bfile:\/\//]) {
        const hit = pattern.exec(text)
        if (hit !== null) {
          findings.push(`G5 ${where} 出现远程/文件 URL 字面量 '${hit[0]}'（桌面壳只加载 loopback）`)
        }
      }
    }

    // ── G6 无自动更新 / 外链 / 崩溃上报 ───────────────────────────────────
    for (const banned of ['autoUpdater', 'setFeedURL', 'openExternal', 'crashReporter']) {
      if (sourceText.includes(banned)) {
        findings.push(`G6 桌面端源码出现 '${banned}'（非目标：不做自动更新 / 外链打开 / 崩溃上报）`)
      }
    }

    // ── G8 审计入口 ───────────────────────────────────────────────────────
    if (!/id:\s*'tab-audit'/.test(webMain)) {
      findings.push(
        `G8 ${FILES.webMain} 里找不到 id: 'tab-audit'（Web 重构改名了：菜单"审计视图"会静默失效）`,
      )
    }
    const auditId = /AUDIT_TAB_ID\s*=\s*'([^']+)'/.exec(read(root, FILES.auditTab))?.[1]
    if (auditId !== 'tab-audit') {
      findings.push(`G8 ${FILES.auditTab} 的 AUDIT_TAB_ID 必须是 'tab-audit'（实际 '${String(auditId)}'）`)
    }

    // ── G9 文档 ───────────────────────────────────────────────────────────
    if (doc.length === 0) {
      findings.push(`G9 缺 ${FILES.doc}（桌面端必须有启动/打包/离线/排障说明）`)
    } else {
      for (const keyword of ['离线', '打包', '故障']) {
        if (!doc.includes(keyword)) findings.push(`G9 ${FILES.doc} 缺「${keyword}」一节`)
      }
      if (!/禁用网卡|断网/.test(doc)) {
        findings.push(`G9 ${FILES.doc} 缺离线演示步骤（必须写明"禁用网卡/断网"这一动作）`)
      }
    }

    // ── G7 打包脚本不依赖 GitHub / electron-builder ──────────────────────
    // 本机 `github.com:443` 不通是既定事实：electron-builder 的 winCodeSign 等依赖
    // 全走 GitHub Releases，构建会随机失败。所以"只走 npmmirror"必须被机器钉住，
    // 而不是靠文档里的一句"我们不用 builder"。
    const pack = read(root, FILES.pack)
    if (pack.length === 0) {
      findings.push(`G7 缺 ${FILES.pack}（便携打包脚本）`)
    } else {
      for (const banned of ['github.com', 'electron-builder', 'electron-packager']) {
        if (pack.includes(banned)) {
          findings.push(`G7 ${FILES.pack} 出现 '${banned}'（构建不得依赖 GitHub / 第三方打包器）`)
        }
      }
      if (!pack.includes('npmmirror.com')) {
        findings.push(`G7 ${FILES.pack} 必须显式从 npmmirror 取 Electron 二进制（默认源是 GitHub）`)
      }
    }

    // ── G10 打包清单含 bundle 的 .js 回退，且桌面端没有第二份 bundle 数据 ──
    if (pack.length > 0) {
      for (const required of ['packages/cli/bundles/base/index.js', 'packages/cli/package.json']) {
        if (!pack.includes(required)) {
          findings.push(`G10 ${FILES.pack} 的必检清单里缺 ${required}（缺了启动就是 unknown-bundle）`)
        }
      }
    }
    // 第二份 bundle 数据 = 第二真相源：桌面端只许**编译**仓库里那一份，不许复制
    const desktopBundles = walk(
      root,
      ['apps/desktop'],
      (name) => name === 'index.ts' || name === 'index.js',
    ).filter((file) => file.replace(/\\/g, '/').includes('/bundles/'))
    if (desktopBundles.length > 0) {
      findings.push(
        `G10 apps/desktop 下出现 ${String(desktopBundles.length)} 个 bundle 文件（第二份 bundle 数据 = 第二真相源）`,
      )
    }
    // 主进程产物体量护栏：接线层不该把 workspace 包吞进来（那是 F-02-03 的复发信号）
    const mainBundle = join(root, 'apps', 'desktop', 'dist', 'main.mjs')
    if (existsSync(mainBundle)) {
      const kb = Math.round(statSync(mainBundle).size / 1024)
      if (kb > 200) {
        findings.push(
          `G10 apps/desktop/dist/main.mjs 有 ${String(kb)} KB（>200 KB 说明 @bah/* 被内联了：会让 instanceof 跨副本失效）`,
        )
      } else {
        notes.push(`G10 main.mjs ${String(kb)} KB（接线层体量正常；@bah/* 未内联）`)
      }
    } else {
      notes.push('G10 未找到 apps/desktop/dist/main.mjs（还没构建，跳过体量护栏）')
    }

    notes.push(
      `扫描桌面端源码 ${String(sources.length)} 个文件；IPC 名 ${String(IPC_NAMES.length)} 条；` +
        `暴露面 ${String(apiKeys.length)} 个方法；硬值 ${String(HARD_VALUES.length)} 项`,
    )
    return { ok: findings.length === 0, findings, notes }
  },
}

export { gate }

if (isMainModule(import.meta.url)) {
  await runStandalone(gate)
}
