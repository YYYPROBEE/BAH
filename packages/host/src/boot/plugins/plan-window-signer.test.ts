/**
 * 窗口代签核验端口（`plan:window-signer`）的**拒绝阶梯**（ADR-0010）。
 *
 * 为什么单独一组：这段判定是"用户确认一次、到期由系统替他把钱花掉"的唯一闸门。
 * 某条拒绝分支被改松的表现不是报错，而是**静默多花钱**——那种回归只能逐臂断言钉住。
 *
 * 判定顺序（`plan.ts` 的 `signer.sign`）每臂一条用例：
 * ① 票据必须带窗口授权 → ② 必须有在途唤醒标记（字段可仿，标记不可）→
 * ③ 窗口存在 / 仍 armed / 三份摘要一致 → ④ 条件复验 → ⑤ 档位 × 整数分 × 预算 →
 * ⑥ 记账扣预算。
 *
 * 装配沿用 `plan-wake.test.ts` 的子集（真实 `boot()` + 真实工具与授权账本）；
 * 时钟由本文件拨动，唤醒标记从 `bah:run` 取宿主那一份——拒绝阶梯的输入必须可控。
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  PLAN_ARM_TOOL,
  PLAN_DISARM_TOOL,
  TOOLS_SERVICE,
  type ArmedPlan,
  type ToolDefinition,
  type ToolExecContext,
} from '@bah/runtime'
import { asSessionId } from '@bah/test-support'
import type { WindowSignRequest } from '@bah/interaction'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { BootedApp, BootOptions, ProfileSummary } from '../boot.ts'
import { boot, RUN_SERVICE } from '../boot.ts'
import { createCatalog } from './index.ts'
import { PLAN_ARMED_SERVICE } from './plan.ts'
import { WINDOW_SIGNER, type WindowSigner } from './plan-grant.ts'
import { testRunContext } from '../test-run-context.ts'

import type { Bundle, ConfigLayer, PluginRow } from '../profile-plugins.ts'
import type { WakeMarkStore } from '../wake-marks.ts'

const NOW = 1_700_000_000_000
const SESSION = asSessionId('s-plan-signer')
const PROFILE: ProfileSummary = { name: 'plan', bundles: ['base'], hmr: false }

const BASE_ROWS: readonly PluginRow[] = [
  { id: 'core:session' },
  { id: 'core:tools' },
  { id: 'core:prompt' },
  { id: 'core:model', config: { provider: 'deepseek', model: 'deepseek-chat' } },
  { id: 'core:agent', config: { loop: { model: 'deepseek:deepseek-chat' } } },
  { id: 'core:persistence', config: { root: 'sessions', fsync: false } },
  { id: 'audit:decisions' },
  { id: 'policy:rules' },
  { id: 'bank:tools', config: { demoUserId: 'u-1', seed: 7, datasetTier: 'demo' } },
  { id: 'interaction:approval', config: { responder: 'none', windowResponder: true } },
  { id: 'safety:sentry', config: { trace: { sink: 'memory' } } },
  { id: 'bank:saga-store', config: { dbPath: ':memory:' } },
  { id: 'bank:saga' },
  { id: 'bank:saga-audit' },
  { id: 'bank:saga-bridge', config: { enabled: false } },
]

const overlay = (rows: readonly PluginRow[]): ConfigLayer => ({
  layer: 'overlay',
  from: 'plan-window-signer.test.ts',
  rows,
})

interface Harness {
  readonly app: BootedApp
  /** 宿主 `signer` 读的就是这一份：标记与预算都由它记账。 */
  readonly wakeMarks: WakeMarkStore
  readonly signer: WindowSigner
  readonly cleanup: () => void
}

/** 一次拨钟的时钟：过期这一臂靠推时钟触发，不靠 sleep。 */
let clockAt = NOW

async function bootHarness(): Promise<Harness> {
  clockAt = NOW
  const dir = mkdtempSync(join(tmpdir(), 'bah-plan-signer-'))
  const bundle: Bundle = { name: 'base', rows: BASE_ROWS }
  const options: BootOptions = {
    profile: PROFILE,
    bundles: [bundle],
    layers: [overlay([{ id: 'plan:dag', use: 'plan:dag', config: { modelTools: true } }])],
    catalog: createCatalog(),
    run: testRunContext({ sessionId: SESSION, now: () => clockAt, jsonlDir: dir }),
  }
  const app = await boot(options)
  const wakeMarks = app.ctx.get(RUN_SERVICE).wakeMarks
  if (wakeMarks === undefined) throw new Error('夹具没有 wakeMarks 账本，拒绝阶梯的输入不可控')
  return {
    app,
    wakeMarks,
    signer: app.ctx.get(WINDOW_SIGNER),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  }
}

