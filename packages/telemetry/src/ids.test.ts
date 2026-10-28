import { describe, expect, it } from 'vitest'

import {
  buildTraceparent,
  parseTraceparent,
  spanIdOf,
  spanIdOfTelemetry,
  toW3cTraceId,
  traceIdOfSession,
  traceparentOf,
  withTraceparent,
} from './ids.ts'

/** 一条真实形状的入站 traceparent（W3C 规范示例值）。 */
const SAMPLE = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01'

describe('ids · traceIdOfSession', () => {
  it('是 32 位小写 hex', () => {
    expect(traceIdOfSession('s-1')).toMatch(/^[0-9a-f]{32}$/)
  })

  it('幂等（同会话同 trace）', () => {
    expect(traceIdOfSession('s-1')).toBe(traceIdOfSession('s-1'))
  })

  it('会话不同则 trace 不同', () => {
    expect(traceIdOfSession('s-1')).not.toBe(traceIdOfSession('s-2'))
  })

  it('是纯函数：不读时钟、不读随机（同一入参调三次同值）', () => {
    const values = new Set([traceIdOfSession('s-x'), traceIdOfSession('s-x'), traceIdOfSession('s-x')])
    expect(values.size).toBe(1)
  })
})

describe('ids · spanIdOfTelemetry', () => {
  it('是 16 位小写 hex', () => {
    expect(spanIdOfTelemetry('tool', 'call-1')).toMatch(/^[0-9a-f]{16}$/)
  })

  it('(kind,key) 任一变化都换 id', () => {
    expect(spanIdOfTelemetry('tool', 'call-1')).not.toBe(spanIdOfTelemetry('tool', 'call-2'))
    expect(spanIdOfTelemetry('tool', 'call-1')).not.toBe(spanIdOfTelemetry('step', 'call-1'))
  })

  it('与 saga 的 spanIdOf 是两套命名空间（同一 key 也不同）', () => {
    expect(spanIdOfTelemetry('tool', 'call-1')).not.toBe(spanIdOf('call-1'))
  })
})

describe('ids · spanIdOf（saga 历史算法，逐字保留）', () => {
  it('等于 sha256(callId) 前 16 位', async () => {
    const { sha256Hex } = await import('@bah/util')
    expect(spanIdOf('call-1')).toBe(sha256Hex('call-1').slice(0, 16))
  })

  it('无前缀、16 hex', () => {
    expect(spanIdOf('call-1')).toMatch(/^[0-9a-f]{16}$/)
  })
})

describe('ids · parseTraceparent', () => {
  it('解析合法值', () => {
    expect(parseTraceparent(SAMPLE)).toEqual({
      traceId: '4bf92f3577b34da6a3ce929d0e0e4736',
      spanId: '00f067aa0ba902b7',
      sampled: true,
    })
  })

  it('flags 只取 bit0，其余保留位忽略', () => {
    const value = `00-${'a'.repeat(32)}-${'b'.repeat(16)}-02`
    expect(parseTraceparent(value)?.sampled).toBe(false)
    expect(parseTraceparent(`00-${'a'.repeat(32)}-${'b'.repeat(16)}-03`)?.sampled).toBe(true)
  })

  it('非法输入一律 undefined，绝不抛', () => {
    const bad = [
      '',
      '00-x-y-01',
      `ff-${'a'.repeat(32)}-${'b'.repeat(16)}-01`,
      `00-${'0'.repeat(32)}-${'b'.repeat(16)}-01`,
      `00-${'a'.repeat(32)}-${'0'.repeat(16)}-01`,
      `00-${'a'.repeat(32)}-${'b'.repeat(16)}-01-extra`,
      `00-${'A'.repeat(32)}-${'b'.repeat(16)}-01`,
      `zz-${'a'.repeat(32)}-${'b'.repeat(16)}-01`,
    ]
    for (const value of bad) expect(parseTraceparent(value)).toBeUndefined()
    expect(parseTraceparent(undefined)).toBeUndefined()
    expect(parseTraceparent(null)).toBeUndefined()
  })

  it('把零校验删掉就会红（反向验证：全零 trace-id 必须被拒）', () => {
    // 这条断言是"零校验存在"的唯一证据：长度/字符集都合法，只有全零这一条能拦住它。
    const zeroTrace = `00-${'0'.repeat(32)}-${'b'.repeat(16)}-01`
    expect(zeroTrace).toHaveLength(55)
    expect(/^[0-9a-f]{32}$/.test('0'.repeat(32))).toBe(true)
    expect(parseTraceparent(zeroTrace)).toBeUndefined()
  })
})

