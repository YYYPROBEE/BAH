/**
 * 沙箱档位解析用例（ 中与 policy 相关的 T-SBX-006 / T-SBX-007，
 * 以及两条恒等规则与批准时效的对抗性用例）。
 */

import { BahError } from '@bah/util'
import { describe, expect, it } from 'vitest'

import { SandboxPolicy } from './policy.ts'
import type { SandboxPolicyOptions } from './policy.ts'
import { DEFAULT_TIER_SPECS, TIER_RANK, isSandboxTier, isWider } from './tier.ts'
import type { SandboxTier, TierSpec } from './tier.ts'

/** 可推进的时钟（时效用例需要真正走过期点）。 */
function mutableClock(start = 1_000_000): { readonly now: () => number; advance(ms: number): void } {
  let current = start
  return {
    now: () => current,
    advance(ms: number) {
      current += ms
    },
  }
}

/** 取用抛出的错误（比 `toThrowError(fn)` 更直白：码与消息分开钉）。 */
function captureError(run: () => unknown): BahError {
  try {
    run()
  } catch (error) {
    return error as BahError
  }
  throw new Error('预期抛错，实际没有抛')
}

/** 固定时钟：所有时效判定都可预测。 */
const FIXED = 1_000_000
const clock = (): (() => number) => () => FIXED

/** 一份典型工具档位表。 */
const defaults = { analysis_calc: 'compute-bounded', bill_analyze: 'query-only' } as const

function makePolicy(options: SandboxPolicyOptions = {}) {
  return new SandboxPolicy({
    defaults: { ...defaults },
    now: clock(),
    ...options,
  })
}

describe('沙箱档位词汇表', () => {
  it('宽窄序：query-only < compute-bounded < none', () => {
    expect(TIER_RANK['query-only']).toBe(0)
    expect(TIER_RANK['compute-bounded']).toBe(1)
    expect(TIER_RANK.none).toBe(2)
    expect(isWider('none', 'compute-bounded')).toBe(true)
    expect(isWider('query-only', 'query-only')).toBe(false)
    expect(isWider('compute-bounded', 'none')).toBe(false)
  })

  it('档位名判定只认三档，别的（含空串）一律 false', () => {
    expect(isSandboxTier('query-only')).toBe(true)
    expect(isSandboxTier('none')).toBe(true)
    expect(isSandboxTier('sandboxed')).toBe(false)
    expect(isSandboxTier('')).toBe(false)
    expect(isSandboxTier(undefined)).toBe(false)
    expect(isSandboxTier(1)).toBe(false)
  })

  it('缺省规格按：query-only 2s、compute-bounded 5s，且隔离档一律零能力', () => {
    expect(DEFAULT_TIER_SPECS['query-only'].timeoutMs).toBe(2_000)
    expect(DEFAULT_TIER_SPECS['compute-bounded'].timeoutMs).toBe(5_000)
    expect(DEFAULT_TIER_SPECS['query-only'].capabilities).toEqual([])
    expect(DEFAULT_TIER_SPECS['compute-bounded'].capabilities).toEqual([])
    // `none` 是唯一的"不经隔离"档：它才带能力位，也正因此模型代码禁入
    expect(DEFAULT_TIER_SPECS.none.capabilities).toEqual([
      'network',
      'filesystem',
      'process',
      'external-io',
    ])
  })
})

