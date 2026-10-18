/**
 * 七段管线单测（施工单 03 §2.2 / §4 的 T-TOOL-003 ~ 012）。
 *
 * 断言口径：一律看「公开可观察面」——管线返回值、`tool/call` / `tool/result` /
 * `user/message` 落账序列、工具体是否真的执行、卡片产物。不碰私有字段。
 */

import { describe, expect, it } from 'vitest'

import { asSessionId, captureRejection, createTestContext, fixedClock, type TestContext } from '@bah/test-support'

import type { AnySessionEvent } from '../session/types.ts'
import { SESSION_SERVICE, provideSession, type SessionApi } from '../session/service.ts'
import { ToolGuard } from './guard.ts'
import { ToolPipeline } from './pipeline.ts'
import { ToolRegistry } from './registry.ts'
import { provideTools } from './index.ts'
import type { ToolCallInput, ToolDefinition } from './types.ts'

interface Harness {
  readonly test: TestContext
  readonly registry: ToolRegistry
  readonly guard: ToolGuard
  readonly pipeline: ToolPipeline
  readonly session: SessionApi
  log(): readonly AnySessionEvent[]
}

/** 建一个带会话服务 + 工具服务 + 管线的测试上下文（结束自动 dispose）。 */
async function withHarness(run: (harness: Harness) => Promise<void>): Promise<void> {
  const test = createTestContext()
  const sessionId = asSessionId('s-pipe')
  const clock = fixedClock({ start: 1_000, step: 1 })
  provideSession(test.ctx, { sessionId, now: clock.now })
  const session = test.ctx.get(SESSION_SERVICE)
  const registry = new ToolRegistry()
  provideTools(test.ctx, registry)
  const guard = new ToolGuard()
  const pipeline = new ToolPipeline({
    ctx: test.ctx,
    registry,
    session,
    guard,
    sessionId,
    now: clock.now,
  })
  try {
    await run({ test, registry, guard, pipeline, session, log: () => session.events() })
  } finally {
    await test.dispose()
  }
}

/** 最小工具定义 + 可覆写字段。 */
function tool(overrides: Partial<ToolDefinition> & { name: string }): ToolDefinition {
  return {
    description: '测试工具',
    schema: { type: 'object' },
    tier: { level: 'green' },
    execute: async () => 'ok',
    ...overrides,
  }
}

const CALL: ToolCallInput = { callId: 'c1', name: 'bank:probe', args: { account: 'a-1' } }

