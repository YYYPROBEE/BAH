/**
 * 治理平面 × 策略外置（S2 / 02 §2、§14）。
 *
 * 断言只看看得见的东西：`tier/decided` 的版本/规则/证据字段、最终 verdict、
 * 以及"策略永远不能降级/不能拦绿级/不能绕过硬规则"三条不变量。
 *
 * 真实 bundle 的适配在 `packages/host/src/boot/plugins/policy.test.ts` 测；
 * 这里用可控的假引擎测**组合规则**，两处分工不重叠。
 */

import { describe, expect, it } from 'vitest'

import { asSessionId } from '@bah/test-support'
import type { PolicyDecision, PolicyEngine } from '@bah/runtime'

import { createPipelineHarness, TEST_CONFIG } from './testing.ts'
import { VerifyService } from '../verify/index.ts'

const VERSION = 'bank-tier/1.0.0+sha256:0123456789abcdef'

function payloads(
  harness: ReturnType<typeof createPipelineHarness>,
  type: string,
): Record<string, unknown>[] {
  return harness
    .events()
    .filter((event) => event.type === type)
    .map((event) => event.data as Record<string, unknown>)
}

/** `tier/decided` 走 `deps.audit`（BankAudit），不在会话事件里。 */
function auditPayloads(
  harness: ReturnType<typeof createPipelineHarness>,
  type: string,
): Record<string, unknown>[] {
  return harness.audits
    .filter((record) => record.type === type)
    .map((record) => record.data as Record<string, unknown>)
}

/** 一个总是返回给定判决的 bundle 引擎。 */
function engineOf(decision: Partial<PolicyDecision> = {}): PolicyEngine & { calls: number } {
  const engine = {
    calls: 0,
    decide(): PolicyDecision {
      engine.calls += 1
      return {
        verdict: 'allow',
        reason: 'bundle-evaluated',
        level: 'yellow',
        tierReason: 'declared',
        ruleIds: ['TR-003-default'],
        policyVersion: VERSION,
        ...decision,
      }
    },
  }
  return engine
}

const TRANSFER_800 = {
  amount: 800,
  payee: { name: '王建国', phone: '13900002222' },
  remark: '房租',
}

describe('策略外置 S2 · 正常判决', () => {
  it('bundle 引擎的级别/理由/规则/版本进入 audit 与最终 verdict；evidence 去 PII', async () => {
    const engine = engineOf({ level: 'red', tierReason: 'new-payee', ruleIds: ['TR-002-new-payee', 'RC-002-default'] })
    const h = createPipelineHarness({ approval: 'allowed-once', policy: engine, policyEngineMode: 'bundle', activePolicyVersion: VERSION })
    try {
      const execution = await h.run('transfer_create', TRANSFER_800)
      expect(execution.result.isError).toBe(false)

      const decided = auditPayloads(h, 'tier/decided')[0]!
      expect(decided).toMatchObject({
        name: 'transfer_create',
        level: 'red',
        reason: 'new-payee',
        verdict: 'ask',
        engineSource: 'bundle',
        policyVersion: VERSION,
        ruleIds: ['TR-002-new-payee', 'RC-002-default'],
      })
      expect(String(decided['paramsDigest'])).toMatch(/^sha256:[0-9a-f]{64}$/)

      const evidence = decided['evidence'] as { inputDigest: string; input: Record<string, unknown> }
      expect(evidence.inputDigest).toMatch(/^sha256:[0-9a-f]{64}$/)
      // PII 不进来：只有枚举与整数分
      expect(JSON.stringify(evidence.input)).not.toContain('王建国')
      expect(JSON.stringify(evidence.input)).not.toContain('13900002222')
      expect(evidence.input).toMatchObject({
        subject: { userId: 'u-1', sessionId: 's-bank-pipe' },
        action: { name: 'transfer_create', declared: 'yellow' },
        limits: { dailyLimitCents: 100_000 },
        params: { riskyCallThreshold: TEST_CONFIG.riskyCallThreshold },
      })

      // 红级挑战仍然由判定矩阵给出（不是引擎直接决定 challenge）
      const asked = payloads(h, 'approval/asked')
      expect(asked[0]?.['challenge']).toBe(TEST_CONFIG.redChallenge)
    } finally {
      await h.dispose()
    }
  })

  it('legacy 引擎不填新字段：audit 写 legacy / [] / 无 evidence，行为逐字不变', async () => {
    const h = createPipelineHarness({ approval: 'allowed-once' })
    try {
      await h.run('transfer_create', TRANSFER_800)
      const decided = auditPayloads(h, 'tier/decided')[0]!
      expect(decided).toMatchObject({
        level: 'yellow',
        reason: 'declared',
        verdict: 'ask',
        engineSource: 'legacy',
        policyVersion: 'legacy',
        ruleIds: [],
      })
      expect(decided['evidence']).toBeUndefined()
      expect(String(decided['paramsDigest'])).toMatch(/^sha256:[0-9a-f]{64}$/)
    } finally {
      await h.dispose()
    }
  })
})

