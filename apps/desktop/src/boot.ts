/**
 * 私有 host 启动（桌面端 02 §2.3）。**不 import electron**：所有电子侧事实都从
 * `options` 传入（`isPackaged` / `resourcesPath` / `appDir` / `appDataRoot`），
 * 这样"启动私有宿主"这件事与"跑在 Electron 里"解耦，也让本文件里的顺序可以被审查。
 *
 * ## 顺序为什么是这五步
 *
 * 1. **sqlite 自检**：`bank:saga-store` 用 `node:sqlite`。Electron 内置 Node 若没有它，
 *    失败会在 boot 中途以一句 `Cannot find module` 出现，且 saga 那一行已经半装配——
 *    先查再起，失败信息才指向真正原因（R-DT-04）。
 * 2. **token 注入**：`channel:desktop` 的 `readWebToken(process.env)` 在 `apply()` 时读。
 *    必须在 `boot()` **之前**写进环境，否则会生成第二个随机 token，页面拿到的
 *    meta 与请求头对不上 → 全站 401。
 * 3. **dev 的 TS loader**：`loadBundles()` 要 `import(.../bundles/base/index.ts)`。
 *    Electron 主进程没有 TS loader，dev 下必须先注册 `tsx`；packaged 下走 03 单的
 *    `.js` 回退，不注册。
 * 4. **chdir**：`staticRoot` / `core:persistence.root` / `policy:rules.root` 都相对
 *    `process.cwd()` 解析。不 chdir，打包后会在 exe 目录下找 `apps/web`（白屏而非崩溃）。
 * 5. **boot**：装配后从 `DESKTOP_SERVER` 取**实际**端口（`port:0`）。
 *
 * ## 会话 ID 固定为 `desktop-demo`
 *
 * 同一台机器每次启动续写同一会话：关掉再打开能看到历史与审计（演示幕 4 依赖这一点）。
 * 清空需人工删 `userData/sessions`——文档写明，不做"自动新建会话"（那会让演示幕 4 失效）。
 */

import { randomBytes } from 'node:crypto'
import { createRequire } from 'node:module'
import { join } from 'node:path'

import { loadBundles, readLayers, readProfile } from '@bah/cli'
import type { SessionId } from '@bah/core'
import { boot, createCatalog, DESKTOP_SERVER, type BootedApp } from '@bah/host'
import { DEFAULT_TENANT_ID, logJson } from '@bah/util'

import { resolveHomeDir, resolveSessionsDir } from './paths.ts'
import { desktopSessionId } from './session-id.ts'

/**
 * 会话 ID：**每次启动一个新会话**（`desktop-<yyyymmdd>-<hhmmss>`）。
 *
 * 方案原文要求固定 `desktop-demo` 以"续写同一会话"，但平台没有 resume：
 * `jsonl:create()` 对已存在会话排他失败、`provideSession()` 也不回放磁盘。
 * 固定 ID 的真实后果是"第二次启动起持久化静默全丢"。完整论证见 `session-id.ts`。
 */
export { desktopSessionId } from './session-id.ts'

/** 启动失败的类异常（`code` 会进 `BootFatal`，也是 03 单排障的检索键）。 */
export class DesktopBootError extends Error {
  readonly code: string

  constructor(code: string, message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'DesktopBootError'
    this.code = code
  }
}

/** 一次成功启动的产物。 */
export interface DesktopBoot {
  readonly app: BootedApp
  /** 实际监听端口（`port:0` ⇒ 每次启动都可能不同）。 */
  readonly port: number
  /** 可直接加载的地址（`http://127.0.0.1:<port>/`）。 */
  readonly url: string
  readonly sessionId: string
}

/** 启动输入（全部由 `main.ts` 从 Electron 取，便于把本函数当普通 Node 代码审查）。 */
export interface DesktopBootOptions {
  /** 仓库根（dev）或 `resources/app`（packaged）。 */
  readonly root: string
  /** userData 根（会话/记忆/saga 的落点）。 */
  readonly userData: string
  /** 是否打包运行（决定是否注册 TS loader）。 */
  readonly isPackaged: boolean
  /** 时钟（测试可注入；生产传 `Date.now`）。 */
  readonly now: () => number
  /** 进程环境（生产传 `process.env`；测试传字面量以便断言 token 注入）。 */
  readonly env: NodeJS.ProcessEnv
  /** chdir 的落地函数（生产 = `process.chdir`；测试可传空实现以不污染同批用例）。 */
  readonly chdir?: (dir: string) => void
}

/**
 * 启动私有 host。
 *
 * @throws `DesktopBootError` 码：`desktop-sqlite-unavailable`（缺 `node:sqlite`）、
 *         `desktop-tsx-unavailable`（dev 下 TS loader 注册失败）；
 *         其余 boot 期错误原样抛出（`web-listen-failed` 等），由调用方翻成 fatal
 */
