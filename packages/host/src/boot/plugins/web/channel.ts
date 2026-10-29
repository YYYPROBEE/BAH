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

import { WebProjector, type ChannelId, type HttpChannelAdapter } from '@bah/channels'
import { describeThrown, type Context, type ServiceKey } from '@bah/core'
import { APPROVAL_SERVICE } from '@bah/interaction'
import { HALT_SERVICE, SENTRY_SERVICE } from '@bah/safety'
import { AGENTS_SERVICE, SESSION_SERVICE, TOOLS_SERVICE, type Agent, type AnySessionEvent } from '@bah/runtime'
import { logJson } from '@bah/util'

import { RUN_SERVICE } from '../../boot.ts'
import { DECISION_AUDIT } from '../audit-decisions.ts'
import { SESSION_FILES } from '../persistence.ts'
import { TELEMETRY } from '../telemetry.ts'
import { createRateLimiter } from '../web-rate-limit.ts'
import { generateWebToken, readWebToken } from '../web-auth.ts'
import { readOperatorConfig } from '../web-operator.ts'
import { createWebAuthRuntime } from './auth/wire.ts'
import type { WebSettings } from './config.ts'
import { tryService, type WebDeps } from './deps.ts'
import { createDispatcher } from './dispatch.ts'
import { createHandoff } from './handoff.ts'
import { sendThrown } from './http.ts'
import { sloReader } from './slo.ts'
import { bindPort } from './listen.ts'
import { createSseHub } from './sse.ts'
import { wireWebPipelines } from './wire.ts'

/**
 * D2 拍板开关（T-04.2）：`password` 模式下是否开放坐席。
 *
 * 本轮不做：password 作业面与坐席登录卡片要一起改（`seat/main.js` 复用登录卡片、
 * `createSeatApi` 走 cookie + `x-bah-csrf`、SSE 用 cookie）。在它落地前，password
 * 模式的 `/operator` 与 5 条坐席 API 一律 404（**在身份解析之前**判，401 会暴露存在性）。
 */
const SEAT_PASSWORD_LOGIN = false

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
  // 施工单 01 §3.5 的注入口在 04 单接线：effects 帧的"写侧工具"权威名单来自
  // 宿主的工具注册表（`sideEffect==='write'`）。绿色但 write 的 `verify_*` 由此进入清单——
  // 只靠 tier 双判据会漏掉它们。
  const writeToolNames = tryService(ctx, TOOLS_SERVICE)
    ?.list()
    .filter((definition) => definition.sideEffect === 'write')
    .map((definition) => definition.name)
  const projector =
    writeToolNames === undefined ? new WebProjector() : new WebProjector({ writeToolNames })
  // 历史重放：进程重启后前端连上来仍能看到完整对话（不依赖前端本地缓存）
  for (const event of session.events() as readonly AnySessionEvent[]) projector.apply(event)

  const staticRoot = resolve(config.staticRoot)
  // 没配环境变量就每次启动生成一个：演示打不开页面比"没鉴权"更糟，
  // 但 token 也绝不写死——它只存在于本进程与同源页面里。
  const webToken = readWebToken(process.env) ?? generateWebToken()
  // 坐席凭证与显示名（未配置 token ⇒ 坐席面整体 404；两 token 相同 ⇒ 启动失败）
  const operator = readOperatorConfig(process.env, webToken)
  // W09：进程级 CSRF token。页面加载时写进 cookie，前端读出后回填 `x-bah-csrf`；
  // 除同源 Origin 外，只接受 cookie 与请求头双提交且都与本值一致。
  const csrfToken = randomBytes(18).toString('base64url')
  const hub = createSseHub({
    projector,
    sessionId: () => String(session.sessionId),
    heartbeatMs: config.heartbeatMs,
    now: run.now,
  })

  // 认证运行期（02 TA-24）：装配细节在 `auth/wire.ts`（会话存储 / 口令目录 / 节流 / 审计）。
  // static 双凭证（合流 T-06）：`svc:web=customer` / `svc:operator=agent`。
  const warn = run.warn ?? ((message: string) => logJson('warn', 'web.channel-warn', { reason: message }))
  const auth = createWebAuthRuntime({
    ctx,
    run,
    config,
    webToken,
    operatorToken: operator.token,
    serverCsrf: csrfToken,
    warn,
  })

  // ①②③ 三条事件管线（W16 从 apply 搬出；合流改成共用一份接线，避免 web/mobile 分叉）
  wireWebPipelines({ ctx, hub, projector, adapter, approval, now: run.now })

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

  const operatorEntry = join(staticRoot, 'operator.html')
  const webSeatEnabled =
    options.channelId === 'web' &&
    (config.auth.mode === 'password' ? SEAT_PASSWORD_LOGIN : operator.token !== undefined)
  const deps: WebDeps = {
    session,
    // 本进程服务的租户（01 TA-16）：只能来自启动期，绝不从请求头取
    tenantId: run.tenantId,
    auth,
    adapter,
    hub, // C5 人工接管（装配细节见 web/handoff.ts）
    handoff: createHandoff({
      session,
      now: run.now,
      pendingTickets: () => adapter.pendingTickets().length,
      files: tryService(ctx, SESSION_FILES),
      slaMs: config.handoff.slaMs,
    }),
    webToken,
    operatorToken: operator.token,
    operatorName: operator.name,
    csrfToken,
    rateLimiter: createRateLimiter(config.rateLimit),
    now: run.now,
    // 取唯一活体 agent（profile 里只有一个 `core:agent`）
    firstAgent: () => agents.list()[0],
    ensureDriver,
    trySentry: () => tryService(ctx, SENTRY_SERVICE),
    tryHalt: () => tryService(ctx, HALT_SERVICE),
    // 审批操作者入链（03 TA-46）：没装 audit:decisions 的 profile 必须照常起
    tryAudit: () => tryService(ctx, DECISION_AUDIT),
    tryTelemetry: () => tryService(ctx, TELEMETRY),
    trySlo: sloReader(ctx),
    staticRoot,
    // 施工单 01 / 00 D3：`/` 的落点与 token 白名单都由配置驱动（绝对路径精确等值）
    defaultEntry: join(staticRoot, config.entry),
    tokenEntries: config.entries.map((entry) => join(staticRoot, entry)),
    operatorEntry: join(staticRoot, 'operator.html'),
    // 坐席工作台只属于桌面 web 渠道：移动壳没有坐席 UI，开着入口就是"存在但打不开"。
    // password 模式的坐席登录本轮不做（D2）：`SEAT_PASSWORD_LOGIN=false` ⇒ 整条 404。
    // 03 单：IM 子进程没有坐席页面，但运营桥要转发 5 条坐席 API——API 面单独判。
    seatEnabled: webSeatEnabled,
    seatApiEnabled:
      webSeatEnabled || (options.channelId === 'im' && operator.token !== undefined),
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
