/**
 * 监听与连接纪律（W16 从 `web.ts` 拆出）的宿主侧用例。
 *
 * 为什么值钱：`listen` 的**失败路径**是演示现场最常见的一种"看起来能用"——
 * 7331 被旧进程占着，服务静默跑到 7332。这里钉两件事：
 *
 * 1. 端口失败必须翻成 `web-listen-failed`（带上游错误码），且没有错误码时也要有可读理由；
 * 2. `bindPort(probe=false)`（CLI `--dump-config`）**一个端口都不占**。
 *
 * 用 EventEmitter 桩而不是真端口：真实 EADDRINUSE 依赖本机端口占用状态，
 * 会随环境抖动；而这里要验的是"错误怎么翻"，不是内核怎么抢端口。
 */

import { EventEmitter } from 'node:events'
import type { Server } from 'node:http'

import { BahError } from '@bah/util'
import { describe, expect, it } from 'vitest'

import { bindPort, listen } from './listen.ts'

/** 最小 Server 桩：只需要 `listen` / `address` 与三个事件方法。 */
function fakeServer(options: {
  /** 调用 `listen()` 时立刻抛出的错误（模拟占用 / 地址不可用）。 */
  readonly fail?: NodeJS.ErrnoException
  /** 调用 `listen()` 时立刻成功（模拟内核已 bind）。 */
  readonly succeed?: boolean
  /** `address()` 的返回值（`null` / 字符串 / 对象分别对应不同分支）。 */
  readonly address?: () => unknown
}): { server: Server; listenCalls: () => number } {
  const emitter = new EventEmitter()
  let calls = 0
  const server = {
    requestTimeout: 0,
    headersTimeout: 0,
    keepAliveTimeout: 0,
    once: emitter.once.bind(emitter),
    off: emitter.off.bind(emitter),
    on: emitter.on.bind(emitter),
    emit: emitter.emit.bind(emitter),
    listen(): void {
      calls += 1
      if (options.fail !== undefined) emitter.emit('error', options.fail)
      else if (options.succeed === true) emitter.emit('listening')
    },
    address: options.address ?? (() => ({ port: 7_331, family: 'IPv4', address: '127.0.0.1' })),
  }
  return { server: server as unknown as Server, listenCalls: () => calls }
}

describe('listen', () => {
  it('成功监听：设置连接超时纪律值', async () => {
    const { server } = fakeServer({ succeed: true })
    await listen(server, '127.0.0.1', 7_331)

    // 慢请求/慢头不能无限占用连接（读超时由 SSE 自己兜）
    expect(server.requestTimeout).toBe(30_000)
    expect(server.headersTimeout).toBe(15_000)
    expect(server.keepAliveTimeout).toBe(5_000)
  })

  it('端口失败 → web-listen-failed，消息里带上游错误码', async () => {
    const busy = Object.assign(new Error('address in use'), {
      code: 'EADDRINUSE',
    }) as NodeJS.ErrnoException
    const { server } = fakeServer({ fail: busy })

    const error = await listen(server, '127.0.0.1', 7_331).catch((thrown: unknown) => thrown)
    expect(error).toBeInstanceOf(BahError)
    expect(error).toMatchObject({ code: 'web-listen-failed' })
    // 演示排障要知道"7331 被占"还是"地址不可用"：错误码必须透出
    expect((error as BahError).message).toContain('EADDRINUSE')
    expect((error as Error).message).toContain('7331')
  })

  /**
   * 为什么补：`error.code ?? 'unknown'` 的右支此前从未执行。
   * 上游抛出的未必是 `ErrnoException`（自定义 Server、代理层都可能抛裸 Error），
   * 缺了兜底就会打出 `undefined`，现场只能看到一句没有信息的报错。
   */
  it('上游错误没有 code → 理由落 "unknown"，不是 undefined', async () => {
    const { server } = fakeServer({ fail: new Error('boom') as NodeJS.ErrnoException })
    const error = await listen(server, '127.0.0.1', 7_331).catch((thrown: unknown) => thrown)

    expect(error).toMatchObject({ code: 'web-listen-failed' })
    expect((error as Error).message).toContain('unknown')
  })
})

describe('bindPort', () => {
  /**
   * 为什么补：`probe === false` 是 `--dump-config` 的开关——装配全部插件只为打印生效树，
   * 既不该占端口，也不该因为"演示服务正开着 7331"而导出失败。
   */
  it('probe=false：不监听，直接返回配置端口', async () => {
    const { server, listenCalls } = fakeServer({ succeed: true })
    await expect(bindPort(server, '127.0.0.1', 7_331, false)).resolves.toBe(7_331)
    expect(listenCalls()).toBe(0)
  })

  it('probe 缺省：真监听，返回内核分配的端口', async () => {
    const { server } = fakeServer({ succeed: true, address: () => ({ port: 54_321 }) })
    await expect(bindPort(server, '127.0.0.1', 0, undefined)).resolves.toBe(54_321)
  })

  it('address() 不是对象（unix socket / 已关闭）→ 回退配置端口，不返回 undefined', async () => {
    const asString = fakeServer({ succeed: true, address: () => '/tmp/bah.sock' })
    await expect(bindPort(asString.server, '127.0.0.1', 7_331, true)).resolves.toBe(7_331)

    const asNull = fakeServer({ succeed: true, address: () => null })
    await expect(bindPort(asNull.server, '127.0.0.1', 7_331, true)).resolves.toBe(7_331)
  })
})
