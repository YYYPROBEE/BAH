/**
 * SSE 汇聚层的资源上限（D1）。
 *
 * 为什么单独一个文件：`web.test.ts` 的 53 例是行为基线（审批、HALT、静态穿越），
 * 连接上限与慢客户端是**资源**约束，不是业务语义。混进去会让下次审 diff 分不清
 * "改了行为"还是"加了边界"。
 *
 * 这里全部用桩：不启端口、不用真 socket。慢客户端的判据是 `writableLength`
 * （内核里还没吐出去的字节），桩直接把它设成超限值即可稳定复现，
 * 不需要真的制造网络拥塞。
 */

import type { IncomingMessage, ServerResponse } from 'node:http'

import type { WebFrame, WebProjector } from '@bah/channels'
import { describe, expect, it } from 'vitest'

import { createSseHub } from './sse.ts'

/** 抓到的响应状态与正文。 */
interface Probe {
  status: number
  headers: Record<string, unknown>
  chunks: string[]
  destroyed: boolean
  ended: boolean
}

/** 最小 ServerResponse 桩：`writableLength` 可写，用来模拟慢客户端。 */
function makeRes(buffered = 0): {
  res: ServerResponse
  probe: Probe
  setBuffered(bytes: number): void
} {
  const probe: Probe = { status: 0, headers: {}, chunks: [], destroyed: false, ended: false }
  const state = { buffered }
  const res = {
    get destroyed(): boolean {
      return probe.destroyed
    },
    get writableLength(): number {
      return state.buffered
    },
    writeHead(status: number, headers: Record<string, unknown> = {}): unknown {
      probe.status = status
      for (const [key, value] of Object.entries(headers)) probe.headers[key.toLowerCase()] = value
      return res
    },
    write(chunk: unknown): boolean {
      probe.chunks.push(String(chunk))
      return state.buffered === 0
    },
    end(chunk?: unknown): unknown {
      if (chunk !== undefined) probe.chunks.push(String(chunk))
      probe.ended = true
      return res
    },
    destroy(): unknown {
      probe.destroyed = true
      return res
    },
  }
  return {
    res: res as unknown as ServerResponse,
    probe,
    setBuffered: (bytes) => {
      state.buffered = bytes
    },
  }
}

/** 最小请求桩：只要 `on('close')` 能挂回调。 */
function makeReq(): { req: IncomingMessage; close(): void } {
  const listeners: (() => void)[] = []
  const req = {
    on(event: string, handler: () => void): unknown {
      if (event === 'close') listeners.push(handler)
      return req
    },
  }
  return {
    req: req as unknown as IncomingMessage,
    close: () => {
      for (const handler of listeners) handler()
    },
  }
}

/**
 * 投影桩：快照固定一帧，够断言"连接建立时先写快照"就行。
 *
 * 形状必须是**合法的 `SnapshotFrame`**（`sessionId` / `maxSeq` / `frames`）：
 * 旧写法 `{ kind: 'snapshot', seq: 0 }` 靠外层 `as unknown as WebProjector` 掩盖了
 * 类型错误，一旦 host 被全量重建（`tsc -b --force`）就会在 `typecheck` 红。
 */
const PROJECTOR = {
  snapshot: (): WebFrame => ({ kind: 'snapshot', sessionId: 's-sse', maxSeq: 0, frames: [] }),
} as unknown as WebProjector

/** 造一个 hub（心跳给一个不会自己触发的长间隔：用例里只手动调 publish）。 */
function makeHub(overrides: Readonly<Record<string, unknown>> = {}): ReturnType<typeof createSseHub> {
  return createSseHub({
    projector: PROJECTOR,
    sessionId: () => 's-sse',
    heartbeatMs: 60_000,
    now: () => 1_700_000_000_000,
    ...overrides,
  })
}

const FRAME = { kind: 'delta', seq: 1 } as unknown as WebFrame

describe('D1 SSE 连接上限与慢客户端', () => {
  it('建立连接先写快照；publish 广播到所有在线连接', () => {
    const hub = makeHub()
    const first = makeRes()
    const second = makeRes()
    hub.attach(makeReq().req, first.res, 0)
    hub.attach(makeReq().req, second.res, 0)

    expect(first.probe.status).toBe(200)
    expect(first.probe.chunks.some((chunk) => chunk.includes('"kind":"snapshot"'))).toBe(true)

    hub.publish(FRAME)
    expect(first.probe.chunks.some((chunk) => chunk.includes('"seq":1'))).toBe(true)
    expect(second.probe.chunks.some((chunk) => chunk.includes('"seq":1'))).toBe(true)
  })

  it('连接数达到上限 → 新连接 503 web-sse-busy，且不写 event-stream 头', () => {
    const hub = makeHub({ maxClients: 2 })
    hub.attach(makeReq().req, makeRes().res, 0)
    hub.attach(makeReq().req, makeRes().res, 0)

    const overflow = makeRes()
    hub.attach(makeReq().req, overflow.res, 0)
    expect(overflow.probe.status).toBe(503)
    // 关键：不能先写 `text/event-stream` 再拒——那样浏览器以为连上了
    expect(String(overflow.probe.headers['content-type'])).toContain('application/json')
    expect(overflow.probe.chunks.join('')).toContain('web-sse-busy')
  })

  it('慢客户端（写缓冲超限）在下一帧被摘掉，正常客户端不受影响', () => {
    const hub = makeHub({ maxBufferedBytes: 16 })
    const slow = makeRes()
    const fast = makeRes()
    hub.attach(makeReq().req, slow.res, 0)
    hub.attach(makeReq().req, fast.res, 0)

    // 正常写一帧：两条连接都收到
    hub.publish(FRAME)
    expect(slow.probe.chunks.at(-1)).toContain('"seq":1')

    // 模拟这条连接卡住：内核缓冲积压到超限，下一帧就该断它
    slow.setBuffered(1024)
    const before = slow.probe.chunks.length
    hub.publish(FRAME)
    expect(slow.probe.destroyed).toBe(true)
    expect(slow.probe.chunks.length).toBe(before)
    expect(fast.probe.chunks.at(-1)).toContain('"seq":1')

    // 已摘掉的连接不再被写
    hub.publish(FRAME)
    expect(slow.probe.chunks.length).toBe(before)
  })

  it('客户端断开（close）后不再占用名额', () => {
    const hub = makeHub({ maxClients: 1 })
    const first = makeReq()
    hub.attach(first.req, makeRes().res, 0)

    const blocked = makeRes()
    hub.attach(makeReq().req, blocked.res, 0)
    expect(blocked.probe.status).toBe(503)

    first.close()
    const afterClose = makeRes()
    hub.attach(makeReq().req, afterClose.res, 0)
    expect(afterClose.probe.status).toBe(200)
  })

  it('dispose 结束所有连接', () => {
    const hub = makeHub()
    const client = makeRes()
    hub.attach(makeReq().req, client.res, 0)
    hub.dispose()
    expect(client.probe.ended).toBe(true)
    const chunks = client.probe.chunks.length
    hub.publish(FRAME)
    expect(client.probe.chunks.length).toBe(chunks)
  })
})
