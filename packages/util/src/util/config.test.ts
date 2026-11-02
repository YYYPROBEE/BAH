/**
 * 配置读取唯一实现面的判定口径（`rejectUnknownConfigKeys` 与三个 `readConfig*`）。
 *
 * 为什么值得单独钉：这些判定原先在 host / safety / saga / bank / cli 各有一份，
 * 「参数顺序与默认值语义已经出现漂移」（见文件头注释）才收口到这里。收口解决的是
 * 「复制分叉」，解决不了「这一份的边界口径被改坏」——而它决定的是
 * **一个坏配置到底能不能启动成功**。
 *
 * 最贵的一类回归是「静默兜底」：`"false"`（YAML 带引号）被当成真、
 * 限流阈值 `0` 被当成合法值、拼错的键被忽略。每条都对应一次线上行为偏离。
 */

import { describe, expect, it } from 'vitest'

import { BahError } from './errors.ts'
import {
  readConfigBoolean,
  readConfigEnum,
  readConfigPositiveInteger,
  rejectUnknownConfigKeys,
  type ConfigFailure,
} from './config.ts'

/** 注入的失败出口：把消息与 detail 原样包成 BahError 供断言。 */
function failing(tag = 'config-invalid'): ConfigFailure {
  return (message, detail) => {
    throw new BahError(tag, message, detail)
  }
}

/** 取抛错消息（没抛则让用例红）。 */
function messageOf(run: () => unknown): string {
  try {
    run()
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
  throw new Error('期望抛错，但没有抛')
}

/** 取抛错时携带的结构化 detail（门禁/前端分支靠它，不靠文案）。 */
function detailOf(run: () => unknown): Record<string, unknown> {
  try {
    run()
  } catch (error) {
    return (error as { detail?: Record<string, unknown> }).detail ?? {}
  }
  throw new Error('期望抛错，但没有抛')
}

describe('rejectUnknownConfigKeys：拼错的键不许被忽略', () => {
  it('全部键都在白名单内 ⇒ 不抛（含空记录与空白名单）', () => {
    expect(() => rejectUnknownConfigKeys({ host: '127.0.0.1' }, ['host'], 'web', failing())).not.toThrow()
    expect(() => rejectUnknownConfigKeys({}, [], 'web', failing())).not.toThrow()
  })

  it('只报未知键，不牵连合法键', () => {
    const detail = detailOf(() =>
      rejectUnknownConfigKeys({ hosts: 'x', port: 1 }, ['host', 'port'], 'web', failing()),
    )
    expect(detail['unknown']).toEqual(['hosts'])
    expect(String(detail['unknown'])).not.toContain('port')
  })

  it('可写清单为空时文案给「无」（不许留下空清单）', () => {
    expect(messageOf(() => rejectUnknownConfigKeys({ a: 1 }, [], 'web', failing()))).toContain('可写：无')
  })

  it('detail 带 where（错误定位不许只活在文案里）', () => {
    const detail = detailOf(() => rejectUnknownConfigKeys({ zzz: 1 }, ['ok'], 'saga.gates', failing()))
    expect(detail).toMatchObject({ where: 'saga.gates', unknown: ['zzz'] })
  })
})

describe('readConfigBoolean：不做真值兜底', () => {
  it('布尔原样返回，缺键用 fallback', () => {
    expect(readConfigBoolean({ on: true }, 'on', 'w', false, failing())).toBe(true)
    expect(readConfigBoolean({ on: false }, 'on', 'w', true, failing())).toBe(false)
    expect(readConfigBoolean({}, 'on', 'w', true, failing())).toBe(true)
  })

  it('字符串 "false" 与数字 1 都必须是错误——按真值判定会把前者读成 true', () => {
    expect(messageOf(() => readConfigBoolean({ on: 'false' }, 'on', 'w', false, failing()))).toContain('必须是布尔')
    expect(() => readConfigBoolean({ on: 1 }, 'on', 'w', false, failing())).toThrow(/必须是布尔/)
  })

  it('null 默认是错误；只有显式 nullAsUndefined 才当缺省', () => {
    expect(() => readConfigBoolean({ on: null }, 'on', 'w', false, failing())).toThrow(/必须是布尔/)
    expect(readConfigBoolean({ on: null }, 'on', 'w', true, failing(), { nullAsUndefined: true })).toBe(true)
  })

  it('nullAsUndefined 只影响 null，不影响缺键', () => {
    expect(readConfigBoolean({}, 'on', 'w', true, failing(), { nullAsUndefined: true })).toBe(true)
  })
})

describe('readConfigPositiveInteger：0 与负数与小数一律拒', () => {
  it('正整数原样返回；缺键用 fallback（fallback 可以是 undefined）', () => {
    expect(readConfigPositiveInteger({ n: 1 }, 'n', 'w', 9, failing())).toBe(1)
    expect(readConfigPositiveInteger({}, 'n', 'w', 9, failing())).toBe(9)
    expect(readConfigPositiveInteger({}, 'n', 'w', undefined, failing())).toBeUndefined()
  })

  it('非正整数取值全部 fail-loud（限流阈值写 0 必须是启动失败）', () => {
    for (const bad of [0, -1, Number.MIN_SAFE_INTEGER, 1.5, Number.NaN, Number.POSITIVE_INFINITY, '5', null, true]) {
      expect(() => readConfigPositiveInteger({ n: bad }, 'n', 'w', 1, failing()), String(bad)).toThrow(/必须是正整数/)
    }
  })

  it('detail 带 where/key/value 三项', () => {
    const detail = detailOf(() => readConfigPositiveInteger({ n: 0 }, 'n', 'web.limits', 1, failing()))
    expect(detail).toMatchObject({ where: 'web.limits', key: 'n', value: 0 })
  })
})

describe('readConfigEnum：只认声明过的字面量', () => {
  const ALLOWED = ['none', 'read', 'write'] as const

  it('声明值原样返回，缺键用 fallback', () => {
    expect(readConfigEnum({ tier: 'read' }, 'tier', 'w', ALLOWED, 'none', failing())).toBe('read')
    expect(readConfigEnum({}, 'tier', 'w', ALLOWED, 'none', failing())).toBe('none')
    expect(readConfigEnum({}, 'tier', 'w', ALLOWED, undefined, failing())).toBeUndefined()
  })

  it('大小写不符与数字都拒绝，且文案给出可选清单', () => {
    const message = messageOf(() => readConfigEnum({ tier: 'Write' }, 'tier', 'w', ALLOWED, 'none', failing()))
    expect(message).toContain('none / read / write')
    expect(() => readConfigEnum({ tier: 2 }, 'tier', 'w', ALLOWED, 'none', failing())).toThrow(/只能是/)
  })

  it('未知枚举值的 detail 带 allowed 与 value', () => {
    const detail = detailOf(() => readConfigEnum({ tier: 'Write' }, 'tier', 'bank', ALLOWED, 'none', failing()))
    expect(detail).toMatchObject({ where: 'bank', key: 'tier', value: 'Write' })
    expect(detail['allowed']).toEqual([...ALLOWED])
  })
})

describe('locate：where 为空时只写键名', () => {
  it('空 where ⇒ 消息以键名开头，不留前导点', () => {
    expect(messageOf(() => readConfigBoolean({ on: 'yes' }, 'on', '', false, failing())).startsWith('on ')).toBe(true)
  })

  it('非空 where ⇒ 消息带 where.key 全路径', () => {
    expect(messageOf(() => readConfigBoolean({ on: 'yes' }, 'on', 'web.tls', false, failing()))).toContain('web.tls.on')
  })
})
