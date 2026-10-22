/**
 * 工具调度（施工单 04 §2.3 / §6 第 5 步）。
 *
 * 钉住两件事：
 * 1. **参数不可用就不执行**：坏 JSON / 根不是 object 的调用直接落 `isError` 的 `tool/result`
 *    （三级防线的最后一道，施工单 05 §2.3），工具体一次都不跑；
 * 2. **失败补记的观察口可用**：`observeToolCalls` 把 `session/event` 喂给 `ToolCallRecovery`，
 *    主循环在 step 失败时才有东西可补（施工单 03 §0 第 4 条）。
 */

import { asSessionId, fixedClock, withTestContext } from '@bah/test-support'
import { describe, expect, it } from 'vitest'

import type { AssembledToolCall } from '@bah/llm'
import type { Context } from '@bah/core'

import { SESSION_SERVICE, provideSession, type SessionApi } from '../session/service.ts'
import { ToolGuard } from '../tools/guard.ts'
import { ToolPipeline } from '../tools/pipeline.ts'
import { ToolCallRecovery } from '../tools/recovery.ts'
import { ToolRegistry } from '../tools/registry.ts'

import {
  ToolCallDispatcher,
  interruptedResult,
  invalidArgumentsResult,
  observeToolCalls,
  toolCallInputOf,
} from './tool-calls.ts'

/** 一次坏参数的调用（坏 JSON 时装配器只标注，不抛）。 */
const INVALID_CALL: AssembledToolCall = {
  callId: 'call-bad',
  name: 'ping',
  argsText: '{"payee":',
  parseError: '参数不是合法 JSON：Unexpected end of JSON input',
}

describe('tool-calls · 参数不可用', () => {
  it('invalidArgumentsResult：isError + 结构化理由码 + 原文可回溯', () => {
    const result = invalidArgumentsResult(INVALID_CALL)

    expect(result.callId).toBe('call-bad')
    expect(result.name).toBe('ping')
    expect(result.isError).toBe(true)
    expect(result.code).toBe('tool-args-invalid')
    expect(result.durationMs).toBe(0)
    const text = result.content[0]?.type === 'text' ? result.content[0].text : ''
    expect(text).toContain('Unexpected end of JSON input')
    expect(text).toContain('{"payee":')
  })

  it('空参数文本时原文显示为（空），不制造空行', () => {
    const result = invalidArgumentsResult({
      callId: 'call-empty',
      name: 'ping',
      argsText: '',
      parseError: undefined,
    })
    const text = result.content[0]?.type === 'text' ? result.content[0].text : ''
    expect(text).toContain('（空）')
  })

  it('parseError 存在 → 不执行工具体，只落一条 isError 的 tool/result', async () => {
    await withTestContext(async (test) => {
      provideSession(test.ctx, { sessionId: asSessionId('s-invalid'), now: fixedClock().now })
      const session = test.ctx.get(SESSION_SERVICE)
      const registry = new ToolRegistry()
      let executed = 0
      registry.register({
        name: 'ping',
        description: '探活',
        schema: { type: 'object', properties: {} },
        tier: { level: 'green' },
        execute: () => {
          executed += 1
          return Promise.resolve('pong')
        },
      })
      const dispatcher = new ToolCallDispatcher({
        pipeline: pipelineOf(test.ctx, registry, session),
        session,
      })

      const execution = await dispatcher.execute(INVALID_CALL)

      expect(executed).toBe(0)
      expect(execution.additionalContexts).toEqual([])
      expect(execution.result.code).toBe('tool-args-invalid')
      // 只有结果，没有 tool/call（这次调用连七段管线的 ① 都没进）
      expect(session.events().map((event) => event.type)).toEqual(['tool/result'])
    })
  })

  it('args 缺省（根不是 object）同样不执行', async () => {
    await withTestContext(async (test) => {
      provideSession(test.ctx, { sessionId: asSessionId('s-object-root'), now: fixedClock().now })
      const session = test.ctx.get(SESSION_SERVICE)
      const registry = new ToolRegistry()
      let executed = 0
      registry.register({
        name: 'ping',
        description: '探活',
        schema: { type: 'object', properties: {} },
        tier: { level: 'green' },
        execute: () => {
          executed += 1
          return Promise.resolve('pong')
        },
      })
      const dispatcher = new ToolCallDispatcher({
        pipeline: pipelineOf(test.ctx, registry, session),
        session,
      })

      const execution = await dispatcher.execute({
        callId: 'call-array',
        name: 'ping',
        argsText: '[1,2]',
        parseError: '参数不是 JSON 对象（工具参数必须以 object 为根）',
      })

      expect(executed).toBe(0)
      expect(execution.result.isError).toBe(true)
    })
  })
})

