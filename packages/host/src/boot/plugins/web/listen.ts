/**
 * 监听与连接纪律（W16 从 `web.ts` 拆出）。
 *
 * 端口占用**不自动换端口**：现场答辩时浏览器开着 7331、服务却跑到 7332 是最坏的一种
 * "看起来能用"。所以这里只做两件事：设连接超时、把 `error` 翻成结构化错误。
 */

import type { Server } from 'node:http'

import { BahError } from '@bah/util'

/**
 * 在 `host:port` 上监听（`port=0` 由 OS 分配，返回值从 `server.address()` 取）。
 *
 * 慢请求/慢头不无限占用连接；SSE 的响应体不受 `requestTimeout` 影响。
 *
 * @throws `web-listen-failed` 端口被占 / 地址不可用
 */
export async function listen(server: Server, host: string, port: number): Promise<void> {
  server.requestTimeout = 30_000
  server.headersTimeout = 15_000
  server.keepAliveTimeout = 5_000

  await new Promise<void>((resolveListen, rejectListen) => {
    const onError = (error: NodeJS.ErrnoException): void => {
      server.off('listening', onListening)
      rejectListen(
        new BahError(
          'web-listen-failed',
          `web: 无法监听 ${host}:${String(port)}（${error.code ?? 'unknown'}）`,
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
    server.listen(port, host)
  })
}
