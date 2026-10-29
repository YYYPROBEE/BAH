/**
 * HTTP 渠道的**唯一装配实现**（施工单 01 §3.6 / 00 D2）。
 *
 * `channel:web` 与 `channel:mobile` 都调它；差异只有三项（D2 原文）：**适配器**（能力位）、
 * **入口 HTML**、**默认端口**。路由表、闸序、安全头、限流、CSRF、SSE、审批与 verify 端点
 * **一份代码**——安全面只有一份实现才可被门禁与复审覆盖；否则移动端会成为
 * "绕过桌面端加固"的旁路。
 *
 * 本文件是 `plugins/web.ts` 原 `apply()` 体的**整体平移**，不是重写：七个 `ctx.effect(...)`
 * 的顺序、`bindPort` 的位置、注释里的 W16/W04/W09 编号全部保留（施工单 01 §10 R1 的判据是
 * `dispatch.test.ts` / `contract.test.ts` / `sse.test.ts` / `listen.test.ts` / `handoff.test.ts`
 * 全绿 + `/api/session` 逐字段相同）。
 *
 * 不做的事：本文件**不**决定用哪个适配器——那由调用方通过 `adapter` 工厂传入
 * （web 传 `createWebChannelAdapter`、mobile 传 `createMobileChannelAdapter`），
 * 这样"渠道身份"只有那两个薄工厂一处定义（01 §9 V9）。
 */

import { randomBytes } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import { join, resolve } from 'node:path'

import { deltaFrame, WebProjector, type ChannelId, type HttpChannelAdapter } from '@bah/channels'
import { describeThrown, type Context, type ServiceKey } from '@bah/core'
import { APPROVAL_SERVICE, type ApprovalResponder } from '@bah/interaction'
import { HALT_SERVICE, SENTRY_SERVICE } from '@bah/safety'
import { AGENTS_SERVICE, SESSION_SERVICE, type Agent, type AnySessionEvent } from '@bah/runtime'

import { RUN_SERVICE } from '../../boot.ts'
import { TELEMETRY } from '../telemetry.ts'
import { createRateLimiter } from '../web-rate-limit.ts'
import { generateWebToken, readWebToken } from '../web-auth.ts'
import type { WebSettings } from './config.ts'
import { tryService, type WebDeps } from './deps.ts'
import { createDispatcher } from './dispatch.ts'
import { createHandoff } from './handoff.ts'
import { sendThrown } from './http.ts'
import { sloReader } from './slo.ts'
import { bindPort } from './listen.ts'
import { createSseHub } from './sse.ts'

/** 绑定后的服务信息（测试 / 桌面壳内嵌 / CLI 打印用）。 */
export interface WebServerInfo {
  /** 实际监听端口（配置为 0 时由内核分配）。 */
  readonly port: number
  /** 可直接打开的地址。 */
  readonly url: string
  readonly sessionId: string
}

/** 装配一个 HTTP 渠道所需的全部差异（D2：只有三项 + 适配器工厂）。 */
export interface HttpChannelOptions {
  /** 插件 id：`channel:web` / `channel:mobile`。用于日志与错误上下文。 */
  readonly pluginId: string
  /** 渠道 id：进适配器与 `/api/session` 上报；同时是审批应答者的唯一 id。 */
  readonly channelId: ChannelId
  /** 已校验的配置（`resolveWebSettings` 的产物；含 entry / entries 白名单）。 */
  readonly settings: WebSettings
  /** 服务键：web 用 `WEB_SERVER`，mobile 用 `MOBILE_SERVER`（不共用，避免取错渠道地址）。 */
  readonly serverKey: ServiceKey<WebServerInfo>
  /** 适配器工厂（渠道身份的唯一落点：能力位与 id 由它决定，见 01 §9 V9）。 */
  readonly adapter: (options: { readonly sessionId?: string }) => HttpChannelAdapter
}

/**
 * 装配一个 HTTP 渠道（在插件 `apply()` 内调用）。
 *
 * @throws `web-listen-failed` 端口被占 / 取不到真实端口 / 显式端口命中禁用表（`listen.ts`）
 */
