/**
 * 主循环状态机。
 *
 * 说明两件"看起来可以更优雅、但不许改"的事：
 * 1. **落账顺序 = 施单 04 §7 T-LOOP-001**：`tool/call → tool/result → assistant/message`
 *    （工具跑完，带 toolCalls 的 assistant 消息才收尾落账）。wire 要求「assistant(tool_calls)
 *    在 tool 消息之前」，这一顺序由 `deriveMessages` 的两遍投影恢复（阶段 8 R44）。
 * 2. **reject / 首个认领为空两处以 `turn/end` 收尾**：伪代码写的是 `return false`，
 *    照字面 return 会让 turn 永远不闭合；T-LOOP-002/011 要求"以 blocked / completed 关闭"。
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  asSessionId,
  captureThrown,
  createTestContext,
  fixedClock,
  waitFor,
  withTestContext,
  type TestContext,
} from '@bah/test-support'
import { describe, expect, it, vi } from 'vitest'

import type { SessionEvent, SessionEventMap, ToolDefinition } from '@bah/core'
import { LlmAdapterRegistry } from '@bah/llm'
import type {
  LlmAdapter,
  LlmRequest,
  ModelInfo,
  ModelSpec,
  PreparedCall,
  ProviderInfo,
  StreamChunk,
} from '@bah/llm'
import { MockLlmAdapter, textStep, toolCallStep, type MockStep } from '@bah/llm/mock'
import { JsonlPersistence } from '@bah/persistence'

import { AGENTS_SERVICE, provideAgents } from '../agent/index.ts'
import { currentSessionBuffer } from '../session/buffer.ts'
import { deriveMessages } from '../session/derive.ts'
import { SESSION_SERVICE, provideSession, type SessionApi } from '../session/service.ts'
import type { AppendOptions, AnySessionEvent, SessionEventType } from '../session/types.ts'
import { buildModelHistory, provideSystemPrompt } from '../system-prompt/index.ts'
import { TOOLS_SERVICE, provideTools } from '../tools/index.ts'
import type { ToolRegistry } from '../tools/index.ts'

import { AgentLoop, outcomeOf, resolveAgentLoopConfig, resolveParams, stickyReason } from './agent.ts'
import type { RuntimeContextProvider } from './agent.ts'
import type { RuntimeContextInvocation } from '../system-prompt/port.ts'
import type { RuntimeContextView } from '../system-prompt/types.ts'

/** 正常工具：绿级、回显参数。 */
const OK_TOOL: ToolDefinition = {
  name: 'ok_tool',
  description: '正常工具',
  schema: { type: 'object', properties: { amount: { type: 'number' } } },
  tier: { level: 'green' },
  execute: (args) => Promise.resolve({ ok: true, args }),
  projectContent: () => [{ type: 'text', text: 'ok' }],
}

/** 判决链会炸的工具（T-LOOP-006 的"step 中途抛错"）。 */
const BOOM_TOOL: ToolDefinition = {
  name: 'boom_tool',
  description: '判决链故障工具',
  schema: { type: 'object', properties: {} },
  tier: { level: 'green' },
  execute: () => Promise.resolve('never'),
}

interface Harness {
  readonly test: TestContext
  readonly session: SessionApi
  readonly registry: LlmAdapterRegistry
  readonly mock: MockLlmAdapter
  readonly loop: AgentLoop
  readonly tools: ToolRegistry
  events(): readonly AnySessionEvent[]
  types(): string[]
}

interface HarnessOptions {
  readonly steps: readonly MockStep[]
  readonly config?: unknown
  readonly channel?: 'web' | 'mobile' | 'im' | 'desktop' | 'headless' | 'sdk'
  /** 是否注入默认运行时上下文视图（默认注入，用来走 request/context 落账）。 */
  readonly runtime?: boolean
  /** 自定义取数函数（优先于 `runtime`；异步 / 抛错 / 记录 invocation 都用它）。 */
  readonly runtimeContext?: RuntimeContextProvider
  readonly sessionId?: string
  /** 包一层 adapter（T-LOOP-010 用）。 */
  readonly wrapAdapter?: (mock: MockLlmAdapter) => LlmAdapter
  /** 装配前先往会话里写历史（模拟"恢复已有会话"；构造 AgentLoop 之前执行）。 */
  readonly seed?: (session: SessionApi) => void
  /** 装配完成后、跑用例前挂监听器。 */
  readonly prepare?: (harness: Harness) => void
  /** 包一层会话（B3 并行 flush 失败隔离用）。 */
  readonly wrapSession?: (session: SessionApi) => SessionApi
  /** 入队前的全系统闸（W07 HALT）。 */
  readonly beforeSend?: () => void
}

async function withHarness(
  options: HarnessOptions,
  run: (harness: Harness) => Promise<void>,
): Promise<void> {
  await withTestContext(async (test) => {
    const clock = fixedClock({ start: 1_000 })
    provideSession(test.ctx, { sessionId: asSessionId(options.sessionId ?? 's-loop'), now: clock.now })
    provideTools(test.ctx)
    provideSystemPrompt(test.ctx)
    provideAgents(test.ctx)

    const tools = test.ctx.get(TOOLS_SERVICE)
    tools.register(OK_TOOL)

    const mock = new MockLlmAdapter({ script: { steps: options.steps }, chunkSize: 4 })
    const registry = new LlmAdapterRegistry()
    registry.register(options.wrapAdapter === undefined ? mock : options.wrapAdapter(mock))

    const rawSession = test.ctx.get(SESSION_SERVICE)
    const session = options.wrapSession?.(rawSession) ?? rawSession
    options.seed?.(session)
    const loop = new AgentLoop({
      ctx: test.ctx,
      session,
      registry,
      config: options.config ?? { model: 'mock:mock-chat' },
      now: clock.now,
      ...(options.channel === undefined ? {} : { channel: options.channel }),
      ...(options.runtimeContext !== undefined
        ? { runtimeContext: options.runtimeContext }
        : options.runtime === false
          ? {}
          : { runtimeContext: () => ({ user: { name: '张三' } }) }),
      ...(options.beforeSend === undefined ? {} : { beforeSend: options.beforeSend }),
    })

    const harness: Harness = {
      test,
      session,
      registry,
      mock,
      loop,
      tools,
      events: () => session.events(),
      types: () => session.events().map((event) => event.type),
    }
    options.prepare?.(harness)
    await run(harness)
  })
}

/** 日志里某类事件的载荷列表（测试断言用，避免满屏 `event.type === ...`）。 */
function payloads<T extends SessionEventType>(
  events: readonly AnySessionEvent[],
  type: T,
): SessionEventMap[T][] {
  return events.flatMap((event) => (event.type === type ? [event.data as SessionEventMap[T]] : []))
}

