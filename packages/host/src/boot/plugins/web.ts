/**
 * `channel:web`：Web 渠道的宿主接线（施工单 13 · 前端作为插件模块接入）。
 *
 * 职责边界（与 `@bah/channels/web` 的分工）：
 * - **本文件**：HTTP / SSE / 静态资源 / 审批应答者 / agent 驱动 —— 一切有副作用的东西；
 * - `@bah/channels/web`：事件 → 帧的纯投影（可快照、可测）；
 * - `apps/web`：帧 → DOM（纯渲染）。
 *
 * 为什么做成插件行而不是独立 server 脚本：
 * 1. 端口 / 静态目录随部署变化 → 必须是校验过的 Config 字段（AGENTS.md 纪律 4）；
 * 2. 渠道要拿 `runtime:session`、`runtime:agents`、`interaction:approval` 三个服务，
 *    只有插件能按 `inject` 等待它们就绪（缺审批服务就挂起，不静默降级）；
 * 3. 装配顺序 / 回滚走内核 `effect()`，`dispose` 时端口、SSE、审批应答者一起收。
 *
 * 端口占用**不自动换端口**：现场答辩时浏览器开着 7331、服务却跑到 7332 是最坏的一种"看起来能用"。
 */

import { readFile } from 'node:fs/promises'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { extname, isAbsolute, join, normalize, resolve, sep } from 'node:path'

import {
  createWebChannelAdapter,
  deltaFrame,
  WebProjector,
  type WebChannelAdapter,
  type WebFrame,
} from '@bah/channels'
import { defineService, describeThrown } from '@bah/core'
import { APPROVAL_SERVICE } from '@bah/interaction'
import type { ApprovalResponder } from '@bah/interaction'
import { SENTRY_SERVICE } from '@bah/safety'
import type { SentryHandle } from '@bah/safety'
import { AGENTS_SERVICE, SESSION_SERVICE } from '@bah/runtime'
import { BahError } from '@bah/util'

import type { Context, ServiceKey } from '@bah/core'
import type { Agent, AnySessionEvent } from '@bah/runtime'

import type { HostPlugin } from '../../plugin-manager/index.ts'
import { RUN_SERVICE } from '../boot.ts'
import { readPositiveInteger, readString, rejectUnknownKeys } from '../config.ts'
import {
  isLoopbackAddress,
  parseUnfreezeBody,
  readAdminToken,
  tokenMatches,
} from './web-admin.ts'

/** `channel:web` 的配置（全部随部署变化 → 全部可校验）。 */
export interface WebSettings {
  /** 监听端口（默认 7331）。 */
  readonly port: number
  /** 监听地址（默认 127.0.0.1；对外暴露需显式改）。 */
  readonly host: string
  /** 静态根（默认 `apps/web`；纯原生 ES 模块，无需构建）。 */
  readonly staticRoot: string
  /** SSE 心跳间隔（ms，默认 15000）。 */
  readonly heartbeatMs: number
}

/** 默认配置。 */
export const DEFAULT_WEB: WebSettings = {
  port: 7331,
  host: '127.0.0.1',
  staticRoot: 'apps/web',
  heartbeatMs: 15_000,
}

/** 人工解冻的唯一入口路径（HP-0 §3.2）。 */
const ADMIN_UNFREEZE_PATH = '/api/admin/sentry/unfreeze'

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

/** 请求体上限（64 KiB）：对话输入不该是上传通道。 */
const MAX_BODY_BYTES = 64 * 1024

/** 票据 ID 白名单（会进日志与查询键，禁止任意字符）。 */
const TICKET_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/

/** 静态资源 MIME（不引第三方库；未知类型一律 `application/octet-stream`）。 */
const MIME: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
}

/** 一条 SSE 连接。 */
interface SseClient {
  readonly res: ServerResponse
  readonly heartbeat: NodeJS.Timeout
}

/**
 * 请求处理期抛出的**客户端**错误 → HTTP 状态码。
 *
 * 未登记的一律 500：这些码是"调用方写错了"，用 500 会让前端把用户的输入问题
 * 报成"服务器故障"，也会把真正的内部错误淹没在同一种响应里。
 */
const REQUEST_ERROR_STATUS: Readonly<Record<string, number>> = {
  'web-body-too-large': 413,
  'web-invalid-body': 400,
  'web-invalid-json': 400,
}

/** 发一个 JSON 响应。 */
function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
  })
  res.end(payload)
}

/** 结构化错误响应。 */
function sendError(res: ServerResponse, status: number, code: string, reason: string): void {
  sendJson(res, status, { error: { code, reason } })
}

