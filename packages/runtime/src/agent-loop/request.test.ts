/**
 * 请求装配 / 冻结 / 提交（施工单 04 §2.2）。
 *
 * 三条被钉住的语义：
 * 1. **历史只从日志派生**：`toLlmMessages` 是投影 → 模型消息的唯一桥（system 跳过、
 *    reasoning 不回放、工具调用由 `toolCalls` 还原成 `tool-call` 块）；
 * 2. **提交晚于 `prepareCall`**（取消即未发生）：`commitAttempt` 的顺序与
 *    `beginAttempt`（阶段 4）逐条一致——本文件用一条对照用例把两处实现钉在一起；
 * 3. **冻结后的路由才是真的**：`request/header` 取 `PreparedCall` 的 model/params，
 *    而不是装配时的首选模型（`agent/request` 可能已经改写）。
 */

import { asSessionId, fixedClock, withTestContext } from '@bah/test-support'
import { describe, expect, it } from 'vitest'

import type { ToolDefinition } from '@bah/core'
import type { LlmRequest, ModelSpec, PreparedCall } from '@bah/llm'

import { SESSION_SERVICE, provideSession, type SessionApi } from '../session/service.ts'
import type { AnySessionEvent } from '../session/types.ts'
import { beginAttempt, RuntimeContextQueue } from '../system-prompt/reconcile.ts'
import { createDefaultPromptRegistry } from '../system-prompt/index.ts'
import { PromptRegistry } from '../system-prompt/registry.ts'
import { ToolRegistry } from '../tools/registry.ts'

import {
  assembleRequest,
  commitAttempt,
  freezeRequest,
  plainParams,
  toLlmMessages,
  toModelBlocks,
  toSessionBlocks,
  toolDescriptorsOf,
} from './request.ts'

/** 被测工具：绿级、无副作用。 */
const PING_TOOL: ToolDefinition = {
  name: 'ping',
  description: '探活',
  schema: { type: 'object', properties: {} },
  tier: { level: 'green' },
  execute: () => Promise.resolve('pong'),
}

/** 被测模型：支持工具调用。 */
const MODEL: ModelSpec = {
  id: 'mock-chat',
  providerId: 'mock',
  capabilities: { toolCall: true, image: false, reasoning: false },
}

describe('request · 投影 → 模型消息', () => {
  it('user / assistant / tool 三类角色都映射到 wire 形状；system 被跳过（由本次装配重写）', () => {
    const messages = toLlmMessages([
      { role: 'system', content: '旧系统头（应被跳过）' },
      { role: 'user', content: '给张三转 100' },
      {
        role: 'assistant',
        content: [{ type: 'text', text: '好的' }],
        toolCalls: [{ callId: 'call-1', name: 'transfer', args: { amount: 100 } }],
      },
      {
        role: 'tool',
        callId: 'call-1',
        name: 'transfer',
        isError: false,
        content: [{ type: 'text', text: '成功' }],
      },
    ])

    expect(messages).toEqual([
      { role: 'user', content: [{ kind: 'text', text: '给张三转 100' }] },
      {
        role: 'assistant',
        content: [
          { kind: 'text', text: '好的' },
          { kind: 'tool-call', id: 'call-1', name: 'transfer', args: { amount: 100 } },
        ],
      },
      {
        role: 'tool',
        toolCallId: 'call-1',
        name: 'transfer',
        content: [{ kind: 'text', text: '成功' }],
      },
    ])
  })

  it('表外角色直接抛错（新增角色必须补映射，不许静默丢消息）', () => {
    expect(() => toLlmMessages([{ role: 'ghost' } as never])).toThrow(/derived-message-role/)
  })

  it('会话内容块 → 模型内容块：text / image 保真', () => {
    expect(
      toModelBlocks([
        { type: 'text', text: '看这张' },
        { type: 'image', mimeType: 'image/png', data: 'AAA' },
      ]),
    ).toEqual([
      { kind: 'text', text: '看这张' },
      { kind: 'image', mimeType: 'image/png', data: 'AAA' },
    ])
  })

  it('表外内容块类型抛错', () => {
    expect(() => toModelBlocks([{ type: 'ghost' } as never])).toThrow(/session-content-block/)
  })

  it('模型内容块 → 会话内容块：只留文本与图片；推理/工具集增量/文件不进历史', () => {
    expect(
      toSessionBlocks([
        { kind: 'text', text: '好的' },
        { kind: 'reasoning', text: '先想一想' },
        { kind: 'image', mimeType: 'image/png', data: 'AAA' },
        { kind: 'tool-call', id: 'call-1', name: 'transfer', args: {} },
        { kind: 'tool-addition', tools: [] },
        { kind: 'tool-removal', names: ['ping'] },
        { kind: 'file', mimeType: 'text/plain', name: 'a.txt', data: 'AA' },
      ]),
    ).toEqual([
      { type: 'text', text: '好的' },
      { type: 'image', mimeType: 'image/png', data: 'AAA' },
    ])
  })

  it('表外内容块 kind 抛错（新增块类型必须显式决定是否进历史）', () => {
    expect(() => toSessionBlocks([{ kind: 'ghost' } as never])).toThrow(/model-content-block/)
  })
})