const execCtx = (callId: string): ToolExecContext => ({
  sessionId: SESSION,
  callId,
  signal: new AbortController().signal,
})

let h: Harness | undefined

function need(): Harness {
  if (h === undefined) throw new Error('harness 未初始化')
  return h
}

function toolOf(name: string): ToolDefinition<Readonly<Record<string, unknown>>, unknown> {
  return need().app.ctx.get(TOOLS_SERVICE).get(name) as ToolDefinition<
    Readonly<Record<string, unknown>>,
    unknown
  >
}

/** 授权一个窗口（只读节点：条件复验恒过，好让每条用例只动自己那一臂）。 */
async function arm(
  callId: string,
  overrides: Readonly<Record<string, unknown>> = {},
): Promise<ArmedPlan> {
  await toolOf(PLAN_ARM_TOOL).execute(
    {
      title: '到期代付',
      planId: `p-${callId}`,
      nodes: [{ id: 'bal', tool: 'account_balance', args: {}, deps: [] }],
      budgetYuan: 100,
      dueAt: new Date(NOW - 1_000).toISOString(),
      ...overrides,
    },
    execCtx(callId),
  )
  const list = need().app.ctx.get(PLAN_ARMED_SERVICE).list()
  const item = list[list.length - 1]
  if (item === undefined) throw new Error('授权账本里没有条目')
  return item
}

/** 把窗口自带的凭据开成在途标记（= "这次 run 确实是唤醒执行器开的"）。 */
function openMark(
  armed: ArmedPlan,
  overrides: { planId?: string; digest?: string; budgetCents?: number } = {},
): () => void {
  return need().wakeMarks.open({
    windowId: armed.windowId,
    planId: overrides.planId ?? armed.planId,
    digest: overrides.digest ?? armed.planDigest,
    budgetCents: overrides.budgetCents ?? armed.budgetCents,
  })
}

/** 一次核验请求（各臂只改自己关心的字段）。 */
function request(
  authorization: WindowSignRequest['authorization'],
  overrides: Partial<WindowSignRequest> = {},
): WindowSignRequest {
  return {
    ticketId: 't-1',
    callId: 'c-1',
    name: 'transfer_create',
    level: 'yellow',
    amountYuan: 30,
    authorization,
    ...overrides,
  }
}

/** 窗口形状的授权（`kind` 必须收窄成字面量，否则宿主会走 ① 的 not-window 臂）。 */
const windowAuth = (armed: ArmedPlan): WindowSignRequest['authorization'] => ({
  kind: 'window',
  ref: armed.windowId,
  digest: armed.planDigest,
})

/** 断言"不放行"并取回理由码。 */
async function denyCode(req: WindowSignRequest): Promise<string> {
  const grant = await need().signer.sign(req)
  if (grant.ok === true) throw new Error(`期望不放行，实际放行了：${JSON.stringify(grant)}`)
  return grant.code
}

beforeEach(async () => {
  h = await bootHarness()
})

afterEach(async () => {
  if (h !== undefined) {
    await h.app.dispose('test-done')
    h.cleanup()
    h = undefined
  }
  clockAt = NOW
})

