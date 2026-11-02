/**
 * 主演示链路的真实模型 e2e（修 B6 /  出口标准的端到端补证）。
 *
 * 与 `approval.test.ts` 的区别只有一处：`core:model` 是**真实 DeepSeek 适配器**，
 * 不 mock、不脚本化。因此这条用例回答的是"模型真的会调工具、审批链路真的跑得通"，
 * 而不是"宿主接线是否正确"（后者由 unit 面用 mock 脚本逐条钉死）。
 *
 * 无 `DEEPSEEK_API_KEY` 时不绿也不算红：
 * 1. `vitest.e2e.config.ts` 在没有密钥时**连用例都不收集**（`include: []` + `passWithNoTests`）；
 * 2. 本文件再叠一层 `describe.skipIf`，防止有人用错误配置把 `*.e2e.test.ts` 收进别的面。
 *
 * 端点与模型由环境变量决定（与 `packages/llm/src/deepseek/adapter.e2e.test.ts` 同口径）：
 * - `DEEPSEEK_API_KEY`：缺失即整面 skip；
 * - `DEEPSEEK_BASE_URL`：缺省 `https://api.deepseek.com`；
 * - `DEEPSEEK_MODEL`：缺省 `deepseek-chat`。
 *
 * 已知风险：真实模型可能不调工具（模型行为不受用例控制）。这时**用例失败**而不是放行，
 * 失败信息里带完整事件类型与 assistant 文本，便于判断是提示词问题还是模型侧波动。
 * 用例只跑一次，不做循环重试——e2e 面打的是付费 API，重试留给 CI 重跑整条流水线。
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { asSessionId } from '@bah/test-support'
import { AGENTS_SERVICE, SESSION_SERVICE } from '@bah/runtime'
import type { AnySessionEvent } from '@bah/runtime'
import { DEEPSEEK_MODELS } from '@bah/llm/deepseek'

import { boot, type BootOptions } from '../boot.ts'
import { createCatalog } from './index.ts'
import type { PluginRow } from '../profile-plugins.ts'
import { testRunContext } from '../test-run-context.ts'

const hasApiKey = Boolean(process.env['DEEPSEEK_API_KEY'])

/** 真实模型标识：缺省打官方 `deepseek-chat`，换兼容网关时用 `DEEPSEEK_MODEL` 覆盖。 */
const modelId = process.env['DEEPSEEK_MODEL'] ?? 'deepseek-chat'
const baseUrl = process.env['DEEPSEEK_BASE_URL']

/**
 * 内置模型表里没有的 id（第三方兼容网关）需要就地声明能力位，否则 `core:model` 启动即
 * 报 `unknown-model`——这是"不猜能力位"的设计，不是缺陷。
 */
const isKnownModel = DEEPSEEK_MODELS.some((model) => model.id === modelId)

/** 触发一次转账工具链：先预览再执行，并明确不要反问。 */
const PROMPT = '给王建国转 100 元，先预览再执行，不要问我问题。'

/** 只断言"转账工具被调过"，不限定 preview / create 的顺序（模型两种都合理）。 */
const TRANSFER_TOOLS = new Set(['transfer_preview', 'transfer_create'])

/**
 * 最小 host：内核三行 + 真实模型 + 主循环 + 持久化 + 银行工具 + 自动审批。
 *
 * 刻意**不装** web / saga / plan / sentry / verify：这条用例证明的是主链路，
 * 多装一行就多一处"环境不对"的变量，而各被拆出去的平面已有自己的用例。
 */
function rows(): readonly PluginRow[] {
  return [
    { id: 'core:session' },
    { id: 'core:tools' },
    { id: 'core:prompt' },
    {
      id: 'core:model',
      config: {
        provider: 'deepseek',
        model: modelId,
        ...(baseUrl === undefined ? {} : { baseUrl }),
        ...(isKnownModel
          ? {}
          : {
              modelSpec: { displayName: modelId, contextWindow: 64_000, toolCall: true },
            }),
        // 真实网络：给足预算，但绝不允许无限等
        requestTimeoutMs: 45_000,
        retryMax: 1,
      },
    },
    {
      id: 'core:agent',
      config: { channel: 'headless', loop: { model: `deepseek:${modelId}`, maxSteps: 8 } },
    },
    { id: 'core:persistence', config: { root: 'sessions', fsync: false } },
    {
      id: 'bank:tools',
      config: { demoUserId: 'u-1', seed: 7, datasetTier: 'demo' },
    },
    {
      id: 'interaction:approval',
      config: { responder: 'headless', autoDecision: 'allow', autoVerify: true },
    },
  ]
}