describe('T-LOOP-001 完整 turn（mock provider）', () => {
  it('T-LOOP-001 user → 模型 → 工具调用 → 结果 → assistant 收尾，事件序列完整', async () => {
    await withHarness(
      {
        steps: [toolCallStep('call-1', 'ok_tool', { amount: 100 }), textStep('已为你完成查询')],
        channel: 'web',
      },
      async (harness) => {
        harness.loop.send('帮我查一下')
        await harness.loop.run()

        expect(harness.types()).toEqual([
          'turn/start',
          'step/start',
          'request/header',
          'system/message',
          'request/context',
          'user/message', // 运行时上下文（runtime-context）
          'user/message', // 用户原话
          'tool/call',
          'tool/result',
          'assistant/message', // 模型发起工具调用（按施单 04 §7：工具结果之后收尾落账）
          'step/end',
          'step/start',
          'request/header',
          'system/message',
          'request/context',
          'user/message', // 第二次 attempt 的运行时上下文
          'assistant/message', // 收尾
          'step/end',
          'usage/summary',
          'turn/end',
        ])

        // 工具结果走七段管线落账，且不是错误
        const results = payloads(harness.events(), 'tool/result')
        expect(results).toHaveLength(1)
        expect(results[0]?.isError).toBe(false)
        expect(results[0]?.content).toEqual([{ type: 'text', text: 'ok' }])

        // 请求头记录冻结后的路由
        expect(payloads(harness.events(), 'request/header').map((header) => header.model)).toEqual([
          'mock-chat',
          'mock-chat',
        ])
        // 成本按 turn 汇总（mock 每步 100/20）
        expect(payloads(harness.events(), 'usage/summary')).toEqual([
          { turn: 1, input: 200, output: 40, calls: 2, cachedInput: 0, costMicroYuan: 0 },
        ])
        expect(payloads(harness.events(), 'turn/end')).toEqual([
          { turn: 1, reason: { kind: 'completed' } },
        ])
      },
    )
  })

  it('T-LOOP-001 模型可见历史可从日志重建（工具调用与结果配对）', async () => {
    await withHarness(
      { steps: [toolCallStep('call-1', 'ok_tool', { amount: 1 }), textStep('完成')] },
      async (harness) => {
        harness.loop.send('转 1 元')
        await harness.loop.run()

        // 模型可见历史 = 折叠 → reconcile（撤回过期上下文 / 旧系统头）→ 投影
        const history = buildModelHistory(harness.events())
        expect(history.map((message) => message.role)).toEqual([
          'system',
          'user',
          'assistant',
          'tool',
          'user',
          'assistant',
        ])
        expect(history[2]).toEqual({
          role: 'assistant',
          content: [],
          toolCalls: [{ callId: 'call-1', name: 'ok_tool', args: { amount: 1 } }],
        })
        expect(history[3]).toEqual({
          role: 'tool',
          callId: 'call-1',
          name: 'ok_tool',
          isError: false,
          content: [{ type: 'text', text: 'ok' }],
        })
      },
    )
  })
})

describe('T-LOOP-002 preStep reject', () => {
  it('T-LOOP-002 入口拒绝：turn 以 blocked 结束，无 step', async () => {
    await withHarness(
      {
        steps: [textStep('不会走到模型')],
        prepare: (harness) => {
          harness.test.ctx.events.on('agent/pre-step', (input, next) =>
            next({
              ...input,
              verdict: { kind: 'reject', code: 'entry-blocked', reason: '入口拒绝' },
            }),
          )
        },
      },
      async (harness) => {
        harness.loop.send('这条会被拒绝')
        await harness.loop.run()

        expect(harness.types()).toEqual(['turn/start', 'turn/end'])
        expect(payloads(harness.events(), 'turn/end')[0]).toEqual({
          turn: 1,
          reason: { kind: 'blocked' },
        })
        expect(harness.types()).not.toContain('step/start')
        // 被拒绝的输入不落账（"入口拒绝"= 这次输入没有被接受）
        expect(harness.types()).not.toContain('user/message')
      },
    )
  })
})

describe('T-LOOP-003 inbox 有待处理', () => {
  it('T-LOOP-003 turn 结束后 wakeDriver 被调用，新 turn 开启', async () => {
    await withHarness(
      {
        steps: [textStep('第一轮回复'), textStep('第二轮回复')],
        prepare: (harness) => {
          harness.test.ctx.events.on('agent/turn-stopping', (input) => {
            if (input.turn === 1) harness.loop.send('第二条消息')
          })
        },
      },
      async (harness) => {
        harness.loop.send('第一条消息')
        const wakesBefore = harness.loop.inbox.wakeCount

        await harness.loop.run()

        expect(harness.loop.inbox.wakeCount).toBeGreaterThan(wakesBefore)
        expect(harness.types().filter((type) => type === 'turn/start')).toHaveLength(2)
        expect(
          payloads(harness.events(), 'user/message')
            .filter((message) => message.source === 'user')
            .map((message) => message.content),
        ).toEqual(['第一条消息', '第二条消息'])
        expect(
          payloads(harness.events(), 'turn/end').map((end) => end.reason),
        ).toEqual([{ kind: 'completed' }, { kind: 'completed' }])
      },
    )
  })
})

describe('T-LOOP-004 steer', () => {
  it('T-LOOP-004 next-step 目标在当前 step 完成后立即被认领，不新开 turn', async () => {
    const requests: LlmRequest[] = []
    await withHarness(
      {
        steps: [toolCallStep('call-1', 'ok_tool', {}), textStep('按新的金额处理')],
        prepare: (harness) => {
          let steered = false
          harness.test.ctx.events.on('agent/request', (input, next) => {
            requests.push(input.request)
            if (!steered) {
              steered = true
              harness.loop.steer('改成 50')
            }
            return next(input)
          })
        },
      },
      async (harness) => {
        harness.loop.send('转 100')
        await harness.loop.run()

        expect(harness.types().filter((type) => type === 'turn/start')).toHaveLength(1)
        expect(harness.types().filter((type) => type === 'step/start')).toHaveLength(2)
        // 第二个请求的最后一条消息就是转向指令（当前 step 完成后立即认领）
        expect(requests[1]?.messages.at(-1)).toEqual({
          role: 'user',
          content: [{ kind: 'text', text: '改成 50' }],
        })
        // 转向消息落账在第二个 step 之内
        const secondStepAt = harness
          .events()
          .findIndex((event) => event.type === 'step/start' && event.data.step === 2)
        const steerAt = harness
          .events()
          .findIndex((event) => event.type === 'user/message' && event.data.content === '改成 50')
        expect(steerAt).toBeGreaterThan(secondStepAt)
      },
    )
  })
})

describe('T-LOOP-005 interrupt', () => {
  it('同批工具执行中中断：剩余调用补记 tool-interrupted，且不再执行', async () => {
    let lateExecuted = 0
    await withHarness(
      {
        steps: [
          {
            content: [
              { kind: 'tool-call', id: 'call-stop', name: 'stop_tool', args: {} },
              { kind: 'tool-call', id: 'call-late', name: 'late_tool', args: {} },
            ],
            finishReason: 'tool-calls',
          },
        ],
        prepare: (harness) => {
          harness.tools.register({
            name: 'stop_tool',
            description: '执行中触发中断',
            schema: { type: 'object' },
            tier: { level: 'green' },
            execute: async () => {
              harness.loop.interrupt('用户按下停止')
              return 'stopped'
            },
          })
          harness.tools.register({
            name: 'late_tool',
            description: '本批剩余调用',
            schema: { type: 'object' },
            tier: { level: 'green' },
            execute: async () => {
              lateExecuted += 1
              return 'late'
            },
          })
        },
        // 本用例钉串行取消语义：并行只读批次会让两个调用同时启动，
        // "剩余调用不执行"不再成立（并行语义见新增用例）。
        config: { model: 'mock:mock-chat', parallelReadTools: false },
      },
      async (harness) => {
        harness.loop.send('跑两个工具')
        await harness.loop.run()

        expect(lateExecuted).toBe(0)
        expect(
          payloads(harness.events(), 'tool/result').map((result) => [result.callId, result.code]),
        ).toEqual([
          ['call-stop', undefined],
          ['call-late', 'tool-interrupted'],
        ])
        expect(harness.types()).toContain('turn/end')
      },
    )
  })

  it('T-LOOP-005 turn/end.reason=aborted，AbortSignal 传播到 llm.stream（新 turn 换新 controller）', async () => {
    let captured: AbortSignal | undefined
    let streams = 0

    await withHarness(
      {
        steps: [textStep('这条回复不应落账'), textStep('第二条正常回复')],
        prepare: (harness) => {
          harness.test.ctx.events.on('llm/stream', (stream, next) =>
            next((call, signal) => {
              streams += 1
              if (streams === 1) {
                captured = signal
                harness.loop.interrupt('用户按下停止')
              }
              return stream(call, signal)
            }),
          )
        },
      },
      async (harness) => {
        harness.loop.send('你好')
        await harness.loop.run()

        expect(captured?.aborted).toBe(true)
        expect(payloads(harness.events(), 'turn/end')[0]?.reason).toEqual({ kind: 'aborted' })
        expect(harness.types()).not.toContain('assistant/message')
        expect(payloads(harness.events(), 'assistant/attempt')[0]?.status).toBe('cancelled')

        // 新 turn 换新 controller：旧的中断不会传染
        harness.loop.send('继续')
        await harness.loop.run()

        expect(streams).toBe(2)
        expect(payloads(harness.events(), 'turn/end').map((end) => end.reason)).toEqual([
          { kind: 'aborted' },
          { kind: 'completed' },
        ])
        expect(payloads(harness.events(), 'assistant/message')).toHaveLength(1)
      },
    )
  })
})

