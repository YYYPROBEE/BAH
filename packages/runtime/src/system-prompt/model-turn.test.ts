/**
 * 模型层参与的完整 turn（集成：会话 + 工具管线 + 提示词装配 + llm-mock）。
 *
 * **本文件的"驱动"是脚本化的**：阶段 5 落地主循环后，同样的断言改由
 * `agent-loop` 产生事件序列（T-LOOP-001 与 T-LLM-001 是同一件事的两面）。
 * 这里先证明**模型层把主循环需要的东西都备齐了**：
 * 流式分片能装配成调用/文本、工具能走七段管线落账、历史能从日志重建。
 */

import { asSessionId, fixedClock, withTestContext } from '@bah/test-support'
import { describe, expect, it } from 'vitest'

import type { ContentBlock, ToolDefinition } from '@bah/core'
import { LlmAdapterRegistry, UsageLedger, assembleStream } from '@bah/llm'
import type { ContentBlock as LlmContentBlock } from '@bah/llm'
import { MOCK_MODEL, MockLlmAdapter, textStep, toolCallStep } from '@bah/llm/mock'

import { SESSION_SERVICE, provideSession, type SessionApi } from '../session/service.ts'
import type { UsageSummaryData } from '../session/types.ts'
import { TOOLS_SERVICE, ToolGuard, ToolPipeline, fingerprintOf, provideTools } from '../tools/index.ts'
import { createDefaultPromptRegistry } from './index.ts'
import { beginAttempt, buildModelHistory } from './reconcile.ts'

/** 被测工具：一次转账（黄级，必须走审批）。 */
const TRANSFER_TOOL: ToolDefinition = {
  name: 'transfer_money',
  description: '转账',
  schema: {
    type: 'object',
    properties: { amount: { type: 'number' }, payee: { type: 'string' } },
    required: ['amount', 'payee'],
  },
  tier: { level: 'yellow', amountPath: 'amount' },
  execute: (args) => Promise.resolve(args),
  projectContent: () => [{ type: 'text', text: '转账成功' }],
}

/** 脚本化 turn 的依赖。 */
interface TurnDeps {
  readonly session: SessionApi
  readonly registry: LlmAdapterRegistry
  readonly pipeline: ToolPipeline
  readonly ledger: UsageLedger
}

/** 模型内容块 → 会话内容块（只保留文本；卡片/图片不走这条路径）。 */
function toSessionContent(content: readonly LlmContentBlock[]): ContentBlock[] {
  return content.flatMap((block) => (block.kind === 'text' ? [{ type: 'text' as const, text: block.text }] : []))
}

/**
 * 脚本化跑一个 turn（阶段 5 会被真实主循环替换）。
 *
 * 步骤与施工单 04 §2 伪代码同形：turn/start → preStep（装配提示词）→ step →
 * 模型流 → 工具调度 → 收尾 → turn/end。
 */
async function scriptedTurn(deps: TurnDeps, turn: number, userText: string): Promise<void> {
  const { session, registry, pipeline, ledger } = deps
  const prompt = createDefaultPromptRegistry()
  const composed = prompt.compose({
    capabilities: { toolCall: true, image: false, reasoning: false },
    tools: [TRANSFER_TOOL],
    channel: 'web',
    runtime: { user: { name: '张三' } },
  })

  session.append('turn/start', { turn })

  for (const step of [1, 2]) {
    session.append('step/start', { turn, step })
    beginAttempt({ session, turn, step, composed })
    if (step === 1) session.append('user/message', { content: userText, source: 'user' })

    // 请求：模型历史只从日志派生（阶段 5 的 `prepareRequest` 就是这几行）
    const adapter = registry.get('mock')
    const prepared = await adapter.prepareCall({
      modelId: MOCK_MODEL.id,
      messages: buildModelHistory(session.events()).map((message) => ({
        role: message.role,
        content: [{ kind: 'text' as const, text: typeof message.content === 'string' ? message.content : '' }],
      })),
    })
    const assembled = await assembleStream(adapter.stream(prepared, new AbortController().signal))
    ledger.record(turn, assembled.usage)

    session.append('assistant/message', {
      content: toSessionContent(assembled.content),
      ...(assembled.toolCalls.length === 0
        ? {}
        : {
            toolCalls: assembled.toolCalls.map((call) => ({
              callId: call.callId,
              name: call.name,
              args: call.args ?? {},
            })),
          }),
    })

    // 结束原因是 tool-calls → 逐个走七段管线
    for (const call of assembled.toolCalls) {
      await pipeline.execute({ callId: call.callId, name: call.name, args: call.args ?? {} })
    }

    session.append('step/end', { turn, step })
  }

  // turn 收尾：成本汇总落审计（施工单 05 §3）
  const usage = ledger.finishTurn(turn)
  if (usage !== undefined) session.append('usage/summary', usage)
  session.append('turn/end', { turn, reason: { kind: 'completed' } })
}