describe('默认档解析', () => {
  it('声明过档位用声明值，未声明走 fallbackTier（缺省最严 query-only）', () => {
    const policy = makePolicy()
    expect(policy.baseTierOf('analysis_calc')).toBe('compute-bounded')
    expect(policy.baseTierOf('unknown_tool')).toBe('query-only')
    const withFallback = new SandboxPolicy({ fallbackTier: 'compute-bounded', now: clock() })
    expect(withFallback.baseTierOf('unknown_tool')).toBe('compute-bounded')
  })

  it('解析结论带生效限制与调用来源（审计面板要能回放"为什么是这一档"）', () => {
    const policy = makePolicy()
    const decision = policy.resolve({ tool: 'analysis_calc', codeSource: 'model' }, 's-1')
    expect(decision).toEqual({
      tool: 'analysis_calc',
      tier: 'compute-bounded',
      limits: DEFAULT_TIER_SPECS['compute-bounded'],
      codeSource: 'model',
    })
  })

  it('构造期档位缺规格即抛（不等到判决时才炸）', () => {
    const partial = { 'query-only': DEFAULT_TIER_SPECS['query-only'] } as Record<
      SandboxTier,
      TierSpec
    >
    expect(
      () =>
        new SandboxPolicy({
          defaults: { analysis_calc: 'compute-bounded' },
          specs: partial,
          now: clock(),
        }),
    ).toThrow(/档位 compute-bounded 没有规格/)
  })

  it('解析到无规格档位即抛 tier-unknown', () => {
    const policy = makePolicy()
    const broken = { 'query-only': DEFAULT_TIER_SPECS['query-only'] } as Record<
      SandboxTier,
      TierSpec
    >
    // 绕过构造期校验：直接改写内部规格表（模拟装配后被破坏的极端情形）
    const specsOf = policy as unknown as { specs: Record<SandboxTier, TierSpec> }
    specsOf.specs = broken
    const error = captureError(() =>
      policy.resolve({ tool: 'analysis_calc', codeSource: 'model' }, 's-1'),
    )
    expect(error.code).toBe('tier-unknown')
    expect(error.message).toBe('bah-sandbox: 档位 compute-bounded 没有规格')
  })
})

describe('T-SBX-006 模型代码禁入 none（硬规则）', () => {
  it('默认档解析到 none 即抛 bah-sandbox: model-code-to-none', () => {
    const policy = makePolicy({ defaults: { analysis_calc: 'none' } })
    const error = captureError(() =>
      policy.resolve({ tool: 'analysis_calc', codeSource: 'model' }, 's-1'),
    )
    expect(error).toBeInstanceOf(BahError)
    expect(error.code).toBe('model-code-to-none')
    expect(error.message).toBe('bah-sandbox: 模型生成的代码禁止进入 none 档（工具 analysis_calc）')
  })

  it('显式批准也买不到 none：批准档直接抛 grant-tier-invalid', () => {
    const policy = makePolicy()
    const error = captureError(() => policy.grant('s-1', 'fp-1', 'none', 60_000))
    expect(error.code).toBe('grant-tier-invalid')
    expect(error.message).toBe('bah-sandbox: 显式批准不得放宽到 none 档')
  })

  it('经批准放宽到 compute-bounded 仍允许（模型代码的上限就是它）', () => {
    const policy = makePolicy({ defaults: { analysis_calc: 'query-only' } })
    policy.grant('s-1', 'fp-1', 'compute-bounded', 60_000)
    const decision = policy.resolve(
      { tool: 'analysis_calc', codeSource: 'model', fingerprint: 'fp-1' },
      's-1',
    )
    expect(decision.tier).toBe('compute-bounded')
    expect(decision.granted).toBe('compute-bounded')
  })

  it('受信任调用可以走 none（none 档是给 mock 银行核心这类仓内代码的）', () => {
    const policy = makePolicy({ defaults: { analysis_calc: 'none' } })
    const decision = policy.resolve({ tool: 'analysis_calc', codeSource: 'trusted' }, 's-1')
    expect(decision.tier).toBe('none')
  })
})