describe('七段管线', () => {
  it('T-TOOL-003 pre-execute allow → 工具体执行，tool/result 落账', async () => {
    await withHarness(async (h) => {
      let executed = 0
      h.registry.register(
        tool({
          name: 'bank:probe',
          execute: async () => {
            executed += 1
            return '余额 100'
          },
        }),
      )

      const execution = await h.pipeline.execute(CALL)

      expect(executed).toBe(1)
      expect(execution.result.isError).toBe(false)
      expect(execution.result.content).toEqual([{ type: 'text', text: '余额 100' }])
      expect(execution.additionalContexts).toEqual([])
      expect(h.log().map((event) => event.type)).toEqual(['tool/call', 'tool/result'])
      expect(h.log()[0]).toMatchObject({ data: { callId: 'c1', name: 'bank:probe' } })
      expect(h.log()[1]).toMatchObject({ data: { callId: 'c1', isError: false } })
    })
  })

  it('T-TOOL-004 pre-execute deny → 工具体不执行，结果带理由码', async () => {
    await withHarness(async (h) => {
      let executed = 0
      h.registry.register(
        tool({
          name: 'bank:probe',
          execute: async () => {
            executed += 1
            return 'ok'
          },
        }),
      )
      h.test.ctx.events.on('tools/pre-execute', (input) => ({
        ...input,
        verdict: { kind: 'deny', reason: '命中危险规则：批量转账', code: 'dangerous-op' },
      }))

      const execution = await h.pipeline.execute(CALL)

      expect(executed).toBe(0)
      expect(execution.result.isError).toBe(true)
      expect(execution.result.code).toBe('dangerous-op')
      expect(execution.result.content).toEqual([
        { type: 'text', text: '命中危险规则：批量转账' },
      ])
      expect(h.log().map((event) => event.type)).toEqual(['tool/call', 'tool/result'])
    })
  })

  it('T-TOOL-005 pre-execute ask（无应答者）→ 按审批未就绪处理：unavailable = deny', async () => {
    await withHarness(async (h) => {
      let executed = 0
      h.registry.register(
        tool({
          name: 'bank:probe',
          execute: async () => {
            executed += 1
            return 'ok'
          },
        }),
      )
      h.test.ctx.events.on('tools/pre-execute', (input) => ({
        ...input,
        verdict: { kind: 'ask', ticket: { fingerprint: 'fp-1', amount: 50_000, ttlMs: 60_000 } },
      }))

      const execution = await h.pipeline.execute(CALL)

      expect(executed).toBe(0)
      expect(execution.result.code).toBe('approval-unavailable')
      // ask 分支的落账必须成对出现（审批事件对）
      expect(h.log().map((event) => event.type)).toEqual([
        'tool/call',
        'approval/asked',
        'approval/decided',
        'tool/result',
      ])
      expect(h.log()[1]).toMatchObject({ data: { ticketId: 'ticket:c1', amount: 50_000 } })
      expect(h.log()[2]).toMatchObject({ data: { decision: 'unavailable' } })
    })
  })

  it('ask 被渠道批准（allowed-once）→ 工具体执行', async () => {
    await withHarness(async (h) => {
      let executed = 0
      h.registry.register(
        tool({
          name: 'bank:probe',
          execute: async () => {
            executed += 1
            return '已转账'
          },
        }),
      )
      h.test.ctx.events.on('tools/pre-execute', (input) => ({
        ...input,
        verdict: { kind: 'ask', ticket: { fingerprint: 'fp-1', amount: 50_000, ttlMs: 60_000 } },
      }))
      h.test.ctx.events.on('approval/request', (input) => ({
        ...input,
        decision: { decision: 'allowed-once' as const },
      }))

      const execution = await h.pipeline.execute(CALL)

      expect(executed).toBe(1)
      expect(execution.result.isError).toBe(false)
      expect(h.log().map((event) => event.type)).toContain('approval/decided')
    })
  })

  it('ask 被渠道拒绝（rejected）→ 工具体不执行，理由码可追溯', async () => {
    await withHarness(async (h) => {
      h.registry.register(tool({ name: 'bank:probe' }))
      h.test.ctx.events.on('tools/pre-execute', (input) => ({
        ...input,
        verdict: { kind: 'ask', ticket: { fingerprint: 'fp-1', ttlMs: 60_000 } },
      }))
      h.test.ctx.events.on('approval/request', (input) => ({
        ...input,
        decision: { decision: 'rejected' as const, reason: '金额超限' },
      }))

      const execution = await h.pipeline.execute(CALL)

      expect(execution.result.code).toBe('approval-rejected')
      expect(execution.result.reason).toBe('金额超限')
    })
  })

  it('T-TOOL-006 判决顺序：deny 先短路，后续 ask 监听器不触发', async () => {
    await withHarness(async (h) => {
      const order: string[] = []
      h.registry.register(tool({ name: 'bank:probe' }))
      h.test.ctx.events.on('tools/pre-execute', (input) => {
        order.push('deny')
        return { ...input, verdict: { kind: 'deny', reason: '先拒', code: 'first-deny' } }
      })
      h.test.ctx.events.on('tools/pre-execute', (input) => {
        order.push('ask')
        return { ...input, verdict: { kind: 'ask', ticket: { fingerprint: 'fp', ttlMs: 1 } } }
      })

      const execution = await h.pipeline.execute(CALL)

      expect(order).toEqual(['deny'])
      expect(execution.result.code).toBe('first-deny')
    })
  })

  it('T-TOOL-007 工具体抛错 → 归一化为 isError，不冒泡', async () => {
    await withHarness(async (h) => {
      h.registry.register(
        tool({
          name: 'bank:probe',
          execute: async () => {
            throw new Error('银行核心超时')
          },
        }),
      )

      const execution = await h.pipeline.execute(CALL)

      expect(execution.result.isError).toBe(true)
      expect(execution.result.code).toBe('tool-failed')
      expect(execution.result.reason).toContain('银行核心超时')
      expect(h.log().at(-1)).toMatchObject({ type: 'tool/result', data: { isError: true } })
    })
  })

  it('工具体抛非 Error（字符串）也留下可读理由', async () => {
    await withHarness(async (h) => {
      h.registry.register(
        tool({
          name: 'bank:probe',
          execute: async () => {
            throw 'raw-failure'
          },
        }),
      )

      const execution = await h.pipeline.execute(CALL)

      expect(execution.result.reason).toBe('raw-failure')
    })
  })

  it('T-TOOL-008 post-execute block → 结果被 block，纠正上下文追加', async () => {
    await withHarness(async (h) => {
      h.registry.register(tool({ name: 'bank:probe', execute: async () => '含身份证号 110' }))
      h.test.ctx.events.on('tools/post-execute', (input) => ({
        ...input,
        verdict: { kind: 'block', reason: '结果含 PII，已拦截', code: 'pii-blocked' },
      }))

      const execution = await h.pipeline.execute(CALL)

      expect(execution.result.isError).toBe(true)
      expect(execution.result.code).toBe('pii-blocked')
      expect(execution.additionalContexts).toEqual(['结果含 PII，已拦截'])
      expect(h.log().map((event) => event.type)).toEqual([
        'tool/call',
        'tool/result',
        'user/message',
      ])
    })
  })

  it('T-TOOL-009 post-execute replace → 模型看到替换后的内容', async () => {
    await withHarness(async (h) => {
      h.registry.register(tool({ name: 'bank:probe', execute: async () => '原始结果' }))
      h.test.ctx.events.on('tools/post-execute', (input) => ({
        ...input,
        verdict: { kind: 'replace', content: [{ type: 'text', text: '已脱敏结果' }] },
      }))

      const execution = await h.pipeline.execute(CALL)

      expect(execution.result.content).toEqual([{ type: 'text', text: '已脱敏结果' }])
      const last = h.log().at(-1)
      expect(last).toMatchObject({ type: 'tool/result' })
      expect((last as { data: { content: unknown } }).data.content).toEqual([
        { type: 'text', text: '已脱敏结果' },
      ])
    })
  })

  it('T-TOOL-010 additionalContexts FIFO：两条上下文按序落在 tool/result 之后', async () => {
    await withHarness(async (h) => {
      h.registry.register(tool({ name: 'bank:probe' }))
      h.test.ctx.events.on('tools/post-execute', (input) => ({
        ...input,
        verdict: { kind: 'addContext', texts: ['第一条纠正', '第二条纠正'] },
      }))

      const execution = await h.pipeline.execute(CALL)

      expect(execution.additionalContexts).toEqual(['第一条纠正', '第二条纠正'])
      const types = h.log().map((event) => event.type)
      expect(types).toEqual(['tool/call', 'tool/result', 'user/message', 'user/message'])
      expect(h.log()[2]).toMatchObject({ data: { content: '第一条纠正', source: 'context' } })
      expect(h.log()[3]).toMatchObject({ data: { content: '第二条纠正' } })
    })
  })

  it('T-TOOL-011 单调 guard：deny 后同 turn 同名同参调用直接 deny', async () => {
    await withHarness(async (h) => {
      let allow = false
      h.registry.register(tool({ name: 'bank:probe' }))
      h.test.ctx.events.on('tools/pre-execute', (input) =>
        allow ? input : { ...input, verdict: { kind: 'deny', reason: '首次拒绝', code: 'first-deny' } },
      )

      const first = await h.pipeline.execute(CALL)
      allow = true // 判决平面「松口」了，但 guard 不许
      const second = await h.pipeline.execute(CALL)

      expect(first.result.code).toBe('first-deny')
      expect(second.result.code).toBe('first-deny')
      expect(h.guard.size).toBe(1)
    })
  })

  it('T-TOOL-012 presentCall / presentResult 是纯函数：同输入同输出，只收参数', async () => {
    await withHarness(async (h) => {
      const definition = tool({
        name: 'bank:probe',
        execute: async () => 'ok',
        presentCall: (args: unknown) => ({ kind: 'transfer-call', data: args }),
        presentResult: (_args: unknown, result: unknown) => ({ kind: 'transfer-done', data: result }),
      })
      h.registry.register(definition)

      const first = await h.pipeline.execute(CALL)
      const second = await h.pipeline.execute(CALL)

      expect(first.callCard).toEqual(second.callCard)
      expect(first.resultCard).toEqual(second.resultCard)
      expect(first.callCard).toEqual({ kind: 'transfer-call', data: CALL.args })
      // 形参只有一个（args / args+result）：签名层面就拿不到 ctx
      expect(definition.presentCall?.length).toBe(1)
      expect(definition.presentResult?.length).toBe(2)
    })
  })
})