/** 失败时的排障快照：事件类型计数 + 每条 assistant 文本。 */
function describeRun(events: readonly AnySessionEvent[]): string {
  const counts = new Map<string, number>()
  for (const event of events) counts.set(event.type, (counts.get(event.type) ?? 0) + 1)
  const types = [...counts.entries()].map(([type, n]) => `${type}×${n}`).join(' / ')

  const assistantTexts = events
    .filter((event) => event.type === 'assistant/message')
    .map((event) => {
      const content = (event.data as { content?: readonly { type: string; text?: string }[] })
        .content
      if (content === undefined) return ''
      return content
        .filter((block) => block.type === 'text')
        .map((block) => block.text ?? '')
        .join('')
    })
    .filter((text) => text.length > 0)

  return [
    `模型=${modelId}`,
    `事件类型：${types.length > 0 ? types : '(无事件)'}`,
    `assistant 文本：${assistantTexts.length > 0 ? assistantTexts.join(' ⏐ ') : '(无文本)'}`,
  ].join('\n')
}

describe.skipIf(!hasApiKey)(`真实模型主链路（e2e · ${modelId}）`, () => {
  it(
    '真实 DeepSeek：转账工具调用 → 审批自动批准 → tool/result → turn/end',
    async () => {
      const dir = mkdtempSync(join(tmpdir(), 'bah-agent-e2e-'))
      const options: BootOptions = {
        profile: { name: 'e2e', bundles: ['e2e'], hmr: false },
        bundles: [{ name: 'e2e', rows: rows() }],
        layers: [],
        catalog: createCatalog(),
        run: testRunContext({
          sessionId: asSessionId('s-agent-e2e'),
          now: () => Date.now(),
          jsonlDir: dir,
        }),
      }
      const app = await boot(options)
      try {
        const agent = app.ctx.get(AGENTS_SERVICE).list()[0]!
        agent.send(PROMPT)
        await agent.run()

        const events = app.ctx.get(SESSION_SERVICE).events()
        const diagnostic = `\n${describeRun(events)}`

        // 1) 模型确实调了转账工具（preview 或 create 都算；只断言"调了"，不猜顺序）
        const transferCalls = events
          .filter((event) => event.type === 'tool/call')
          .map((event) => event.data as { callId?: string; name?: string })
          .filter((call) => call.name !== undefined && TRANSFER_TOOLS.has(call.name))
        expect(
          transferCalls.map((call) => call.name),
          `模型没有调用 transfer_preview / transfer_create。${diagnostic}`,
        ).not.toHaveLength(0)

        // 2) 每次调用都有同 callId 的 tool/result（配不上 = 工具没执行完）
        const callIds = new Set(transferCalls.map((call) => call.callId))
        const transferResults = events
          .filter((event) => event.type === 'tool/result')
          .map((event) => event.data as { callId?: string })
          .filter((result) => result.callId !== undefined && callIds.has(result.callId))
        expect(
          transferResults.length,
          `转账调用没有对应的 tool/result。${diagnostic}`,
        ).toBeGreaterThan(0)

        // 3) transfer_create 是写操作，必然走审批；黄级（演示档王建国为白名单收款人）
        //    只需 allow，红级则由 autoVerify 的强验证兜住。
        const decided = events.filter((event) => event.type === 'approval/decided')
        expect(decided.length, `审批没有被裁决（approval/decided 缺失）。${diagnostic}`).toBeGreaterThan(
          0,
        )

        // 4) turn 必须正常收尾（completed / blocked 都算"结束了"，这里只要求落账）
        expect(
          events.some((event) => event.type === 'turn/end'),
          `turn 没有收尾（turn/end 缺失）。${diagnostic}`,
        ).toBe(true)
      } finally {
        await app.dispose('e2e')
        rmSync(dir, { recursive: true, force: true })
      }
    },
    60_000,
  )
})
