/**
 * `bank:saga-bridge`：把写工具接进协调器的接线层（配置面 + 行为面）。
 *
 * 行为面的判据不是"没抛错"，而是**协调器真的留下了一笔事务**：
 *   `saga_transaction.state = SUCCEEDED`、两步 `EXECUTED`、`attempts = 1`。
 * 这三条同时成立才说明"预检 → 扣款"确实按拓扑顺序跑过一次，且没有被重试。
 */

import { createHash, generateKeyPairSync } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createContext } from '@bah/core'
import { BANK_COMPENSATION } from '@bah/bank'
import { createSagaStore } from '@bah/persistence'
import {
  AGENTS_SERVICE,
  provideSession,
  provideTools,
  SESSION_SERVICE,
  TOOLS_SERVICE,
  ToolRegistry,
} from '@bah/runtime'
import {
  installIdempotency,
  parseSagaSettings,
  SAGA_AUDIT,
  SAGA_CLOCK,
  SAGA_STORE,
} from '@bah/saga'
import { asSessionId } from '@bah/test-support'
import { BahError } from '@bah/util'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { boot, type BootOptions, type ProfileSummary } from '../boot.ts'
import { createCatalog } from './index.ts'
import { compensationDepsFor, sagaBridgePlugin, SAGA_BRIDGE_RECIPES } from './saga-bridge.ts'

import type { Context } from '@bah/core'
import type { SagaAudit, SideEffectClass } from '@bah/saga'
import type { ToolCallInput } from '@bah/runtime'

import type { Bundle, PluginRow } from '../profile-plugins.ts'
import type { BootedApp } from '../boot.ts'
import type { SagaBridgeSettings } from './saga-bridge.ts'
import { testRunContext } from '../test-run-context.ts'

const PROFILE: ProfileSummary = { name: 'fx-saga', bundles: ['fx-saga'], hmr: false }

/** 一笔演示转账：金额与收款人与 demo 数据一致（800 元走黄级）。 */
const TRANSFER_SCRIPT = [
  {
    tool: {
      id: 'call-t1',
      name: 'transfer_create',
      args: {
        amount: 800,
        payee: { name: '王建国', phone: '13900002222' },
        remark: '房租',
      },
    },
  },
  { text: '已为你在模拟环境完成 800 元转账。' },
  // 第二轮：脚本按 LLM 调用逐条消耗，要跑第二笔转账必须再给一对（tool, text）
  {
    tool: {
      id: 'call-t2',
      name: 'transfer_create',
      args: {
        amount: 800,
        payee: { name: '王建国', phone: '13900002222' },
        remark: '房租',
      },
    },
  },
  { text: '已完成第二笔 800 元转账。' },
]

/** 最小可跑行集：银行工具 + 审批 + saga 三行 + 接线层。 */
function rows(
  bridgeConfig: Readonly<Record<string, unknown>>,
  script: readonly Readonly<Record<string, unknown>>[] = TRANSFER_SCRIPT,
  signingKeyPath?: string,
): readonly PluginRow[] {
  return [
    { id: 'core:session' },
    { id: 'core:tools' },
    { id: 'core:prompt' },
    { id: 'core:model', config: { provider: 'mock', script } },
    { id: 'core:agent', config: { loop: { model: 'mock:mock-chat' } } },
    { id: 'core:persistence', config: { root: 'sessions', fsync: false } },
    { id: 'bank:tools', config: { demoUserId: 'u-1', seed: 7, datasetTier: 'demo' } },
    {
      id: 'interaction:approval',
      config: { responder: 'headless', autoDecision: 'allow', autoVerify: true },
    },
    { id: 'bank:saga-store', config: { dbPath: ':memory:' } },
    { id: 'bank:saga' },
    {
      id: 'bank:saga-audit',
      // W12：补偿事件（saga/comp-issued / comp-result）在签名白名单里，没有私钥会
      // commit-failed。生产靠部署注入；测试生成一次性临时钥匙（不进仓库）。
      ...(signingKeyPath === undefined ? {} : { config: { signingKeyPath } }),
    },
    { id: 'bank:saga-bridge', config: bridgeConfig },
  ]
}