describe('tools/execute 环绕', () => {
  it('listener 可包裹执行（超时/重试/沙箱的挂点）', async () => {
    await withHarness(async (h) => {
      const order: string[] = []
      h.registry.register(
        tool({
          name: 'bank:probe',
          execute: async () => {
            order.push('execute')
            return 'ok'
          },
        }),
      )
      h.test.ctx.events.on('tools/execute', async (run, next) => {
        order.push('before')
        const wrapped = async (call: ToolCallInput): Promise<unknown> => {
          const value = await run(call)
          order.push('after')
          return value
        }
        return next(wrapped)
      })

      await h.pipeline.execute(CALL)

      expect(order).toEqual(['before', 'execute', 'after'])
    })
  })

  it('未注册工具 → 直接抛错（连 tool/call 都不落账）', async () => {
    await withHarness(async (h) => {
      await expect(h.pipeline.execute(CALL)).rejects.toThrow(/未注册/)
      expect(h.log()).toHaveLength(0)
    })
  })

  it('没有 projectContent 时默认渲染：字符串直出、对象 JSON 化', async () => {
    await withHarness(async (h) => {
      h.registry.register(tool({ name: 'bank:probe', execute: async () => ({ balance: 100 }) }))
      const objectResult = await h.pipeline.execute(CALL)
      expect(objectResult.result.content).toEqual([{ type: 'text', text: '{"balance":100}' }])

      h.registry.register(tool({ name: 'bank:text', execute: async () => 'plain' }))
      const textResult = await h.pipeline.execute({ callId: 'c2', name: 'bank:text', args: {} })
      expect(textResult.result.content).toEqual([{ type: 'text', text: 'plain' }])
    })
  })

  it('第三方返回未知判决 → fail-loud（不许静默当 accept）', async () => {
    await withHarness(async (h) => {
      h.registry.register(tool({ name: 'bank:probe' }))
      h.test.ctx.events.on('tools/post-execute', (input) => ({
        ...input,
        verdict: { kind: 'bogus' } as never,
      }))

      const error = await captureRejection(() => h.pipeline.execute(CALL))
      expect(error.code).toBe('unreachable-branch')
    })
  })
})
