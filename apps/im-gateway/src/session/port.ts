/**
 * 端口预分配。
 *
 * WHY 预分配：子进程的 `channel:im` 是 fail-loud 的（端口被占 = 启动失败），
 * 而"随机挑一个端口再试"会把失败暴露给用户。这里先在网关进程里 `listen(0)` 拿一个
 * 系统分配的端口、立刻关掉，再把号码交给子进程——冲突窗口只剩"关闭到子进程 listen"
 * 这几毫秒，且失败时还能换号重试（最多 8 次）。
 *
 * 子进程只听 `127.0.0.1`（门禁 G5）：公网入口只有网关，反代 `/api/*` 会绕过闸序。
 */

import { createServer } from 'node:net'

/** 端口冲突时的最大重试次数（§2.11：最多 8 次）。 */
export const PORT_RETRY_LIMIT = 8

/** 子进程绑定的地址（**不许**改成 0.0.0.0；门禁 G5 逐字比对）。 */
export const CHILD_BIND_HOST = '127.0.0.1'

/**
 * 预分配一个空闲端口。
 *
 * @throws `Error('im-port-exhausted')` 拿不到端口（系统资源耗尽时会走到这里）
 */
export async function reservePort(host: string = CHILD_BIND_HOST): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const server = createServer()
    server.unref()
    server.once('error', (error) => reject(error))
    server.listen(0, host, () => {
      const address = server.address()
      const port = typeof address === 'object' && address !== null ? address.port : 0
      server.close(() => {
        if (port > 0) resolve(port)
        else reject(new Error('im-port-exhausted'))
      })
    })
  })
}

/**
 * 预分配并最多重试 {@link PORT_RETRY_LIMIT} 次。
 *
 * `attempt` 注入只为测试：生产永远从 1 开始。
 */
export async function reservePortWithRetry(
  reserve: () => Promise<number> = reservePort,
  attempts: number = PORT_RETRY_LIMIT,
): Promise<number> {
  let lastError: unknown
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await reserve()
    } catch (error) {
      lastError = error
    }
  }
  throw lastError instanceof Error ? lastError : new Error('im-port-exhausted')
}