export async function createHttpChannel(ctx: Context, options: HttpChannelOptions): Promise<void> {
  const config = options.settings
  const run = ctx.get(RUN_SERVICE)
  const session = ctx.get(SESSION_SERVICE)
  const agents = ctx.get(AGENTS_SERVICE)
  const approval = ctx.get(APPROVAL_SERVICE)

  const adapter: HttpChannelAdapter = options.adapter({
    // 归属校验（W04）：票据只能由它所属的会话应答；与 ApprovalService 的 sessionId 必须同源
    sessionId: String(session.sessionId),
  })
  const projector = new WebProjector()
  // 历史重放：进程重启后前端连上来仍能看到完整对话（不依赖前端本地缓存）
  for (const event of session.events() as readonly AnySessionEvent[]) projector.apply(event)

  const staticRoot = resolve(config.staticRoot)
  // 没配环境变量就每次启动生成一个：演示打不开页面比"没鉴权"更糟，
  // 但 token 也绝不写死——它只存在于本进程与同源页面里。
  const webToken = readWebToken(process.env) ?? generateWebToken()
  // W09：进程级 CSRF token。页面加载时写进 cookie，前端读出后回填 `x-bah-csrf`；
  // 除同源 Origin 外，只接受 cookie 与请求头双提交且都与本值一致。
  const csrfToken = randomBytes(18).toString('base64url')
  const hub = createSseHub({
    projector,
    sessionId: () => String(session.sessionId),
    heartbeatMs: config.heartbeatMs,
    now: run.now,
  })

  // ① 会话事件 → 帧（唯一的实时数据源）
  ctx.effect(
    ctx.events.on('session/event', (payload) => {
      for (const frame of projector.apply(payload.event)) hub.publish(frame)
    }),
  )

  // ② 流式分片 → ephemeral delta（不入日志；断线即丢，权威仍是 assistant/message）
  ctx.effect(
    ctx.events.on('llm/stream', (streamer, next) => {
      const tapped: typeof streamer = async function* (call, signal) {
        for await (const chunk of streamer(call, signal)) {
          if (chunk.kind === 'text-delta') hub.publish(deltaFrame(chunk.text, run.now()))
          yield chunk
        }
      }
      return next(tapped)
    }),
  )

  // ③ 审批应答者：只登记，结论从 HTTP 提交（人点按钮 → adapter.decide → view.answer）。
  //    应答者 id = 渠道 id（`ApprovalService` 要求唯一；web/mobile 各一个实例）。
  const responder: ApprovalResponder = {
    id: options.channelId,
    attach(view) {
      adapter.attachApproval(view)
    },
  }
  ctx.effect(approval.attach(responder))

  // ④ agent 常驻驱动（首次提交时懒启动：headless 测试不会因空转挂住）
  let driver: Promise<void> | undefined
  const ensureDriver = (agent: Agent): void => {
    if (driver !== undefined) return
    driver = agent
      .drive()
      .catch((error: unknown) => {
        hub.publishFault('agent-driver-failed', describeThrown(error))
      })
      .finally(() => {
        driver = undefined
      })
  }

  const deps: WebDeps = {
    session,
    adapter,
    hub, // C5 人工接管（装配细节见 web/handoff.ts）
    handoff: createHandoff({ session, now: run.now, pendingTickets: () => adapter.pendingTickets().length }),
    webToken,
    csrfToken,
    rateLimiter: createRateLimiter(config.rateLimit),
    now: run.now,
    // 取唯一活体 agent（profile 里只有一个 `core:agent`）
    firstAgent: () => agents.list()[0],
    ensureDriver,
    trySentry: () => tryService(ctx, SENTRY_SERVICE),
    tryHalt: () => tryService(ctx, HALT_SERVICE),
    tryTelemetry: () => tryService(ctx, TELEMETRY),
    trySlo: sloReader(ctx),
    staticRoot,
    // 施工单 01 / 00 D3：`/` 的落点与 token 白名单都由配置驱动（绝对路径精确等值）
    defaultEntry: join(staticRoot, config.entry),
    tokenEntries: config.entries.map((entry) => join(staticRoot, entry)),
  }

  const handle = createDispatcher(config, deps)
  const server: Server = createServer((req, res) => {
    void handle(req, res).catch((error: unknown) => {
      // 单个请求出错不能拖垮服务；错误结构化返回，原因进响应体（不静默）
      sendThrown(res, error)
    })
  })

  // ⑤ 把实际端口暴露成服务（测试用 0 取随机端口；桌面壳内嵌也要知道地址）。
  // `--dump-config` 不监听（见 listen.ts 的 `bindPort`）：导出配置不该占端口
  const boundPort = await bindPort(server, config.host, config.port, run.probe)
  ctx.effect(
    ctx.provide(options.serverKey, {
      port: boundPort,
      url: `http://${config.host}:${String(boundPort)}/`,
      sessionId: String(session.sessionId),
    }),
  )

  // ⑥ 收尾。内核 `effect` **逆序**执行（`packages/core/src/context.ts:407`）⇒ 实跑顺序是先
  // `server.close()` 再断在途 SSE + 注销应答者；旧注释写"先断连接再关端口"，与内核相反（W16 复审更正）。
  ctx.effect(() => {
    hub.dispose()
    adapter.dispose()
  })
  ctx.effect(() => {
    server.close()
  })
}