describe('T-LOOP-006 失败 step 补记', () => {
  it('T-LOOP-006 step 中途抛错：已执行工具补记 isError 的 tool/result', async () => {
    await withHarness(
      {
        steps: [
          {
            content: [
              { kind: 'tool-call', id: 'call-ok', name: 'ok_tool', args: {} },
              { kind: 'tool-call', id: 'call-boom', name: 'boom_tool', args: {} },
            ],
            finishReason: 'tool-calls',
          },
        ],
        prepare: (harness) => {
          harness.tools.register(BOOM_TOOL)
          harness.test.ctx.events.on('tools/pre-execute', (input, next) => {
            if (input.call.name === 'boom_tool') throw new Error('工具判决链故障')
            return next(input)
          })
        },
      },
      async (harness) => {
        harness.loop.send('跑两个工具')
        await expect(harness.loop.run()).rejects.toThrow(/工具判决链故障/)

        // 两个调用都还了债：执行完的带真实结果，没执行的补记 isError
        expect(payloads(harness.events(), 'tool/result').map((result) => [
          result.callId,
          result.isError,
          result.code,
        ])).toEqual([
          ['call-ok', false, undefined],
          ['call-boom', true, 'tool-interrupted'],
        ])
        // step 收尾了，turn 也必须闭合：异常逃逸不能留下未闭合 turn（否则回退边界丢失）
        expect(harness.types()).toContain('step/end')
        expect(harness.types()).toContain('turn/end')
        expect(payloads(harness.events(), 'turn/end').at(-1)).toMatchObject({
          reason: { kind: 'failed' },
        })

        // 失败路径也必须落承载消息：tool/result 在 assistant/message 之前（施单 04 §7 顺序）
        expect(
          harness
            .types()
            .filter((type) =>
              ['tool/call', 'tool/result', 'assistant/message', 'step/end'].includes(type),
            ),
        ).toEqual([
          'tool/call',
          'tool/result',
          'tool/call',
          'tool/result',
          'assistant/message',
          'step/end',
        ])
        expect(
          payloads(harness.events(), 'assistant/message')[0]?.toolCalls?.map((call) => call.callId),
        ).toEqual(['call-ok', 'call-boom'])
      },
    )
  })
})

describe('T-LOOP-007 max-tokens 粘性', () => {
  it('T-LOOP-007 后续 step 维持 max-tokens 直到 turn 关闭', async () => {
    await withHarness(
      {
        steps: [textStep('被截断的回复', 'length'), textStep('转向后的回复')],
      },
      async (harness) => {
        harness.loop.send('写一段长文')
        harness.loop.steer('继续写')
        await harness.loop.run()

        expect(harness.types().filter((type) => type === 'step/start')).toHaveLength(2)
        expect(
          payloads(harness.events(), 'assistant/message').map((message) => message.content),
        ).toEqual([
          [{ type: 'text', text: '被截断的回复' }],
          [{ type: 'text', text: '转向后的回复' }],
        ])
        // 第 2 步正常收尾，但粘性原因仍是 max-tokens
        expect(payloads(harness.events(), 'turn/end')[0]?.reason).toEqual({ kind: 'max-tokens' })
      },
    )
  })
})

describe('阶段 8：压缩判定前移（R44 收口）', () => {
  it('请求装配前折叠已完整结束的 turn；本轮不折叠，同一 turn 内判定幂等', async () => {
    await withHarness(
      {
        steps: [textStep('第一段'), textStep('第二段')],
        config: { model: 'mock:mock-chat', compaction: { maxTurns: 2, keepRecentTurns: 1 } },
        // 造 3 个已完整结束的 turn（模拟"进程恢复后带着长历史开工"）
        seed: (session) => {
          for (const turn of [1, 2, 3]) {
            session.append('turn/start', { turn })
            session.append('step/start', { turn, step: 1 })
            session.append('system/message', { content: `系统头 v${turn}` })
            session.append('user/message', { content: `第 ${turn} 轮问题` })
            session.append('assistant/message', {
              content: [{ type: 'text', text: `第 ${turn} 轮回答` }],
            })
            session.append('step/end', { turn, step: 1 })
            session.append('turn/end', { turn, reason: { kind: 'completed' } })
          }
        },
      },
      async (harness) => {
        harness.loop.send('新一轮问题')
        harness.loop.steer('再补一句')
        await harness.loop.run()

        const events = harness.events()
        const summaries = events.filter((event) => event.type === 'compaction/summary')
        // 折叠 turns 1..2（keepRecentTurns=1）：只有一个摘要（第二步判定不会重复折叠）
        expect(summaries).toHaveLength(1)
        expect(summaries[0]?.data.fromTurn).toBe(1)
        expect(summaries[0]?.data.toTurn).toBe(2)

        // 摘要落在本轮第一个 step/start 之后、请求落账之前 = 请求装配前判定
        const stepStarts = events.filter(
          (event) => event.type === 'step/start' && event.data.turn === 4,
        )
        const header = events.find((event) => event.type === 'request/header' && event.data.turn === 4)
        expect(stepStarts).toHaveLength(2)
        expect(summaries[0]!.seq).toBeGreaterThan(stepStarts[0]!.seq)
        expect(summaries[0]!.seq).toBeLessThan(header!.seq)

        // 折叠只影响投影：日志仍 append-only，模型历史仍可重建
        expect(() => deriveMessages(events)).not.toThrow()
      },
    )
  })
})

