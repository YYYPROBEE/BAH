/**
 * 告警总线与 SLO 聚合的缺口用例（`alert/index.ts`）。
 *
 * 缺口来源：`alert/index.ts` 不在逐文件 100% 名单里（名单只钉 `alert/sink.ts` 与
 * `alert/sink.ts` 的扇出契约），2026-10-31 缺口扫描实测以下四条判决路径**零覆盖**：
 *
 * 1. `fanout` 里 sink 自身抛错——「单 sink 失败不得阻断后续」这条纪律在真正的
 *    出口（webhook 消费的是本文件的 `registerAlertSink`）上没有任何用例；
 * 2. `compFailureRate` 的补偿聚合循环——既有测试从不建补偿行，资金域第一指标
 *    恒等于 `0/0`，把 DLQ/ERR/UNKNOWN 数错也不会红；
 * 3. `p95` 的分位下标与 `ratio` 的「无数据 ≠ 0」；
 * 4. 审计面**不可用**与链**确实断裂**的分开计数。
 *
 * 时钟手推、sqlite 用 `:memory:`、告警只断言进程内 sink：无定时器、无外部调用。
 */

import { createContext } from '@bah/core'
import { createSagaStore } from '@bah/persistence'
import { afterEach, describe, expect, it } from 'vitest'

import {
  alertChainVerifyErrorCount,
  alertSinkErrorCount,
  alertSoft,
  checkChainHealth,
  collectSloMetrics,
  heartbeat,
  page,
  provideAlertBus,
  registerAlertSink,
} from './index.ts'
import { SAGA_AUDIT, SAGA_CLOCK, SAGA_STORE } from '../seams.ts'
import { parseSagaSettings } from '../settings.ts'

import type { Context, Disposer } from '@bah/core'
import type { SagaAudit } from '../seams.ts'
import type { SagaSettings, CompTemplate, CompState, SagaStep, SagaTransaction } from '../types.ts'
import type { AlertEvent } from './index.ts'

/** 固定基准时刻（不读系统时钟：同输入同输出）。 */
const BASE = 1_700_000_000_000

/** 一天的毫秒数（recon 心跳按天换算）。 */
const DAY_MS = 86_400_000

const closers: Array<{ close(): void }> = []

afterEach(() => {
  for (const closer of closers.splice(0)) closer.close()
})

type StoreHandle = ReturnType<typeof createSagaStore>

interface Harness {
  readonly ctx: Context
  readonly store: StoreHandle
  readonly settings: SagaSettings
}

/** 只桩审计面，其余用真 store：本文件要钉的是**聚合口径**，不是存储实现。 */
function harness(verify: SagaAudit['verify']): Harness {
  const store = createSagaStore({ dbPath: ':memory:', now: () => BASE })
  closers.push(store)
  const ctx = createContext()
  ctx.provide(SAGA_STORE, store)
  ctx.provide(SAGA_CLOCK, { now: () => BASE, sleep: async () => undefined })
  ctx.provide(SAGA_AUDIT, {
    append: () => ({ seqInSaga: 1, recordHash: '' }),
    verify,
    anchor: async () => ({ merkleRoot: '', targets: [] }),
  })
  return { ctx, store, settings: parseSagaSettings({}) }
}

function transaction(sagaId: string, createdAt: number): SagaTransaction {
  return {
    sagaId,
    businessType: 'TRANSFER',
    traceId: `trace-${sagaId}`,
    state: 'RUNNING',
    version: 1,
    timeoutBudgetMs: 60_000,
    compStrategy: 'AUTO',
    initiator: '{}',
    frozen: false,
    createdAt,
    updatedAt: createdAt,
  }
}

const TEMPLATE: CompTemplate = {
  templateId: 'tpl-refund',
  templateVersion: 1,
  targetTool: 'pay.refund',
  compKind: 'FULL_REFUND',
  compEndpoint: '/comp/refund',
  compIdempotent: true,
  residualRules: [],
  approvalRequired: false,
  payloadProjection: '{"fields":[]}',
  status: 'ACTIVE',
}

