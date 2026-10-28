/**
 * 租户 ID 的口径用例（租户与鉴权 01 · TA-10）。
 *
 * 每个反例都对应一条**下游事故**，不是"格式偏好"：
 * `Demo` 会与 `demo` 落进两个目录却在环境变量后缀上撞车；`../etc` 会穿越租户根；
 * `租户1` 会让环境变量后缀出现非 ASCII；`demo_bank` 会让 `_` 与 `-` 两种分隔符歧义。
 */

import { describe, expect, it } from 'vitest'

import { BahError } from './util/errors.ts'
import {
  DEFAULT_TENANT_ID,
  TENANT_ID_PATTERN,
  asTenantId,
  isTenantId,
  parseTenantId,
  tenantEnvSuffix,
} from './tenant.ts'

/** 取错误码（非 BahError 直接让用例红）。 */
function codeOf(fn: () => unknown): string {
  try {
    fn()
  } catch (error) {
    if (error instanceof BahError) return error.code
    throw error
  }
  throw new Error('期望抛错，但没有抛')
}

describe('TENANT_ID_PATTERN / isTenantId', () => {
  it('TA-10-1 合法集：demo / a-b / acme-2 / 31 字符边界都通过', () => {
    for (const value of ['demo', 'a-b', 'acme-2', 'acme-bank', '0x', 'a'.repeat(31)]) {
      expect(isTenantId(value), value).toBe(true)
    }
  })

  it('TA-10-2 反例：大写 / 1 字符 / 穿越 / 非 ASCII / 下划线 / 超长全部拒绝', () => {
    const invalid = [
      'Demo', // 大写：会与 demo 落进两个目录
      'a', // 1 字符：低于下限
      '../etc', // 穿越
      '租户1', // 非 ASCII：环境变量后缀无意义
      'demo_bank', // 下划线：与 demo-bank 的后缀撞车
      'a'.repeat(32), // 32 字符：超上限
      'demo-', // 尾连字符：命令行里会被当成开关
      '-demo', // 首连字符
      '', // 空串
      ' demo', // 前导空格：不做 trim，笔误要 loud
      'demo ', // 尾空格
      'demo bank', // 空格：指标标签会坏
      'demo.bank', // 点：不是租户字符集
      'demo/bank', // 分隔符
      'demo\\bank', // Windows 分隔符
      '..', // 纯点
    ]
    for (const value of invalid) {
      expect(isTenantId(value), value).toBe(false)
    }
  })

  it('TA-10-3 正则本身不接受空串与只有连字符的值', () => {
    expect(TENANT_ID_PATTERN.test('')).toBe(false)
    expect(TENANT_ID_PATTERN.test('-')).toBe(false)
    expect(TENANT_ID_PATTERN.test('--')).toBe(false)
  })
})

describe('parseTenantId', () => {
  it('TA-10-4 合法值原样返回（运行期就是 string）', () => {
    expect(parseTenantId('demo') as string).toBe('demo')
    expect(String(parseTenantId('acme-bank'))).toBe('acme-bank')
  })

  it('TA-10-5 非法值抛 tenant-id-invalid，且消息里带上被拒的原值', () => {
    expect(codeOf(() => parseTenantId('Demo'))).toBe('tenant-id-invalid')
    let message = ''
    try {
      parseTenantId('../etc')
    } catch (error) {
      message = (error as Error).message
    }
    // 报错必须能定位到"是哪个值被拒"——否则运维只能猜
    expect(message).toContain('../etc')
  })

  it('TA-10-6 31 字符通过、32 字符拒绝（边界逐字取）', () => {
    expect(() => parseTenantId('a'.repeat(31))).not.toThrow()
    expect(codeOf(() => parseTenantId('a'.repeat(32)))).toBe('tenant-id-invalid')
  })

  it('TA-10-7 两侧空白不被静默吞掉（错的是调用方，不是校验器）', () => {
    expect(codeOf(() => parseTenantId(' demo '))).toBe('tenant-id-invalid')
  })
})

describe('asTenantId', () => {
  it('TA-10-8 不校验：运行期是恒等函数（契约如此，运行时输入必须走 parseTenantId）', () => {
    expect(asTenantId('Demo') as string).toBe('Demo')
    expect(asTenantId('demo') as string).toBe('demo')
  })

  it('TA-10-9 与 parseTenantId 对合法值给出同一运行期值', () => {
    expect(String(asTenantId('acme-2'))).toBe(String(parseTenantId('acme-2')))
  })
})

describe('tenantEnvSuffix', () => {
  it('TA-10-10 大写并把连字符换成下划线', () => {
    expect(tenantEnvSuffix(parseTenantId('demo'))).toBe('DEMO')
    expect(tenantEnvSuffix(parseTenantId('acme-bank'))).toBe('ACME_BANK')
    expect(tenantEnvSuffix(parseTenantId('acme-2'))).toBe('ACME_2')
  })

  it('TA-10-11 结果只含 [A-Z0-9_]（环境变量名的安全子集）', () => {
    for (const value of ['demo', 'a-b', 'acme-bank', 'a1-b2-c3']) {
      expect(tenantEnvSuffix(parseTenantId(value))).toMatch(/^[A-Z0-9_]+$/)
    }
  })

  it('TA-10-12 demo-bank 与 demo_bank 不可能同时是租户（后者被字符集拒绝）', () => {
    expect(tenantEnvSuffix(parseTenantId('demo-bank'))).toBe('DEMO_BANK')
    expect(isTenantId('demo_bank')).toBe(false)
  })
})

describe('DEFAULT_TENANT_ID', () => {
  it('TA-10-13 缺省租户是 demo，且本身就是合法租户', () => {
    expect(String(DEFAULT_TENANT_ID)).toBe('demo')
    expect(isTenantId(String(DEFAULT_TENANT_ID))).toBe(true)
  })
})
