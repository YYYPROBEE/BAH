/**
 * 银行工具族的测试夹具（**只服务单测**，不从包入口导出，不进发布面）。
 *
 * 两个 harness：
 * - `createBankHarness`：直接调用 `ToolDefinition.execute`，验证工具体与落账；
 * - `createPipelineHarness`：装真实七段管线 + 治理平面，验证 T-TOOLS-001~004 的
 *   allow / ask / 票据 / 升级链路。
 */

import {
  asSessionId,
  createTestContext,
  fixedClock,
  type TestContext,
} from '@bah/test-support'
import {
  SESSION_SERVICE,
  ToolGuard,
  ToolPipeline,
  ToolRegistry,
  provideSession,
  provideTools,
} from '@bah/runtime'
import type { SessionApi } from '@bah/runtime'
import type { Context, ToolDefinition, ToolExecContext } from '@bah/core'
import type { AnySessionEvent, ToolExecution } from '@bah/runtime'

import type { ForgeTier } from '../forge/index.ts'
import { DEMO_NOW, buildBankDataset } from '../forge/index.ts'
import { MockBankCore, bankIds } from '../core/index.ts'
import { createBankTools } from './catalog.ts'
import type { BankAudit, BankSessionEventMap, BankSessionEventType } from './events.ts'
import { provideBankGovernance } from './governance.ts'
import type { BankToolDeps, BankToolsConfig, ComputeSeam } from './types.ts'
import { VerifyService, createMockVerifyProvider } from '../verify/index.ts'

/** 落账记录（测试断言用）。 */
export interface AuditRecord {
  readonly type: BankSessionEventType
  readonly data: unknown
}

/** 默认配置（测试与 host 默认一致）。 */
export const TEST_CONFIG: BankToolsConfig = {
  disclaimerId: 'wealth-risk-v1',
  computeTimeoutMs: 5_000,
  ticketTtlSeconds: 120,
  redChallenge: 'sms',
}

/** 直接调用工具的 harness。 */
export interface BankHarness {
  readonly deps: BankToolDeps
  readonly core: MockBankCore
  readonly verify: VerifyService
  readonly tools: ReadonlyMap<string, ToolDefinition<any, any>>
  readonly audits: AuditRecord[]
  readonly ctx: ToolExecContext
  call(name: string, args?: Readonly<Record<string, unknown>>, callId?: string): Promise<unknown>
  auditsOf<K extends BankSessionEventType>(type: K): BankSessionEventMap[K][]
}

/** 造依赖（两个 harness 共用）。 */
export function createDeps(options: {
  readonly now: () => number
  /** `null` = 未绑定身份（测 `no-identity`）；缺省 = demo 用户 `u-1`。 */
  readonly userId?: string | null
  readonly tier?: ForgeTier
  readonly seed?: number
  readonly config?: Partial<BankToolsConfig>
  readonly audits: AuditRecord[]
  readonly verify?: VerifyService
  readonly core?: MockBankCore
  readonly compute?: ComputeSeam
}): { deps: BankToolDeps; core: MockBankCore; verify: VerifyService } {
  const dataset = buildBankDataset({
    seed: options.seed ?? 7,
    tier: options.tier ?? 'demo',
    now: DEMO_NOW,
  })
  const core = options.core ?? new MockBankCore({ data: dataset, now: options.now })
  const verify =
    options.verify ??
    new VerifyService({ provider: createMockVerifyProvider(), now: options.now })
  const audit: BankAudit = {
    append: (type, data) => {
      options.audits.push({ type, data })
    },
  }
  const userId = options.userId === null ? undefined : (options.userId ?? 'u-1')
  const deps: BankToolDeps = {
    core,
    tickets: core.tickets,
    audit,
    identity: { resolve: () => userId },
    verify,
    config: { ...TEST_CONFIG, ...options.config },
    now: options.now,
    ...(options.compute === undefined ? {} : { compute: options.compute }),
  }
  return { deps, core, verify }
}

