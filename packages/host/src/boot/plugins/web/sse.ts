/**
 * `channel:web` 的 SSE 汇聚层（W16 从 `web.ts` 拆出）。
 *
 * 一条连接 = 一份快照 + 增量。快照**始终全量**：客户端按键替换，比"补发到某条"少一条会错的路径。
 * 这里的三个出口（`publish` / `publishFault` / `attach`）是实时链路的**唯一**写帧处——
 * 拆 handler 时最容易踩的坑就是又开一条 `res.write` 直写，结果心跳与快照绕过了注销逻辑。
 */

import type { IncomingMessage, ServerResponse } from 'node:http'

import type { WebFrame, WebProjector } from '@bah/channels'

import { SECURITY_HEADERS } from './http.ts'

/** 一条 SSE 连接。 */
interface SseClient {
  readonly res: ServerResponse
  readonly heartbeat: NodeJS.Timeout
}

/** SSE 汇聚层的依赖（构造后不可变）。 */
export interface SseHubOptions {
  /** 事件 → 帧的纯投影（快照也由它给）。 */
  readonly projector: WebProjector
  /**
   * 快照里要写的会话 ID。
   *
   * 刻意用**取值函数**而不是字符串：`attach` 时现读，才能保留"会话在连接建立之后
   * 才坏掉"的那条失败路径（快照投影失败 → 已发出的头不重写，只结束连接）。
   */
  readonly sessionId: () => string
  /** 心跳间隔（ms）。 */
  readonly heartbeatMs: number
  /** 注入钟（心跳注释里的 `now`，快照/回放不许用 `Date.now()`）。 */
  readonly now: () => number
}

/** 广播 + 连接管理。 */
export interface SseHub {
  /** 推一帧给所有连接（会话事件与流式分片共用）。 */
  publish(frame: WebFrame): void
  /**
   * 渠道级故障（不是会话事实，走独立事件名，避免与 EventSource 内置 error 冲突）。
   */
  publishFault(code: string, reason: string): void
  /** 建立一条 SSE 连接：先写快照，再等增量。 */
  attach(req: IncomingMessage, res: ServerResponse, since: number): void
  /** 注销全部连接（插件 dispose 时先断连接再关端口）。 */
  dispose(): void
}

/** 造一个 SSE 汇聚层。 */
export function createSseHub(options: SseHubOptions): SseHub {
  const clients = new Set<SseClient>()

  const publish = (frame: WebFrame): void => {
    const payload = `event: frame\ndata: ${JSON.stringify(frame)}\n\n`
    for (const client of clients) client.res.write(payload)
  }

  return {
    publish,

    publishFault(code: string, reason: string): void {
      const payload = `event: fault\ndata: ${JSON.stringify({ code, reason })}\n\n`
      for (const client of clients) client.res.write(payload)
    },

    attach(req: IncomingMessage, res: ServerResponse, since: number): void {
      res.writeHead(200, {
        ...SECURITY_HEADERS,
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-store',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      })
      res.write(': connected\n\n')
      // 快照始终全量：客户端按键替换，比"补发到某条"少一条会错的路径
      res.write(
        `event: frame\ndata: ${JSON.stringify(options.projector.snapshot(options.sessionId()))}\n\n`,
      )

      const heartbeat = setInterval(() => {
        res.write(`: ping ${String(options.now())} ${String(since)}\n\n`)
      }, options.heartbeatMs)
      heartbeat.unref()

      const client: SseClient = { res, heartbeat }
      clients.add(client)
      req.on('close', () => {
        clearInterval(heartbeat)
        clients.delete(client)
      })
    },

    dispose(): void {
      for (const client of clients) {
        clearInterval(client.heartbeat)
        client.res.end()
      }
      clients.clear()
    },
  }
}