describe('T-LOOP-008 turn-stopping', () => {
  it('T-LOOP-008 listener 顺序执行；载荷带 turn/signal 与 stop()', async () => {
    const calls: string[] = []
    let payloadTurn = 0
    let stopIsFunction = false
    let hasNext = false

    await withHarness(
      {
        steps: [textStep('回复')],
        prepare: (harness) => {
          harness.test.ctx.events.on('agent/turn-stopping', (input, next) => {
            calls.push('first')
            payloadTurn = input.turn
            stopIsFunction = typeof input.stop === 'function'
            hasNext = typeof next === 'function'
            return undefined
          })
          harness.test.ctx.events.on('agent/turn-stopping', () => {
            calls.push('second')
          })
        },
      },
      async (harness) => {
        harness.loop.send('你好')
        await harness.loop.run()

        expect(calls).toEqual(['first', 'second'])
        expect(payloadTurn).toBe(1)
        expect(stopIsFunction).toBe(true)
        // serial 的 next 是透传函数（"无 next 参数"指不需要交还控制权）
        expect(hasNext).toBe(true)
      },
    )
  })

  it('T-LOOP-008 判停：即便队列里已有转向消息也不再继续（guard 的权力）', async () => {
    const disposers: (() => void)[] = []

    await withHarness(
      {
        steps: [textStep('第一段'), textStep('第二段')],
        prepare: (harness) => {
          disposers.push(
            harness.test.ctx.events.on('agent/turn-stopping', (input) => {
              // 想继续的钩子：往 next-step 推一条纠正提示
              harness.loop.steer('纠正提示')
              // 但循环 guard 判停：本 turn 不再继续
              input.stop('循环 guard：工具调用超上限')
            }),
          )
        },
      },
      async (harness) => {
        harness.loop.send('请自查')
        const reason = await harness.loop.turn()

        expect(reason).toEqual({ kind: 'guard-stopped', reason: '循环 guard：工具调用超上限' })
        // turn/end 落账的也是判停原因（不是 failed）
        expect(payloads(harness.events(), 'turn/end')[0]?.reason).toEqual({
          kind: 'guard-stopped',
          reason: '循环 guard：工具调用超上限',
        })
        expect(harness.types().filter((type) => type === 'step/start')).toHaveLength(1)
        // 判停优先于"还有转向消息"：消息留在队列里，交给下一轮
        expect(harness.loop.inbox.nextStep).toHaveLength(1)

        for (const dispose of disposers) dispose()
        await harness.loop.run()
        expect(harness.types().filter((type) => type === 'turn/start')).toHaveLength(2)
        expect(
          payloads(harness.events(), 'user/message').some(
            (message) => message.content === '纠正提示',
          ),
        ).toBe(true)
      },
    )
  })
})

describe('T-LOOP-009 agent/request 阶段取消', () => {
  it('T-LOOP-009 system/user 均不落账（取消就是没发生）', async () => {
    await withHarness(
      {
        steps: [textStep('不会发出')],
        prepare: (harness) => {
          harness.test.ctx.events.on('agent/request', (input, next) => {
            harness.loop.interrupt('请求装配阶段取消')
            return next(input)
          })
        },
      },
      async (harness) => {
        harness.loop.send('这条不该留下')
        await harness.loop.run()

        expect(payloads(harness.events(), 'turn/end')[0]?.reason).toEqual({ kind: 'aborted' })
        expect(payloads(harness.events(), 'assistant/attempt')[0]?.status).toBe('cancelled')
        const types = harness.types()
        expect(types).not.toContain('request/header')
        expect(types).not.toContain('system/message')
        expect(types).not.toContain('request/context')
        expect(types).not.toContain('user/message')
      },
    )
  })
})

describe('T-LOOP-010 prepareCall 阶段取消', () => {
  it('T-LOOP-010 system/user 均不落账', async () => {
    let loop: AgentLoop | undefined
    await withHarness(
      {
        steps: [textStep('不会发出')],
        wrapAdapter: (mock) =>
          new InterruptingAdapter(mock, () => loop?.interrupt('prepareCall 阶段取消')),
        prepare: (harness) => {
          loop = harness.loop
        },
      },
      async (harness) => {
        harness.loop.send('这条不该留下')
        await harness.loop.run()

        expect(payloads(harness.events(), 'turn/end')[0]?.reason).toEqual({ kind: 'aborted' })
        expect(payloads(harness.events(), 'assistant/attempt')[0]?.status).toBe('cancelled')
        const types = harness.types()
        expect(types).not.toContain('request/header')
        expect(types).not.toContain('system/message')
        expect(types).not.toContain('user/message')
      },
    )
  })
})

describe('T-LOOP-011 首个认领为空', () => {
  it('T-LOOP-011 turn 以 completed 关闭且无 step/start', async () => {
    await withHarness({ steps: [textStep('不该被消费')] }, async (harness) => {
      await harness.loop.run()

      expect(harness.types()).toEqual(['turn/start', 'turn/end'])
      expect(payloads(harness.events(), 'turn/end')[0]?.reason).toEqual({ kind: 'completed' })
      // 没有 step 就没有成本可报：不落 usage/summary
      expect(harness.types()).not.toContain('usage/summary')
    })
  })
})

