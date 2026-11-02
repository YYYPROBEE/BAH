/**
 * 在 `listen(0)` 之后避开 Node `fetch` 的禁用端口。
 *
 * 为什么需要这一步：`fetch`（undici）对一批"危险端口"直接抛 `TypeError: bad port`，
 * 而 Windows 的临时端口段（49152–65535）**包含** 6566 / 6665–6669 / 6679 / 6697。
 * `listen(0)` 由 OS 随机分配，撞上就整条用例红，且只在那次运行复现——
 * 看起来像网络故障，实际与被测代码毫无关系，纯属端口运气。
 *
 * 做法：撞上就关掉重听，最多 8 次；8 次都撞说明不是运气问题，直接抛错。
 */

import type { Server } from 'node:http'

/**
 * undici `badPorts` 中**可能由 `listen(0)` 分配**的那部分。
 *
 * 其余禁用端口（80、443、6000、10080 等）不在 Windows 临时端口段内，
 * 列进来只会让这张表看起来更完整、实际一行都用不上。
 */
const BLOCKED_BY_FETCH: ReadonlySet<number> = new Set([6566, 6665, 6666, 6667, 6668, 6669, 6679, 6697])

/** 最多重听几次。8 次全撞的概率约 (8/16384)^8，只能是环境坏了。 */
const MAX_ATTEMPTS = 8

/** 让 `server` 在 127.0.0.1 上听一个 `fetch` 能访问的随机端口，返回该端口。 */
export async function listenOnSafePort(server: Server): Promise<number> {
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        resolve()
      })
    })
    const address = server.address()
    const port = typeof address === 'object' && address !== null ? address.port : 0
    if (!BLOCKED_BY_FETCH.has(port)) return port
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve()
      })
    })
  }
  throw new Error(
    `listenOnSafePort: 连续 ${String(MAX_ATTEMPTS)} 次都分配到 fetch 禁用端口——端口段异常，先查环境再看用例`,
  )
}
