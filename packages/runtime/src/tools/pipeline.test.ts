/**
 * 七段管线单测（施工单 03 §2.2 / §4 的 T-TOOL-003 ~ 012）。
 *
 * 断言口径：一律看「公开可观察面」——管线返回值、`tool/call` / `tool/result` /
 * `user/message` 落账序列、工具体是否真的执行、卡片产物。不碰私有字段。
 */

import { describe, expect, it, vi } from 'vitest'

import { asSessionId, captureRejection, createTestContext, fixedClock, type TestContext } from '@bah/test-support'

import type { SessionEventMap, TicketId } from '@bah/core'

import type { AppendOptions, AnySessionEvent, SessionEventType } from '../session/types.ts'
import {
  SESSION_SERVICE,
  provideSession,
  type SessionApi,
  type SessionSink,
} from '../session/service.ts'
import { fingerprintOf, ToolGuard } from './guard.ts'
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
      // 票据 ID 是随机 UUID：只断言形状（`ticket:` + 36 位），不再断言具体值。
      // 断言形状本身就是在钉"不可预测"这个性质——写死一个值反而在鼓励可预测。
      expect(h.log()[1]?.data).toMatchObject({ amount: 50_000 })
      expect(String((h.log()[1]?.data as { ticketId?: string }).ticketId)).toMatch(
        /^ticket:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      )
      expect(h.log()[2]).toMatchObject({ data: { decision: 'unavailable' } })
    })
  })

  it('票据 ID 可注入：验收面按 callId 派生，生产默认随机', async () => {
    await withHarness(async (h) => {
      h.registry.register(tool({ name: 'bank:probe' }))
      h.test.ctx.events.on('tools/pre-execute', (input) => ({
        ...input,
        verdict: { kind: 'ask', ticket: { fingerprint: 'fp-1', amount: 50_000, ttlMs: 60_000 } },
      }))

      const pipeline = (
        mintTicketId?: (callId: string) => TicketId,
      ): ToolPipeline =>
        new ToolPipeline({
          ctx: h.test.ctx,
          registry: h.registry,
          session: h.session,
          guard: new ToolGuard(),
          sessionId: h.session.sessionId,
          now: fixedClock({ start: 1_000, step: 1 }).now,
          ...(mintTicketId === undefined ? {} : { mintTicketId }),
        })

      await pipeline((callId) => `ticket:snap-${callId}` as TicketId).execute(CALL)
      expect(h.log().at(-3)?.data).toMatchObject({ ticketId: 'ticket:snap-c1' })

      // 默认不传：同一 callId 两次签发必须是不同的票号——否则"不可预测"就是假的
      await pipeline().execute(CALL)
      await pipeline().execute(CALL)
      const asks = h.log().filter((event) => event.type === 'approval/asked')
      const before = String((asks.at(-2)?.data as { ticketId?: string }).ticketId)
      const after = String((asks.at(-1)?.data as { ticketId?: string }).ticketId)
      expect(before).not.toBe(after)
      expect(before).toMatch(/^ticket:[0-9a-f-]{36}$/)
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

  it('超时包裹可用（施工单 11 沙箱 / 超时策略的挂点形态）', async () => {
    await withHarness(async (h) => {
      h.registry.register(
        tool({
          name: 'bank:slow',
          execute: async () => {
            await new Promise((resolve) => setTimeout(resolve, 50))
            return 'too-late'
          },
        }),
      )
      // 环绕形态：listener 用 next(wrapped) 交还一个"包过的执行函数"
      h.test.ctx.events.on('tools/execute', async (run, next) => {
        const wrapped = async (call: ToolCallInput): Promise<unknown> => {
          const timeout = new Promise<never>((_resolve, reject) => {
            setTimeout(() => {
              reject(new Error('工具执行超时（10ms）'))
            }, 10)
          })
          return Promise.race([run(call), timeout])
        }
        return next(wrapped)
      })

      const execution = await h.pipeline.execute({ callId: 'c-slow', name: 'bank:slow', args: {} })

      // 环绕层抛的错同样走归一化：不冒泡到主循环
      expect(execution.result.isError).toBe(true)
      expect(execution.result.code).toBe('tool-failed')
      expect(execution.result.reason).toContain('超时')
    })
  })

  it('未注册工具 → 归一化为 tool-missing 失败结果（不落 tool/call，不冒泡）', async () => {
    await withHarness(async (h) => {
      const execution = await h.pipeline.execute(CALL)
      expect(execution.result).toMatchObject({ isError: true, code: 'tool-missing' })
      // 没有可执行体：只补一条结果，避免 assistant.toolCalls 出现空洞
      expect(h.log().map((event) => event.type)).toEqual(['tool/result'])
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

describe('参数预算', () => {
  it('参数超过 64KB → tool-args-too-large，不执行也不落 tool/call', async () => {
    await withHarness(async (h) => {
      let executed = 0
      h.registry.register(
        tool({
          name: 'bank:big',
          execute: async () => {
            executed += 1
            return 'ok'
          },
        }),
      )
      const result = await h.pipeline.execute({
        callId: 'c-big',
        name: 'bank:big',
        args: { blob: 'x'.repeat(70 * 1024) },
      })
      expect(result.result.code).toBe('tool-args-too-large')
      expect(executed).toBe(0)
      expect(h.log().some((event) => event.type === 'tool/call')).toBe(false)
    })
  })

  it('参数无法序列化（循环引用）→ tool-args-invalid', async () => {
    await withHarness(async (h) => {
      h.registry.register(tool({ name: 'bank:cyclic' }))
      const circular: Record<string, unknown> = {}
      circular['self'] = circular
      const result = await h.pipeline.execute({
        callId: 'c-cyclic',
        name: 'bank:cyclic',
        args: circular,
      })
      expect(result.result.code).toBe('tool-args-invalid')
    })
  })
})

describe('取消短路', () => {
  it('signal 已取消 → tool-interrupted，不执行工具体', async () => {
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
      const controller = new AbortController()
      controller.abort()
      const pipeline = new ToolPipeline({
        ctx: h.test.ctx,
        registry: h.registry,
        session: h.session,
        guard: h.guard,
        sessionId: h.session.sessionId,
        signal: controller.signal,
      })
      const result = await pipeline.execute(CALL)
      expect(result.result.code).toBe('tool-interrupted')
      expect(executed).toBe(0)
    })
  })
})

describe('B3 回调边界与结果落账顺序', () => {
  it('presenter / projector / finalizer 抛错 → 工具结果仍成功，逐项落 callback-failed', async () => {
    await withHarness(async (h) => {
      h.registry.register(
        tool({
          name: 'bank:probe',
          projectContent: () => {
            throw new Error('project boom')
          },
          finalizeContent: () => {
            throw new Error('finalize boom')
          },
          presentCall: () => {
            throw new Error('call boom')
          },
          presentResult: () => {
            throw new Error('result boom')
          },
        }),
      )

      const execution = await h.pipeline.execute(CALL)

      expect(execution.result.isError).toBe(false)
      expect(execution.callCard).toBeUndefined()
      expect(execution.resultCard).toBeUndefined()
      const failed = h.log().filter((event) => event.type === 'tool/callback-failed')
      expect(failed.map((event) => event.data.stage)).toEqual([
        'present-call',
        'project-content',
        'finalize-content',
        'present-result',
      ])
      expect(h.log().filter((event) => event.type === 'tool/result')).toHaveLength(1)
    })
  })

  it('tools/post-execute 监听器抛错 → 按 accept 继续，结果落账并审计', async () => {
    await withHarness(async (h) => {
      h.test.ctx.events.on('tools/post-execute', () => {
        throw new Error('post boom')
      })
      h.registry.register(
        tool({
          name: 'bank:probe',
          projectContent: () => [{ type: 'text', text: '原始内容' }],
        }),
      )

      const execution = await h.pipeline.execute(CALL)

      expect(execution.result.isError).toBe(false)
      expect(execution.result.content).toEqual([{ type: 'text', text: '原始内容' }])
      expect(
        h
          .log()
          .some(
            (event) =>
              event.type === 'tool/callback-failed' && event.data.stage === 'post-execute',
          ),
      ).toBe(true)
    })
  })

  it('tools/result 监听器抛错 → 后续监听器仍执行；tool/result 先落账再广播', async () => {
    await withHarness(async (h) => {
      const seen: string[] = []
      let persistedWhenBroadcast = false
      h.test.ctx.events.on('tools/result', (result) => {
        seen.push(`first:${result.callId}`)
        persistedWhenBroadcast = h
          .log()
          .some((event) => event.type === 'tool/result' && event.data.callId === result.callId)
        throw new Error('listener boom')
      })
      h.test.ctx.events.on('tools/result', (result) => {
        seen.push(`second:${result.callId}`)
      })
      h.registry.register(tool({ name: 'bank:probe', projectContent: () => [{ type: 'text', text: 'ok' }] }))

      const execution = await h.pipeline.execute(CALL)

      expect(execution.result.isError).toBe(false)
      expect(seen).toEqual(['first:c1', 'second:c1'])
      expect(persistedWhenBroadcast).toBe(true)
      expect(h.log().filter((event) => event.type === 'tool/result')).toHaveLength(1)
      expect(
        h
          .log()
          .some(
            (event) =>
              event.type === 'tool/callback-failed' && event.data.stage === 'emit-result',
          ),
      ).toBe(true)
    })
  })

  it('deny 路径同样先落账后广播，且广播失败不影响后续监听器', async () => {
    await withHarness(async (h) => {
      h.registry.register(tool({ name: 'bank:probe' }))
      h.test.ctx.events.on('tools/pre-execute', (input) => ({
        ...input,
        verdict: { kind: 'deny', reason: '拒绝', code: 'denied' },
      }))
      let second = 0
      h.test.ctx.events.on('tools/result', () => {
        throw new Error('listener boom')
      })
      h.test.ctx.events.on('tools/result', () => {
        second += 1
      })

      const execution = await h.pipeline.execute(CALL)

      expect(execution.result.isError).toBe(true)
      expect(execution.result.code).toBe('denied')
      expect(second).toBe(1)
      expect(h.log().filter((event) => event.type === 'tool/result')).toHaveLength(1)
    })
  })

  it('未知工具：落 tool/result 并广播，不进入执行段', async () => {
    await withHarness(async (h) => {
      let broadcast = 0
      h.test.ctx.events.on('tools/result', () => {
        broadcast += 1
      })

      const execution = await h.pipeline.execute({ callId: 'c-missing', name: 'missing', args: {} })

      expect(execution.result.isError).toBe(true)
      expect(execution.result.code).toBe('tool-missing')
      expect(broadcast).toBe(1)
      expect(h.log().filter((event) => event.type === 'tool/result')).toHaveLength(1)
    })
  })

  it('结果循环引用 → 渲染回退固定文本，工具结果仍是成功', async () => {
    await withHarness(async (h) => {
      const circular: Record<string, unknown> = {}
      circular['self'] = circular
      h.registry.register(
        tool({
          name: 'bank:probe',
          execute: async () => circular,
        }),
      )

      const execution = await h.pipeline.execute(CALL)

      expect(execution.result.isError).toBe(false)
      expect(execution.result.content[0]?.type).toBe('text')
      expect(
        h
          .log()
          .some(
            (event) =>
              event.type === 'tool/callback-failed' && event.data.stage === 'project-content',
          ),
      ).toBe(true)
    })
  })

  /**
   * 监听器抛错会被会话服务的 `emitIsolated` 隔离（落账已成功，审计通道其实是好的），
   * 只留一条 `bah-runtime:` 运维日志。
   *
   * 2026-10-23 修正：这条原本标题写的是"审计通道自身失败"，但让监听器抛错根本走不到
   * 审计通道坏了那条路，`toHaveBeenCalled()` 断到的其实是隔离日志——一条看着绿、
   * 实际没守它宣称的不变量的用例。审计通道真坏的场景由下面那条（把 `append` 做成
   * 同步抛错）覆盖，这里改成如实断言隔离日志的前缀。
   */
  it('广播监听器抛错 → 被隔离且只留 bah-runtime 运维日志，不反噬主流程', async () => {
    await withHarness(async (h) => {
      const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
      h.test.ctx.events.on('session/event', ({ event }) => {
        if (event.type === 'tool/callback-failed') throw new Error('audit down')
      })
      h.registry.register(
        tool({
          name: 'bank:probe',
          projectContent: () => {
            throw new Error('project boom')
          },
        }),
      )

      const execution = await h.pipeline.execute(CALL)

      expect(execution.result.isError).toBe(false)
      // 断的是"隔离日志"，不是"任意一条 console.error"——否则审计通道真坏时它也会误绿。
      expect(spy.mock.calls.some(([first]) => String(first).startsWith('bah-runtime:'))).toBe(true)
      expect(spy.mock.calls.some(([first]) => String(first).includes('tool/callback-failed 审计落账失败'))).toBe(
        false,
      )
      spy.mockRestore()
    })
  })

  /**
   * 回调抛错之后，写 `tool/callback-failed` 审计**又**失败 → 只留运维日志（L144-145）。
   *
   * 与上面那条用例的分工要说清：上面那条让 `session/event` 的监听器抛错，走的是会话服务
   * 的 `emitIsolated`（落账已成功，监听器被隔离），**审计通道其实是好的**；本条把
   * `append` 本身做成同步抛错，才是"审计通道坏了"这条兜底路径。
   *
   * 守的不变量有两条：
   * 1. 运维日志必须带上 stage 的原始异常（`auditError`），不许静默吞掉"账写不进去"这件事；
   * 2. 主流程不能被审计通道反噬——工具体已经成功，`projectContent` 抛错仍按回退内容
   *    收尾成**成功结果**，原始回调错误不因审计失败而变成工具失败。
   */
  it('回调抛错 + tool/callback-failed 审计也失败 → console.error 留痕，主流程仍按成功收尾', async () => {
    await withHarness(async (h) => {
      const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
      const auditError = new Error('audit channel down')
      /** 只把 `tool/callback-failed` 这一条做成同步抛错，其余落账照旧。 */
      const sink: SessionSink = {
        ...h.session,
        append: <S extends SessionEventType>(
          type: S,
          data: SessionEventMap[S],
          options?: AppendOptions,
        ) => {
          if (type === 'tool/callback-failed') throw auditError
          return h.session.append(type, data, options)
        },
      }
      const pipeline = new ToolPipeline({
        ctx: h.test.ctx,
        registry: h.registry,
        session: sink,
        guard: h.guard,
        sessionId: h.session.sessionId,
        now: () => 1_000,
      })
      h.registry.register(
        tool({
          name: 'bank:probe',
          projectContent: () => {
            throw new Error('project boom')
          },
        }),
      )

      const execution = await pipeline.execute(CALL)

      // ① 运维日志：固定前缀 + 原始审计异常本体（不是一串格式化文本）
      expect(spy).toHaveBeenCalledTimes(1)
      expect(spy).toHaveBeenCalledWith('bah-tools: tool/callback-failed 审计落账失败', auditError)
      // ② 主流程继续：成功结果仍是成功，内容走 fallbackContent 回退
      expect(execution.result.isError).toBe(false)
      expect(execution.result.code).toBeUndefined()
      expect(execution.result.content).toEqual([{ type: 'text', text: 'ok' }])
      // ③ 审计通道坏了 = 一条 callback-failed 都没落下去；其余落账不受牵连
      expect(h.log().map((event) => event.type)).toEqual(['tool/call', 'tool/result'])
      expect(h.log().filter((event) => event.type === 'tool/callback-failed')).toHaveLength(0)
      spy.mockRestore()
    })
  })

  it('自定义 emitResult 抛错 → 权威结果已落账并审计 emit-result', async () => {
    await withHarness(async (h) => {
      const pipeline = new ToolPipeline({
        ctx: h.test.ctx,
        registry: h.registry,
        session: h.session,
        guard: h.guard,
        sessionId: h.session.sessionId,
        now: () => 1_000,
        emitResult: () => {
          throw new Error('emit boom')
        },
      })
      h.registry.register(tool({ name: 'bank:probe' }))

      const execution = await pipeline.execute(CALL)

      expect(execution.result.isError).toBe(false)
      expect(h.log().filter((event) => event.type === 'tool/result')).toHaveLength(1)
      expect(
        h
          .log()
          .some(
            (event) =>
              event.type === 'tool/callback-failed' && event.data.stage === 'emit-result',
          ),
      ).toBe(true)
    })
  })

  it('未注入 now / signal / emitResult → 默认实现可用', async () => {
    await withHarness(async (h) => {
      const pipeline = new ToolPipeline({
        ctx: h.test.ctx,
        registry: h.registry,
        session: h.session,
        guard: h.guard,
        sessionId: h.session.sessionId,
      })
      h.registry.register(tool({ name: 'bank:probe' }))
      let broadcast = 0
      h.test.ctx.events.on('tools/result', () => {
        broadcast += 1
      })

      const execution = await pipeline.execute(CALL)

      expect(execution.result.isError).toBe(false)
      expect(execution.result.durationMs).toBeGreaterThanOrEqual(0)
      expect(broadcast).toBe(1)
    })
  })
})

describe('isReadOnly', () => {
  it('未注册工具返回 false（并行批次准入不抛）', async () => {
    await withHarness(async (h) => {
      expect(h.pipeline.isReadOnly('missing')).toBe(false)
      h.registry.register(tool({ name: 'bank:probe' }))
      // 绿级但没有副作用声明 = 保守拒绝（不能只信 tier）
      expect(h.pipeline.isReadOnly('bank:probe')).toBe(false)
      h.registry.register(tool({ name: 'bank:probe-write', sideEffect: 'write' }))
      expect(h.pipeline.isReadOnly('bank:probe-write')).toBe(false)
      h.registry.register(tool({ name: 'bank:probe-read', sideEffect: 'read' }))
      expect(h.pipeline.isReadOnly('bank:probe-read')).toBe(true)
      h.registry.register(tool({ name: 'bank:probe-pure', sideEffect: 'none' }))
      expect(h.pipeline.isReadOnly('bank:probe-pure')).toBe(true)
    })
  })
})

/**
 * 并行批次准入的第二道闸：`isReadOnly` 只管"能不能并行"，`isDenied` 管"本 turn 已经判过 deny 的
 * 同名同参调用必须回到串行、复用原判决"。这条一旦放开，模型就能靠"再发一次同样的调用"
 * 绕开 deny（同指纹 = 同一笔业务），所以把它钉在管线上而不是只靠 agent-loop 侧的间接覆盖。
 */
describe('isDenied', () => {
  it('未判 deny 的调用可进并行批次；同名同参被 deny 过必须回串行', async () => {
    await withHarness(async (h) => {
      h.registry.register(tool({ name: 'bank:probe' }))
      expect(h.pipeline.isDenied(CALL)).toBe(false)

      h.guard.deny(fingerprintOf(CALL), { kind: 'deny', reason: '命中危险规则', code: 'dangerous-op' })
      expect(h.pipeline.isDenied(CALL)).toBe(true)
      // 同指纹 = 同一次业务：换个 callId 也一样回串行（指纹只取 name + args）
      expect(h.pipeline.isDenied({ callId: 'c2', name: 'bank:probe', args: { account: 'a-1' } })).toBe(true)
      // 参数不同 = 另一笔业务：不受这条 deny 牵连
      expect(h.pipeline.isDenied({ callId: 'c3', name: 'bank:probe', args: { account: 'a-2' } })).toBe(false)
    })
  })
})
