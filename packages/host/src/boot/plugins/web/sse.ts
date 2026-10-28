/**
 * `channel:web` 的 SSE 汇聚层（W16 从 `web.ts` 拆出）。
 *
 * 一条连接 = 一份快照 + 增量。快照**始终全量**：客户端按键替换，比"补发到某条"少一条会错的路径。
 * 这里的三个出口（`publish` / `publishFault` / `attach`）是实时链路的**唯一**写帧处——
 * 拆 handler 时最容易踩的坑就是又开一条 `res.write` 直写，结果心跳与快照绕过了注销逻辑。
 */

import type { IncomingMessage, ServerResponse } from 'node:http'

import type { WebFrame, WebProjector } from '@bah/channels'

import { SECURITY_HEADERS, sendError } from './http.ts'

/** 同时在线连接的上限（D1）。单机演示 = 一台机器一两个页面；16 已经远超正常量。 */
const DEFAULT_MAX_CLIENTS = 16

/** 进程内帧计数（`/api/metrics` 的 `bah_sse_frames_total`；单进程，不区分 hub 实例）。 */
const frames = { frame: 0, fault: 0 }

/** 读 SSE 帧计数（只读快照）。 */
export function sseFrameStats(): { readonly frame: number; readonly fault: number } {
  return { frame: frames.frame, fault: frames.fault }
}

/** 单连接允许积压的字节数（D1）：超过就是慢客户端，直接断开，不替它缓存。 */
const DEFAULT_MAX_BUFFERED_BYTES = 1024 * 1024

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
  /** 同时在线连接上限（缺省 16）。 */
  readonly maxClients?: number
  /** 单连接写缓冲上限（字节，缺省 1 MiB）。 */
  readonly maxBufferedBytes?: number
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
  /** 当前在线连接数（`/api/metrics` 用；不暴露连接本身）。 */
  size(): number
  /** 注销全部连接（插件 dispose 时先断连接再关端口）。 */
  dispose(): void
}

/** 造一个 SSE 汇聚层。 */
export function createSseHub(options: SseHubOptions): SseHub {
  const clients = new Set<SseClient>()
  const maxClients = options.maxClients ?? DEFAULT_MAX_CLIENTS
  const maxBufferedBytes = options.maxBufferedBytes ?? DEFAULT_MAX_BUFFERED_BYTES

  /** 断一条连接并从表里摘掉（心跳必须一起清，否则定时器会写已关闭的 socket）。 */
  const drop = (client: SseClient): void => {
    clearInterval(client.heartbeat)
    clients.delete(client)
    client.res.destroy()
  }

  /**
   * 写一帧；返回 `false` 表示这条连接已被判定为慢客户端并断开。
   *
   * `res.write` 返回 `false` 只说明"内核缓冲满了"，本身不是错误；真正的判据是
   * `writableLength`（还没吐出去的字节数）。超过上限就断开——**不替慢客户端无限缓存**，
   * 否则一个挂着不读的标签页能把整个进程的内存拖到 OOM。
   */
  const writeTo = (client: SseClient, payload: string): boolean => {
    if (client.res.destroyed) {
      clients.delete(client)
      clearInterval(client.heartbeat)
      return false
    }
    // 先看积压再写：已经卡住的连接不该再往里塞一帧
    if (client.res.writableLength > maxBufferedBytes) {
      drop(client)
      return false
    }
    client.res.write(payload)
    return true
  }

  const broadcast = (event: string, data: unknown): void => {
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
    // 先快照再遍历：drop 会在遍历中改集合
    for (const client of [...clients]) writeTo(client, payload)
  }

  return {
    publish(frame: WebFrame): void {
      frames.frame += 1
      broadcast('frame', frame)
    },

    publishFault(code: string, reason: string): void {
      frames.fault += 1
      broadcast('fault', { code, reason })
    },

    attach(req: IncomingMessage, res: ServerResponse, since: number): void {
      // D1：连接数上限。拒绝时给 503 而不是"先 200 再静默不推帧"——
      // 后者在浏览器侧表现为"页面连上了但永远不更新"，比明确失败难查得多。
      if (clients.size >= maxClients) {
        sendError(res, 503, 'web-sse-busy', `SSE 连接已达上限 ${String(maxClients)} 条`)
        return
      }
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

      // 心跳也走 `writeTo`：慢客户端连心跳都积压时同样要断开，否则"发一次心跳就漏一个 client"
      let client: SseClient | undefined
      const heartbeat = setInterval(() => {
        if (client === undefined) return
        writeTo(client, `: ping ${String(options.now())} ${String(since)}\n\n`)
      }, options.heartbeatMs)
      heartbeat.unref()

      client = { res, heartbeat }
      clients.add(client)
      req.on('close', () => {
        clearInterval(heartbeat)
        clients.delete(client as SseClient)
      })
    },

    size(): number {
      return clients.size
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