describe('T-LOOP-013 JSONL 落盘', () => {
  it('T-LOOP-013 session.jsonl 存在，且可被 deriveMessages 重建', async () => {
    await withTestContext(async (test) => {
      const clock = fixedClock({ start: 1_000 })
      const sessionId = asSessionId('s-jsonl')
      provideSession(test.ctx, { sessionId, now: clock.now })
      provideTools(test.ctx)
      provideSystemPrompt(test.ctx)
      const base = test.ctx.get(SESSION_SERVICE)
      test.ctx.get(TOOLS_SERVICE).register(OK_TOOL)

      const dir = mkdtempSync(join(tmpdir(), 'bah-loop-'))
      // 本用例验证 seq 与投影的落盘一致性；PII 掩码会改写字符串（默认开启），
      // 这里关掉掩码；掩码本身由 persistence 的专项用例覆盖。
      const backend = new JsonlPersistence({ fsync: false, warn: () => {}, redact: false })
      try {
        const handle = backend.create(dir, sessionId, { now: 1_000 })
        // 落账面：会话服务 + JSONL 句柄（阶段 6 的 profile 会把两者装配成一条链）
        const session: SessionApi = {
          ...base,
          append<S extends SessionEventType>(
            type: S,
            data: SessionEventMap[S],
            options?: AppendOptions,
          ): SessionEvent<S> {
            const event = base.append(type, data, options)
            handle.append(event)
            return event
          },
        }

        const registry = new LlmAdapterRegistry()
        registry.register(
          new MockLlmAdapter({
            script: {
              steps: [toolCallStep('call-1', 'ok_tool', { amount: 1 }), textStep('已完成')],
            },
          }),
        )
        const loop = new AgentLoop({
          ctx: test.ctx,
          session,
          registry,
          config: { model: 'mock:mock-chat' },
          now: clock.now,
          channel: 'headless',
        })
        loop.send('转 1 元')
        await loop.run()

        const file = join(dir, 'session.jsonl')
        const lines = readFileSync(file, 'utf8')
          .split('\n')
          .filter((line) => line.length > 0)
        // header + 每条事件一行
        expect(lines).toHaveLength(session.lastSeq() + 1)
        expect(JSON.parse(lines[0] ?? '{}')).toMatchObject({
          kind: 'bah-session-header',
          sessionId: 's-jsonl',
        })

        // 重新打开：seq 与内存态一致，投影一致
        const opened = backend.open(dir)
        expect(opened.events().map((event) => event.seq)).toEqual(
          session.events().map((event) => event.seq),
        )
        const rebuilt = deriveMessages(opened.events() as AnySessionEvent[])
        expect(rebuilt).toEqual(deriveMessages(base.events()))
        expect(rebuilt.some((message) => message.role === 'tool' && message.callId === 'call-1')).toBe(
          true,
        )
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    })
  })
})

describe('主循环 · 补充用例（无编号）', () => {
  it('配置 fail-loud：未知键 / 缺 model / 非法参数 / 非法 maxSteps', () => {
    expect(captureThrown(() => resolveAgentLoopConfig(null)).code).toBe('agent-invalid-config')
    expect(captureThrown(() => resolveAgentLoopConfig({ model: 'm', extra: 1 })).code).toBe(
      'agent-invalid-config',
    )
    expect(captureThrown(() => resolveAgentLoopConfig({})).code).toBe('agent-invalid-config')
    expect(captureThrown(() => resolveAgentLoopConfig({ model: '   ' })).code).toBe(
      'agent-invalid-config',
    )
    expect(
      captureThrown(() => resolveAgentLoopConfig({ model: 'm', params: { seed: 1 } })).code,
    ).toBe('agent-invalid-config')
    expect(
      captureThrown(() => resolveAgentLoopConfig({ model: 'm', params: { temperature: 3 } })).code,
    ).toBe('agent-invalid-config')
    expect(
      captureThrown(() => resolveAgentLoopConfig({ model: 'm', params: { maxTokens: 0 } })).code,
    ).toBe('agent-invalid-config')
    expect(
      captureThrown(() => resolveAgentLoopConfig({ model: 'm', maxSteps: 0 })).code,
    ).toBe('agent-invalid-config')
    expect(
      captureThrown(() => resolveAgentLoopConfig({ model: 'm', compaction: {} })).code,
    ).toBe('compaction-invalid-config')
    expect(
      captureThrown(() => resolveAgentLoopConfig({ model: 'm', parallelReadTools: 'yes' })).code,
    ).toBe('agent-invalid-config')
  })

  it('配置校验通过后的形状（默认 maxSteps / 参数解析 / 压缩配置透传）', () => {
    expect(resolveParams({ temperature: 0.1, topP: 0.9, maxTokens: 256, stop: ['\n'] })).toEqual({
      temperature: 0.1,
      topP: 0.9,
      maxTokens: 256,
      stop: ['\n'],
    })
    expect(captureThrown(() => resolveParams('x')).code).toBe('agent-invalid-config')
    expect(captureThrown(() => resolveParams({ temperature: 'x' })).code).toBe('agent-invalid-config')
    expect(captureThrown(() => resolveParams({ stop: '' })).code).toBe('agent-invalid-config')

    const config = resolveAgentLoopConfig({
      model: ' mock:mock-chat ',
      params: { temperature: 0.5 },
      compaction: { maxTurns: 4, keepRecentTurns: 1 },
    })
    expect(config.model).toBe('mock:mock-chat')
    expect(config.maxSteps).toBe(32)
    expect(config.params).toEqual({ temperature: 0.5 })
    expect(config.compaction).toEqual({ maxTurns: 4, keepRecentTurns: 1 })
  })

  it('outcomeOf / stickyReason：结束原因映射与粘性', () => {
    expect(outcomeOf('stop')).toEqual({ kind: 'completed' })
    expect(outcomeOf('tool-calls')).toBeNull()
    expect(outcomeOf('length')).toEqual({ kind: 'max-tokens' })
    expect(outcomeOf('aborted')).toEqual({ kind: 'aborted' })
    expect(outcomeOf('error')).toEqual({ kind: 'failed', reason: '模型以 error 结束' })
    expect(captureThrown(() => outcomeOf('ghost' as never)).code).toBe('unreachable-branch')
    expect(stickyReason(null, { kind: 'max-tokens' })).toEqual({ kind: 'max-tokens' })
    expect(
      stickyReason({ kind: 'max-tokens' }, { kind: 'completed' }),
    ).toEqual({ kind: 'max-tokens' })
    expect(stickyReason(null, null)).toBeNull()
  })

  it('模型解析失败：turn 以 failed 关闭并留痕（不猜默认模型）', async () => {
    await withHarness(
      { steps: [textStep('不会发出')], config: { model: 'nope:nope-chat' } },
      async (harness) => {
        harness.loop.send('你好')
        const reason = await harness.loop.turn()

        expect(reason.kind === 'failed' && reason.reason).toContain('模型解析')
        expect(payloads(harness.events(), 'assistant/attempt')[0]?.status).toBe('failed')
        expect(payloads(harness.events(), 'turn/end')[0]?.reason).toEqual(reason)
      },
    )
  })

  it('prepareCall 抛错：turn 以 failed 关闭（请求没发出去，system/user 也不落账）', async () => {
    await withHarness(
      {
        steps: [textStep('不会发出')],
        wrapAdapter: (mock) => new PrepareFailingAdapter(mock, () => new Error('缺少 API Key')),
      },
      async (harness) => {
        harness.loop.send('你好')
        const reason = await harness.loop.turn()

        expect(reason.kind === 'failed' && reason.reason).toContain('缺少 API Key')
        expect(harness.types()).not.toContain('system/message')
        expect(payloads(harness.events(), 'assistant/attempt')[0]?.status).toBe('failed')
      },
    )
  })

  it('prepareCall 抛 AbortError（平台取消）：按取消收尾', async () => {
    await withHarness(
      {
        steps: [textStep('不会发出')],
        wrapAdapter: (mock) =>
          new PrepareFailingAdapter(
            mock,
            () => Object.assign(new Error('调用被中止'), { name: 'AbortError' }),
          ),
      },
      async (harness) => {
        harness.loop.send('你好')
        const reason = await harness.loop.turn()

        expect(reason).toEqual({ kind: 'aborted' })
        expect(payloads(harness.events(), 'assistant/attempt')[0]?.status).toBe('cancelled')
      },
    )
  })

  it('模型流以 aborted 结束（信号未被取消）：仍按取消收尾，不落 assistant 消息', async () => {
    await withHarness(
      {
        steps: [{ content: [{ kind: 'text', text: '半截回复' }], finishReason: 'aborted' }],
      },
      async (harness) => {
        harness.loop.send('你好')
        const reason = await harness.loop.turn()

        expect(reason).toEqual({ kind: 'aborted' })
        expect(harness.types()).not.toContain('assistant/message')
        expect(payloads(harness.events(), 'assistant/attempt')[0]?.status).toBe('cancelled')
      },
    )
  })

  it('agent/pre-step 可改写认领消息并标记 startsRequestSeries（透传不破坏 turn）', async () => {
    await withHarness(
      {
        steps: [textStep('改写后的回复')],
        prepare: (harness) => {
          harness.test.ctx.events.on('agent/pre-step', (input, next) =>
            next({
              ...input,
              verdict: {
                kind: 'enter',
                messages: input.messages.map((message) => ({
                  ...message,
                  text: `${message.text}（归一化）`,
                })),
                startsRequestSeries: true,
              },
            }),
          )
        },
      },
      async (harness) => {
        harness.loop.send('  你好  ')
        const reason = await harness.loop.turn()

        expect(reason).toEqual({ kind: 'completed' })
        expect(
          payloads(harness.events(), 'user/message')
            .filter((message) => message.source === 'user')
            .map((message) => message.content),
        ).toEqual(['你好（归一化）'])
      },
    )
  })

  it('未注入时钟时用系统时间（默认值可被覆盖，但不是必须）', async () => {
    await withTestContext(async (test) => {
      provideSession(test.ctx, { sessionId: asSessionId('s-default-clock') })
      provideTools(test.ctx)
      provideSystemPrompt(test.ctx)
      test.ctx.get(TOOLS_SERVICE).register(OK_TOOL)
      const registry = new LlmAdapterRegistry()
      registry.register(
        new MockLlmAdapter({
          script: { steps: [toolCallStep('call-1', 'ok_tool', {}), textStep('完成')] },
        }),
      )

      const loop = new AgentLoop({
        ctx: test.ctx,
        session: test.ctx.get(SESSION_SERVICE),
        registry,
        config: { model: 'mock:mock-chat' },
      })
      loop.send('你好')
      await loop.run()

      expect(payloads(loop.session.events(), 'turn/end')).toHaveLength(1)
      // turn 与工具事件都带了真实时间戳（默认 `now` 生效）
      expect(payloads(loop.session.events(), 'tool/call')[0]?.at).toBeGreaterThan(0)
    })
  })

  it('step 数超上限：turn 以 failed 关闭（防模型无限要工具）', async () => {
    await withHarness(
      {
        steps: [toolCallStep('c1', 'ok_tool', {}), toolCallStep('c2', 'ok_tool', {}), toolCallStep('c3', 'ok_tool', {})],
        config: { model: 'mock:mock-chat', maxSteps: 2 },
      },
      async (harness) => {
        harness.loop.send('一直调工具')
        const reason = await harness.loop.turn()

        expect(reason).toEqual({ kind: 'failed', reason: 'step 数超过上限（2）' })
        expect(harness.types().filter((type) => type === 'step/start')).toHaveLength(2)
        expect(payloads(harness.events(), 'turn/end')[0]?.reason).toEqual(reason)
      },
    )
  })

  it('模型以 tool-calls 结束却没给任何调用：拒绝空转（不静默 completed）', async () => {
    await withHarness(
      {
        steps: [{ content: [{ kind: 'text', text: '假装要调工具' }], finishReason: 'tool-calls' }],
      },
      async (harness) => {
        harness.loop.send('试试')
        const reason = await harness.loop.turn()

        expect(reason.kind).toBe('failed')
        expect(payloads(harness.events(), 'assistant/attempt')[0]?.status).toBe('failed')
        expect(payloads(harness.events(), 'turn/end')[0]?.reason.kind).toBe('failed')
      },
    )
  })

  it('agent 注册表：注册可逆、重名即抛、未注册即抛', async () => {
    await withHarness({ steps: [] }, async (harness) => {
      const registry = harness.test.ctx.get(AGENTS_SERVICE)
      const disposer = registry.register(harness.loop)
      expect(registry.get(harness.loop.id)).toBe(harness.loop)
      expect(registry.has(harness.loop.id)).toBe(true)
      expect(registry.ids()).toEqual([harness.loop.id])
      expect(captureThrown(() => registry.register(harness.loop)).code).toBe('agent-duplicate')

      disposer()
      expect(registry.has(harness.loop.id)).toBe(false)
      expect(captureThrown(() => registry.get(harness.loop.id)).code).toBe('agent-missing')
      // 注销幂等
      disposer()
    })
  })

  it('dispose 之后拒绝驱动（agent-disposed）；并发 run 报 agent-busy', async () => {
    await withHarness({ steps: [textStep('第一轮')] }, async (harness) => {
      harness.loop.send('你好')
      const running = harness.loop.run()
      await expect(harness.loop.run()).rejects.toThrow(/正在运行/)
      await running

      harness.loop.dispose('测试收尾')
      expect(harness.loop.status).toBe('disposed')
      expect(captureThrown(() => harness.loop.send('太晚了')).code).toBe('agent-disposed')
      await expect(harness.loop.run()).rejects.toThrow(/已 dispose/)
    })
  })

  it('drive：空队列挂起，send 唤醒后跑一轮，dispose 退出', async () => {
    await withHarness({ steps: [textStep('常驻回复')] }, async (harness) => {
      const driving = harness.loop.drive()
      await waitFor(() => harness.loop.status === 'running', { label: 'drive 进入运行态' })

      harness.loop.send('常驻场景的输入')
      await waitFor(() => payloads(harness.events(), 'turn/end').length === 1, {
        label: '常驻驱动跑完一轮',
      })

      harness.loop.dispose()
      await driving

      expect(payloads(harness.events(), 'turn/end')[0]?.reason).toEqual({ kind: 'completed' })
    })
  })

  it('agent.inject：运行时上下文进下一次被认领的请求并落账', async () => {
    await withHarness(
      { steps: [textStep('好')], runtime: false },
      async (harness) => {
        harness.loop.inject('系统注入：今天是工作日')
        harness.loop.send('今天几号')
        await harness.loop.run()

        expect(payloads(harness.events(), 'request/context')[0]?.texts).toEqual([
          '系统注入：今天是工作日',
        ])
        expect(
          payloads(harness.events(), 'user/message').some(
            (message) =>
              message.source === 'runtime-context' &&
              message.content.includes('系统注入：今天是工作日'),
          ),
        ).toBe(true)
      },
    )
  })

  it('fork：新 agent 续号、forkInfo 正确、共享注册表', async () => {
    await withHarness(
      { steps: [textStep('第一轮'), textStep('分叉后的第一轮')] },
      async (harness) => {
        harness.loop.send('原会话第一轮')
        await harness.loop.run()

        const child = createTestContext()
        try {
          const forked = harness.loop.fork({
            sessionId: asSessionId('s-forked'),
            turn: 1,
            ctx: child.ctx,
          })

          expect(forked.forkInfo).toEqual({
            parentSession: harness.session.sessionId,
            seedLength: harness.session.lastSeq(),
            turn: 1,
          })
          expect(forked.id).not.toBe(harness.loop.id)
          expect(forked.session.lastSeq()).toBe(harness.session.lastSeq())

          // 原会话不动
          const originalLength = harness.session.lastSeq()
          forked.send('分叉后的输入')
          await forked.run()

          expect(harness.session.lastSeq()).toBe(originalLength)
          expect(payloads(forked.session.events(), 'turn/start').map((item) => item.turn)).toEqual([
            1,
            2,
          ])
        } finally {
          await child.dispose('fork-finished')
        }
      },
    )
  })
})

/** T-LOOP-010 用：在 `prepareCall` 里触发中断的适配器包装。 */
class InterruptingAdapter implements LlmAdapter {
  constructor(
    private readonly inner: MockLlmAdapter,
    private readonly onPrepare: () => void,
  ) {}

  providerInfo(): ProviderInfo {
    return this.inner.providerInfo()
  }

  listModels(): Promise<readonly ModelInfo[]> {
    return this.inner.listModels()
  }

  resolveModel(modelId: string): ModelSpec {
    return this.inner.resolveModel(modelId)
  }

  prepareCall(request: LlmRequest): Promise<PreparedCall> {
    this.onPrepare()
    return this.inner.prepareCall(request)
  }

  stream(call: PreparedCall, signal: AbortSignal): AsyncIterable<StreamChunk> {
    return this.inner.stream(call, signal)
  }
}

/** `prepareCall` 直接抛错的适配器包装（缺密钥 / 平台取消两种形态）。 */
class PrepareFailingAdapter implements LlmAdapter {
  constructor(
    private readonly inner: MockLlmAdapter,
    private readonly errorOf: () => Error,
  ) {}

  providerInfo(): ProviderInfo {
    return this.inner.providerInfo()
  }

  listModels(): Promise<readonly ModelInfo[]> {
    return this.inner.listModels()
  }

  resolveModel(modelId: string): ModelSpec {
    return this.inner.resolveModel(modelId)
  }

  prepareCall(): Promise<PreparedCall> {
    return Promise.reject(this.errorOf())
  }

  stream(call: PreparedCall, signal: AbortSignal): AsyncIterable<StreamChunk> {
    return this.inner.stream(call, signal)
  }
}

describe('T-LOOP-014 收尾段异常', () => {
  it('usage/summary 落账失败：turn/end 仍落账，异常随后抛出', async () => {
    await withTestContext(async (test) => {
      const clock = fixedClock({ start: 1_000 })
      provideSession(test.ctx, { sessionId: asSessionId('s-close-error'), now: clock.now })
      provideTools(test.ctx)
      provideSystemPrompt(test.ctx)
      provideAgents(test.ctx)
      const base = test.ctx.get(SESSION_SERVICE)
      test.ctx.get(TOOLS_SERVICE).register(OK_TOOL)

      const session: SessionApi = {
        ...base,
        append<S extends SessionEventType>(
          type: S,
          data: SessionEventMap[S],
          options?: AppendOptions,
        ): SessionEvent<S> {
          if (type === 'usage/summary') throw new Error('summary sink down')
          return base.append(type, data, options)
        },
      }
      const registry = new LlmAdapterRegistry()
      registry.register(new MockLlmAdapter({ script: { steps: [textStep('好的')] } }))
      const loop = new AgentLoop({
        ctx: test.ctx,
        session,
        registry,
        config: { model: 'mock:mock-chat' },
        now: clock.now,
      })
      loop.send('你好')
      await expect(loop.run()).rejects.toThrow(/summary sink down/)
      expect(session.events().some((event) => event.type === 'turn/end')).toBe(true)
    })
  })
})

describe('T-LOOP-015 只读工具并行（P-P4）', () => {
  it('两个 green 调用并发执行；事件仍按调用顺序 flush', async () => {
    let active = 0
    let maxActive = 0
    await withHarness(
      {
        steps: [
          {
            content: [
              { kind: 'tool-call', id: 'call-slow', name: 'slow_tool', args: {} },
              { kind: 'tool-call', id: 'call-fast', name: 'fast_tool', args: {} },
            ],
            finishReason: 'tool-calls',
          },
        ],
        prepare: (harness) => {
          harness.tools.register({
            name: 'slow_tool',
            description: '慢只读工具',
            schema: { type: 'object' },
            tier: { level: 'green' },
            sideEffect: 'read',
            execute: async () => {
              harness.session.appendDomain('read/slow', {}, { ignorable: true })
              active += 1
              maxActive = Math.max(maxActive, active)
              await new Promise((resolve) => setTimeout(resolve, 20))
              active -= 1
              return 'slow'
            },
          })
          harness.tools.register({
            name: 'fast_tool',
            description: '快只读工具',
            schema: { type: 'object' },
            tier: { level: 'green' },
            sideEffect: 'read',
            execute: async () => {
              harness.session.appendDomain('read/fast', {}, { ignorable: true })
              active += 1
              maxActive = Math.max(maxActive, active)
              active -= 1
              return 'fast'
            },
          })
        },
      },
      async (harness) => {
        harness.loop.send('并行查两个')
        await harness.loop.run()

        expect(maxActive).toBe(2)
        // 事件顺序仍是模型给出的调用顺序（slow → fast），不是完成顺序
        expect(payloads(harness.events(), 'tool/call').map((call) => call.name)).toEqual([
          'slow_tool',
          'fast_tool',
        ])
        expect(payloads(harness.events(), 'tool/result').map((result) => result.callId)).toEqual([
          'call-slow',
          'call-fast',
        ])
        // 领域审计也走同一缓冲：按调用顺序，而不是完成顺序
        expect(
          harness.events().filter((event) => event.type.startsWith('read/')).map((event) => event.type),
        ).toEqual(['read/slow', 'read/fast'])
      },
    )
  })

  it('D1：单批最多 8 个——9 个只读调用分两批，第 9 个不与前 8 个同时跑', async () => {
    // 为什么钉这个：`MAX_PARALLEL_READS` 是"防打爆"的工程底线（模型一口气要 20 个只读调用时
    // 全部同时打出去会吃光 CPU/句柄/上游配额）。它原本只有常量与注释、没有任何断言，
    // 改坏了不会被任何用例拦住。这里的判据是"同时在跑的最大数"。
    let active = 0
    let maxActive = 0
    const CALLS = 9
    await withHarness(
      {
        steps: [
          {
            content: Array.from({ length: CALLS }, (_unused, index) => ({
              kind: 'tool-call' as const,
              id: `call-${String(index)}`,
              name: 'probe_tool',
              args: { index },
            })),
            finishReason: 'tool-calls',
          },
        ],
        prepare: (harness) => {
          harness.tools.register({
            name: 'probe_tool',
            description: '只读探针（记录并发度）',
            schema: { type: 'object' },
            tier: { level: 'green' },
            sideEffect: 'read',
            execute: async () => {
              harness.session.appendDomain('read/probe', {}, { ignorable: true })
              active += 1
              maxActive = Math.max(maxActive, active)
              // 让出一次事件循环：不 await 的话 9 个调用会顺序跑完，测不出并发
              await new Promise((resolve) => setTimeout(resolve, 5))
              active -= 1
              return 'ok'
            },
          })
        },
      },
      async (harness) => {
        harness.loop.send('九个只读调用')
        await harness.loop.run()

        // 上限是 8：第 9 个必须等第一批收尾
        expect(maxActive).toBe(8)
        // 全部 9 个都执行了（上限不是丢弃），且结果按调用顺序落账
        const results = payloads(harness.events(), 'tool/result')
        expect(results).toHaveLength(CALLS)
        expect(results.map((result) => result.callId)).toEqual(
          Array.from({ length: CALLS }, (_unused, index) => `call-${String(index)}`),
        )
      },
    )
  })

  it('并行批次 flush 失败隔离：后续缓冲继续 flush，结果广播失败落审计，最终聚合报错', async () => {
    let active = 0
    let maxActive = 0
    let auditAttempts = 0
    const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined)

    await withHarness(
      {
        steps: [
          {
            content: [
              { kind: 'tool-call', id: 'call-slow', name: 'slow_tool', args: {} },
              { kind: 'tool-call', id: 'call-fast', name: 'fast_tool', args: {} },
            ],
            finishReason: 'tool-calls',
          },
        ],
        wrapSession: (session): SessionApi => ({
          ...session,
          append: ((type: string, data: unknown, options?: AppendOptions) => {
            if (type === 'tool/callback-failed' && currentSessionBuffer() === undefined) {
              auditAttempts += 1
              // 第一条审计成功落账，第二条让审计通道也失败（覆盖 console.error 兜底）。
              if (auditAttempts >= 2) throw new Error('audit down')
            }
            return session.append(type as never, data as never, options)
          }) as SessionApi['append'],
          // 执行期（有 buffer）正常记录；flush 期（无 buffer）让领域事件写失败。
          appendDomain: (type, data, options) => {
            if (currentSessionBuffer() === undefined && type.startsWith('read/')) {
              throw new Error(`flush boom: ${type}`)
            }
            return session.appendDomain(type, data, options)
          },
        }),
        prepare: (harness) => {
          harness.test.ctx.events.on('tools/result', () => {
            throw new Error('broadcast boom')
          })
          const register = (name: string, ms: number): void => {
            harness.tools.register({
              name,
              description: `${name} 只读工具`,
              schema: { type: 'object' },
              tier: { level: 'green' },
              sideEffect: 'read',
              execute: async () => {
                active += 1
                maxActive = Math.max(maxActive, active)
                await delay(ms)
                active -= 1
                harness.session.appendDomain(`read/${name}`, {}, { ignorable: true })
                return name
              },
            })
          }
          register('slow_tool', 20)
          register('fast_tool', 1)
        },
      },
      async (harness) => {
        harness.loop.send('并行查两个')
        await expect(harness.loop.run()).rejects.toThrow(/并行批次失败/)
        expect(maxActive).toBe(2)
        const callbackFailures = harness
          .events()
          .filter(
            (event) =>
              event.type === 'tool/callback-failed' && event.data.stage === 'emit-result',
          )
        expect(callbackFailures.length).toBeGreaterThan(0)
        expect(auditAttempts).toBeGreaterThanOrEqual(2)
        expect(spy).toHaveBeenCalled()
        spy.mockRestore()
      },
    )
  })
})

