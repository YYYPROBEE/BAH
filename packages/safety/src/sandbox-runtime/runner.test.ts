/**
 * 沙箱运行时冒烟用例（先验证 worker 架构本身：加载、硬杀、能力拒绝）。
 */

import { describe, expect, it } from 'vitest'

import { SandboxPolicy } from '../sandbox-policy/policy.ts'
import { DEFAULT_TIER_SPECS } from '../sandbox-policy/tier.ts'
import type { SandboxTier, TierSpec } from '../sandbox-policy/tier.ts'
import { SandboxRegistry } from './registry.ts'
import { SandboxRunner } from './runner.ts'
import type { SandboxAuditRecord } from './runner.ts'

const href = (relative: string): string => new URL(relative, import.meta.url).href

/** 把档位时限压到几十毫秒，超时用例不必真等 2s / 5s。 */
function fastSpecs(overrides: Partial<Record<SandboxTier, Partial<TierSpec>>> = {}): Record<SandboxTier, TierSpec> {
  const tiers: SandboxTier[] = ['query-only', 'compute-bounded', 'none']
  const specs = {} as Record<SandboxTier, TierSpec>
  for (const tier of tiers) {
    specs[tier] = { ...DEFAULT_TIER_SPECS[tier], ...(overrides[tier] ?? {}) }
  }
  return specs
}

function makeRunner(tiers: Partial<Record<SandboxTier, Partial<TierSpec>>> = {}): {
  runner: SandboxRunner
  registry: SandboxRegistry
  records: SandboxAuditRecord[]
} {
  const records: SandboxAuditRecord[] = []
  const registry = new SandboxRegistry()
  const policy = new SandboxPolicy({
    defaults: { analysis_calc: 'compute-bounded', bill_analyze: 'query-only' },
    specs: fastSpecs(tiers),
  })
  const runner = new SandboxRunner({
    policy,
    registry,
    workerUrl: href('./worker.ts'),
    audit: (record) => records.push(record),
  })
  return { runner, registry, records }
}