/** 装好一整套依赖并跑脚本化 turn。 */
async function withTurn(run: (deps: TurnDeps) => Promise<void>): Promise<void> {
  await withTestContext(async (test) => {
    const clock = fixedClock({ start: 1_000 })
    provideSession(test.ctx, { sessionId: asSessionId('s-turn'), now: clock.now })
    provideTools(test.ctx)
    // 治理平面（施工单 09 的插件线）在这里只是个测试替身：黄/红级 → ask，绿级直通。
    // 它证明的是"审批挂在接缝上"这件事——七段管线拿到的判决不来自工具体。
    test.ctx.events.on('tools/pre-execute', (input, next) => {
      const definition = test.ctx.get(TOOLS_SERVICE).get(input.call.name)
      if (definition.tier.level === 'green') return next(input)
      const amount = input.call.args['amount']
      return next({
        ...input,
        verdict: {
          kind: 'ask',
          ticket: {
            fingerprint: fingerprintOf(input.call),
            ...(typeof amount === 'number' ? { amount } : {}),
            ttlMs: 60_000,
          },
        },
      })
    })
    // 审批应答者：一律批准（渠道面属插件线，这里只证明管线能拿到结论）
    test.ctx.events.on('approval/request', (input, next) =>
      next({ ...input, decision: { decision: 'allowed-once' as const } }),
    )

    const session = test.ctx.get(SESSION_SERVICE)
    const registry = new LlmAdapterRegistry()
    registry.register(
      new MockLlmAdapter({
        script: {
          steps: [toolCallStep('call-1', 'transfer_money', { amount: 100, payee: '张三' }), textStep('已为你完成转账')],
        },
      }),
    )
    const pipeline = new ToolPipeline({
      ctx: test.ctx,
      registry: test.ctx.get(TOOLS_SERVICE),
      session,
      guard: new ToolGuard(),
      sessionId: session.sessionId,
      now: clock.now,
    })
    test.ctx.get(TOOLS_SERVICE).register(TRANSFER_TOOL)

    await run({ session, registry, pipeline, ledger: new UsageLedger() })
  })
}

describe('T-LLM-001 mock 跑通完整 turn（模型面）', () => {
  it('T-LLM-001 user → 模型 → 工具调用 → 结果 → assistant 收尾，事件序列完整', async () => {
    await withTurn(async (deps) => {
      await scriptedTurn(deps, 1, '帮我给张三转 100 元')

      expect(deps.session.events().map((event) => event.type)).toEqual([
        'turn/start',
        'step/start',
        'system/message',
        'request/context',
        'user/message', // runtime.context
        'user/message', // 用户原话
        'assistant/message', // 模型发起工具调用
        'tool/call',
        'approval/asked', // 黄级工具：先签票据
        'approval/decided',
        'tool/result',
        'step/end',
        'step/start',
        'system/message',
        'request/context',
        'user/message', // runtime.context
        'assistant/message', // 收尾
        'step/end',
        'usage/summary',
        'turn/end',
      ])

      // 工具结果走七段管线落账，且不是错误
      const result = deps.session.events().find((event) => event.type === 'tool/result')
      expect(result?.type === 'tool/result' && result.data.isError).toBe(false)
      expect(result?.type === 'tool/result' && result.data.content).toEqual([
        { type: 'text', text: '转账成功' },
      ])
      // 审批成对落账（黄级工具必须留痕）
      expect(
        deps.session.events().filter((event) => event.type === 'approval/asked'),
      ).toHaveLength(1)
      expect(
        deps.session.events().filter((event) => event.type === 'approval/decided'),
      ).toHaveLength(1)
    })
  })

  it('T-LLM-001 模型可见历史可从日志重建（system → 上下文 → 用户 → 调用 → 结果 → 收尾）', async () => {
    await withTurn(async (deps) => {
      await scriptedTurn(deps, 1, '帮我给张三转 100 元')

      const history = buildModelHistory(deps.session.events())
      // 顺序说明：system 头被提到最前（旧装配结果已撤回）；第 2 步的运行时上下文
      // 按时间顺序落在第 1 步的工具结果之后。
      expect(history.map((message) => message.role)).toEqual([
        'system',
        'user',
        'assistant',
        'tool',
        'user',
        'assistant',
      ])
      // 系统头与运行时上下文各就各位
      expect(history[0]).toEqual({ role: 'system', content: expect.stringContaining('安全底线') })
      expect(history[1]).toEqual({ role: 'user', content: '帮我给张三转 100 元' })
      // 工具结果与调用的 callId 配对（deriveMessages 不报空洞即证明）
      expect(history[3]).toEqual({
        role: 'tool',
        callId: 'call-1',
        name: 'transfer_money',
        isError: false,
        content: [{ type: 'text', text: '转账成功' }],
      })
      expect(history[4]).toEqual({ role: 'user', content: expect.stringContaining('姓名：张三') })
      expect(history[5]).toEqual({ role: 'assistant', content: [{ type: 'text', text: '已为你完成转账' }] })
    })
  })
})

describe('T-LLM-004 usage 记账落审计', () => {
  it('T-LLM-004 每 turn 汇总 tokens 落成 usage/summary 事件', async () => {
    await withTurn(async (deps) => {
      await scriptedTurn(deps, 1, '帮我给张三转 100 元')

      const event = deps.session.events().find((candidate) => candidate.type === 'usage/summary')
      expect(event).toBeDefined()
      if (event?.type !== 'usage/summary') throw new Error('unreachable')

      // 两步各一次调用，步骤用量累加（mock 每步上报 100/20）
      expect(event.data).toEqual({ turn: 1, input: 200, output: 40, calls: 2 })
      expect(deps.ledger.get(1)).toEqual(event.data)
      expect(deps.ledger.totals()).toEqual({ input: 200, output: 40 })

      // 与 @bah/llm 的 TurnUsage 同形（两处形状一旦漂移，这里编译失败）
      const typed: UsageSummaryData = { turn: 1, input: 200, output: 40, calls: 2 }
      expect(event.data).toEqual(typed)
    })
  })
})