describe('策略外置 S2 · 组合规则（I2 / I3 / I4）', () => {
  it('策略 allow 不能把已声明的红降级', async () => {
    const engine = engineOf({ level: 'green', tierReason: 'declared' })
    const h = createPipelineHarness({ approval: 'allowed-once', policy: engine, policyEngineMode: 'bundle' })
    try {
      await h.run('card_report_lost', { cardId: 'c-1' })
      const decided = auditPayloads(h, 'tier/decided')[0]!
      // 声明红 + 引擎说绿 → 仍红、仍要挑战
      expect(decided).toMatchObject({ level: 'red', verdict: 'ask' })
      expect(payloads(h, 'approval/asked')[0]?.['challenge']).toBe(TEST_CONFIG.redChallenge)
    } finally {
      await h.dispose()
    }
  })

  it('策略 deny 覆盖 allow：最终 deny，code 取策略码', async () => {
    const engine = engineOf({
      verdict: 'deny',
      reason: '策略拒绝：命中反诈名单',
      code: 'policy-denied',
      level: 'red',
      tierReason: 'new-payee',
      ruleIds: ['TR-009-deny'],
    })
    const h = createPipelineHarness({ approval: 'allowed-once', policy: engine, policyEngineMode: 'bundle' })
    try {
      const execution = await h.run('transfer_create', TRANSFER_800)
      expect(execution.result.isError).toBe(true)
      expect(execution.result.code).toBe('policy-denied')
      expect(auditPayloads(h, 'tier/decided')[0]).toMatchObject({
        verdict: 'deny',
        code: 'policy-denied',
        engineSource: 'bundle',
      })
    } finally {
      await h.dispose()
    }
  })

  it('绿级读工具不咨询策略：deny-all 引擎也拦不住余额查询', async () => {
    const engine = engineOf({ verdict: 'deny', code: 'policy-denied', reason: '一律拒绝' })
    const h = createPipelineHarness({ policy: engine, policyEngineMode: 'bundle' })
    try {
      const execution = await h.run('account_balance')
      expect(execution.result.isError).toBe(false)
      expect(engine.calls).toBe(0)
      expect(auditPayloads(h, 'tier/decided')[0]).toMatchObject({
        name: 'account_balance',
        level: 'green',
        verdict: 'allow',
        ruleIds: [],
      })
    } finally {
      await h.dispose()
    }
  })

  it('锁定中 + 红：策略 allow 仍然 deny verify-locked（硬不变量在代码）', async () => {
    const verify = new VerifyService({
      provider: { verify: async () => ({ success: false }) },
      maxAttempts: 3,
      lockMs: 30 * 60 * 1000,
      now: () => 1_792_000_000_000,
    })
    const engine = engineOf({ level: 'yellow', tierReason: 'declared' })
    const h = createPipelineHarness({
      approval: 'allowed-once',
      verify,
      policy: engine,
      policyEngineMode: 'bundle',
    })
    try {
      const sessionId = asSessionId('s-bank-pipe')
      const challenge = verify.issue(sessionId, 'sms')
      await verify.submit(sessionId, challenge.id, 'sms')
      await verify.submit(sessionId, challenge.id, 'sms')
      const third = await verify.submit(sessionId, challenge.id, 'sms')
      expect(third.justLocked).toBe(true)

      const execution = await h.run('card_report_lost', { cardId: 'c-1' })
      expect(execution.result.isError).toBe(true)
      expect(execution.result.code).toBe('verify-locked')
      expect(auditPayloads(h, 'tier/decided')[0]).toMatchObject({
        verdict: 'deny',
        code: 'verify-locked',
      })
    } finally {
      await h.dispose()
    }
  })
})

