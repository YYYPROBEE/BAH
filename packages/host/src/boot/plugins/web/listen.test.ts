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

/** 最小 Server 桩：只需要 `listen` / `address` / `close` 与三个事件方法。 */
function fakeServer(options: {
  /** 调用 `listen()` 时立刻抛出的错误（模拟占用 / 地址不可用）。 */
  readonly fail?: NodeJS.ErrnoException
  /** 调用 `listen()` 时立刻成功（模拟内核已 bind）。 */
  readonly succeed?: boolean
  /** `address()` 的返回值（`null` / 字符串 / 对象分别对应不同分支）。 */
  readonly address?: () => unknown
}): { server: Server; listenCalls: () => number; closeCalls: () => number } {
  const emitter = new EventEmitter()
  let calls = 0
  let closes = 0
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
    close(callback?: (error?: Error) => void): void {
      closes += 1
      // 真实 http.Server 在 'close' 完成后回调；桩用微任务模拟，让 await 真的等一轮。
      queueMicrotask(() => callback?.())
    },
    address: options.address ?? (() => ({ port: 7_331, family: 'IPv4', address: '127.0.0.1' })),
  }
  return {
    server: server as unknown as Server,
    listenCalls: () => calls,
    closeCalls: () => closes,
  }
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

  /**
   * 2026-10-28 随机红的真因：不是 `address()` 为 null，而是 OS 从动态端口范围里
   * 分到了 Fetch 禁用端口（本机实测 4190/4045 必抛 `bad port`）。`port: 0` 是
   * "让 OS 选"，换一个名额不违反"不自动换端口"：关闭后重绑即可。
   */
  it('port=0 分到 Fetch 禁用端口 → 关闭重绑，返回下一个可用端口', async () => {
    const assigned = [4_190, 54_321]
    let index = 0
    const { server, listenCalls, closeCalls } = fakeServer({
      succeed: true,
      address: () => ({ port: assigned[Math.min(index++, assigned.length - 1)] }),
    })
    await expect(bindPort(server, '127.0.0.1', 0, true)).resolves.toBe(54_321)
    expect(listenCalls()).toBe(2)
    expect(closeCalls()).toBe(1)
  })

  it('显式端口命中 Fetch 禁用表 → fail-loud，绝不偷偷换端口', async () => {
    const { server, listenCalls, closeCalls } = fakeServer({
      succeed: true,
      address: () => ({ port: 4_190 }),
    })
    const error = await bindPort(server, '127.0.0.1', 4_190, true).catch((thrown: unknown) => thrown)

    expect(error).toMatchObject({ code: 'web-listen-failed' })
    expect((error as Error).message).toContain('4190')
    expect((error as Error).message).toContain('bad port')
    expect(listenCalls()).toBe(1)
    expect(closeCalls()).toBe(1)
  })

  it('port=0 连续 8 次都分到禁用端口 → fail-loud（有界重试）', async () => {
    const { server, listenCalls, closeCalls } = fakeServer({
      succeed: true,
      address: () => ({ port: 4_045 }),
    })
    const error = await bindPort(server, '127.0.0.1', 0, true).catch((thrown: unknown) => thrown)

    expect(error).toMatchObject({ code: 'web-listen-failed' })
    expect((error as Error).message).toContain('连续 8 次')
    expect(listenCalls()).toBe(8)
    expect(closeCalls()).toBe(8)
  })

  /**
   * 为什么改：旧实现拿不到地址就回退配置端口；配置端口为 `0` 时会把
   * `http://host:0/` 交给调用方（fetch 必抛 `bad port`）。停机能被看见，
   * 不可用的 URL 不能——所以必须 fail-loud，而不是"看起来能用"。
   */
  it('address() 不是对象（unix socket / 已关闭）→ web-listen-failed，不回退配置端口', async () => {
    const asString = fakeServer({ succeed: true, address: () => '/tmp/bah.sock' })
    await expect(bindPort(asString.server, '127.0.0.1', 7_331, true)).rejects.toMatchObject({
      code: 'web-listen-failed',
    })
    expect(asString.closeCalls()).toBe(1)

    const asNull = fakeServer({ succeed: true, address: () => null })
    await expect(bindPort(asNull.server, '127.0.0.1', 7_331, true)).rejects.toMatchObject({
      code: 'web-listen-failed',
    })
    expect(asNull.closeCalls()).toBe(1)

    const asZero = fakeServer({ succeed: true, address: () => ({ port: 0 }) })
    await expect(bindPort(asZero.server, '127.0.0.1', 0, true)).rejects.toMatchObject({
      code: 'web-listen-failed',
    })
  })
})