/** `compensating_action` 有指向 `saga_step` 的外键（PRAGMA foreign_keys=ON），先落步骤再绑定。 */
function step(sagaId: string, stepId: string, seqNo: number): SagaStep {
  return {
    stepId,
    sagaId,
    seqNo,
    topologyDeps: [],
    toolName: 'pay.charge',
    endpoint: '/pay/charge',
    sideEffectClass: 'EXTERNAL_UNDOABLE',
    idempotencyKey: `FWD:${sagaId}:${stepId}`,
    idempotencyNonce: `nonce-${stepId}`,
    state: 'EXECUTED',
    attempts: 1,
    maxAttempts: 3,
    deadlineMs: 5_000,
  }
}

function captureAlerts(): { readonly events: AlertEvent[]; readonly dispose: Disposer } {
  const events: AlertEvent[] = []
  return { events, dispose: registerAlertSink((event) => void events.push(event)) }
}

describe('alert · 出口扇出的失败隔离', () => {
  it('单个 sink 抛错不得阻断其余 sink，且按次计入失败数', () => {
    const seen: string[] = []
    const before = alertSinkErrorCount()
    const disposers: Disposer[] = [
      registerAlertSink((event) => void seen.push(`a:${event.level}`)),
      registerAlertSink(() => {
        throw new Error('webhook 5xx')
      }),
      registerAlertSink((event) => void seen.push(`c:${event.metric ?? '-'}`)),
    ]
    try {
      alertSoft('compFailureRate', '补偿失败率越 soft 阈值')
      page(createContext(), 'P0', '链断裂需人工介入')

      // 顺序即证据：抛错的 sink 既不吞掉后一个，也不让它收不到。
      expect(seen).toEqual(['a:alert', 'c:compFailureRate', 'a:P0', 'c:-'])
      expect(alertSinkErrorCount() - before).toBe(2)

      disposers[1]?.()
      const afterRemoval = alertSinkErrorCount()
      alertSoft('dlqDepth', 'DLQ 深度偏高')
      expect(seen.slice(4)).toEqual(['a:alert', 'c:dlqDepth'])
      expect(alertSinkErrorCount()).toBe(afterRemoval)
    } finally {
      for (const dispose of disposers) dispose()
    }
  })

  it('AlertBus 门面与直调出口走同一条扇出（不存在第二条告警路径）', () => {
    const h = harness(() => ({ ok: true }))
    const bus = provideAlertBus(h.ctx, h.settings)
    const alerts = captureAlerts()
    try {
      bus.alert('residualDiffRate', '残差差异率越阈')
      bus.page(h.ctx, 'P0', '残差账本对不平')
      expect(alerts.events).toEqual([
        { level: 'alert', metric: 'residualDiffRate', detail: '残差差异率越阈' },
        { level: 'P0', detail: '残差账本对不平' },
      ])
    } finally {
      alerts.dispose()
    }
  })
})

