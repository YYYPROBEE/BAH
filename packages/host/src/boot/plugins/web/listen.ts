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

/**
 * 装配期绑定端口，返回**实际**端口。
 *
 * `probe === false` 是 CLI 的 `--dump-config`：它装配全部插件只为打印生效树，
 * 所以既不该占端口，也不该因为"演示服务正开着 7331"而导出失败（A8 的同一纪律：
 * 只有 `bank:knowledge` 一处曾读过这个开关，新插件必须一起认）。
 * 此时返回配置端口：`WEB_SERVER` 仍可被打印，只是没有真实监听。
 */
export async function bindPort(
  server: Server,
  host: string,
  port: number,
  probe: boolean | undefined,
): Promise<number> {
  if (probe === false) return port
  await listen(server, host, port)
  const address = server.address()
  return typeof address === 'object' && address !== null ? address.port : port
}