describe('T-SBX-007 会话 override 只能收紧', () => {
  it('放宽即拒绝（override-widens），解析时同样拒绝（防绕过）', () => {
    const policy = makePolicy()
    expect(captureError(() => policy.override('s-1', 'analysis_calc', 'none', '想放宽')).code).toBe(
      'override-widens',
    )
    // 直接塞进内部状态再解析：解析口必须独立拦下
    const sessions = (
      policy as unknown as { sessions: Map<string, { overrides: Map<string, unknown> }> }
    ).sessions
    sessions.set('s-1', {
      overrides: new Map([['analysis_calc', { tier: 'none', reason: '伪造放宽' }]]),
    })
    const error = captureError(() =>
      policy.resolve({ tool: 'analysis_calc', codeSource: 'trusted' }, 's-1'),
    )
    expect(error.code).toBe('override-widens')
    expect(error.message).toBe('bah-sandbox: 会话 override 不能放宽档位：analysis_calc 默认 compute-bounded，override none')
  })

  it('收紧生效并在结论里标出 narrowed', () => {
    const policy = makePolicy()
    policy.override('s-1', 'analysis_calc', 'query-only', '本会话只允许只读计算')
    const decision = policy.resolve({ tool: 'analysis_calc', codeSource: 'model' }, 's-1')
    expect(decision.tier).toBe('query-only')
    expect(decision.narrowed).toBe('query-only')
    expect(decision.granted).toBeUndefined()
  })

  it('同档 override 是幂等的（不算收紧也不算放宽）', () => {
    const policy = makePolicy()
    policy.override('s-1', 'analysis_calc', 'compute-bounded', '重申')
    const decision = policy.resolve({ tool: 'analysis_calc', codeSource: 'model' }, 's-1')
    expect(decision.tier).toBe('compute-bounded')
    expect(decision.narrowed).toBeUndefined()
  })

  it('取消 override 后回到默认档', () => {
    const policy = makePolicy()
    policy.override('s-1', 'analysis_calc', 'query-only', '收紧')
    policy.clearOverride('s-1', 'analysis_calc')
    expect(policy.resolve({ tool: 'analysis_calc', codeSource: 'model' }, 's-1').tier).toBe(
      'compute-bounded',
    )
  })

  it('viewOf 报当前生效档位（未建状态的会话也能安全查看）', () => {
    const policy = makePolicy()
    expect(policy.viewOf('空会话').analysis_calc).toBe('compute-bounded')
    policy.override('s-1', 'analysis_calc', 'query-only', '收紧')
    expect(policy.viewOf('s-1')).toEqual({ analysis_calc: 'query-only', bill_analyze: 'query-only' })
  })

  it('release 清掉会话状态（dispose 路径）', () => {
    const policy = makePolicy()
    policy.override('s-1', 'analysis_calc', 'query-only', '收紧')
    policy.release('s-1')
    expect(policy.resolve({ tool: 'analysis_calc', codeSource: 'model' }, 's-1').tier).toBe(
      'compute-bounded',
    )
    // 再 release 一次不报错（幂等）
    policy.release('s-1')
  })
})