/** 起一个应用（落盘目录临时、dispose 后清理）。 */
async function bootWith(
  bridgeConfig: Readonly<Record<string, unknown>>,
  script: readonly Readonly<Record<string, unknown>>[] = TRANSFER_SCRIPT,
): Promise<{ readonly app: BootedApp; readonly cleanup: () => void }> {
  const dir = mkdtempSync(join(tmpdir(), 'bah-saga-bridge-'))
  const signingKeyPath = join(dir, 'saga-ed25519.pem')
  writeFileSync(
    signingKeyPath,
    generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }),
    { mode: 0o600 },
  )
  const bundle: Bundle = { name: 'fx-saga', rows: rows(bridgeConfig, script, signingKeyPath) }
  const options: BootOptions = {
    profile: PROFILE,
    bundles: [bundle],
    layers: [],
    catalog: createCatalog(),
    run: testRunContext({ sessionId: asSessionId('s-saga-bridge'), now: () => 1_000, jsonlDir: dir }),
  }
  const app = await boot(options)
  return {
    app,
    cleanup: () => {
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

describe('bank:saga-bridge 配置校验', () => {
  it('默认启用、默认只接管 transfer_create、默认不发射 tick', () => {
    const settings = sagaBridgePlugin.validate({})
    expect(settings.enabled).toBe(true)
    expect(settings.eligible).toEqual(['transfer_create'])
    expect(settings.tickIntervalMs).toBe(0)
    // 协调器设置走同一个解析面：不写 maxAttempts 就是库默认 3
    expect(settings.saga.maxAttempts).toBe(3)
  })

  it('写了没有配方的工具名 → 启动即失败（不静默降级成直通）', () => {
    expect(() => sagaBridgePlugin.validate({ eligible: ['wealth_purchase'] })).toThrow(
      /没有编排配方/,
    )
  })

  it('未知配置键 fail-loud', () => {
    expect(() => sagaBridgePlugin.validate({ eligible: ['transfer_create'], extra: 1 })).toThrow(
      /extra/,
    )
  })

  it('W12 补偿开关：默认注入、可显式关闭、嵌套未知键 fail-loud', () => {
    expect(sagaBridgePlugin.validate({}).compensation).toEqual({ enabled: true })
    expect(
      sagaBridgePlugin.validate({ compensation: { enabled: false } }).compensation,
    ).toEqual({ enabled: false })
    expect(() => sagaBridgePlugin.validate({ compensation: { enabled: 'yes' } })).toThrow(
      /enabled/,
    )
    expect(() =>
      sagaBridgePlugin.validate({ compensation: { enabled: true, extra: 1 } }),
    ).toThrow(/extra/)
  })

  it('saga 段的非法值也会被解析面拦下', () => {
    expect(() => sagaBridgePlugin.validate({ saga: { maxAttempts: 0 } })).toThrow(/maxAttempts/)
  })
})

describe('bank:saga-bridge 行为：写工具真的走进协调器', () => {
  it('一笔转账留下一笔 SUCCEEDED 事务，两步各执行一次', async () => {
    const { app, cleanup } = await bootWith({
      enabled: true,
      eligible: ['transfer_create'],
      // 安全约束：幂等键没传给核心，重试就是多扣钱
      saga: { maxAttempts: 1 },
    })
    try {
      const agent = app.ctx.get(AGENTS_SERVICE).list()[0]
      agent!.send('给王建国转 800 元房租')
      await agent!.run()

      const store = app.ctx.get(SAGA_STORE)
      const sagas = store.listAllSagas()
      expect(sagas).toHaveLength(1)

      const [saga] = sagas
      expect(saga!.state).toBe('SUCCEEDED')
      expect(saga!.businessType).toBe('TRANSFER_CREATE')

      const steps = store.listSteps(saga!.sagaId)
      // `step_id` 是全局主键（不是 `(saga_id, step_id)` 复合键），所以断言不绑死字面量：
      // 绑死了就测不出"第二次运行撞键"这种只在重复执行时才现形的缺陷。
      expect(steps.map((step) => [step.toolName, step.state, step.attempts])).toEqual([
        ['transfer_preview', 'EXECUTED', 1],
        ['transfer_create', 'EXECUTED', 1],
      ])
      expect(new Set(steps.map((step) => step.stepId)).size).toBe(2)
      // 拓扑依赖必须落库：DAG 不是画出来的，是 `topology_deps` 里的事实
      expect(steps[1]!.topologyDeps).toEqual([steps[0]!.stepId])
    } finally {
      await app.dispose('test-done')
      cleanup()
    }
  })

  /**
   * 回归：同一库连跑两笔转账不得撞键。
   *
   * `saga_step.step_id` 是全局主键，早期实现用固定名（`preview` / `execute`），
   * 第一笔成功、第二笔报 `UNIQUE constraint failed` —— 而单笔用例永远是绿的。
   * 这个用例存在的唯一理由就是不让人把固定名写回去。
   */
  it('连续两笔转账：两次都成功，step_id 不撞键', async () => {
    const { app, cleanup } = await bootWith({
      enabled: true,
      eligible: ['transfer_create'],
      saga: { maxAttempts: 1 },
    })
    try {
      const agent = app.ctx.get(AGENTS_SERVICE).list()[0]!
      for (const turn of ['第一笔', '第二笔'] as const) {
        agent.send(`给王建国转 800 元${turn}`)
        await agent.run()
      }

      const store = app.ctx.get(SAGA_STORE)
      const sagas = store.listAllSagas()
      expect(sagas).toHaveLength(2)
      for (const saga of sagas) {
        expect(saga.state).toBe('SUCCEEDED')
        const steps = store.listSteps(saga.sagaId)
        expect(steps).toHaveLength(2)
        expect(steps.every((step) => step.state === 'EXECUTED')).toBe(true)
      }
    } finally {
      await app.dispose('test-done')
      cleanup()
    }
  })

  it('关掉开关即退回原路径：不产生任何事务', async () => {
    const { app, cleanup } = await bootWith({
      enabled: false,
      eligible: ['transfer_create'],
      saga: { maxAttempts: 1 },
    })
    try {
      const agent = app.ctx.get(AGENTS_SERVICE).list()[0]
      agent!.send('给王建国转 800 元房租')
      await agent!.run()
      expect(app.ctx.get(SAGA_STORE).listAllSagas()).toHaveLength(0)
    } finally {
      await app.dispose('test-done')
      cleanup()
    }
  })
})

/* ════════════════════════════════════════════════════════════════════════════
 * 单元面：接线层的错误码与副作用。
 *
 * 为什么另起最小 ctx 夹具（而不是继续用上面的全量 boot）：这些分支要么需要
 * "没有配方的 eligible 工具"（validate 的 fail-loud 在真配置里根本配不出来），
 * 要么需要工具体抛特定形状的错误 / 定时器到点——全量 mock 宿主反而会把
 * "错误码从哪来"淹在管线噪音里。这里复用 `@bah/saga` 测试同款真实协调器栈
 * （:memory: store + 真幂等 + 确定性时钟），只把工具面与会话面换成替身。
 * ════════════════════════════════════════════════════════════════════════════ */

/** 与生产 `StepSpec` 同形的本地夹具类型（配方表就是 `SAGA_BRIDGE_RECIPES` 本体，回查靠结构对齐）。 */
interface UnitStep {
  readonly stepId: string
  readonly toolName: string
  readonly sideEffectClass: SideEffectClass
  readonly deps: readonly string[]
  readonly args: Readonly<Record<string, unknown>>
}

const recipeTable = SAGA_BRIDGE_RECIPES as unknown as Record<
  string,
  (call: ToolCallInput) => readonly UnitStep[]
>

const fakeRecipeNames: string[] = []

/** 登记一段测试专用配方（afterEach 统一摘除，不污染其他用例）。 */
function registerFakeRecipe(name: string, specs: readonly UnitStep[]): void {
  recipeTable[name] = () => specs
  fakeRecipeNames.push(name)
}

afterEach(() => {
  for (const name of fakeRecipeNames.splice(0)) delete recipeTable[name]
})

/** 单元夹具的本地确定性时钟（tick 用例要控制 `now` 的现取行为）。 */
let unitNow = 12345
const unitClock = { now: () => unitNow, sleep: async () => undefined }

/** 内存审计替身：单元面只断"库里落了什么"，不起 JSONL 链（链的真实写入由 bank:saga-audit 侧用例负责）。 */
function fakeAudit(): SagaAudit {
  return {
    append: () => ({ seqInSaga: 1, recordHash: 'unit' }),
    verify: () => ({ ok: true }),
    anchor: async () => ({ merkleRoot: 'unit', targets: [] }),
  }
}

interface BridgeUnit {
  readonly ctx: Context
  readonly store: ReturnType<typeof createSagaStore>
  /** 注册替身工具体（在 ctx.start 之后、派发之前）。 */
  addTool(name: string, behavior: (args: Record<string, unknown>) => Promise<unknown>): void
  /** 走一遍 `tools/execute` 瀑布（与管线 ⑤ 段同款派发面）。 */
  runCall(call: ToolCallInput): Promise<unknown>
  dispose(): Promise<void>
}

async function bridgeUnit(settings: SagaBridgeSettings): Promise<BridgeUnit> {
  const ctx = createContext()
  const store = createSagaStore({ dbPath: ':memory:' })
  ctx.provide(SAGA_STORE, store)
  ctx.effect(() => store.close())
  ctx.provide(SAGA_CLOCK, unitClock)
  ctx.provide(SAGA_AUDIT, fakeAudit())
  installIdempotency(ctx)
  provideSession(ctx, { sessionId: asSessionId('s-bridge-unit'), now: () => unitNow })
  const registry = new ToolRegistry()
  provideTools(ctx, registry)

  await ctx.use(sagaBridgePlugin.plugin, settings)
  await ctx.start()

  return {
    ctx,
    store,
    addTool: (name, behavior) => {
      registry.register({
        name,
        description: '单元测试替身工具',
        schema: { type: 'object' },
        tier: { level: 'green' },
        execute: async (args: unknown) => behavior(args as Record<string, unknown>),
      })
    },
    runCall: async (call) => {
      const innermost = async (target: ToolCallInput): Promise<unknown> => ({
        passthrough: target.callId,
      })
      const executor = await ctx.events.waterfall('tools/execute', innermost)
      return executor(call)
    },
    dispose: () => ctx.dispose('test-done'),
  }
}

/** 预期拒绝 → 拿到抛出的错误对象（拒绝之外的情况一律判失败）。 */
async function rejectAsError(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => {
      throw new Error('预期应抛错，但调用成功了——错误路径没有守住')
    },
    (error: unknown) => error,
  )
}

const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex')

describe('bank:saga-bridge 单元面：接线层的错误码与副作用', () => {
  it('非 eligible 调用原样透传给内层执行器；eligible 却无配方时返回 undefined——桥接层绝不凭空造事务', async () => {
    // 这份设置刻意绕过 validate 的 fail-loud：生产配置里"没配方还进 eligible"根本装不上，
    // 但运行期防御（直通 + 不记账）必须有用例钉住，否则将来放开校验就是裸奔。
    const settings: SagaBridgeSettings = {
      enabled: true,
      eligible: ['no_recipe'],
      tickIntervalMs: 0,
      saga: parseSagaSettings({ maxAttempts: 1 }),
      compensation: { enabled: true },
    }
    const h = await bridgeUnit(settings)
    try {
      expect(await h.runCall({ callId: 'c-x', name: 'other_tool', args: {} })).toEqual({
        passthrough: 'c-x',
      })
      expect(await h.runCall({ callId: 'c-y', name: 'no_recipe', args: {} })).toBeUndefined()
      // 副作用判据：两种"不接管"都不许在库里留下任何一笔事务
      expect(h.store.listAllSagas()).toHaveLength(0)
    } finally {
      await h.dispose()
    }
  })

  it('工具体返回循环引用 / undefined：摘要回退 String(payload)——幂等与审计只认摘要，序列化炸了也不许拖垮事务', async () => {
    const ring: Record<string, unknown> = { note: '循环引用' }
    ring['self'] = ring
    registerFakeRecipe('digest_call', [
      { stepId: 'ring', toolName: 'ring_tool', sideEffectClass: 'NONE', deps: [], args: {} },
      { stepId: 'void', toolName: 'void_tool', sideEffectClass: 'NONE', deps: [], args: {} },
    ])
    const h = await bridgeUnit(
      sagaBridgePlugin.validate({ eligible: ['digest_call'], saga: { maxAttempts: 1 } }),
    )
    try {
      h.addTool('ring_tool', async () => ring)
      h.addTool('void_tool', async () => undefined)
      // 最后一步产出 undefined（外层结果必须是最后一步，预检的返回值不能顶包）
      expect(await h.runCall({ callId: 'c-digest', name: 'digest_call', args: {} })).toBeUndefined()

      const saga = h.store.listAllSagas()[0]!
      expect(saga.state).toBe('SUCCEEDED')
      const byTool = new Map(h.store.listSteps(saga.sagaId).map((step) => [step.toolName, step]))
      // JSON.stringify 抛错 → 退回 String(payload)；undefined 序列化成 undefined → 同一路径。
      // 摘要必须**等于** sha256(String(payload))：钉住回退语义，而不是只钉"没炸"。
      expect(byTool.get('ring_tool')!.responseDigest).toBe(sha256('[object Object]'))
      expect(byTool.get('void_tool')!.responseDigest).toBe(sha256('undefined'))
    } finally {
      await h.dispose()
    }
  })

  it('步骤抛 BahError：记的是工具自己的理由码，外层统一 saga-step-failed 且消息里同时有 failure.code 与 sagaId（不吞）', async () => {
    registerFakeRecipe('fail_call', [
      {
        stepId: 's1',
        toolName: 'risk_tool',
        sideEffectClass: 'EXTERNAL_UNDOABLE',
        deps: [],
        args: {},
      },
    ])
    const h = await bridgeUnit(
      sagaBridgePlugin.validate({ eligible: ['fail_call'], saga: { maxAttempts: 1 } }),
    )
    try {
      h.addTool('risk_tool', async () => {
        throw new BahError('risk-decline', '风控黄级拦截', { threshold: 500 })
      })
      const error = (await rejectAsError(
        h.runCall({ callId: 'c-fail', name: 'fail_call', args: {} }),
      )) as BahError
      expect(error.code).toBe('saga-step-failed')
      expect(error.message).toContain('risk-decline')
      const detail = error.detail as { code: string; sagaId: string }
      expect(detail.code).toBe('risk-decline')
      expect(error.message).toContain(detail.sagaId)

      // 副作用判据（W12 修订）：失败发生在任何执行成功的副作用之前 → 没有可退的东西，
      // 补偿通道注入后按 COMPENSATED 收敛（"无事可做"= 补偿成功），不是假阳性。
      // maxAttempts=1 → attempts=1，绝不自动重试（重试就是真的多扣一次钱）。
      const saga = h.store.listAllSagas()[0]!
      expect(saga.state).toBe('COMPENSATED')
      const step = h.store.listSteps(saga.sagaId)[0]!
      expect(step.state).toBe('FAILED')
      expect(step.attempts).toBe(1)
    } finally {
      await h.dispose()
    }
  })

  it('步骤抛非 BahError：理由码兜底成 tool-failed——错误必须结构化，裸 Error 不许冒充理由码', async () => {
    registerFakeRecipe('bare_call', [
      { stepId: 's1', toolName: 'bare_tool', sideEffectClass: 'EXTERNAL_UNDOABLE', deps: [], args: {} },
    ])
    const h = await bridgeUnit(
      sagaBridgePlugin.validate({ eligible: ['bare_call'], saga: { maxAttempts: 1 } }),
    )
    try {
      h.addTool('bare_tool', async () => {
        throw new Error('核心网关裸超时')
      })
      const error = (await rejectAsError(
        h.runCall({ callId: 'c-bare', name: 'bare_call', args: {} }),
      )) as BahError
      expect(error.code).toBe('saga-step-failed')
      const detail = error.detail as { code: string }
      expect(detail.code).toBe('tool-failed')
      expect(error.message).toContain('tool-failed')
    } finally {
      await h.dispose()
    }
  })

  it('配方依赖未定义的步骤：计划期即抛 recipe-invalid（带 recipe/step/dep），库里不留半笔事务', async () => {
    // 配方必须按拓扑序书写——依赖指向不存在的步骤属于配方写错，
    // 必须在建事务**之前**失败；留给运行期去发现就是拿一笔开了一半的 saga 当垃圾。
    registerFakeRecipe('ghost_call', [
      { stepId: 'a', toolName: 'ghost_tool_a', sideEffectClass: 'NONE', deps: [], args: {} },
      {
        stepId: 'b',
        toolName: 'ghost_tool_b',
        sideEffectClass: 'EXTERNAL_UNDOABLE',
        deps: ['ghost'],
        args: {},
      },
    ])
    const h = await bridgeUnit(
      sagaBridgePlugin.validate({ eligible: ['ghost_call'], saga: { maxAttempts: 1 } }),
    )
    try {
      const error = (await rejectAsError(
        h.runCall({ callId: 'c-ghost', name: 'ghost_call', args: {} }),
      )) as BahError
      expect(error.code).toBe('recipe-invalid')
      expect(error.message).toContain('依赖未定义的 ghost')
      expect(error.detail).toMatchObject({ recipe: 'ghost_call', step: 'b', dep: 'ghost' })
      expect(h.store.listAllSagas()).toHaveLength(0)
    } finally {
      await h.dispose()
    }
  })

  it('派发时回查不到配方步（本地名重复致全局 stepId 反查失联）：该步记 recipe-missing，已执行副作用无绑定 → fail-closed 到 COMPENSATION_DLQ', async () => {
    // `localToGlobal` 反查靠"本地名→全局 id"唯一；配方把两个本地名写成同一个，
    // 先落库的那步就再也反查不回自己的 spec——这条防御不许静默跳过（那等于悄悄少执行一步）。
    registerFakeRecipe('dup_call', [
      { stepId: 'dup', toolName: 'dup_tool_a', sideEffectClass: 'NONE', deps: [], args: {} },
      {
        stepId: 'dup',
        toolName: 'dup_tool_b',
        sideEffectClass: 'EXTERNAL_UNDOABLE',
        deps: [],
        args: {},
      },
    ])
    const h = await bridgeUnit(
      sagaBridgePlugin.validate({ eligible: ['dup_call'], saga: { maxAttempts: 1 } }),
    )
    try {
      h.addTool('dup_tool_a', async () => 'A')
      h.addTool('dup_tool_b', async () => 'B')
      const error = (await rejectAsError(
        h.runCall({ callId: 'c-dup', name: 'dup_call', args: {} }),
      )) as BahError
      expect(error.code).toBe('saga-step-failed')
      const detail = error.detail as { code: string }
      expect(detail.code).toBe('recipe-missing')
      expect(error.message).toContain('recipe-missing')

      // 实测（W12）：配方撞名让第二个 spec 同时顶替两步——先落库的那步拿到
      // `recipe-missing`（FAILED），另一步以 `dup_tool_b`（EXTERNAL_UNDOABLE）**执行成功**。
      // 已执行的副作用没有补偿绑定 → 绑定缺口，正确落点是 COMPENSATION_DLQ（人工处置），
      // 绝不能静默报 COMPENSATED。
      const saga = h.store.listAllSagas()[0]!
      expect(saga.state).toBe('COMPENSATION_DLQ')
      const steps = h.store.listSteps(saga.sagaId)
      expect([...steps.map((step) => step.state)].sort()).toEqual(['EXECUTED', 'FAILED'])
    } finally {
      await h.dispose()
    }
  })

  it('tickIntervalMs>0：到点必须按 serial 派发 saga/tick，dueJobs 固定 janitor/recon/anchor/plan-wake/sub-reminder/birthday-reminder/aa-expire，now 每次发射现取 SAGA_CLOCK，dispose 即 clearInterval', async () => {
    vi.useFakeTimers()
    try {
      unitNow = 12345
      const setSpy = vi.spyOn(globalThis, 'setInterval')
      const h = await bridgeUnit(
        sagaBridgePlugin.validate({ tickIntervalMs: 200, saga: { maxAttempts: 1 } }),
      )
      expect(setSpy).toHaveBeenCalledWith(expect.any(Function), 200)
      const intervalIndex = setSpy.mock.calls.findIndex((args) => args[1] === 200)
      const timerHandle = setSpy.mock.results[intervalIndex]!.value

      const ticks: { now: number; dueJobs: readonly string[] }[] = []
      // 监听器显式声明 serial：`saga/tick` 是冻结事件表里唯一的 serial 键，
      // 派发方若改用别的模式，select() 会当场抛 event-mode-mismatch（声明侧验派发侧）。
      h.ctx.events.on(
        'saga/tick',
        (payload: unknown) => {
          ticks.push(payload as { now: number; dueJobs: readonly string[] })
        },
        'serial',
      )

      await vi.advanceTimersByTimeAsync(200)
      expect(ticks).toHaveLength(1)
      expect(ticks[0]).toEqual({
        now: 12345,
        dueJobs: [
          'janitor',
          'recon',
          'anchor',
          'plan-wake',
          'sub-reminder',
          'birthday-reminder',
          'aa-expire',
        ],
      })

      // now 不许在 apply 期缓存：时钟推进后下一次发射必须看见新值
      unitNow = 99_000
      await vi.advanceTimersByTimeAsync(200)
      expect(ticks).toHaveLength(2)
      expect(ticks[1]).toEqual({
        now: 99_000,
        dueJobs: [
          'janitor',
          'recon',
          'anchor',
          'plan-wake',
          'sub-reminder',
          'birthday-reminder',
          'aa-expire',
        ],
      })

      // 注册即可逆：dispose 必须把定时器 clearInterval 掉（用的是 apply 期那个句柄）
      const clearSpy = vi.spyOn(globalThis, 'clearInterval')
      await h.dispose()
      expect(clearSpy).toHaveBeenCalledWith(timerHandle)
    } finally {
      vi.useRealTimers()
      vi.restoreAllMocks()
    }
  })

  it('定时器必须 unref——否则 CLI 跑完一个 turn 进程退不掉；派发失败的兜底日志同样走 codeOf（BahError 用自身码，其余退 tool-failed）', async () => {
    const unref = vi.fn()
    let tick!: () => void
    let captured = false
    // 用受控替身接管 setInterval：`unref` 是否被调用、句柄是否交给 dispose，都在这一个用例里钉死。
    const setSpy = vi
      .spyOn(globalThis, 'setInterval')
      .mockImplementation(((fn: () => void) => {
        if (!captured) {
          captured = true
          tick = fn
        }
        return { unref }
      }) as unknown as typeof setInterval)
    const clearSpy = vi.spyOn(globalThis, 'clearInterval').mockImplementation(() => undefined)
    const logSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))
    try {
      const h = await bridgeUnit(
        sagaBridgePlugin.validate({ tickIntervalMs: 50, saga: { maxAttempts: 1 } }),
      )
      expect(unref).toHaveBeenCalledOnce()

      let boom: unknown
      h.ctx.events.on('saga/tick', async () => {
        if (boom !== undefined) throw boom
      })

      // 定时器里抛错没人接：只能落日志，且理由码必须结构化（codeOf：BahError 原码透传）
      boom = new BahError('anchor-lock-contended', '锚定周期锁被占用')
      tick()
      await settle()
      const lines = logSpy.mock.calls.map((call) => String(call[0]))
      expect(
        lines.some(
          (line) => line.includes('"code":"host.saga-tick-failed"') && line.includes('anchor-lock-contended'),
        ),
      ).toBe(true)

      // 非 BahError → 统一退到 tool-failed（与步骤派发失败同一个兜底码，审计口径一致）
      boom = new Error('裸超时')
      tick()
      await settle()
      expect(
        logSpy.mock.calls
          .map((call) => String(call[0]))
          .some((line) => line.includes('"code":"host.saga-tick-failed"') && line.includes('tool-failed')),
      ).toBe(true)

      await h.dispose()
      expect(clearSpy).toHaveBeenCalledWith(setSpy.mock.results[0]!.value)
    } finally {
      vi.restoreAllMocks()
    }
  })
})

