/**
 * 公网 HTTP 服务（施工单 02 §2.3）。
 *
 * 只认三件事：`GET /healthz`、`GET|POST /im/:platform/:accountKey`、其它 404。
 *
 * **硬约束（门禁 G10）**：本文件不 import 任何平台实现（`platform/wechat/*`）或
 * `protocol/*`——平台差异只经 `PlatformAdapter` 进入。一旦这里 import 了微信 XML 解析，
 * 网关就从"通用网关"退化成"微信专用网关"，第二个平台只能复制路由。
 *
 * **不反代 `/api/*`**（门禁 G5）：子进程的 `/api/turn` 只许网关自己带 Bearer 调，
 * 任何转发到公网的路径都等于绕过宿主的闸序。
 */

import type { Server } from 'node:http'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'

import type { ImInbound, PlatformAdapter, PlatformReply, PlatformRequest, PlatformResponse } from '@bah/channels'
import { assertNever } from '@bah/util'

import type { ImLogger } from './log.ts'
import type { PlatformRegistry } from './platform/registry.ts'
import type { InboundOutcome } from './bridge/turn.ts'

/** 请求体读取上限（防"超大 body 打内存"；16 KiB 的业务上限由 XML 层判）。 */
const MAX_BODY_BYTES = 64 * 1024

/** `/im/:platform/:accountKey` 的路径形态（平台/账号名都只允许安全字符）。 */
const IM_PATH = /^\/im\/([A-Za-z0-9_-]{1,64})\/([A-Za-z0-9_-]{1,64})$/u

/** 统一的安全头（网关不是浏览器面，只加最低必要项）。 */
const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
}

/** 服务依赖。 */
export interface GatewayServerDeps {
  readonly registry: PlatformRegistry
  readonly log: ImLogger
  /** 处理一条已解析的消息（编排在 `bridge/turn.ts`）。 */
  readonly handleMessage: (inbound: ImInbound, reply: PlatformReply) => Promise<InboundOutcome>
  /** 当前存活子进程数（`/healthz` 只给数量）。 */
  readonly children: () => number
  readonly startedAtMs: number
  readonly nowMs?: () => number
}

/** 直接写一个平台响应。 */
function writePlatform(res: ServerResponse, response: PlatformResponse): void {
  res.writeHead(response.status, { ...SECURITY_HEADERS, ...response.headers })
  res.end(response.body)
}

/** 写结构化错误（不回显原文，只给 code + 一句人话）。 */
function writeError(res: ServerResponse, status: number, code: string, reason: string): void {
  const payload = JSON.stringify({ error: { code, reason } })
  res.writeHead(status, {
    ...SECURITY_HEADERS,
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
  })
  res.end(payload)
}

/** 读请求体（超限直接 413，不把半个 body 交给适配器）。 */
async function readBody(req: IncomingMessage): Promise<string | undefined> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = chunk as Buffer
    size += buffer.length
    if (size > MAX_BODY_BYTES) return undefined
    chunks.push(buffer)
  }
  return Buffer.concat(chunks).toString('utf8')
}

/** 把 Node 的 header 归一成 `Record<string, string | undefined>`（同名多值逗号拼接）。 */
function headersOf(req: IncomingMessage): Record<string, string | undefined> {
  const result: Record<string, string | undefined> = {}
  for (const [key, value] of Object.entries(req.headers)) {
    result[key.toLowerCase()] = Array.isArray(value) ? value.join(',') : value
  }
  return result
}

/** 把 URL 查询参数展开成记录（同名多值取最后一个，与微信的回调形态一致）。 */
function queryOf(url: URL): Record<string, string> {
  const result: Record<string, string> = {}
  for (const [key, value] of url.searchParams) result[key] = value
  return result
}