describe('沙箱 worker 通道', () => {
  it('compute-bounded 里跑通受限表达式', async () => {
    const { runner, registry, records } = makeRunner()
    registry.register({ key: 'compute', capabilities: [], moduleUrl: href('./handlers/compute.ts') })
    const outcome = await runner.run(
      {
        tool: 'analysis_calc',
        handlerKey: 'compute',
        codeSource: 'model',
        payload: { code: 'sum(data.food, data.rent)', data: { food: 120, rent: 3000 }, limits: { timeoutMs: 1_000, maxOperations: 1_000 } },
      },
      's-1',
    )
    expect(outcome.kind).toBe('ok')
    if (outcome.kind !== 'ok') return
    expect(outcome.value).toEqual({ value: 3120, operations: expect.any(Number) })
    expect(outcome.tier).toBe('compute-bounded')
    expect(records.map((record) => record.type)).toEqual(['sandbox/done'])
  })

  it('永不返回的执行体被超时硬杀（T-SBX-001 / T-SBX-003）', async () => {
    const { runner, registry, records } = makeRunner({ 'compute-bounded': { timeoutMs: 120 } })
    registry.register({ key: 'loop', capabilities: [], moduleUrl: href('./testing/loop-fixture.ts') })
    const outcome = await runner.run(
      { tool: 'analysis_calc', handlerKey: 'loop', codeSource: 'model', payload: {} },
      's-1',
    )
    expect(outcome).toEqual({ kind: 'timeout', tier: 'compute-bounded', timeoutMs: 120 })
    expect(records[0]?.type).toBe('sandbox/timeout')
  })

  it('声明了 network 能力的执行体进不了隔离档（T-SBX-005）', async () => {
    const { runner, registry } = makeRunner()
    registry.register({
      key: 'needs-network',
      capabilities: ['network'],
      moduleUrl: href('./testing/network-fixture.ts'),
    })
    const outcome = await runner.run(
      { tool: 'analysis_calc', handlerKey: 'needs-network', codeSource: 'model', payload: {} },
      's-1',
    )
    expect(outcome.kind).toBe('refused')
    if (outcome.kind !== 'refused') return
    expect(outcome.code).toBe('sandbox-capability-denied')
    expect(outcome.reason).toContain('network')
  })

  it('worker 没交回结论就退出 → 判失败（不是"没有结果也算成功"）', async () => {
    const { runner, registry, records } = makeRunner({ 'compute-bounded': { timeoutMs: 5_000 } })
    registry.register({ key: 'idle', capabilities: [], moduleUrl: href('./testing/idle-fixture.ts') })
    const outcome = await runner.run(
      { tool: 'analysis_calc', handlerKey: 'idle', codeSource: 'model', payload: {} },
      's-1',
    )
    expect(outcome.kind).toBe('error')
    if (outcome.kind !== 'error') return
    expect(outcome.code).toBe('sandbox-worker-exit')
    expect(records[0]?.type).toBe('sandbox/error')
    expect(records[0]?.data.reason).toBe(outcome.message)
  })

  it('投影数据是克隆进去的：执行体改写不影响主进程（T-SBX-008）', async () => {
    const { runner, registry } = makeRunner()
    registry.register({ key: 'mutate', capabilities: [], moduleUrl: href('./testing/mutate-fixture.ts') })
    const data = { probe: 1 }
    const outcome = await runner.run(
      { tool: 'analysis_calc', handlerKey: 'mutate', codeSource: 'model', payload: { data } },
      's-1',
    )
    expect(outcome.kind).toBe('ok')
    if (outcome.kind !== 'ok') return
    expect(outcome.value).toBe(999)
    expect(data).toEqual({ probe: 1 })
  })

  it('未登记的执行体一律拒绝（沙箱不知道能跑什么，登记表说了算）', async () => {
    const { runner } = makeRunner()
    const outcome = await runner.run(
      { tool: 'analysis_calc', handlerKey: 'nope', codeSource: 'model', payload: {} },
      's-1',
    )
    expect(outcome.kind).toBe('refused')
    if (outcome.kind !== 'refused') return
    expect(outcome.code).toBe('sandbox-handler-missing')
  })

  it('载荷超档位预算时连 worker 都不起（T-SBX-005 的预算侧）', async () => {
    const { runner, registry } = makeRunner({ 'compute-bounded': { maxPayloadBytes: 32 } })
    registry.register({ key: 'compute', capabilities: [], moduleUrl: href('./handlers/compute.ts') })
    const outcome = await runner.run(
      {
        tool: 'analysis_calc',
        handlerKey: 'compute',
        codeSource: 'model',
        payload: { code: '1+1', data: { blob: 'x'.repeat(200) }, limits: { timeoutMs: 1_000, maxOperations: 8 } },
      },
      's-1',
    )
    expect(outcome.kind).toBe('refused')
    if (outcome.kind !== 'refused') return
    expect(outcome.code).toBe('sandbox-payload-too-large')
  })

  it('不可序列化的载荷直接拒（循环引用不该拖垮 worker 派发）', async () => {
    const { runner, registry } = makeRunner()
    registry.register({ key: 'compute', capabilities: [], moduleUrl: href('./handlers/compute.ts') })
    const circular: Record<string, unknown> = {}
    circular['self'] = circular
    const outcome = await runner.run(
      { tool: 'analysis_calc', handlerKey: 'compute', codeSource: 'model', payload: circular },
      's-1',
    )
    expect(outcome.kind).toBe('refused')
    if (outcome.kind !== 'refused') return
    expect(outcome.code).toBe('sandbox-payload-unserializable')
  })

  it('none 档进程内直调（受信任代码；模型代码买不到这一档）', async () => {
    const { runner, registry, records } = makeRunner()
    registry.register({ key: 'compute', capabilities: [], moduleUrl: href('./handlers/compute.ts') })
    const outcome = await runner.run(
      {
        tool: 'internal_compute',
        handlerKey: 'compute',
        codeSource: 'trusted',
        payload: { code: 'round(data.x / data.y)', data: { x: 10, y: 4 }, limits: { timeoutMs: 1_000, maxOperations: 64 } },
      },
      's-1',
    )
    // internal_compute 未声明档位 → 走 fallback（query-only），因此仍是 worker 通道
    expect(outcome.kind).toBe('ok')
    if (outcome.kind !== 'ok') return
    expect(outcome.value).toEqual({ value: 3, operations: expect.any(Number) })
    expect(records[0]?.data.tier).toBe('query-only')

    // 显式把受信任工具配到 none：进程内直调，结果一致
    const trusted = new SandboxRunner({
      policy: new SandboxPolicy({
        defaults: { internal_compute: 'none' },
        specs: fastSpecs(),
      }),
      registry,
      workerUrl: href('./worker.ts'),
    })
    const inProcess = await trusted.run(
      {
        tool: 'internal_compute',
        handlerKey: 'compute',
        codeSource: 'trusted',
        payload: { code: 'abs(0 - data.n)', data: { n: 7 }, limits: { timeoutMs: 1_000, maxOperations: 64 } },
      },
      's-2',
    )
    expect(inProcess).toEqual({ kind: 'ok', value: { value: 7, operations: expect.any(Number) }, tier: 'none', elapsedMs: expect.any(Number) })
  })

  it('执行体模块形状不符 → 结构化加载失败（不静默降级）', async () => {
    const { runner, registry } = makeRunner()
    registry.register({ key: 'compute', capabilities: [], moduleUrl: href('./testing/not-a-handler.fixture.ts') })
    const outcome = await runner.run(
      { tool: 'analysis_calc', handlerKey: 'compute', codeSource: 'model', payload: { code: '1' } },
      's-1',
    )
    expect(outcome.kind).toBe('error')
    if (outcome.kind !== 'error') return
    expect(outcome.code).toBe('sandbox-handler-load-failed')
    expect(outcome.message).toContain('SANDBOX_HANDLER')
  })

  it('载荷形状不符 → 执行体抛程序错误，转成结构化错误（不冒泡）', async () => {
    const { runner, registry } = makeRunner()
    registry.register({ key: 'compute', capabilities: [], moduleUrl: href('./handlers/compute.ts') })
    const outcome = await runner.run(
      { tool: 'analysis_calc', handlerKey: 'compute', codeSource: 'model', payload: { nope: 1 } },
      's-1',
    )
    expect(outcome.kind).toBe('error')
    if (outcome.kind !== 'error') return
    expect(outcome.code).toBe('program-invalid')
    expect(outcome.message).toBe('计算载荷缺少字符串 code')
  })
})