describe('request · 装配', () => {
  it('顺序固定：system 头 → 派生历史 → 运行时上下文 → 本次认领的消息', async () => {
    await withTestContext(async (test) => {
      const clock = fixedClock({ start: 1_000 })
      provideSession(test.ctx, { sessionId: asSessionId('s-assemble'), now: clock.now })
      const session = test.ctx.get(SESSION_SERVICE)
      session.append('user/message', { content: '历史里的话' })

      const tools = new ToolRegistry()
      tools.register(PING_TOOL)
      const queue = new RuntimeContextQueue()
      queue.inject('系统注入：今天是工作日')

      const assembly = assembleRequest({
        session,
        composer: createDefaultPromptRegistry(),
        tools,
        model: MODEL,
        queue,
        claim: [
          { text: '本次认领', source: 'user', target: 'next-turn', at: 1 },
        ],
        params: { temperature: 0.2 },
        channel: 'web',
        runtime: { user: { name: '张三' } },
      })

      const roles = assembly.request.messages.map((message) => message.role)
      expect(roles).toEqual(['system', 'user', 'user', 'user'])
      // ① system 头
      expect(assembly.request.messages[0]?.content[0]).toEqual({
        kind: 'text',
        text: expect.stringContaining('安全底线'),
      })
      // ② 历史（一条用户消息）
      expect(assembly.request.messages[1]?.content).toEqual([
        { kind: 'text', text: '历史里的话' },
      ])
      // ③ 运行时上下文（渲染结果在前、注入文本在后）
      const contextText = assembly.request.messages[2]?.content[0]
      expect(contextText?.kind === 'text' && contextText.text).toContain('系统注入：今天是工作日')
      expect(contextText?.kind === 'text' && contextText.text).toContain('姓名：张三')
      // ④ 本次认领
      expect(assembly.request.messages[3]?.content).toEqual([
        { kind: 'text', text: '本次认领' },
      ])
      // 队列已取空；上下文文本同时用于提交（渲染结果 + 注入文本）
      expect(queue.size).toBe(0)
      expect(assembly.contextTexts).toHaveLength(2)
      expect(assembly.contextTexts[0]).toContain('姓名：张三')
      expect(assembly.contextTexts[1]).toBe('系统注入：今天是工作日')
      expect(assembly.request.modelId).toBe('mock-chat')
      expect(assembly.request.params).toEqual({ temperature: 0.2 })
      expect(assembly.request.sessionId).toBe('s-assemble')
      expect(assembly.request.tools?.map((tool) => tool.name)).toEqual(['ping'])
    })
  })

  it('能力位不支持工具调用时不下发工具 schema（塞了它只会照着编）', async () => {
    await withTestContext(async (test) => {
      provideSession(test.ctx, { sessionId: asSessionId('s-no-tool'), now: fixedClock().now })
      const session = test.ctx.get(SESSION_SERVICE)
      const tools = new ToolRegistry()
      tools.register(PING_TOOL)

      const assembly = assembleRequest({
        session,
        composer: createDefaultPromptRegistry(),
        tools,
        model: { ...MODEL, capabilities: { toolCall: false, image: false, reasoning: false } },
        queue: new RuntimeContextQueue(),
        claim: [],
      })

      expect(assembly.request.tools).toBeUndefined()
      expect(assembly.composed.sectionIds).not.toContain('bank.capabilities')
    })
  })

  it('没有运行时上下文时 contextTexts 为空、不追加 user 消息', async () => {
    await withTestContext(async (test) => {
      provideSession(test.ctx, { sessionId: asSessionId('s-empty'), now: fixedClock().now })
      const session = test.ctx.get(SESSION_SERVICE)

      const assembly = assembleRequest({
        session,
        composer: new PromptRegistry(),
        tools: new ToolRegistry(),
        model: MODEL,
        queue: new RuntimeContextQueue(),
        claim: [],
      })

      expect(assembly.composed.header).toBe('')
      expect(assembly.contextTexts).toEqual([])
      expect(assembly.request.messages).toEqual([])
      expect(assembly.request.tools).toBeUndefined()
      expect(assembly.request.params).toBeUndefined()
    })
  })

  it('工具描述带 tier（提示词装配要用它解释权限），工具 schema 不带执行体', () => {
    const tools = new ToolRegistry()
    tools.register(PING_TOOL)

    expect(toolDescriptorsOf(tools)).toEqual([
      { name: 'ping', description: '探活', schema: { type: 'object', properties: {} }, tier: { level: 'green' } },
    ])
  })
})