export async function startDesktopHost(options: DesktopBootOptions): Promise<DesktopBoot> {
  assertNodeSqlite()

  // ── token：只在主进程环境里，不写文件、不打印、不进 IPC（I-DT-06）─────────────
  const existing = options.env['BAH_WEB_TOKEN']
  if (existing === undefined || existing.trim() === '') {
    options.env['BAH_WEB_TOKEN'] = randomBytes(24).toString('base64url')
  }

  if (!options.isPackaged) {
    await registerDevTsLoader()
  }

  // ── chdir：staticRoot / policy root / persistence root 都相对 cwd ─────────────
  const chdir = options.chdir ?? ((dir: string) => process.chdir(dir))
  chdir(options.root)

  const profile = readProfile(options.root, 'desktop')
  const bundles = await loadBundles(options.root, profile.bundles)
  const { layers } = readLayers(options.root, profile, {
    home: resolveHomeDir(options.userData),
    overlays: [],
  })

  const app = await boot({
    profile,
    bundles,
    layers,
    catalog: createCatalog(),
    run: {
      sessionId: desktopSessionId(new Date(options.now())) as SessionId,
      // 租户只来自启动期（TA-16）；桌面端没有 `--tenant`，固定 demo
      tenantId: DEFAULT_TENANT_ID,
      now: options.now,
      // I-DT-08：会话只能写 userData。`core:persistence.root`（sessions）相对 cwd，
      // 不覆盖就会写进 resources/app —— 安装目录通常只读，失败信息是 EACCES。
      jsonlDir: resolveSessionsDir(options.userData),
      /**
       * ⚠ **必须为 `true`**（不能照抄 02 §2.3 的 `probe:false`）。
       *
       * `web/listen.ts` 的 `bindPort()` 第一行就是 `if (probe === false) return port`
       * ——它是给 `--dump-config` 用的"只装配不占端口"。桌面端写 `port: 0`，
       * 一旦 `probe:false`，`DESKTOP_SERVER.port` 会等于 **0**、地址变成
       * `http://127.0.0.1:0/`，窗口必然打不开，而且不是崩溃、是一句 `bad port`。
       *
       * "离线不探 RAG"这件事由 `bank:knowledge.required:false` 保证（sidecar 缺席
       * 只降级为 `knowledge-unavailable`）；连接被拒是**立即**失败，不是等满 1s。
       */
      probe: true,
      warn: (message: string) => {
        logJson('warn', 'desktop.host-warn', { reason: message })
      },
    },
  })

  const info = app.ctx.get(DESKTOP_SERVER)
  logJson('info', 'desktop.host-ready', {
    port: info.port,
    sessionId: info.sessionId,
    packaged: options.isPackaged,
  })

  return { app, port: info.port, url: info.url, sessionId: info.sessionId }
}

/**
 * 自检 `node:sqlite`。
 *
 * 用 `createRequire(import.meta.url)` 而不是 `import('node:sqlite')`：后者在 Node 22 里
 * 会打一条 `ExperimentalWarning` 到 stderr（每次启动都有），而 `require` 只在真正
 * 用到时才加载——这里只需要"能不能拿到"这一个事实。
 */
function assertNodeSqlite(): void {
  try {
    const require = createRequire(import.meta.url)
    require('node:sqlite')
  } catch (error) {
    throw new DesktopBootError(
      'desktop-sqlite-unavailable',
      `Electron 内置 Node（${process.versions.node}）没有 node:sqlite，bank:saga-store 无法装配。` +
        '请升级 Electron，或显式关闭 saga（本方案不提供后者：静默禁用 saga 会让补偿账本消失）',
      { cause: error },
    )
  }
}

/**
 * dev 下注册 tsx 的 ESM loader。
 *
 * 失败**不静默跳过**：跳过之后 `loadBundles` 会抛一个"不知道 index.ts 是什么"的
 * 解析错误，那个信息对现场毫无帮助。这里把它翻成可检索的 `desktop-tsx-unavailable`。
 */
async function registerDevTsLoader(): Promise<void> {
  try {
    const tsx = (await import('tsx/esm/api')) as { register: () => unknown }
    tsx.register()
  } catch (error) {
    throw new DesktopBootError(
      'desktop-tsx-unavailable',
      'dev 模式需要 tsx 才能加载 packages/cli/bundles/**/index.ts；请确认根目录已装 tsx（pnpm install）',
      { cause: error },
    )
  }
}

/** 退出时释放（`before-quit` 调一次；重复调用由内核幂等）。 */
export async function stopDesktopHost(instance: DesktopBoot, reason: string): Promise<void> {
  await instance.app.dispose(reason)
  logJson('info', 'desktop.host-stopped', { reason, sessionId: instance.sessionId })
}

/** 会话目录（菜单"打开会话目录"用）。 */
export function sessionsDirOf(userData: string): string {
  return resolveSessionsDir(userData)
}

/** 拼接静态根（排障日志里打印"到底在找哪个目录"）。 */
export function webDirOf(root: string): string {
  return join(root, 'apps', 'web')
}
