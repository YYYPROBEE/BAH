/**
 * `bank:saga-bridge`：把写工具接进协调器的接线层（配置面 + 行为面）。
 *
 * 行为面的判据不是"没抛错"，而是**协调器真的留下了一笔事务**：
 *   `saga_transaction.state = SUCCEEDED`、两步 `EXECUTED`、`attempts = 1`。
 * 这三条同时成立才说明"预检 → 扣款"确实按拓扑顺序跑过一次，且没有被重试。
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { AGENTS_SERVICE } from '@bah/runtime'
import { SAGA_STORE } from '@bah/saga'
import { asSessionId } from '@bah/test-support'
import { describe, expect, it } from 'vitest'

import { boot, type BootOptions, type ProfileSummary } from '../boot.ts'
import { createCatalog } from './index.ts'
import { sagaBridgePlugin } from './saga-bridge.ts'

import type { Bundle, PluginRow } from '../profile-plugins.ts'
import type { BootedApp } from '../boot.ts'

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
function rows(bridgeConfig: Readonly<Record<string, unknown>>): readonly PluginRow[] {
  return [
    { id: 'core:session' },
    { id: 'core:tools' },
    { id: 'core:prompt' },
    { id: 'core:model', config: { provider: 'mock', script: TRANSFER_SCRIPT } },
    { id: 'core:agent', config: { loop: { model: 'mock:mock-chat' } } },
    { id: 'core:persistence', config: { root: 'sessions', fsync: false } },
    { id: 'bank:tools', config: { demoUserId: 'u-1', seed: 7, datasetTier: 'demo' } },
    {
      id: 'interaction:approval',
      config: { responder: 'headless', autoDecision: 'allow', autoVerify: true },
    },
    { id: 'bank:saga-store', config: { dbPath: ':memory:' } },
    { id: 'bank:saga' },
    { id: 'bank:saga-audit' },
    { id: 'bank:saga-bridge', config: bridgeConfig },
  ]
}

/** 起一个应用（落盘目录临时、dispose 后清理）。 */
async function bootWith(
  bridgeConfig: Readonly<Record<string, unknown>>,
): Promise<{ readonly app: BootedApp; readonly cleanup: () => void }> {
  const dir = mkdtempSync(join(tmpdir(), 'bah-saga-bridge-'))
  const bundle: Bundle = { name: 'fx-saga', rows: rows(bridgeConfig) }
  const options: BootOptions = {
    profile: PROFILE,
    bundles: [bundle],
    layers: [],
    catalog: createCatalog(),
    run: { sessionId: asSessionId('s-saga-bridge'), now: () => 1_000, jsonlDir: dir },
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