/** 读请求体（JSON；空体视为 `{}`）。 */
async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = chunk as Buffer
    size += buffer.length
    if (size > MAX_BODY_BYTES) {
      throw new BahError('web-body-too-large', `web: 请求体超过 ${String(MAX_BODY_BYTES)} 字节`)
    }
    chunks.push(buffer)
  }
  if (size === 0) return {}
  const text = Buffer.concat(chunks).toString('utf8')
  try {
    const parsed: unknown = JSON.parse(text)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new BahError('web-invalid-body', 'web: 请求体必须是 JSON 对象')
    }
    return parsed as Record<string, unknown>
  } catch (error) {
    if (error instanceof BahError) throw error
    throw new BahError('web-invalid-json', 'web: 请求体不是合法 JSON')
  }
}

/** 读字符串字段。 */
function readBodyString(body: Record<string, unknown>, key: string): string | undefined {
  const value = body[key]
  return typeof value === 'string' ? value : undefined
}

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

      const adapter: WebChannelAdapter = createWebChannelAdapter()
      const projector = new WebProjector()
      // 历史重放：进程重启后前端连上来仍能看到完整对话（不依赖前端本地缓存）
      for (const event of session.events() as readonly AnySessionEvent[]) projector.apply(event)

      const clients = new Set<SseClient>()
      const staticRoot = resolve(config.staticRoot)

      /** 推一帧给所有连接。 */
      const publish = (frame: WebFrame): void => {
        const payload = `event: frame\ndata: ${JSON.stringify(frame)}\n\n`
        for (const client of clients) client.res.write(payload)
      }

      /** 渠道级故障（不是会话事实，走独立事件名，避免与 EventSource 内置 error 冲突）。 */
      const publishFault = (code: string, reason: string): void => {
        const payload = `event: fault\ndata: ${JSON.stringify({ code, reason })}\n\n`
        for (const client of clients) client.res.write(payload)
      }

      // ① 会话事件 → 帧（唯一的实时数据源）
      ctx.effect(
        ctx.events.on('session/event', (payload) => {
          for (const frame of projector.apply(payload.event)) publish(frame)
        }),
      )

      // ② 流式分片 → ephemeral delta（不入日志；断线即丢，权威仍是 assistant/message）
      ctx.effect(
        ctx.events.on('llm/stream', (streamer, next) => {
          const tapped: typeof streamer = async function* (call, signal) {
            for await (const chunk of streamer(call, signal)) {
              if (chunk.kind === 'text-delta') publish(deltaFrame(chunk.text, run.now()))
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
          // 只登记；结论由 HTTP 提交（人点按钮 → adapter.decide → view.answer）
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
            publishFault('agent-driver-failed', describeThrown(error))
          })
          .finally(() => {
            driver = undefined
          })
      }

      /** 取唯一活体 agent（profile 里只有一个 `core:agent`）。 */
      const firstAgent = (): Agent | undefined => agents.list()[0]

      // ⑤ SSE：一条连接 = 一份快照 + 增量
      const streamEvents = (req: IncomingMessage, res: ServerResponse, since: number): void => {
        res.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-store',
          connection: 'keep-alive',
          'x-accel-buffering': 'no',
        })
        res.write(': connected\n\n')
        // 快照始终全量：客户端按键替换，比"补发到某条"少一条会错的路径
        res.write(`event: frame\ndata: ${JSON.stringify(projector.snapshot(String(session.sessionId)))}\n\n`)

        const heartbeat = setInterval(() => {
          res.write(`: ping ${String(run.now())} ${String(since)}\n\n`)
        }, config.heartbeatMs)
        heartbeat.unref()

        const client: SseClient = { res, heartbeat }
        clients.add(client)
        req.on('close', () => {
          clearInterval(heartbeat)
          clients.delete(client)
        })
      }

      /** 静态资源：路径规范化 + 前缀校验（穿越直接 404，不返回 403 免得被探测）。 */
      const serveStatic = async (pathname: string, res: ServerResponse, headOnly = false): Promise<void> => {
        // 先去掉前导斜杠再规范化：`path.normalize('/../../x')` 会把 `..` 夹在根上吞掉，
        // 直接 join 反而读到了 staticRoot 内的文件——"看起来安全"的穿越
        const decoded = pathname === '/' ? 'index.html' : decodeURIComponent(pathname)
        const relativePath = normalize(decoded.replace(/^[\\/]+/, ''))
        const escaped = relativePath === '..' || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)
        const target = resolve(join(staticRoot, relativePath))
        if (escaped || (target !== staticRoot && !target.startsWith(staticRoot + sep))) {
          sendError(res, 404, 'web-not-found', `没有这个资源：${pathname}`)
          return
        }
        try {
          const content = await readFile(target)
          res.writeHead(200, {
            'content-type': MIME[extname(target).toLowerCase()] ?? 'application/octet-stream',
            'content-length': content.length,
            'cache-control': 'no-cache',
          })
          res.end(headOnly ? undefined : content)
        } catch {
          sendError(res, 404, 'web-not-found', `没有这个资源：${pathname}`)
        }
      }

      /**
       * 惰性取 sentry 服务。
       *
       * **不能**把 `SENTRY_SERVICE.id` 写进 `webPlugin.plugin.inject`：那样没有 sentry 的
       * profile 会直接起不来。web 是渠道，不是风控的一部分——它只提供入口。
       */
      const trySentry = (): SentryHandle | undefined => {
        try {
          return ctx.get(SENTRY_SERVICE)
        } catch {
          return undefined
        }
      }

      /**
       * 人工解冻（HP-0 §3.2）。
       *
       * 状态码顺序即安全顺序，且**"路由是否存在"必须排在最前**：
       * 没配 token 时无论用什么方法打过来都返回 404——否则一个 `GET` 拿到 405
       * 就等于告诉扫描器"这里有个管理口，只是方法不对"。
       */
      const handleUnfreeze = async (
        req: IncomingMessage,
        res: ServerResponse,
        method: string,
      ): Promise<void> => {
        const token = readAdminToken(process.env)
        if (token === undefined) {
          sendError(res, 404, 'web-not-found', '没有这个资源')
          return
        }
        if (!isLoopbackAddress(req.socket.remoteAddress)) {
          sendError(res, 403, 'web-admin-forbidden', '管理路由只接受本机回环请求')
          return
        }
        if (method !== 'POST') {
          sendError(res, 405, 'web-method-not-allowed', `${method} ${ADMIN_UNFREEZE_PATH} 不被支持`)
          return
        }
        if (!tokenMatches(token, req.headers.authorization)) {
          sendError(res, 401, 'web-admin-unauthorized', '缺少或错误的 admin token')
          return
        }

        let body: unknown
        try {
          body = await readJson(req)
        } catch (error) {
          // 体过大 / 坏 JSON 都是**客户端**的问题，不许报成 500
          sendError(res, 400, 'web-admin-invalid-body', describeThrown(error))
          return
        }
        const parsed = parseUnfreezeBody(body)
        if (!parsed.ok) {
          sendError(res, 400, parsed.code, parsed.detail)
          return
        }

        const sentry = trySentry()
        if (sentry === undefined) {
          sendError(res, 503, 'sentry-absent', '当前 profile 没有 safety:sentry，无法解冻')
          return
        }

        // 幂等：本来没冻结就返回 unfrozen:false，不是错误
        const unfrozen = sentry.unfreeze(parsed.by, parsed.reason)
        sendJson(res, 200, { ok: true, unfrozen })
      }

      /** 路由。 */
      const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
        const method = req.method ?? 'GET'
        const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`)
        const path = url.pathname

        if (method === 'GET' && path === '/api/session') {
          sendJson(res, 200, {
            sessionId: String(session.sessionId),
            lastSeq: session.lastSeq(),
            capabilities: adapter.capabilities,
          })
          return
        }

        if (method === 'GET' && path === '/api/health') {
          sendJson(res, 200, {
            ok: true,
            lastSeq: session.lastSeq(),
            pendingTickets: adapter.pendingTickets(),
          })
          return
        }

        if (method === 'GET' && path === '/api/events') {
          const raw = url.searchParams.get('since') ?? '0'
          const since = Number(raw)
          if (!Number.isInteger(since) || since < 0) {
            sendError(res, 400, 'web-invalid-since', `since 必须是非负整数（收到 ${raw}）`)
            return
          }
          streamEvents(req, res, since)
          return
        }

        if (method === 'POST' && path === '/api/turn') {
          const agent = firstAgent()
          if (agent === undefined) {
            sendError(res, 503, 'agent-absent', '没有活体 agent：profile 缺少 core:agent 行')
            return
          }
          const body = await readJson(req)
          const text = readBodyString(body, 'text') ?? ''
          let inbound
          try {
            inbound = adapter.inbound({ text, at: run.now() })
          } catch (error) {
            sendError(res, 400, 'web-empty-message', describeThrown(error))
            return
          }
          agent.send(inbound.text)
          ensureDriver(agent)
          sendJson(res, 202, { ok: true })
          return
        }

        if (method === 'POST' && path === '/api/interrupt') {
          const agent = firstAgent()
          if (agent === undefined) {
            sendError(res, 503, 'agent-absent', '没有活体 agent')
            return
          }
          const body = await readJson(req)
          const reason = readBodyString(body, 'reason') ?? '用户点击"算了"'
          agent.interrupt(reason)
          sendJson(res, 200, { ok: true })
          return
        }

        if (method === 'POST' && path.startsWith('/api/approval/')) {
          const ticketId = decodeURIComponent(path.slice('/api/approval/'.length))
          if (!TICKET_PATTERN.test(ticketId)) {
            sendError(res, 400, 'web-invalid-ticket', `票据 ID 非法：${ticketId}`)
            return
          }
          const body = await readJson(req)
          const result = adapter.decide(ticketId, body)
          if (result.ok) {
            sendJson(res, 200, { ok: true })
            return
          }
          const status = result.code === 'unknown-ticket' ? 404 : result.code === 'already-decided' || result.code === 'expired' ? 409 : 400
          sendError(res, status, result.code, result.reason)
          return
        }

        if (method === 'POST' && path.startsWith('/api/verify/')) {
          const ticketId = decodeURIComponent(path.slice('/api/verify/'.length))
          if (!TICKET_PATTERN.test(ticketId)) {
            sendError(res, 400, 'web-invalid-ticket', `票据 ID 非法：${ticketId}`)
            return
          }
          const result = await adapter.verify(ticketId)
          if (result.ok) {
            sendJson(res, 200, { ok: true })
            return
          }
          const status = result.code === 'unknown-ticket' ? 404 : 400
          sendError(res, status, result.code, result.reason)
          return
        }

        // 人工解冻：唯一入口（HP-0 §3.2）。默认关闭、只绑回环、token 只从环境变量读。
        if (path === ADMIN_UNFREEZE_PATH) {
          await handleUnfreeze(req, res, method)
          return
        }

        if (method === 'GET' || method === 'HEAD') {
          await serveStatic(path, res, method === 'HEAD')
          return
        }

        sendError(res, 405, 'web-method-not-allowed', `${method} ${path} 不被支持`)
      }

      const server: Server = createServer((req, res) => {
        void handle(req, res).catch((error: unknown) => {
          // 单个请求出错不能拖垮服务；错误结构化返回，原因进响应体（不静默）
          const code = error instanceof BahError ? error.code : 'web-internal'
          if (!res.headersSent) {
            sendError(res, REQUEST_ERROR_STATUS[code] ?? 500, code, describeThrown(error))
          } else {
            res.end()
          }
        })
      })

      await new Promise<void>((resolveListen, rejectListen) => {
        const onError = (error: NodeJS.ErrnoException): void => {
          server.off('listening', onListening)
          rejectListen(
            new BahError(
              'web-listen-failed',
              `web: 无法监听 ${config.host}:${String(config.port)}（${error.code ?? 'unknown'}）`,
              { cause: error },
            ),
          )
        }
        const onListening = (): void => {
          server.off('error', onError)
          resolveListen()
        }
        server.once('error', onError)
        server.once('listening', onListening)
        server.listen(config.port, config.host)
      })

      // ⑤.5 把实际端口暴露成服务（测试用 0 取随机端口；桌面壳内嵌也要知道地址）
      const address = server.address()
      const boundPort = typeof address === 'object' && address !== null ? address.port : config.port
      ctx.effect(
        ctx.provide(WEB_SERVER, {
          port: boundPort,
          url: `http://${config.host}:${String(boundPort)}/`,
          sessionId: String(session.sessionId),
        }),
      )

      // ⑥ 收尾：先断连接再关端口，最后注销应答者（ctx.effect 逆序执行）
      ctx.effect(() => {
        for (const client of clients) {
          clearInterval(client.heartbeat)
          client.res.end()
        }
        clients.clear()
        adapter.dispose()
      })
      ctx.effect(() => {
        server.close()
      })
    },
  },

  validate(config) {
    rejectUnknownKeys(config, ['port', 'host', 'staticRoot', 'heartbeatMs'], 'channel:web')
    // 端口单独校验：0 是合法值（OS 分配随机端口，测试与桌面壳内嵌用）
    const rawPort = config['port']
    if (
      rawPort !== undefined &&
      (typeof rawPort !== 'number' || !Number.isInteger(rawPort) || rawPort < 0 || rawPort > 65_535)
    ) {
      throw new BahError('web-invalid-config', 'channel:web: port 必须是 0..65535 的整数')
    }
    const port = rawPort as number | undefined
    const heartbeatMs = readPositiveInteger(config, 'heartbeatMs', 'channel:web')
    const host = readString(config, 'host', 'channel:web')
    const staticRoot = readString(config, 'staticRoot', 'channel:web')

    return {
      port: port ?? DEFAULT_WEB.port,
      host: host ?? DEFAULT_WEB.host,
      staticRoot: staticRoot ?? DEFAULT_WEB.staticRoot,
      heartbeatMs: heartbeatMs ?? DEFAULT_WEB.heartbeatMs,
    }
  },
}
