/**
 * 监听与连接纪律（W16 从 `web.ts` 拆出）。
 *
 * 端口占用**不自动换端口**：现场答辩时浏览器开着 7331、服务却跑到 7332 是最坏的一种
 * "看起来能用"。所以这里只做三件事：设连接超时、把 `error` 翻成结构化错误、
 * 对 `port: 0` 的 OS 随机名额避开 Fetch/浏览器禁用端口（见 `FETCH_BAD_PORTS`）。
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
 * Fetch / 浏览器禁用端口（WHATWG Fetch Standard 的 "bad port" 表，undici 与 Chromium 同表）。
 *
 * 为什么必须在**绑定侧**处理：这些端口上服务能正常监听，但 `fetch()` 在连接前就直接抛
 * `bad port`，浏览器同样拒连。`port: 0` 会让 OS 从动态端口范围（本机实测 1024–15000）
 * 里顺序分配，4190（ManageSieve）/4045（NFS lockd）等都在范围内——全量测试每轮要绑
 * 60 个左右的端口，命中率约 8%，表现就是"随机一条用例 `bad port`"。
 * 显式配置的端口不在此列：命中就 fail-loud（见文件头的"不自动换端口"纪律）。
 */
const FETCH_BAD_PORTS: ReadonlySet<number> = new Set([
  1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79, 87, 95, 101,
  102, 103, 104, 109, 110, 111, 113, 115, 117, 119, 123, 135, 137, 139, 143, 161, 179, 389,
  427, 465, 512, 513, 514, 515, 526, 530, 531, 532, 540, 548, 554, 556, 563, 587, 601, 636,
  989, 990, 993, 995, 1719, 1720, 1723, 2049, 3659, 4045, 4190, 5060, 5061, 6000, 6566, 6665,
  6666, 6667, 6668, 6669, 6679, 6697, 10080,
])

/** `port: 0` 时最多重绑几次。单次命中禁用端口约 0.14%，8 次全命中远低于任何实用阈值。 */
const MAX_RANDOM_BIND_ATTEMPTS = 8

/** 关闭刚绑定但决定弃用的 server（回调式；`close` 对已关闭的服务会把错误交给回调，不抛）。 */
async function closeQuietly(server: Server): Promise<void> {
  await new Promise<void>((resolveClose) => {
    server.close(() => {
      resolveClose()
    })
  })
}

/**
 * 装配期绑定端口，返回**实际**端口。
 *
 * `probe === false` 是 CLI 的 `--dump-config`：它装配全部插件只为打印生效树，
 * 所以既不该占端口，也不该因为"演示服务正开着 7331"而导出失败（A8 的同一纪律：
 * 只有 `bank:knowledge` 一处曾读过这个开关，新插件必须一起认）。
 * 此时返回配置端口：`WEB_SERVER` 仍可被打印，只是没有真实监听。
 *
 * 两条硬约束（2026-10-28 随机红根因修复）：
 *
 * 1. 监听完必须能拿到**真实**端口；拿不到就抛错，绝不回落到配置端口
 *    （配置端口为 `0` 时会产出 `http://host:0/`，fetch 直接 `bad port`）。
 * 2. `port: 0` 是"让 OS 选"，若选到 Fetch 禁用端口就关闭重绑——换的是 OS 给的名额，
 *    不是用户指定的端口；显式端口命中禁用表则 fail-loud。
 */
export async function bindPort(
  server: Server,
  host: string,
  port: number,
  probe: boolean | undefined,
): Promise<number> {
  if (probe === false) return port
  for (let attempt = 1; attempt <= MAX_RANDOM_BIND_ATTEMPTS; attempt += 1) {
    // 第一次尊重调用方给的端口；只有 `port: 0` 的弃用重绑才会走到 `0`。
    await listen(server, host, attempt === 1 ? port : 0)
    const address = server.address()
    if (typeof address !== 'object' || address === null || address.port <= 0) {
      await closeQuietly(server)
      throw new BahError(
        'web-listen-failed',
        `web: 已监听 ${host} 但 server.address() 取不到真实端口（无法给出可用 URL）`,
      )
    }
    const boundPort = address.port
    if (!FETCH_BAD_PORTS.has(boundPort)) return boundPort
    await closeQuietly(server)
    if (port !== 0) {
      throw new BahError(
        'web-listen-failed',
        `web: 端口 ${String(boundPort)} 在 Fetch/浏览器禁用端口表内（bad port），浏览器与 fetch 无法连接`,
      )
    }
  }
  throw new BahError(
    'web-listen-failed',
    `web: 连续 ${String(MAX_RANDOM_BIND_ATTEMPTS)} 次随机分配都落在 Fetch 禁用端口表内`,
  )
}
