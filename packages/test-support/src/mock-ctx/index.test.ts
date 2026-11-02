/**
 * mock-ctx 自测（测试地基自己也要有测试，否则没人知道夹具还能不能用）。
 */

import { describe, expect, it } from 'vitest'

import { defineService } from '@bah/core'

import { captureRejection } from '../assertions/index.ts'
import { createTestContext, flush, waitFor, withTestContext } from './index.ts'

describe('createTestContext', () => {
  it('装插件 → start → 服务读写走通，dispose 回滚 effect 并透传原因', async () => {
    const applied: string[] = []
    const rolled: Array<string | undefined> = []
    const model = defineService<{ ask(): string }>('bank:model')

    await withTestContext(async (test) => {
      await test.use({
        name: 'bank:probe',
        apply: (ctx) => {
          applied.push('apply')
          ctx.effect((reason) => {
            rolled.push(reason)
          })
          ctx.provide(model, { ask: () => 'ok' })
        },
      })
      await test.start()

      expect(applied).toEqual(['apply'])
      expect(test.ctx.get(model).ask()).toBe('ok')
    }, '用例结束')

    expect(rolled).toEqual(['用例结束'])
  })

  it('use / start 可链式（返回测试上下文本身）', async () => {
    const test = createTestContext()
    const chained = await test.use({ name: 'bank:noop', apply: () => {} }).then((it) => it.start())

    expect(chained).toBe(test)
    await test.dispose()
  })
})

describe('record', () => {
  it('按派发顺序累积载荷，count / last / clear 可用', async () => {
    await withTestContext(async (test) => {
      const emitted = test.record<{ seq: number }>('session/event', 'emit')

      test.ctx.events.emit('session/event', { seq: 1 })
      test.ctx.events.emit('session/event', { seq: 2 })

      expect(emitted.values).toEqual([{ seq: 1 }, { seq: 2 }])
      expect(emitted.count).toBe(2)
      expect(emitted.last()).toEqual({ seq: 2 })

      emitted.clear()
      expect(emitted.count).toBe(0)
      expect(emitted.last()).toBeUndefined()
    })
  })

  it('waterfall 上会交还控制权，不改变链的结果', async () => {
    await withTestContext(async (test) => {
      const seen = test.record<{ hops: number }>('tools/pre-execute', 'waterfall')

      test.ctx.events.on('tools/pre-execute', async (value, next) =>
        next({ hops: (value as { hops: number }).hops + 1 }),
      )

      const result = await test.ctx.events.waterfall('tools/pre-execute', { hops: 0 })

      expect(seen.values).toEqual([{ hops: 0 }])
      expect(result).toEqual({ hops: 1 })
    })
  })

  it('bail 上不参与裁决（监听器无返回值）', async () => {
    await withTestContext(async (test) => {
      const seen = test.record('approval/request', 'bail')
      test.ctx.events.on('approval/request', () => 'allow')

      await expect(test.ctx.events.bail('approval/request', {})).resolves.toBe('allow')
      expect(seen.count).toBe(1)
    })
  })
})

describe('确定性等待', () => {
  it('flush 清空微任务队列', async () => {
    let done = false
    void Promise.resolve().then(() => {
      done = true
    })

    expect(done).toBe(false)
    await flush()
    expect(done).toBe(true)
  })

  it('waitFor 等到条件成立', async () => {
    let ready = false
    setTimeout(() => {
      ready = true
    }, 5)

    await waitFor(() => ready, { label: '定时器置位' })
    expect(ready).toBe(true)
  })

  it('waitFor 超时抛 BahError（绝不无限等）', async () => {
    const error = await captureRejection(() =>
      waitFor(() => false, { timeoutMs: 20, label: '永不成立' }),
    )

    expect(error.code).toBe('wait-timeout')
    expect(error.message).toContain('永不成立')
  })
})
