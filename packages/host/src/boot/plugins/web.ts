/**
 * `channel:web`：Web 渠道的宿主接线（施工单 13 · 前端作为插件模块接入）。
 *
 * 分工：**本文件只做装配与生命周期**——起监听、装事件、注入服务、按 `ctx.effect` 收尾。
 * 路由表在 `web/router.ts`（数据，供快照比对），闸的顺序在 `web/dispatch.ts`，
 * 四组处理器在 `web/handlers/*`；`@bah/channels/web` 是事件→帧的纯投影，`apps/web` 是帧→DOM。
 *
 * 为什么是插件行而不是独立 server 脚本：端口/静态目录随部署变化（必须是校验过的 Config 字段）；
 * 渠道要按 `inject` 等 `runtime:session` / `runtime:agents` / `interaction:approval` 就绪
 * （缺审批服务就挂起，不静默降级）；装配与回滚走内核 `effect()`。
 *
 * 端口占用**不自动换端口**：答辩时浏览器开着 7331、服务却跑到 7332 是最坏的"看起来能用"。
 *
 * W16 拆分：本文件从 916 行降到装配面，行为零变化——证据是路由表快照与
 * `snapshots/web-channel` 回放 diff=0。新增路由必须走路由表，**不许**再往 `apply` 里加 `if`。
 */

import { randomBytes } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import { join, resolve } from 'node:path'

import {
  createWebChannelAdapter,
  deltaFrame,
  WebProjector,
  type WebChannelAdapter,
} from '@bah/channels'
import { defineService, describeThrown, type ServiceKey } from '@bah/core'
import { APPROVAL_SERVICE, type ApprovalResponder } from '@bah/interaction'
import { HALT_SERVICE, SENTRY_SERVICE } from '@bah/safety'
import {
  AGENTS_SERVICE,
  SESSION_SERVICE,
  type Agent,
  type AnySessionEvent,
} from '@bah/runtime'

import type { HostPlugin } from '../../plugin-manager/index.ts'
import { RUN_SERVICE } from '../boot.ts'
import { TELEMETRY } from './telemetry.ts'
import { createRateLimiter } from './web-rate-limit.ts'
import { generateWebToken, readWebToken } from './web-auth.ts'
import { DEFAULT_WEB, resolveWebSettings, type WebSettings } from './web/config.ts'
import { tryService, type WebDeps } from './web/deps.ts'
import { createDispatcher } from './web/dispatch.ts'
import { createHandoff } from './web/handoff.ts'
import { sendThrown } from './web/http.ts'
import { bindPort } from './web/listen.ts'
import { createSseHub } from './web/sse.ts'

/** 配置面再导出（调用方与测试只认 `web.ts`，不认内部文件布局）。 */
export { DEFAULT_WEB }
export type { WebSettings }

/** 绑定后的服务信息（测试 / 桌面壳内嵌 / CLI 打印用）。 */
export interface WebServerInfo {
  /** 实际监听端口（配置为 0 时由内核分配）。 */
  readonly port: number
  /** 可直接打开的地址。 */
  readonly url: string
  readonly sessionId: string
}

/** 服务键：`channel:web`（取服务即证明渠道已就绪）。 */
export const WEB_SERVER: ServiceKey<WebServerInfo> = defineService<WebServerInfo>('channel:web')

export const webPlugin: HostPlugin<WebSettings> = {
  id: 'channel:web',

  plugin: {
    name: 'channel:web',
    inject: [RUN_SERVICE.id, SESSION_SERVICE.id, AGENTS_SERVICE.id, APPROVAL_SERVICE.id],

    async apply(ctx, config) {
      const run = ctx.get(RUN_SERVICE)
      const session = ctx.get(SESSION_SERVICE)
      const agents = ctx.get(AGENTS_SERVICE)
      const approval = ctx.get(APPROVAL_SERVICE)

      const adapter: WebChannelAdapter = createWebChannelAdapter({
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

      // ③ 审批应答者：只登记，结论从 HTTP 提交（人点按钮 → adapter.decide → view.answer）
      const responder: ApprovalResponder = {
        id: 'web',
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
        tenantId: run.tenantId,
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
        staticRoot,
        indexPath: join(staticRoot, 'index.html'),
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
        ctx.provide(WEB_SERVER, {
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
    },
  },

  validate(config) {
    return resolveWebSettings(config)
  },
}