describe('tool-calls · 正常调度', () => {
  it('参数可用时进七段管线（tool/call 与 tool/result 成对）', async () => {
    await withTestContext(async (test) => {
      provideSession(test.ctx, { sessionId: asSessionId('s-dispatch'), now: fixedClock().now })
      const session = test.ctx.get(SESSION_SERVICE)
      const registry = new ToolRegistry()
      const seen: unknown[] = []
      registry.register({
        name: 'ping',
        description: '探活',
        schema: { type: 'object', properties: { text: { type: 'string' } } },
        tier: { level: 'green' },
        execute: (args) => {
          seen.push(args)
          return Promise.resolve('pong')
        },
      })
      const dispatcher = new ToolCallDispatcher({
        pipeline: pipelineOf(test.ctx, registry, session),
        session,
      })

      const execution = await dispatcher.execute({
        callId: 'call-1',
        name: 'ping',
        argsText: '{"text":"hi"}',
        args: { text: 'hi' },
      })

      expect(seen).toEqual([{ text: 'hi' }])
      expect(execution.result.isError).toBe(false)
      expect(execution.result.content).toEqual([{ type: 'text', text: 'pong' }])
      expect(session.events().map((event) => event.type)).toEqual(['tool/call', 'tool/result'])
    })
  })

  it('executeAll 按模型给出的顺序串行执行', async () => {
    await withTestContext(async (test) => {
      provideSession(test.ctx, { sessionId: asSessionId('s-order'), now: fixedClock().now })
      const session = test.ctx.get(SESSION_SERVICE)
      const registry = new ToolRegistry()
      const order: string[] = []
      for (const name of ['first', 'second']) {
        registry.register({
          name,
          description: name,
          schema: { type: 'object', properties: {} },
          tier: { level: 'green' },
          execute: () => {
            order.push(name)
            return Promise.resolve(name)
          },
        })
      }
      const dispatcher = new ToolCallDispatcher({
        pipeline: pipelineOf(test.ctx, registry, session),
        session,
      })

      const executions = await dispatcher.executeAll([
        { callId: 'call-1', name: 'first', argsText: '{}', args: {} },
        { callId: 'call-2', name: 'second', argsText: '{}', args: {} },
      ])

      expect(order).toEqual(['first', 'second'])
      expect(executions.map((execution) => execution.result.callId)).toEqual(['call-1', 'call-2'])
    })
  })

  it('toolCallInputOf：args 缺省视为无参', () => {
    expect(toolCallInputOf({ callId: 'c', name: 'n', argsText: '' })).toEqual({
      callId: 'c',
      name: 'n',
      args: {},
    })
  })
})

describe('tool-calls · 失败补记的观察口', () => {
  it('observeToolCalls：把 session/event 喂给补记器；撤销后不再观察', async () => {
    await withTestContext(async (test) => {
      provideSession(test.ctx, { sessionId: asSessionId('s-observe'), now: fixedClock().now })
      const session = test.ctx.get(SESSION_SERVICE)
      const recovery = new ToolCallRecovery()

      const stop = observeToolCalls(test.ctx, recovery)
      session.append('tool/call', {
        callId: 'call-open',
        name: 'ping',
        args: {},
        fingerprint: 'ping:{}',
        tier: { level: 'green' },
        at: 1,
      })
      expect(recovery.pending).toBe(1)

      stop()
      session.append('tool/call', {
        callId: 'call-ignored',
        name: 'ping',
        args: {},
        fingerprint: 'ping:{}',
        tier: { level: 'green' },
        at: 2,
      })

      const recovered = recovery.results('step 中断')
      expect(recovered.map((item) => item.callId)).toEqual(['call-open'])
      expect(recovered[0]?.data.isError).toBe(true)
      expect(recovered[0]?.data.code).toBe('tool-interrupted')
    })
  })
})

/** 造一条持有测试上下文的管线（guard 单 turn 一个，用后即弃）。 */
function pipelineOf(ctx: Context, registry: ToolRegistry, session: SessionApi): ToolPipeline {
  return new ToolPipeline({
    ctx,
    registry,
    session,
    guard: new ToolGuard(),
    sessionId: session.sessionId,
    now: () => 1,
  })
}

describe('tool-calls · 取消', () => {
  it('interruptedResult：结构化理由码 + 自定义原因，供未执行调用补记', () => {
    expect(
      interruptedResult(
        { callId: 'call-late', name: 'transfer_create', argsText: '{}', args: {} },
        '批次已取消',
      ),
    ).toMatchObject({
      callId: 'call-late',
      name: 'transfer_create',
      isError: true,
      code: 'tool-interrupted',
      reason: '批次已取消',
    })
  })
})