describe('request · 冻结与提交', () => {
  const REQUEST: LlmRequest = {
    modelId: 'mock-chat',
    messages: [{ role: 'user', content: [{ kind: 'text', text: '你好' }] }],
  }

  const PREPARED: PreparedCall = {
    id: 'mock-call-1',
    request: REQUEST,
    // 冻结后的模型可能已被 agent/request 改写：提交必须认它
    model: { ...MODEL, id: 'rewritten-model' },
    params: { temperature: 0.7, maxTokens: 512 },
  }

  it('freezeRequest：对象冻结后不可改写', () => {
    const frozen = freezeRequest(REQUEST)
    expect(Object.isFrozen(frozen)).toBe(true)
    expect(() => {
      ;(frozen as unknown as { modelId: string }).modelId = 'other'
    }).toThrow(TypeError)
  })

  it('plainParams：转成纯 JSON 快照（不把类实例写进日志）', () => {
    expect(plainParams({ temperature: 0.1 })).toEqual({ temperature: 0.1 })
    expect(plainParams({})).toEqual({})
  })

  it('commitAttempt 的落账顺序与载荷（request/header 取冻结后的 model/params）', async () => {
    await withTestContext(async (test) => {
      provideSession(test.ctx, { sessionId: asSessionId('s-commit'), now: fixedClock().now })
      const session = test.ctx.get(SESSION_SERVICE)
      const composed = createDefaultPromptRegistry().compose({
        capabilities: MODEL.capabilities,
        tools: [],
      })

      commitAttempt({
        session,
        turn: 2,
        step: 3,
        prepared: PREPARED,
        composed,
        contextTexts: ['渲染的上下文', '注入的上下文'],
        messages: [{ text: '用户原话', source: 'user', target: 'next-turn', at: 1 }],
      })

      expect(session.events().map((event) => event.type)).toEqual([
        'request/header',
        'system/message',
        'request/context',
        'user/message',
        'user/message',
      ])

      const [header, system, context, runtimeContext, user] = session.events() as [
        AnySessionEvent,
        AnySessionEvent,
        AnySessionEvent,
        AnySessionEvent,
        AnySessionEvent,
      ]
      expect(header.type === 'request/header' && header.data).toEqual({
        turn: 2,
        step: 3,
        model: 'rewritten-model',
        params: { temperature: 0.7, maxTokens: 512 },
      })
      expect(system.type === 'system/message' && system.data.content).toBe(composed.header)
      expect(context.type === 'request/context' && context.data).toEqual({
        turn: 2,
        step: 3,
        texts: ['渲染的上下文', '注入的上下文'],
      })
      expect(runtimeContext.type === 'user/message' && runtimeContext.data).toEqual({
        content: '渲染的上下文\n\n注入的上下文',
        source: 'runtime-context',
      })
      expect(user.type === 'user/message' && user.data).toEqual({
        content: '用户原话',
        source: 'user',
      })
    })
  })

  it('与 beginAttempt 逐条一致（阶段 4 的提交面不被主循环改歪）', async () => {
    await withTestContext(async (test) => {
      provideSession(test.ctx, { sessionId: asSessionId('s-parity'), now: fixedClock().now })
      const session: SessionApi = test.ctx.get(SESSION_SERVICE)
      const composed = createDefaultPromptRegistry().compose({
        capabilities: MODEL.capabilities,
        tools: [],
        runtime: { user: { name: '张三' } },
      })

      const before = new RuntimeContextQueue()
      before.inject('注入 A')
      beginAttempt({ session, turn: 1, step: 1, composed, queue: before })

      const commit = new RuntimeContextQueue()
      commit.inject('注入 A')
      const drained = commit.drain()
      commitAttempt({
        session,
        turn: 1,
        step: 1,
        prepared: PREPARED,
        composed,
        // 与 beginAttempt 相同的输入：渲染结果 + 注入文本
        contextTexts: [composed.context ?? '', ...drained],
        messages: [],
      })

      const events = session.events()
      // beginAttempt 落 3 条；commitAttempt 落 4 条（多一条 request/header）
      const begin = events.slice(0, 3)
      const committed = events.slice(4)
      expect(committed.map((event) => event.type)).toEqual(begin.map((event) => event.type))
      expect(committed[0]?.type === 'system/message' && committed[0].data).toEqual(
        begin[0]?.type === 'system/message' && begin[0].data,
      )
      expect(committed[1]?.type === 'request/context' && committed[1].data.texts).toEqual(
        begin[1]?.type === 'request/context' && begin[1].data.texts,
      )
      expect(committed[2]?.type === 'user/message' && committed[2].data).toEqual(
        begin[2]?.type === 'user/message' && begin[2].data,
      )
    })
  })
})