/** 建一个直接调用工具的 harness。 */
export function createBankHarness(options: {
  readonly userId?: string | null
  readonly tier?: ForgeTier
  readonly seed?: number
  readonly config?: Partial<BankToolsConfig>
  readonly compute?: ComputeSeam
  readonly verify?: VerifyService
} = {}): BankHarness {
  const clock = fixedClock({ start: DEMO_NOW, step: 1 })
  const audits: AuditRecord[] = []
  const { deps, core, verify } = createDeps({ ...options, now: clock.now, audits })
  const tools = new Map(createBankTools(deps).map((tool) => [tool.name, tool]))
  const ctx: ToolExecContext = {
    sessionId: asSessionId('s-bank'),
    callId: 'c-direct',
    signal: new AbortController().signal,
  }
  return {
    deps,
    core,
    verify,
    tools,
    audits,
    ctx,
    async call(name, args = {}, callId = 'c-direct') {
      const tool = tools.get(name)
      if (tool === undefined) throw new Error(`测试里没有工具 ${name}`)
      return tool.execute(args, { ...ctx, callId })
    },
    auditsOf<K extends BankSessionEventType>(type: K) {
      return audits
        .filter((record) => record.type === type)
        .map((record) => record.data as BankSessionEventMap[K])
    },
  }
}

/** 装真实七段管线的 harness（T-TOOLS-001~004）。 */
export interface PipelineHarness {
  readonly test: TestContext
  readonly ctx: Context
  readonly session: SessionApi
  readonly deps: BankToolDeps
  readonly core: MockBankCore
  readonly audits: AuditRecord[]
  readonly pipeline: ToolPipeline
  readonly events: () => readonly AnySessionEvent[]
  run(name: string, args?: Readonly<Record<string, unknown>>): Promise<ToolExecution>
  dispose(): Promise<void>
}

/** 建一个带会话 / 工具注册表 / 管线的测试上下文，并装上治理平面。 */
export function createPipelineHarness(options: {
  readonly userId?: string | null
  readonly approval?: 'allowed-once' | 'rejected' | 'unavailable'
  readonly tier?: ForgeTier
  readonly verify?: VerifyService
} = {}): PipelineHarness {
  const test = createTestContext()
  const sessionId = asSessionId('s-bank-pipe')
  const clock = fixedClock({ start: DEMO_NOW, step: 10 })
  provideSession(test.ctx, { sessionId, now: clock.now })
  const session = test.ctx.get(SESSION_SERVICE)
  const registry = new ToolRegistry()
  provideTools(test.ctx, registry)

  const audits: AuditRecord[] = []
  const { deps, core } = createDeps({ ...options, now: clock.now, audits })
  for (const tool of createBankTools(deps)) registry.register(tool)
  provideBankGovernance({ ctx: test.ctx, sessionId, deps })

  if (options.approval !== undefined) {
    const decision = options.approval
    test.ctx.events.on('approval/request', (payload) => {
      const input = payload as { decision: { decision: string } }
      return { ...input, decision: { decision } }
    })
  }

  const pipeline = new ToolPipeline({
    ctx: test.ctx,
    registry,
    session,
    guard: new ToolGuard(),
    sessionId,
    now: clock.now,
  })
  let sequence = 0
  return {
    test,
    ctx: test.ctx,
    session,
    deps,
    core,
    audits,
    pipeline,
    events: () => session.events(),
    async run(name, args = {}) {
      sequence += 1
      return pipeline.execute({ callId: `c-${sequence}`, name, args })
    },
    dispose: () => test.dispose(),
  }
}

/** 当前用户名下的主账户 ID（测试里少写一次 listAccounts）。 */
export async function primaryAccountId(core: MockBankCore): Promise<string> {
  const accounts = await core.listAccounts(bankIds.user('u-1'))
  const current = accounts.find((account) => account.type === 'current') ?? accounts[0]
  if (current === undefined) throw new Error('demo 数据没有账户')
  return current.id
}