/** 健康检查（只给数量：ID/账号/openid 都不出这个口）。 */
function handleHealthz(res: ServerResponse, deps: GatewayServerDeps, nowMs: () => number): void {
  const payload = JSON.stringify({
    ok: true,
    platforms: deps.registry.size(),
    children: deps.children(),
    uptimeSec: Math.floor(Math.max(0, nowMs() - deps.startedAtMs) / 1000),
  })
  res.writeHead(200, {
    ...SECURITY_HEADERS,
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
  })
  res.end(payload)
}

/** 取适配器；未知平台/账号 → undefined。 */
function adapterFor(
  deps: GatewayServerDeps,
  platform: string,
  accountKey: string,
): PlatformAdapter | undefined {
  const adapter = deps.registry.get(platform, accountKey)
  if (adapter === undefined) {
    deps.log.warn('im-platform-unknown', { platform, accountKey })
  }
  return adapter
}

/** 处理 `/im/:platform/:accountKey`。 */
async function handlePlatformRequest(
  req: IncomingMessage,
  res: ServerResponse,
  deps: GatewayServerDeps,
  nowMs: () => number,
  platform: string,
  accountKey: string,
): Promise<void> {
  const adapter = adapterFor(deps, platform, accountKey)
  if (adapter === undefined) {
    writeError(res, 404, 'im-unknown-platform', '没有这个平台或账号')
    return
  }

  const method = req.method === 'POST' ? 'POST' : 'GET'
  const url = new URL(req.url ?? '/', 'http://127.0.0.1')
  const body = await readBody(req)
  if (body === undefined) {
    writeError(res, 413, 'im-body-too-large', '请求体超过网关上限')
    return
  }

  const request: PlatformRequest = {
    method,
    path: url.pathname,
    query: queryOf(url),
    headers: headersOf(req),
    body,
  }

  const nowSec = Math.floor(nowMs() / 1000)
  const verdict = adapter.verify(request, nowSec)
  if (!verdict.ok) {
    deps.log.warn('im-sig-invalid', { platform, code: verdict.code })
    // §2.5：响应体只有 `invalid signature`，不回显期望值
    res.writeHead(verdict.status, {
      ...SECURITY_HEADERS,
      'content-type': 'text/plain; charset=utf-8',
      'cache-control': 'no-store',
    })
    res.end('invalid signature')
    return
  }

  const parsed = adapter.parse(request, nowSec)
  switch (parsed.kind) {
    case 'message': {
      const outcome = await deps.handleMessage(parsed.inbound, parsed.reply)
      writePlatform(res, outcome.response)
      // 后台任务（push / 拉取落库）不阻塞响应；它自己的失败已在 `deliverTurn` 里记过
      void outcome.done
      return
    }
    case 'challenge':
      writePlatform(res, parsed.response)
      return
    case 'unsupported':
      writePlatform(res, parsed.response)
      return
    case 'reject':
      deps.log.warn('im-xml-rejected', { platform, code: parsed.code })
      writeError(res, parsed.status, parsed.code, '报文被拒绝')
      return
    default:
      return assertNever(parsed, 'platform-parse-result')
  }
}

/**
 * 造一个公网服务（不 listen，调用方决定监听地址与端口）。
 *
 * @param deps 见 {@link GatewayServerDeps}
 */
export function createGatewayServer(deps: GatewayServerDeps): Server {
  const nowMs = deps.nowMs ?? ((): number => Date.now())

  return createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      const path = url.pathname

      if (path === '/healthz' && (req.method === 'GET' || req.method === 'HEAD')) {
        handleHealthz(res, deps, nowMs)
        return
      }

      const match = IM_PATH.exec(path)
      if (match !== null && (req.method === 'GET' || req.method === 'POST')) {
        await handlePlatformRequest(req, res, deps, nowMs, match[1] ?? '', match[2] ?? '')
        return
      }

      writeError(res, 404, 'im-not-found', '没有这个路径')
    })().catch((error: unknown) => {
      deps.log.error('im-turn-failed', {
        reason: 'unhandled',
        detail: error instanceof Error ? error.message : 'unknown',
      })
      if (!res.headersSent) writeError(res, 500, 'im-internal', '网关内部错误')
      else res.end()
    })
  })
}
