/**
 * 网关入口（施工单 02 §4）。
 *
 * 装配顺序：配置 → 日志 → token/传输 → 微信适配器 → 注册表 → 监督者 → 入站编排 → 服务。
 *
 * **生产只注册 `wechat`**（门禁 G11/G12）：Mock 适配器住在 `test/mock-platform.ts`，
 * 本文件不 import 它，也没有 `BAH_IM_ENABLE_MOCK` 之类的开关——"测试代码进生产"
 * 只要有一个环境变量开关就会发生。
 */

import type { Server } from 'node:http'

import { createWechatAdapter } from '@bah/channels'
import { BahError, configureLogging } from '@bah/util'

import { createPullStore, type PullStore } from './bridge/outbound.ts'
import { handleInbound } from './bridge/turn.ts'
import { loadConfig, type GatewayConfig, type PushMode } from './config.ts'
import { createDedupe, type Dedupe } from './ingress/dedupe.ts'
import { createRateLimiter, type RateLimiter } from './ingress/ratelimit.ts'
import { createImLogger, type ImLogger } from './log.ts'
import { createRegistry, type PlatformRegistry } from './platform/registry.ts'
import { createTokenProvider } from './platform/wechat/token.ts'
import { createNodeFetchJson, createWechatPushText } from './platform/wechat/transport.ts'
import { createGatewayServer } from './server.ts'
import { createSupervisor, REAP_INTERVAL_MS, type Supervisor } from './session/supervisor.ts'

/** 一个装配好的网关（`server` 尚未 listen）。 */
export interface GatewayApp {
  readonly config: GatewayConfig
  readonly server: Server
  readonly registry: PlatformRegistry
  readonly supervisor: Supervisor
  readonly dedupe: Dedupe
  readonly rateLimiter: RateLimiter
  readonly pull: PullStore
  readonly log: ImLogger
  /** 停服务 + 停子进程 + 停定时器（可重复调用）。 */
  dispose(): Promise<void>
}

/** 装配依赖（只在测试里注入假实现）。 */
export interface BuildOptions {
  readonly log?: ImLogger
  readonly nowMs?: () => number
  readonly fetchJson?: ReturnType<typeof createNodeFetchJson>
  readonly pushMode?: PushMode
}

/**
 * 装配网关（不 listen）。
 *
 * @throws `BahError('im-config-invalid')` 平台能力位自相矛盾（既不能被动回复也不能推送）
 */
export function buildGateway(config: GatewayConfig, options: BuildOptions = {}): GatewayApp {
  const nowMs = options.nowMs ?? ((): number => Date.now())
  const log = options.log ?? createImLogger(config.logLevel)
  const fetchJson = options.fetchJson ?? createNodeFetchJson()

  const token = createTokenProvider({
    appId: config.wechat.appId,
    appSecret: config.wechat.appSecret,
    apiBase: config.wechat.apiBase,
    fetchJson,
    nowMs,
  })
  const pushText = createWechatPushText({ token, apiBase: config.wechat.apiBase, fetchJson, log })

  const wechat = createWechatAdapter({
    accountKey: config.wechat.accountKey,
    token: config.wechat.token,
    appId: config.wechat.appId,
    appSecret: config.wechat.appSecret,
    apiBase: config.wechat.apiBase,
    nowSec: () => Math.floor(nowMs() / 1000),
    pushText,
  })

  // 能力位自相矛盾 → 启动期 fail-loud（§2.13："不等到用户消息才报"）
  if (!wechat.capabilities.passiveReply && !wechat.capabilities.asyncPush) {
    throw new BahError('im-config-invalid', 'im: 平台既不能被动回复也不能推送，网关不可用')
  }

  const registry = createRegistry([wechat], { wechat: [config.wechat.accountKey] })
  const supervisor = createSupervisor({ config, log, nowMs })
  const dedupe = createDedupe({ nowMs })
  const rateLimiter = createRateLimiter()
  const pull = createPullStore({ nowMs })

  const effectiveConfig: GatewayConfig =
    options.pushMode === undefined ? config : { ...config, pushMode: options.pushMode }

  const server = createGatewayServer({
    registry,
    log,
    children: () => supervisor.children(),
    startedAtMs: nowMs(),
    nowMs,
    handleMessage: (inbound, reply) =>
      handleInbound(
        {
          config: effectiveConfig,
          supervisor,
          dedupe,
          rateLimiter,
          pull,
          log,
          capabilitiesOf: (platform, accountKey) => registry.get(platform, accountKey)?.capabilities,
        },
        inbound,
        reply,
      ),
  })

  // 闲置扫描（§2.11："每 60s 扫描"）；`unref` 让测试进程能正常退出
  const reaper = setInterval(() => {
    const reaped = supervisor.reapIdle()
    if (reaped > 0) log.info('im-child-reap', { reason: 'idle', count: reaped })
  }, REAP_INTERVAL_MS)
  reaper.unref()

  let disposed = false
  return {
    config: effectiveConfig,
    server,
    registry,
    supervisor,
    dedupe,
    rateLimiter,
    pull,
    log,
    async dispose(): Promise<void> {
      if (disposed) return
      disposed = true
      clearInterval(reaper)
      await new Promise<void>((resolve) => {
        server.close(() => resolve())
      })
      await supervisor.dispose()
    },
  }
}

/** 监听（生产用；测试可直接 `server.listen(0)`）。 */
export async function listen(app: GatewayApp): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    app.server.once('error', reject)
    app.server.listen(app.config.port, app.config.host, () => {
      const address = app.server.address()
      resolve(typeof address === 'object' && address !== null ? address.port : app.config.port)
    })
  })
}

/** 进程入口。 */
async function main(): Promise<void> {
  const config = loadConfig(process.env, process.cwd())
  configureLogging({ level: config.logLevel })
  const app = buildGateway(config)
  const port = await listen(app)
  app.log.info('im-gateway-start', { port, platforms: app.registry.size() })

  const shutdown = (signal: string): void => {
    app.log.info('im-child-reap', { reason: 'shutdown', signal })
    void app.dispose().then(() => {
      process.exitCode = 0
    })
  }
  process.once('SIGINT', shutdown)
  process.once('SIGTERM', shutdown)
}

// 直接运行（`tsx src/main.ts`）时才启动；被测试 import 时不自动 listen
if (process.argv[1] !== undefined && /main\.(?:ts|js)$/u.test(process.argv[1])) {
  void main().catch((error: unknown) => {
    const code = error instanceof BahError ? error.code : 'im-internal'
    process.stderr.write(`im-gateway: 启动失败（${code}）：${error instanceof Error ? error.message : 'unknown'}\n`)
    process.exitCode = 1
  })
}