describe('显式批准档（一次性 + 时效）', () => {
  it('批准只对那一个指纹有效，且消费一次即失效', () => {
    const policy = makePolicy({ defaults: { analysis_calc: 'query-only' } })
    policy.grant('s-1', 'fp-1', 'compute-bounded', 60_000)
    const first = policy.resolve(
      { tool: 'analysis_calc', codeSource: 'model', fingerprint: 'fp-1' },
      's-1',
    )
    expect(first.tier).toBe('compute-bounded')
    // 第二次同指纹：批准已被消费，回到默认档
    const second = policy.resolve(
      { tool: 'analysis_calc', codeSource: 'model', fingerprint: 'fp-1' },
      's-1',
    )
    expect(second.tier).toBe('query-only')
    expect(second.granted).toBeUndefined()
  })

  it('过期批准不生效，并被清扫（批准表不无界增长）', () => {
    const timer = mutableClock()
    const policy = new SandboxPolicy({
      defaults: { analysis_calc: 'query-only' },
      now: timer.now,
    })
    policy.grant('s-1', 'fp-1', 'compute-bounded', 1)
    timer.advance(2)
    expect(
      policy.resolve({ tool: 'analysis_calc', codeSource: 'model', fingerprint: 'fp-1' }, 's-1').tier,
    ).toBe('query-only')
    const grantsOf = (): unknown[] =>
      (
        policy as unknown as { sessions: Map<string, { grants: unknown[] }> }
      ).sessions.get('s-1')?.grants ?? []
    // 过期条目在解析时即清扫
    expect(grantsOf()).toEqual([])
    // 未过期但指纹不匹配的批准保留，命中的那条消费掉
    policy.grant('s-1', 'fp-other', 'compute-bounded', 60_000)
    policy.grant('s-1', 'fp-2', 'compute-bounded', 60_000)
    expect(
      policy.resolve({ tool: 'analysis_calc', codeSource: 'model', fingerprint: 'fp-2' }, 's-1').tier,
    ).toBe('compute-bounded')
    expect(grantsOf()).toEqual([{ fingerprint: 'fp-other', tier: 'compute-bounded', expiresAt: 1_060_002 }])
  })

  it('会话不存在时批准匹配不报错（无状态即无批准）', () => {
    const policy = makePolicy({ defaults: { analysis_calc: 'query-only' } })
    expect(
      policy.resolve({ tool: 'analysis_calc', codeSource: 'model', fingerprint: 'fp-x' }, '空会话')
        .tier,
    ).toBe('query-only')
  })

  it('没有批准记录或不带指纹的调用不受批准影响', () => {
    const policy = makePolicy({ defaults: { analysis_calc: 'query-only' } })
    expect(policy.resolve({ tool: 'analysis_calc', codeSource: 'model' }, '无状态').tier).toBe(
      'query-only',
    )
    policy.grant('s-1', 'fp-1', 'compute-bounded', 60_000)
    // 会话有批准表，但本次调用没给指纹 → 不消费
    expect(policy.resolve({ tool: 'analysis_calc', codeSource: 'model' }, 's-1').tier).toBe(
      'query-only',
    )
  })

  it('override 与批准同时存在时，override 的收紧仍然优先', () => {
    const policy = makePolicy()
    policy.override('s-1', 'analysis_calc', 'query-only', '收紧')
    policy.grant('s-1', 'fp-1', 'compute-bounded', 60_000)
    // current = query-only（已收紧），批准可放宽到 compute-bounded 是"人签过"的例外
    const decision = policy.resolve(
      { tool: 'analysis_calc', codeSource: 'model', fingerprint: 'fp-1' },
      's-1',
    )
    expect(decision.tier).toBe('compute-bounded')
    expect(decision.narrowed).toBe('query-only')
    expect(decision.granted).toBe('compute-bounded')
  })
})

describe('缺省装配：不注入时钟与档位表时的兜底', () => {
  // 生产装配（Config 未写 `sandbox.clock` / `sandbox.specs`）走的就是这条路径。
  // 单测此前一律注入固定钟，导致 `now ?? (() => Date.now())` 的默认分支从未被执行——
  // 而它恰恰是真实部署里唯一会生效的那一支。
  it('无参构造可用：兜底档 query-only，时钟退化为 Date.now()', () => {
    const policy = new SandboxPolicy()
    expect(policy.baseTierOf('未声明的工具')).toBe('query-only')

    // 默认档表未声明该工具 → 解析到 query-only，且规格来自 DEFAULT_TIER_SPECS
    const decision = policy.resolve({ tool: '未声明的工具', codeSource: 'trusted' }, 's-default')
    expect(decision.tier).toBe('query-only')
    expect(decision.limits).toEqual(DEFAULT_TIER_SPECS['query-only'])
  })

  it('默认时钟会被批准时效读取（不抛、且立即生效）', () => {
    const policy = new SandboxPolicy({ defaults: { analysis_calc: 'query-only' } })
    // grant 内部用 this.now() 计算 expiresAt：默认箭头必须在这里被真正调用
    expect(() => policy.grant('s-default', 'fp-default', 'compute-bounded', 60_000)).not.toThrow()

    const decision = policy.resolve(
      { tool: 'analysis_calc', codeSource: 'model', fingerprint: 'fp-default' },
      's-default',
    )
    expect(decision.tier).toBe('compute-bounded')
    expect(decision.granted).toBe('compute-bounded')
  })
})