describe('beforeSend（W07 全系统闸）', () => {
  it('闸抛错 → 输入不入队；放行后正常入队（闸不改变既有时序）', async () => {
    let armed = true
    await withHarness(
      {
        steps: [textStep('收到')],
        beforeSend: () => {
          if (armed) {
            throw Object.assign(new Error('系统已 HALT'), { code: 'safety-halted' })
          }
        },
      },
      async (harness) => {
        expect(() => harness.loop.send('这条不该入队')).toThrowError(/系统已 HALT/)
        expect(harness.loop.inbox.pending).toBe(0)
        expect(harness.types()).not.toContain('turn/start')

        armed = false
        harness.loop.send('这条可以入队')
        expect(harness.loop.inbox.pending).toBe(1)
        await harness.loop.run()
        expect(harness.types()).toContain('turn/start')
      },
    )
  })
})

/* ────────────────────────────────────────────────────────────────────────────
 * 实体槽位：运行时上下文端口（S1 · ES-13…ES-17）
 * ──────────────────────────────────────────────────────────────────────────── */

describe('实体槽位：运行时上下文解析（S1）', () => {
  it('每个 step 调一次，invocation 带 turn / step / 当前 sessionId', async () => {
    const calls: RuntimeContextInvocation[] = []
    await withHarness(
      {
        steps: [textStep('好的')],
        runtimeContext: (invocation) => {
          calls.push(invocation)
          return { user: { name: '张三' } }
        },
      },
      async (harness) => {
        harness.loop.send('你好')
        await harness.loop.run()

        expect(calls).toHaveLength(1)
        expect(calls[0]?.sessionId).toBe(asSessionId('s-loop'))
        expect(calls[0]?.turn).toBe(1)
        expect(calls[0]?.step).toBe(1)
        expect(calls[0]?.forkOf).toBeUndefined()
        expect(typeof calls[0]?.now).toBe('function')
      },
    )
  })

  it('每 step 现算：两步返回不同视图 → 两段 request/context 不同（I3）', async () => {
    let round = 0
    await withHarness(
      {
        steps: [toolCallStep('call-1', 'ok_tool', { amount: 1 }), textStep('完成')],
        runtimeContext: () => {
          round += 1
          return { user: { name: round === 1 ? '张三' : '李四' } }
        },
      },
      async (harness) => {
        harness.loop.send('查一下')
        await harness.loop.run()

        const contexts = payloads(harness.events(), 'request/context')
        expect(contexts).toHaveLength(2)
        expect(contexts[0]?.texts.join('')).toContain('张三')
        expect(contexts[1]?.texts.join('')).toContain('李四')
      },
    )
  })

  it('解析挂起时 interrupt → 该 step 不提交 system/user/context', async () => {
    let resolveLate: ((view: RuntimeContextView) => void) | undefined
    let entered = false
    await withHarness(
      {
        steps: [textStep('不该走到这里')],
        runtimeContext: () =>
          new Promise<RuntimeContextView>((resolve) => {
            entered = true
            resolveLate = resolve
          }),
      },
      async (harness) => {
        harness.loop.send('你好')
        const running = harness.loop.turn()
        await waitFor(() => entered)

        harness.loop.interrupt('用户按下停止')
        resolveLate?.({ user: { name: '张三' } })
        const outcome = await running

        expect(outcome).toEqual({ kind: 'aborted' })
        expect(harness.types()).not.toContain('request/header')
        expect(harness.types()).not.toContain('system/message')
        expect(harness.types()).not.toContain('request/context')
        expect(payloads(harness.events(), 'assistant/attempt')[0]?.status).toBe('cancelled')
      },
    )
  })

  it('解析抛普通 Error → turn failed（bug 是异常，不是降级值）', async () => {
    await withHarness(
      {
        steps: [textStep('x')],
        runtimeContext: () => {
          throw new Error('boom')
        },
      },
      async (harness) => {
        harness.loop.send('你好')
        const outcome = await harness.loop.turn()

        expect(outcome).toEqual({ kind: 'failed', reason: '运行时上下文：boom' })
        expect(payloads(harness.events(), 'assistant/attempt')[0]?.reason).toContain('运行时上下文')
        expect(harness.types()).not.toContain('request/header')
      },
    )
  })

  it('解析拒绝时已 interrupt → 记 cancelled（取消优先于失败）', async () => {
    let rejectLate: ((error: Error) => void) | undefined
    let entered = false
    await withHarness(
      {
        steps: [textStep('不该走到这里')],
        runtimeContext: () =>
          new Promise<RuntimeContextView>((_resolve, reject) => {
            entered = true
            rejectLate = reject
          }),
      },
      async (harness) => {
        harness.loop.send('你好')
        const running = harness.loop.turn()
        await waitFor(() => entered)

        harness.loop.interrupt('用户按下停止')
        rejectLate?.(new Error('端口忽略了取消'))
        const outcome = await running

        expect(outcome).toEqual({ kind: 'aborted' })
        expect(payloads(harness.events(), 'assistant/attempt')[0]?.status).toBe('cancelled')
        expect(harness.types()).not.toContain('request/header')
      },
    )
  })

  it('bank 视图 → 落 context/slots 事件，payload 不含 PII', async () => {
    await withHarness(
      {
        steps: [textStep('好的')],
        runtimeContext: () => ({
          user: { name: '张三' },
          accounts: [
            {
              name: '活期',
              maskedNumber: '1234',
              balanceText: '¥12,345.67',
              availableText: '¥12,345.67',
            },
          ],
          recentTransactions: ['2026-10-23 12:57 转出 ¥68.00（消费）'],
          notes: ['演示数据'],
          meta: { source: 'bank', status: 'ok', asOfText: '2026-10-28 12:57' },
        }),
      },
      async (harness) => {
        harness.loop.send('你好')
        await harness.loop.run()

        const slots = harness
          .events()
          .filter((event) => (event as { type: string }).type === 'context/slots')
        expect(slots).toHaveLength(1)
        expect(slots[0]?.data).toEqual({
          source: 'bank',
          status: 'ok',
          accounts: 1,
          transactions: 1,
          asOfText: '2026-10-28 12:57',
        })

        const payload = JSON.stringify(slots[0]?.data)
        expect(payload).not.toContain('张三')
        expect(payload).not.toContain('1234')
        expect(payload).not.toContain('¥')
      },
    )
  })

  it('静态视图（无 meta）→ 不落 context/slots', async () => {
    await withHarness({ steps: [textStep('好的')] }, async (harness) => {
      harness.loop.send('你好')
      await harness.loop.run()

      expect(
        harness.events().filter((event) => (event as { type: string }).type === 'context/slots'),
      ).toHaveLength(0)
    })
  })

  it('fork：子 loop 的 invocation 是子会话，forkOf 是父会话（I12）', async () => {
    const calls: RuntimeContextInvocation[] = []
    await withHarness(
      {
        steps: [textStep('第一轮'), textStep('分叉后')],
        runtimeContext: (invocation) => {
          calls.push(invocation)
          return { user: { name: '张三' } }
        },
      },
      async (harness) => {
        harness.loop.send('原会话')
        await harness.loop.run()

        const child = createTestContext()
        try {
          const forked = harness.loop.fork({
            sessionId: asSessionId('s-forked'),
            turn: 1,
            ctx: child.ctx,
          })
          forked.send('分叉后')
          await forked.run()

          const forkedCall = calls[calls.length - 1]
          expect(forkedCall?.sessionId).toBe(asSessionId('s-forked'))
          expect(forkedCall?.forkOf).toBe(harness.session.sessionId)
        } finally {
          await child.dispose('fork-finished')
        }
      },
    )
  })
})