describe('ids · buildTraceparent', () => {
  it('构造 00-<32>-<16>-01', () => {
    const hex = 'a'.repeat(32)
    expect(buildTraceparent(hex, 'b'.repeat(16))).toBe(`00-${hex}-${'b'.repeat(16)}-01`)
  })

  it('sampled=false 时 flags 是 00', () => {
    expect(buildTraceparent('a'.repeat(32), 'b'.repeat(16), false)).toBe(
      `00-${'a'.repeat(32)}-${'b'.repeat(16)}-00`,
    )
  })

  it('trace-id 走确定性归一（不是 32-hex 也能构造）', async () => {
    const { sha256Hex } = await import('@bah/util')
    expect(buildTraceparent('saga:s-1:c-1', 'b'.repeat(16))).toBe(
      `00-${sha256Hex('saga:s-1:c-1').slice(0, 32)}-${'b'.repeat(16)}-01`,
    )
  })

  it('span-id 非法抛 invalid-traceparent', () => {
    expect(() => buildTraceparent('t', 'xyz')).toThrowError(/invalid-traceparent/)
    expect(() => buildTraceparent('t', '0'.repeat(16))).toThrowError(/invalid-traceparent/)
    expect(() => buildTraceparent('t', '0'.repeat(16))).toThrowError(
      expect.objectContaining({ name: 'BahError', code: 'invalid-traceparent' }),
    )
  })

  it('构造结果能被自己解析回来（往返一致）', () => {
    const hex = 'c'.repeat(32)
    const parsed = parseTraceparent(buildTraceparent(hex, 'd'.repeat(16)))
    expect(parsed).toEqual({ traceId: hex, spanId: 'd'.repeat(16), sampled: true })
  })
})

describe('ids · toW3cTraceId', () => {
  it('已是合法 32-hex 则原样小写', () => {
    const hex = 'abcdef0123456789abcdef0123456789'
    expect(toW3cTraceId(hex.toUpperCase())).toBe(hex)
  })

  it('非 hex 走 sha256 前 32 位', async () => {
    const { sha256Hex } = await import('@bah/util')
    expect(toW3cTraceId('trace-abc')).toBe(sha256Hex('trace-abc').slice(0, 32))
  })

  it('全零 trace-id 不做原样返回，而走 sha256', async () => {
    const { sha256Hex } = await import('@bah/util')
    expect(toW3cTraceId('0'.repeat(32))).toBe(sha256Hex('0'.repeat(32)).slice(0, 32))
  })
})

describe('ids · withTraceparent / traceparentOf', () => {
  it('挂上去能读出来，且 traceparent 不可枚举', () => {
    const original = { callId: 'call-1', tool: 'transfer_create' }
    const traced = withTraceparent(original, buildTraceparent('a'.repeat(32), spanIdOf('call-2')))
    expect(traceparentOf(traced)).toBeDefined()
    expect(Object.keys(traced)).toEqual(['callId', 'tool'])
    expect(JSON.stringify(traced)).toBe(JSON.stringify(original))
  })

  it('不污染原对象', () => {
    const original = { callId: 'call-1' }
    withTraceparent(original, buildTraceparent('a'.repeat(32), 'b'.repeat(16)))
    expect(traceparentOf(original)).toBeUndefined()
  })

  it('非字符串值读成 undefined（不抛）', () => {
    expect(traceparentOf({ traceparent: 42 } as unknown as object)).toBeUndefined()
  })
})
