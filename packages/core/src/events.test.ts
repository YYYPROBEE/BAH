/**
 * 事件五模式单测（施工单 02 §3 / §4 / §10）。
 *
 * 用例 ID 与施工单 §10 表逐一对应，编号不得增删改。
 * 只测公开行为（派发结果 / 调用顺序 / 抛出），不碰私有注册表。
 */

import { describe, expect, it } from 'vitest'

import { BahEvents, MAX_WATERFALL_DEPTH } from './events.ts'

/** 测试里的事件载荷（`BahEventMap` 当前是索引签名，取用处按需收窄）。 */
interface Probe {
  hops: number
}

const asProbe = (value: unknown): Probe => value as Probe

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms)
  })

describe('waterfall（施工单 02 §4 逐条）', () => {
  it('T-CORE-006 handler 调 next() → 控制权正确传递，值可被改写', async () => {
    const events = new BahEvents()
    const order: string[] = []

    events.on('tools/pre-execute', async (value, next) => {
      order.push('first')
      return next({ hops: asProbe(value).hops + 1 })
    })
    events.on('tools/pre-execute', async (value, next) => {
      order.push('second')
      return next({ hops: asProbe(value).hops + 1 })
    })

    const result = await events.waterfall('tools/pre-execute', { hops: 0 })

    expect(order).toEqual(['first', 'second'])
    expect(result).toEqual({ hops: 2 })
  })

  it('T-CORE-007 handler 不调 next() → 拥有判决，后续 handler 不执行', async () => {
    const events = new BahEvents()
    const order: string[] = []

    events.on('tools/pre-execute', () => {
      order.push('decided')
      return { hops: 99 }
    })
    events.on('tools/pre-execute', () => {
      order.push('shadowed')
      return { hops: 0 }
    })

    const result = await events.waterfall('tools/pre-execute', { hops: 0 })

    expect(order).toEqual(['decided'])
    expect(result).toEqual({ hops: 99 })
  })

  it('T-CORE-008 waterfall 33 级 → 抛「超 32 级」错误', async () => {
    const events = new BahEvents()
    for (let index = 0; index < MAX_WATERFALL_DEPTH + 1; index += 1) {
      events.on('deep-chain', async (value, next) => next(value))
    }

    await expect(events.waterfall('deep-chain', { hops: 0 })).rejects.toThrow(/超过 32 级/)
  })

  it('T-CORE-009 waterfall 内部 await → 瀑布仍按注册顺序步进', async () => {
    const events = new BahEvents()
    const order: string[] = []

    events.on('slow-chain', async (value, next) => {
      await delay(20)
      order.push('slow')
      return next(value)
    })
    events.on('slow-chain', async (value, next) => {
      await delay(0)
      order.push('fast')
      return next(value)
    })

    await events.waterfall('slow-chain', { hops: 0 })

    expect(order).toEqual(['slow', 'fast'])
  })

  it('waterfall 以最外层 handler 返回值为准：只 await next() 不 return 就会丢值', async () => {
    // 这是有意的显式语义（与施工单 00 §12 的机制对照锚点一致），不是 bug：
    // 「链尾值兜底」会让 next 之后的改写被静默吃掉，所以这里把行为钉死，防止被好心重构掉。
    const events = new BahEvents()
    events.on('audited-chain', async (value, next) => {
      await next({ hops: asProbe(value).hops + 1 })
    })
    events.on('audited-chain', async (value, next) => next(value))

    await expect(events.waterfall('audited-chain', { hops: 0 })).resolves.toBeUndefined()
  })
})

describe('serial / bail / emit / parallel', () => {
  it('T-CORE-010 serial 逐个 await，顺序与注册一致', async () => {
    const events = new BahEvents()
    const order: string[] = []

    events.on('agent/turn-stopping', async () => {
      order.push('first:start')
      await delay(10)
      order.push('first:end')
    })
    events.on('agent/turn-stopping', async () => {
      order.push('second')
    })

    await events.serial('agent/turn-stopping', {})

    expect(order).toEqual(['first:start', 'first:end', 'second'])
  })

  it('T-CORE-011 bail 首个非 undefined 返回即短路，后续不执行', async () => {
    const events = new BahEvents()
    const order: string[] = []

    events.on('tools/pre-execute', () => {
      order.push('abstain')
      return undefined
    })
    events.on('tools/pre-execute', () => {
      order.push('deny')
      return { kind: 'deny' }
    })
    events.on('tools/pre-execute', () => {
      order.push('shadowed')
      return { kind: 'allow' }
    })

    const verdict = await events.bail('tools/pre-execute', {})

    expect(order).toEqual(['abstain', 'deny'])
    expect(verdict).toEqual({ kind: 'deny' })
  })

  it('T-CORE-012 bail 无裁决 → 返回 undefined', async () => {
    const events = new BahEvents()
    events.on('bail-nothing', () => undefined)

    await expect(events.bail('bail-nothing', {})).resolves.toBeUndefined()
  })

  it('T-CORE-013 emit 不阻塞：同步返回、无返回值', async () => {
    const events = new BahEvents()
    const order: string[] = []

    events.on('session/event', async () => {
      await delay(20)
      order.push('async-listener')
    })

    const returned = events.emit('session/event', { seq: 1 })
    order.push('after-emit')

    expect(returned).toBeUndefined()
    expect(order).toEqual(['after-emit'])

    await delay(30)
    expect(order).toEqual(['after-emit', 'async-listener'])
  })

  it('parallel 并发派发：全部开始后才逐个完成', async () => {
    const events = new BahEvents()
    const order: string[] = []

    events.on('broadcast', async () => {
      order.push('first:start')
      await delay(10)
      order.push('first:end')
    })
    events.on('broadcast', async () => {
      order.push('second:start')
      await delay(0)
      order.push('second:end')
    })

    await events.parallel('broadcast', {})

    expect(order).toEqual(['first:start', 'second:start', 'second:end', 'first:end'])
  })
})

describe('注册表与 @mode 契约', () => {
  it('注销句柄幂等：重复调用后不再派发', async () => {
    const events = new BahEvents()
    const seen: string[] = []
    const off = events.on('session/event', () => {
      seen.push('hit')
    })

    events.emit('session/event', {})
    off()
    off()
    events.emit('session/event', {})

    expect(seen).toEqual(['hit'])
    // 最后一条监听器撤销后事件表清空：再派发是空操作而不是报错
    await expect(events.serial('session/event', {})).resolves.toBeUndefined()
  })

  it('低层 on(name, listener, mode)：声明 mode 与派发模式分叉即抛错', () => {
    const events = new BahEvents()
    events.on('legacy-event', () => undefined, 'serial')

    expect(() => events.emit('legacy-event', {})).toThrow(/声明为 serial/)
    expect(() => events.emit('legacy-event', {})).toThrow(/不能按 emit 派发/)
  })

  it('低层 on 声明 mode 后按同模式派发可正常工作', async () => {
    const events = new BahEvents()
    const order: string[] = []
    events.register('legacy-serial', () => {
      order.push('hit')
    }, 'serial')

    await events.serial('legacy-serial', {})
    expect(order).toEqual(['hit'])
  })

  it('emit / serial / bail 的监听器误调 next() 也只是透传（不炸、不改语义）', async () => {
    const events = new BahEvents()
    const seen: unknown[] = []

    events.on('legacy-sink', async (_value, next) => {
      seen.push(await next('passthrough'))
    })

    events.emit('legacy-sink', {})
    await delay(0)

    expect(seen).toEqual(['passthrough'])
  })
})