describe('W12 补偿回读：saga 真冲正', () => {
  /** 先扣款、后置校验失败的确定性脚本（外层仍叫 transfer_create，票据绑定才对得上）。 */
  const COMP_SCRIPT = [
    {
      tool: {
        id: 'call-comp',
        name: 'transfer_create',
        args: {
          amount: 800,
          payee: { name: '王建国', phone: '13900002222' },
          remark: '房租',
        },
      },
    },
    { text: '补偿演示：扣款后失败。' },
  ] as const

  it('TC-W12-03 转账成功后后续步骤失败 → reverse(txnId) → COMPENSATED，余额回到初值', async () => {
    // 配方只在本用例内替换（direct assignment + finally 复原），
    // 不能走 registerFakeRecipe：afterEach 会 delete 掉真实的 transfer_create 配方。
    const table = SAGA_BRIDGE_RECIPES as unknown as Record<
      string,
      (call: ToolCallInput) => readonly {
        readonly stepId: string
        readonly toolName: string
        readonly sideEffectClass: SideEffectClass
        readonly deps: readonly string[]
        readonly args: Readonly<Record<string, unknown>>
      }[]
    >
    const original = table['transfer_create']!
    table['transfer_create'] = (call) => [
      {
        stepId: 'pay',
        toolName: 'transfer_create',
        sideEffectClass: 'EXTERNAL_UNDOABLE',
        deps: [],
        args: call.args,
      },
      { stepId: 'post', toolName: 'post_check', sideEffectClass: 'NONE', deps: ['pay'], args: {} },
    ]

    const { app, cleanup } = await bootWith(
      { enabled: true, eligible: ['transfer_create'], saga: { maxAttempts: 1 } },
      COMP_SCRIPT,
    )
    try {
      const tools = app.ctx.get(TOOLS_SERVICE)
      tools.register({
        name: 'post_check',
        description: '补偿用例：扣款后失败',
        schema: { type: 'object' },
        tier: { level: 'green' },
        execute: async () => {
          throw new BahError('post-check-failed', '后置校验失败（演示补偿）')
        },
      })
      const sessionId = asSessionId('s-saga-bridge')
      const readBalance = async (callId: string): Promise<{ balanceCents: number; availableCents: number }> =>
        (await tools.get('account_balance')!.execute({}, {
          sessionId,
          callId,
          signal: new AbortController().signal,
        })) as { balanceCents: number; availableCents: number }

      const before = await readBalance('read-before')
      const agent = app.ctx.get(AGENTS_SERVICE).list()[0]!
      agent.send('给王建国转 800 元房租')
      await agent.run()
      const after = await readBalance('read-after')

      // 本单最硬的证据：账户前后对比（扣了又退回来了）
      expect(after.balanceCents).toBe(before.balanceCents)
      expect(after.availableCents).toBe(before.availableCents)

      const store = app.ctx.get(SAGA_STORE)
      const sagas = store.listAllSagas()
      expect(sagas).toHaveLength(1)
      expect(sagas[0]!.state).toBe('COMPENSATED')
      expect(store.tx((tx) => tx.listCompensations(sagas[0]!.sagaId)).map((comp) => comp.state)).toEqual([
        'OK',
      ])

      // 冲正真的发生了：从 transfer/created 找到原流水号，窄端口能查回冲正结果
      // 领域事件不在 AnySessionEvent 的窄联合里，按结构读一遍（只取 transfer/created 的 result）
      const events = app.ctx.get(SESSION_SERVICE).events() as readonly {
        readonly type: string
        readonly data: unknown
      }[]
      const created = events.find((event) => event.type === 'transfer/created')
      const txnId = (created?.data as { result?: { txnId?: string } } | undefined)?.result?.txnId
      expect(txnId).toBeDefined()
      expect(app.ctx.get(BANK_COMPENSATION).reversalOf(txnId!)).toBeDefined()
    } finally {
      await app.dispose('test-done')
      cleanup()
      table['transfer_create'] = original
    }
  })

  it('compensation.enabled:false → 不注入通道，失败停在 COMPENSATING（旧行为可回滚）', async () => {
    const table = SAGA_BRIDGE_RECIPES as unknown as Record<
      string,
      (call: ToolCallInput) => readonly {
        readonly stepId: string
        readonly toolName: string
        readonly sideEffectClass: SideEffectClass
        readonly deps: readonly string[]
        readonly args: Readonly<Record<string, unknown>>
      }[]
    >
    const original = table['transfer_create']!
    table['transfer_create'] = (call) => [
      {
        stepId: 'pay',
        toolName: 'transfer_create',
        sideEffectClass: 'EXTERNAL_UNDOABLE',
        deps: [],
        args: call.args,
      },
      { stepId: 'post', toolName: 'post_check', sideEffectClass: 'NONE', deps: ['pay'], args: {} },
    ]
    const { app, cleanup } = await bootWith(
      {
        enabled: true,
        eligible: ['transfer_create'],
        saga: { maxAttempts: 1 },
        compensation: { enabled: false },
      },
      COMP_SCRIPT,
    )
    try {
      app.ctx.get(TOOLS_SERVICE).register({
        name: 'post_check',
        description: '补偿用例：扣款后失败',
        schema: { type: 'object' },
        tier: { level: 'green' },
        execute: async () => {
          throw new BahError('post-check-failed', '后置校验失败（演示补偿）')
        },
      })
      const agent = app.ctx.get(AGENTS_SERVICE).list()[0]!
      agent.send('给王建国转 800 元房租')
      await agent.run()

      const saga = app.ctx.get(SAGA_STORE).listAllSagas()[0]!
      expect(saga.state).toBe('COMPENSATING')
      // 关闭注入 = 退回"止于决策"：不注册、不绑定、不发射，库里的补偿面为空
      expect(
        app.ctx.get(SAGA_STORE).tx((tx) => tx.listCompensations(saga.sagaId)),
      ).toHaveLength(0)
    } finally {
      await app.dispose('test-done')
      cleanup()
      table['transfer_create'] = original
    }
  })
})