describe('alert · SLO 八指标聚合', () => {
  it('补偿失败率只数 DLQ/ERR/UNKNOWN；P95 取 95 分位下标；注入观测按 ratio 出数', () => {
    const h = harness(() => ({ ok: true }))
    h.store.tx((tx) => {
      tx.insertTransaction(transaction('saga-a', BASE - 1_000))
      tx.insertTransaction(transaction('saga-b', BASE - 3_000))
      for (const [index, stepId] of ['st-1', 'st-2', 'st-3', 'st-4'].entries()) {
        tx.insertStep(step('saga-a', stepId, index + 1))
        tx.bindCompensation('saga-a', stepId, TEMPLATE)
      }
      tx.insertStep(step('saga-b', 'st-5', 1))
      tx.bindCompensation('saga-b', 'st-5', TEMPLATE)
      // 再补 18 个非终态 saga：20 个存活时长才能把 95 分位下标与"取最大值"区分开
      for (let index = 1; index <= 18; index += 1) {
        tx.insertTransaction(transaction(`saga-x${String(index)}`, BASE - (3_000 + index * 1_000)))
      }
      const states: readonly CompState[] = ['DLQ', 'ERR', 'UNKNOWN', 'OK']
      tx.listCompensations('saga-a').forEach((row, index) => {
        tx.updateCompensation({ ...row, state: states[index] as CompState })
      })
    })
    heartbeat(h.ctx, 'recon', BASE - 2 * DAY_MS)

    const metrics = collectSloMetrics(h.ctx, h.settings, {
      posNegDiff: 3,
      participatingSagas: 10,
      residualDiff: 1,
      residualTotal: 0,
    })
    expect(metrics.compFailureRate.value).toBe(0.6)
    expect(metrics.compFailureRate.detail).toContain('3/5')
    // 20 个非终态：ceil(20*0.95)-1 = 18 ⇒ 升序第 19 个（20000），不是最大值 21000
    expect(metrics.danglingP95.value).toBe(20_000)
    expect(metrics.danglingP95.detail).toContain('非终态 20 个')
    expect(metrics.reconHeartbeat.value).toBe(2)
    expect(metrics.reconHeartbeat.detail).toContain('2.00')
    expect(metrics.posNegMismatchRate.value).toBe(0.3)
    // 分母 ≤ 0 是「无数据」，不是 0——0 会被看板读成"差异率为零"的健康结论
    expect(metrics.residualDiffRate.value).toBeNull()
    expect(metrics.dlqDepth.value).toBe(0)
    expect(metrics.chainBreak.value).toBe(0)

    const bare = collectSloMetrics(h.ctx, h.settings)
    expect(bare.posNegMismatchRate.value).toBeNull()
    expect(bare.residualDiffRate.value).toBeNull()
    expect(bare.rto.value).toBeNull()
    // 补偿与心跳是存储/心跳读数，与注入观测无关：同一棵树重算必须同值
    expect(bare.compFailureRate.value).toBe(0.6)
    expect(bare.reconHeartbeat.value).toBe(2)
  })

  it('既无补偿又无非终态时，指标退化为 0 与 null 而不是抛错', () => {
    const h = harness(() => ({ ok: true }))
    const metrics = collectSloMetrics(h.ctx, h.settings)
    expect(metrics.compFailureRate.value).toBe(0)
    expect(metrics.danglingP95.value).toBeNull()
    expect(metrics.reconHeartbeat.value).toBeNull()
    expect(metrics.reconHeartbeat.detail).toContain('尚无心跳')
  })
})

describe('alert · 审计面故障分级', () => {
  it('审计服务抛错按「宁高估」计一条断裂，并单独计入 verify 失败数', () => {
    const h = harness(() => {
      throw new Error('audit 服务未就绪')
    })
    const before = alertChainVerifyErrorCount()
    expect(collectSloMetrics(h.ctx, h.settings).chainBreak.value).toBe(1)
    expect(alertChainVerifyErrorCount() - before).toBe(1)

    const alerts = captureAlerts()
    try {
      expect(checkChainHealth(h.ctx, 's-1')).toEqual({ ok: false })
      expect(alerts.events).toHaveLength(1)
      expect(alerts.events[0]).toMatchObject({ level: 'P0' })
      // 分级口径：抛错走 verify-failed 文案，绝不能被消费端读成"链断了"的数据完整性事故。
      expect(alerts.events[0]?.detail).toContain('chain-verify-failed')
      expect(alerts.events[0]?.detail).toContain('audit 服务未就绪')
      expect(alerts.events[0]?.detail).not.toContain('chain-broken')
    } finally {
      alerts.dispose()
    }
  })

  it('全链巡检（不带 sagaId）发现断裂时以 all 定位', () => {
    const h = harness(() => ({ ok: false, brokenAt: 7 }))
    const alerts = captureAlerts()
    try {
      expect(checkChainHealth(h.ctx)).toEqual({ ok: false, brokenAt: 7 })
      expect(alerts.events.at(-1)?.detail).toBe('chain-broken: all at 7')
      // 断裂读数走 verify 的正常返回（不是抛错），因此不进 verify 计数
      const before = alertChainVerifyErrorCount()
      expect(collectSloMetrics(h.ctx, h.settings).chainBreak.value).toBe(1)
      expect(alertChainVerifyErrorCount()).toBe(before)
    } finally {
      alerts.dispose()
    }
  })
})