describe('窗口代签核验端口：拒绝阶梯逐臂', () => {
  it('① 人工票据 ⇒ not-window，不碰标记也不扣预算', async () => {
    const armed = await arm('call-ladder-1')
    const release = openMark(armed)
    try {
      expect(
        await denyCode(
          request({ kind: 'human', ref: armed.windowId, digest: armed.planDigest }),
        ),
      ).toBe('not-window')
      expect(need().wakeMarks.get(armed.windowId)?.spentCents).toBe(0)
    } finally {
      release()
    }
  })

  it('② 没有在途唤醒标记 ⇒ no-wake-mark：authorization 字段能仿，标记不能', async () => {
    const armed = await arm('call-ladder-2')
    // 关键负控：一份**结构完全合法、摘要也对得上**的窗口授权，
    // 但这次 run 不是唤醒执行器开的 ⇒ 必须沉默，而不是"字段齐了就代签"
    expect(await denyCode(request(windowAuth(armed)))).toBe('no-wake-mark')
    expect(need().wakeMarks.get(armed.windowId)).toBeUndefined()
  })

  it('③ 标记在但窗口不存在 ⇒ window-unknown（标记不能凭空造出授权）', async () => {
    const release = need().wakeMarks.open({
      windowId: 'w-ghost',
      planId: 'p-ghost',
      digest: 'd-ghost',
      budgetCents: 10_000,
    })
    try {
      expect(await denyCode(request({ kind: 'window', ref: 'w-ghost', digest: 'd-ghost' }))).toBe(
        'window-unknown',
      )
    } finally {
      release()
    }
  })

  it('③ 窗口已撤销 ⇒ window-cancelled（撤销必须在代签前生效）', async () => {
    const armed = await arm('call-ladder-4')
    const release = openMark(armed)
    try {
      await toolOf(PLAN_DISARM_TOOL).execute({ windowId: armed.windowId }, execCtx('call-ladder-4-off'))
      expect(await denyCode(request(windowAuth(armed)))).toBe('window-cancelled')
    } finally {
      release()
    }
  })

  it('③ 标记与窗口不是同一个计划 / 摘要对不上 ⇒ window-mismatch（两条都判）', async () => {
    const armed = await arm('call-ladder-5')

    const wrongPlan = openMark(armed, { planId: 'p-someone-else' })
    try {
      expect(await denyCode(request(windowAuth(armed)))).toBe('window-mismatch')
    } finally {
      wrongPlan()
    }

    const wrongDigest = openMark(armed, { digest: 'd-forged' })
    try {
      // 票据自带的是真摘要，标记带的是别的：三者必须同时一致才放行
      expect(await denyCode(request(windowAuth(armed)))).toBe('window-mismatch')
    } finally {
      wrongDigest()
    }
  })

  it('④ 窗口已过期 ⇒ 沿用 checkWindow 的理由码，且一分不消耗', async () => {
    const expiresAt = NOW + 60_000
    const armed = await arm('call-ladder-6', { expiresAt: new Date(expiresAt).toISOString() })
    const release = openMark(armed)
    try {
      clockAt = expiresAt + 1
      expect(await denyCode(request(windowAuth(armed)))).toBe('window-expired')
      expect(need().wakeMarks.get(armed.windowId)?.spentCents).toBe(0)
    } finally {
      release()
    }
  })

  it('⑤ 标准档不代签红级 ⇒ tier-not-allowed（"选了标准档"不等于"红级也能自动"）', async () => {
    const armed = await arm('call-ladder-7')
    const release = openMark(armed)
    try {
      expect(await denyCode(request(windowAuth(armed), { level: 'red' }))).toBe('tier-not-allowed')
      expect(need().wakeMarks.get(armed.windowId)?.spentCents).toBe(0)
    } finally {
      release()
    }
  })

  it('⑤ 预算按本次 run 累计：第二次超支 ⇒ over-budget，失败的那笔不记账', async () => {
    const armed = await arm('call-ladder-8', { budgetYuan: 50 })
    const release = openMark(armed)
    try {
      expect((await need().signer.sign(request(windowAuth(armed)))).ok).toBe(true)
      expect(need().wakeMarks.get(armed.windowId)?.spentCents).toBe(3_000)
      // ¥30 + ¥30 = 6000 分 > 预算 5000 分：第二笔必须留给人工，而不是"先放行再补账"
      expect(await denyCode(request(windowAuth(armed)))).toBe('over-budget')
      expect(need().wakeMarks.get(armed.windowId)?.spentCents).toBe(3_000)
    } finally {
      release()
    }
  })

  it('⑤ 金额口径必须整数分 ⇒ amount-invalid（不接受四舍五入后放行）', async () => {
    const armed = await arm('call-ladder-9')
    const release = openMark(armed, { budgetCents: 10_000.5 })
    try {
      expect(await denyCode(request(windowAuth(armed)))).toBe('amount-invalid')
    } finally {
      release()
    }
  })

  it('无金额的工具按 0 分记账：缺省与非有限值都放行，且不占预算', async () => {
    const armed = await arm('call-ladder-10')
    const release = openMark(armed)
    try {
      for (const amountYuan of [undefined, Number.NaN]) {
        const grant = await need().signer.sign(
          request(windowAuth(armed), { name: 'plan_wake', amountYuan }),
        )
        expect(grant.ok).toBe(true)
      }
      expect(need().wakeMarks.get(armed.windowId)?.spentCents).toBe(0)
    } finally {
      release()
    }
  })
})