describe('策略外置 S2 · fail-closed（I5）', () => {
  it('引擎抛错 → deny policy-engine-error，且不改写输入', async () => {
    const engine: PolicyEngine = {
      decide() {
        throw new Error('IR 损坏')
      },
    }
    const h = createPipelineHarness({ approval: 'allowed-once', policy: engine, policyEngineMode: 'bundle' })
    try {
      const execution = await h.run('transfer_create', TRANSFER_800)
      expect(execution.result.isError).toBe(true)
      expect(execution.result.code).toBe('policy-engine-error')
      expect(auditPayloads(h, 'tier/decided')[0]).toMatchObject({
        verdict: 'deny',
        code: 'policy-engine-error',
        ruleIds: [],
      })
    } finally {
      await h.dispose()
    }
  })

  it('bundle 模式缺引擎 → deny policy-unavailable（运行期兜底，无隐式 legacy）', async () => {
    const h = createPipelineHarness({ approval: 'allowed-once', policyEngineMode: 'bundle' })
    try {
      const execution = await h.run('transfer_create', TRANSFER_800)
      expect(execution.result.isError).toBe(true)
      expect(execution.result.code).toBe('policy-unavailable')
      expect(auditPayloads(h, 'tier/decided')[0]).toMatchObject({
        verdict: 'deny',
        code: 'policy-unavailable',
      })
    } finally {
      await h.dispose()
    }
  })

  it('引擎返回 level 但缺 ruleIds / 非法理由 / 空版本 → 一律 deny policy-engine-error', async () => {
    const cases: readonly [string, Partial<PolicyDecision>][] = [
      ['缺 ruleIds', { ruleIds: undefined }],
      ['空 ruleIds', { ruleIds: [] }],
      ['非法理由', { tierReason: 'risk' }],
      ['空版本', { policyVersion: ' ' }],
    ]
    for (const [name, patch] of cases) {
      const engine = engineOf(patch)
      const h = createPipelineHarness({ approval: 'allowed-once', policy: engine, policyEngineMode: 'bundle' })
      try {
        const execution = await h.run('transfer_create', TRANSFER_800)
        expect(`${name}: ${execution.result.code}`).toBe(`${name}: policy-engine-error`)
        expect(auditPayloads(h, 'tier/decided')[0]).toMatchObject({
          verdict: 'deny',
          code: 'policy-engine-error',
        })
      } finally {
        await h.dispose()
      }
    }
  })
})

describe('策略外置 S2 · 审计旁路（I17）', () => {
  it('tier/decided 写失败不改判：余额查询仍然成功，只告警', async () => {
    const h = createPipelineHarness()
    const original = h.deps.audit.append
    h.deps.audit.append = ((type: string, data: unknown) => {
      if (type === 'tier/decided') throw new Error('audit sink down')
      original(type as never, data as never)
    }) as typeof h.deps.audit.append
    try {
      const execution = await h.run('account_balance')
      expect(execution.result.isError).toBe(false)
    } finally {
      h.deps.audit.append = original
      await h.dispose()
    }
  })
})