describe('W12 补偿通道 · 反查与探诊的失败面', () => {
  const template = {
    templateId: 'tpl-1',
    templateVersion: 1,
    targetTool: 'transfer_create',
    compKind: 'FULL_REFUND' as const,
    compEndpoint: 'tool://transfer_create',
    compIdempotent: true,
    residualRules: [],
    approvalRequired: false,
    payloadProjection: '{}',
    status: 'ACTIVE',
  }
  const invocation = {
    sagaId: 'saga-1',
    stepId: 'st-1',
    compId: 'comp-1',
    toolName: 'transfer_create',
    endpoint: 'tool://transfer_create',
    compKind: 'FULL_REFUND' as const,
    compKey: 'k-1',
    payload: {},
    template,
  }
  const stepRef = { sagaId: 'saga-1', stepId: 'comp-1', toolName: 'transfer_create' }
  const signal = new AbortController().signal

  function depsWith(port: {
    reverse: (txnId: string) => Promise<unknown>
    reversalOf: (txnId: string) => unknown
  }): ReturnType<typeof compensationDepsFor> {
    const ctx = { get: () => port } as unknown as Pick<Context, 'get'>
    return compensationDepsFor(ctx, new Map([['st-1', {}]]), new Map())
  }

  it('正向结果里没有 txnId → reverse-source-missing（不猜流水号、不空退）', async () => {
    const deps = depsWith({ reverse: async () => ({ ok: true }), reversalOf: () => undefined })
    await expect(deps.invoke(invocation, signal)).resolves.toEqual({
      kind: 'err',
      code: 'reverse-source-missing',
    })
  })

  it('冲正抛错 → 保留工具码；成功 → 返回摘要并记住 compId→txnId', async () => {
    const failed = compensationDepsFor(
      {
        get: () => ({
          reverse: async () => {
            throw new BahError('upstream-unavailable', '核心不可用')
          },
          reversalOf: () => undefined,
        }),
      } as unknown as Pick<Context, 'get'>,
      new Map([['st-1', { txnId: 'txn-1' }]]),
      new Map(),
    )
    await expect(failed.invoke({ ...invocation }, signal)).resolves.toEqual({
      kind: 'err',
      code: 'upstream-unavailable',
    })

    const okCtx = { get: () => ({ reverse: async () => ({ reversalId: 'r-1' }), reversalOf: () => undefined }) }
    const maps = new Map<string, string>()
    const deps = compensationDepsFor(
      okCtx as unknown as Pick<Context, 'get'>,
      new Map([['st-1', { txnId: 'txn-1' }]]),
      maps,
    )
    const result = await deps.invoke({ ...invocation }, signal)
    expect(result).toMatchObject({ kind: 'ok' })
    expect(maps.get('comp-1')).toBe('txn-1')
  })

  it('探诊：未记录 → failed；未发生 → not-executed；已发生 → executed；端口抛错 → failed', async () => {
    const maps = new Map<string, string>()
    const deps = depsWith({ reverse: async () => ({}), reversalOf: () => ({ reversalId: 'r-1' }) })

    await expect(deps.probe('tool://x', stepRef, signal)).resolves.toEqual({ kind: 'failed' })

    maps.set('comp-1', 'txn-1')
    const withMissing = compensationDepsFor(
      { get: () => ({ reverse: async () => ({}), reversalOf: () => undefined }) } as unknown as Pick<Context, 'get'>,
      new Map(),
      maps,
    )
    await expect(withMissing.probe('tool://x', stepRef, signal)).resolves.toEqual({
      kind: 'not-executed',
    })

    const withResult = compensationDepsFor(
      { get: () => ({ reverse: async () => ({}), reversalOf: () => ({ reversalId: 'r-1' }) }) } as unknown as Pick<Context, 'get'>,
      new Map(),
      maps,
    )
    await expect(withResult.probe('tool://x', stepRef, signal)).resolves.toMatchObject({
      kind: 'executed',
    })

    const withThrow = compensationDepsFor(
      {
        get: () => ({
          reverse: async () => ({}),
          reversalOf: () => {
            throw new BahError('db-down', '库存不可读')
          },
        }),
      } as unknown as Pick<Context, 'get'>,
      new Map(),
      maps,
    )
    await expect(withThrow.probe('tool://x', stepRef, signal)).resolves.toEqual({ kind: 'failed' })
  })
})

describe('W12 装配顺序（复审回归）', () => {
  it('apply 期不取 saga 服务：先装桥接、后装存储也能起（行顺序不是隐性契约）', async () => {
    const ctx = createContext()
    // 刻意不提供 SAGA_STORE / SAGA_CLOCK / SAGA_TEMPLATES：apply 只挂监听器
    await ctx.use(
      sagaBridgePlugin.plugin,
      sagaBridgePlugin.validate({
        eligible: ['transfer_create'],
        compensation: { enabled: true },
      }),
    )
    await ctx.start()
    // 没有在 apply 期抛 service-missing 即为通过；真正的 saga 调用会由 planSaga 报缺服务
    await ctx.dispose('test-done')
  })
})
