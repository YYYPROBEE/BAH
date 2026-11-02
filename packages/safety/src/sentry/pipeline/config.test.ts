/**
 * `safety:sentry` 配置面（fail-loud）。
 *
 * 锚点：未知键 / 类型错 / 阈值越界 / 正则编译失败 → 载入即抛（`bah-sentry: `）。
 */

import { describe, expect, it } from 'vitest'

import { CROSS_SCENARIO_RULES, DEFAULT_SENTRY_SETTINGS, resolveSentrySettings } from './config.ts'

describe('sentry 配置（fail-loud）', () => {
  it('T-SNT-CFG-001 空配置缺 trace.sink → fail-loud；其余默认不被误冻', () => {
    // W08：trace.sink 没有缺省值，空配置必须载入失败
    expect(codeOf(() => resolveSentrySettings())).toBe('sentry-trace-sink-required')

    const settings = resolveSentrySettings({ trace: { sink: 'session' } })
    expect(settings).toEqual({
      ...DEFAULT_SENTRY_SETTINGS,
      trace: { ...DEFAULT_SENTRY_SETTINGS.trace, sink: 'session' },
    })
    expect(DEFAULT_SENTRY_SETTINGS.breaker.denyThreshold).toBe(5)
    expect(DEFAULT_SENTRY_SETTINGS.breaker.windowSeconds).toBe(600)
    // XSC 是部署侧追加规则：默认关，演示/压测 profile 显式打开
    expect(DEFAULT_SENTRY_SETTINGS.rules.crossScenario).toBe(false)
    // HALT 默认开启：它是"全系统停机"面，默认关闭等于没有（W07）
    expect(DEFAULT_SENTRY_SETTINGS.halt).toEqual({ enabled: true, ticketTtlSeconds: 120 })
    // W09：高风险会话默认拒绝非绿工具（读工具不受影响）
    expect(DEFAULT_SENTRY_SETTINGS.riskScore).toEqual({ enforce: true })
    // 默认值里刻意不存在 sink（防止将来被顺手塞回 memory）
    expect('sink' in DEFAULT_SENTRY_SETTINGS.trace).toBe(false)
  })

  it('T-SNT-CFG-016 trace.sink 缺失 / trace 段为空 → 特定错误码（TC-W08-05）', () => {
    expect(codeOf(() => resolveSentrySettings({ trace: {} }))).toBe('sentry-trace-sink-required')
    expect(codeOf(() => resolveSentrySettings({ trace: { ringSize: 10 } }))).toBe(
      'sentry-trace-sink-required',
    )
    // 三种合法值都必须显式写；`memory` 是合法选择，但不能再由默认值代劳
    for (const sink of ['memory', 'stderr', 'session'] as const) {
      expect(resolveSentrySettings({ trace: { sink } }).trace.sink).toBe(sink)
    }
  })

  it('T-SNT-CFG-002 逐层覆盖（阈值 / 窗口 / 白名单 / 预算 / 降级 / 开关）', () => {
    const settings = resolveSentrySettings({
      detector: { warnThreshold: 0.3, highThreshold: 0.9 },
      rules: {
        engine: 'bundle',
        disabled: ['CMD-001'],
        demoWhitelist: false,
        crossScenario: false,
        extra: [{ id: 'EXT-001', pattern: 'secret-\\d+', family: 'exfil', note: '测试规则' }],
      },
      budget: { totalCalls: 10, riskyCalls: 3, amountYuan: 500 },
      breaker: { denyThreshold: 2, windowSeconds: 60, revokeTickets: false },
      degrade: { invalidArgsThreshold: 1 },
      guard: { maxToolsPerTurn: 2 },
      honesty: { numeric: false, noResult: false },
      riskScore: { enforce: false },
      halt: { enabled: false, ticketTtlSeconds: 60 },
      trace: { ringSize: 10, flushThreshold: 2, sink: 'stderr' },
    })
    expect(settings.detector).toEqual({ warnThreshold: 0.3, highThreshold: 0.9 })
    expect(settings.rules.engine).toBe('bundle')
    expect(settings.rules.disabled).toEqual(['CMD-001'])
    expect(settings.rules.demoWhitelist).toBe(false)
    expect(settings.rules.crossScenario).toBe(false)
    expect(settings.rules.extra).toHaveLength(1)
    expect(settings.rules.extra[0]?.id).toBe('EXT-001')
    expect(settings.rules.extra[0]?.pattern.source).toBe('secret-\\d+')
    expect(settings.budget).toEqual({ totalCalls: 10, riskyCalls: 3, amountYuan: 500 })
    expect(settings.breaker).toEqual({ denyThreshold: 2, windowSeconds: 60, revokeTickets: false })
    expect(settings.degrade.invalidArgsThreshold).toBe(1)
    expect(settings.guard.maxToolsPerTurn).toBe(2)
    expect(settings.honesty).toEqual({ numeric: false, noResult: false })
    expect(settings.riskScore).toEqual({ enforce: false })
    expect(settings.halt).toEqual({ enabled: false, ticketTtlSeconds: 60 })
    expect(settings.trace).toEqual({ ringSize: 10, flushThreshold: 2, sink: 'stderr' })
  })

  it('T-SNT-CFG-015 halt 子键未知 / 类型错 / TTL 非正 → 载入即抛', () => {
    expect(codeOf(() => resolveSentrySettings({ halt: { enabled: 'yes' } }))).toBe(
      'sentry-invalid-config',
    )
    expect(codeOf(() => resolveSentrySettings({ halt: { ticketTtlSeconds: 0 } }))).toBe(
      'sentry-invalid-config',
    )
    expect(codeOf(() => resolveSentrySettings({ halt: { force: true } }))).toBe(
      'sentry-unknown-config-key',
    )
  })

  it('T-SNT-CFG-014 trace.sink 支持 session（durable 回放）', () => {
    expect(resolveSentrySettings({ trace: { sink: 'session' } }).trace.sink).toBe('session')
    expect(codeOf(() => resolveSentrySettings({ trace: { sink: 'file' } }))).toBe(
      'sentry-invalid-config',
    )
  })

  it('T-SNT-CFG-003 默认跨场景规则是确定性正则（不是概率检测）', () => {
    expect(CROSS_SCENARIO_RULES.map((rule) => rule.id)).toEqual(['XSC-001', 'XSC-002'])
    expect(CROSS_SCENARIO_RULES[0]?.pattern.test('用理财额度跨场景转账')).toBe(true)
    expect(CROSS_SCENARIO_RULES[1]?.pattern.test('绕过限额把额度套出来')).toBe(true)
    expect(CROSS_SCENARIO_RULES[0]?.pattern.test('今天天气不错')).toBe(false)
  })

  it('T-SNT-CFG-010 未知键 / 段类型错 / 子键未知全部拒绝', () => {
    const cases: readonly [string, Readonly<Record<string, unknown>>, string][] = [
      ['根未知键', { nope: 1 }, 'sentry-unknown-config-key'],
      ['detector 未知键', { detector: { nope: 1 } }, 'sentry-unknown-config-key'],
      ['detector 非对象', { detector: 1 }, 'sentry-invalid-config'],
      ['rules 非对象', { rules: [] }, 'sentry-invalid-config'],
      ['budget 非对象', { budget: 'x' }, 'sentry-invalid-config'],
      ['trace 非对象', { trace: null }, 'sentry-invalid-config'],
    ]
    for (const [name, config, code] of cases) {
      expect(`${name}: ${codeOf(() => resolveSentrySettings(config))}`).toBe(`${name}: ${code}`)
    }
  })

  it('T-SNT-CFG-011 类型 / 范围 / 顺序全部拒绝', () => {
    const cases: readonly [string, Readonly<Record<string, unknown>>, string][] = [
      ['warn 非数字', { detector: { warnThreshold: '0.5' } }, 'sentry-invalid-config'],
      ['warn 为 0', { detector: { warnThreshold: 0 } }, 'sentry-invalid-config'],
      ['high 超过 1', { detector: { highThreshold: 1.5 } }, 'sentry-invalid-config'],
      ['warn >= high', { detector: { warnThreshold: 0.9, highThreshold: 0.5 } }, 'sentry-invalid-config'],
      ['布尔类型错', { rules: { demoWhitelist: 'yes' } }, 'sentry-invalid-config'],
      ['正整数为 0', { budget: { totalCalls: 0 } }, 'sentry-invalid-config'],
      ['正整数非整数', { budget: { riskyCalls: 1.5 } }, 'sentry-invalid-config'],
      ['窗口非整数', { breaker: { windowSeconds: 1.2 } }, 'sentry-invalid-config'],
      ['sink 枚举非法', { trace: { sink: 'file' } }, 'sentry-invalid-config'],
      ['engine 非法', { rules: { engine: 'opa' } }, 'sentry-invalid-config'],
      ['disabled 非数组', { rules: { disabled: 'CMD-001' } }, 'sentry-invalid-config'],
      ['disabled 含空串', { rules: { disabled: [''] } }, 'sentry-invalid-config'],
    ]
    for (const [name, config, code] of cases) {
      expect(`${name}: ${codeOf(() => resolveSentrySettings(config))}`).toBe(`${name}: ${code}`)
    }
  })

  it('T-SNT-CFG-012 追加规则逐条校验（结构 / 重复 / 正则编译）', () => {
    const cases: readonly [string, Readonly<Record<string, unknown>>, string][] = [
      ['extra 非数组', { rules: { extra: {} } }, 'sentry-invalid-config'],
      ['条目非对象', { rules: { extra: [1] } }, 'sentry-invalid-config'],
      ['条目未知键', { rules: { extra: [{ id: 'A', pattern: 'x', nope: 1 }] } }, 'sentry-unknown-config-key'],
      ['id 为空', { rules: { extra: [{ id: '', pattern: 'x' }] } }, 'sentry-invalid-config'],
      ['pattern 为空', { rules: { extra: [{ id: 'A', pattern: '' }] } }, 'sentry-invalid-config'],
      ['pattern 类型错', { rules: { extra: [{ id: 'A', pattern: 1 }] } }, 'sentry-invalid-config'],
      [
        'pattern 无法编译',
        { rules: { extra: [{ id: 'A', pattern: '(' }] } },
        'sentry-invalid-rule',
      ],
      [
        'id 重复',
        {
          rules: {
            extra: [
              { id: 'A', pattern: 'x' },
              { id: 'A', pattern: 'y' },
            ],
          },
        },
        'sentry-invalid-config',
      ],
      [
        'family 类型错',
        { rules: { extra: [{ id: 'A', pattern: 'x', family: 1 }] } },
        'sentry-invalid-config',
      ],
      [
        'note 空串',
        { rules: { extra: [{ id: 'A', pattern: 'x', note: '' }] } },
        'sentry-invalid-config',
      ],
    ]
    for (const [name, config, code] of cases) {
      expect(`${name}: ${codeOf(() => resolveSentrySettings(config))}`).toBe(`${name}: ${code}`)
    }
  })

  it('T-SNT-CFG-013 不可序列化值也能给出可读错误（不静默失败）', () => {
    const cyclic: Record<string, unknown> = {}
    cyclic['self'] = cyclic
    const error = thrown(() => resolveSentrySettings({ rules: { disabled: [cyclic] } }))
    expect(error.code).toBe('sentry-invalid-config')
    expect(error.message).toContain('bah-sentry: ')
  })
})

/** 取抛出物的理由码（未抛 → `no-error`）。 */
function codeOf(run: () => unknown): string {
  return thrown(run).code
}

/** 取抛出物（未抛 → 断言失败）。 */
function thrown(run: () => unknown): { code: string; message: string } {
  try {
    run()
  } catch (error) {
    if (error instanceof Error && 'code' in error) {
      return { code: String((error as { code: unknown }).code), message: error.message }
    }
    return { code: 'non-bah-error', message: String(error) }
  }
  return { code: 'no-error', message: '' }
}
