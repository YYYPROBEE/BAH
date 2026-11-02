/**
 * 契约校验接缝的管线级断言（W03 · TC-W03-01 / 04 / 09）。
 *
 * 校验器本身在 `@bah/util` 已有 33 例；本文件只证明**接缝通了**：
 * 服务注入后管线真的会拦，且拦的位置对（`tool/call` 在、票据不在）。
 *
 * 为什么单独一个文件：`pipeline.test.ts` 断言的是七段管线本身，
 * 契约校验是"可选接缝"，混进去会让那个文件的用例数基线（W15 要接 CI）失真。
 */

import { describe, expect, it } from 'vitest'

import { asSessionId, createTestContext, fixedClock } from '@bah/test-support'

import { SESSION_SERVICE, provideSession } from '../session/service.ts'
import { ToolGuard } from './guard.ts'
import { ToolPipeline } from './pipeline.ts'
import { ToolRegistry } from './registry.ts'
import { provideTools } from './index.ts'
import { findToolContracts, provideToolContracts, type ToolContractSource } from './contracts.ts'
import type { ToolCallInput, ToolDefinition } from './types.ts'

function tool(overrides: Partial<ToolDefinition> & { name: string }): ToolDefinition {
  return {
    description: '测试工具',
    schema: { type: 'object' },
    tier: { level: 'green' },
    execute: async () => 'ok',
    ...overrides,
  }
}

/** 建一套最小上下文；`contracts` 为 `undefined` 表示不装契约（模拟纯内核 profile）。 */
async function withPipeline(
  contracts: ToolContractSource | undefined,
  run: (ctx: {
    pipeline: ToolPipeline
    registry: ToolRegistry
    events: () => readonly { type: string }[]
  }) => Promise<void>,
): Promise<void> {
  const test = createTestContext()
  const sessionId = asSessionId('s-contract')
  const clock = fixedClock({ start: 1_000, step: 1 })
  provideSession(test.ctx, { sessionId, now: clock.now })
  const session = test.ctx.get(SESSION_SERVICE)
  const registry = new ToolRegistry()
  provideTools(test.ctx, registry)
  if (contracts !== undefined) provideToolContracts(test.ctx, contracts)
  const pipeline = new ToolPipeline({
    ctx: test.ctx,
    registry,
    session,
    guard: new ToolGuard(),
    sessionId,
    now: clock.now,
  })
  try {
    await run({ pipeline, registry, events: () => session.events() })
  } finally {
    await test.dispose()
  }
}

const CALL: ToolCallInput = { callId: 'c1', name: 'bank:probe', args: { account: 'a-1' } }

const SOURCE: ToolContractSource = {
  get: (name) =>
    name === 'bank:probe'
      ? {
          argsSchema: {
            type: 'object',
            required: ['account', 'amount'],
            properties: { account: { type: 'string' }, amount: { type: 'number' } },
          },
          resultSchema: {
            type: 'object',
            required: ['balanceCents'],
            properties: { balanceCents: { type: 'integer' } },
          },
          validateAt: 'pre-execute',
        }
      : undefined,
}

describe('契约接缝 · 缺省不校验', () => {
  it('没提供契约服务时照常执行（既有 1616 例不因缺省而变红）', async () => {
    await withPipeline(undefined, async ({ pipeline, registry }) => {
      let executed = 0
      registry.register(
        tool({
          name: 'bank:probe',
          execute: async () => {
            executed += 1
            return 'ok'
          },
        }),
      )
      const execution = await pipeline.execute(CALL)
      expect(executed).toBe(1)
      expect(execution.result.isError).toBe(false)
    })
  })

  it('findToolContracts 在未注册时返回 undefined（不抛）', () => {
    const test = createTestContext()
    expect(findToolContracts(test.ctx)).toBeUndefined()
  })
})

describe('契约接缝 · 入参（TC-W03-01 / 09）', () => {
  it('TC-W03-01 缺必填 amount → tool-args-invalid，且没有 ticket/issued', async () => {
    await withPipeline(SOURCE, async ({ pipeline, registry, events }) => {
      let executed = 0
      registry.register(
        tool({
          name: 'bank:probe',
          tier: { level: 'yellow' }, // 黄档会走审批 → 若校验晚于审批就会出现票据
          execute: async () => {
            executed += 1
            return { balanceCents: 100 }
          },
        }),
      )

      const execution = await pipeline.execute(CALL)

      expect(execution.result.isError).toBe(true)
      expect(execution.result.code).toBe('tool-args-invalid')
      // 工具体一次都不许跑：参数都不对，跑了就是"用错参数动了钱"
      expect(executed).toBe(0)
      const types = events().map((event) => event.type)
      expect(types).toContain('tool/result')
      expect(types).not.toContain('ticket/issued')
    })
  })

  it('TC-W03-09 校验失败时 tool/call 仍在，且 args 原样保留（审计留痕）', async () => {
    await withPipeline(SOURCE, async ({ pipeline, registry, events }) => {
      registry.register(tool({ name: 'bank:probe' }))

      await pipeline.execute(CALL)

      const call = events().find((event) => event.type === 'tool/call')
      expect(call).toBeDefined()
      // 事件载荷在 `.data` 里（顶层是 type / seq 等信封字段）
      expect((call as unknown as { data: { args: unknown } }).data.args).toEqual({ account: 'a-1' })
    })
  })

  it('TC-W03-03 enum 越界 → tool-args-invalid', async () => {
    const source: ToolContractSource = {
      get: () => ({
        argsSchema: { type: 'object', properties: { channel: { type: 'string', enum: ['app'] } } },
        resultSchema: { type: 'object' },
        validateAt: 'pre-execute',
      }),
    }
    await withPipeline(source, async ({ pipeline, registry }) => {
      registry.register(tool({ name: 'bank:probe' }))
      const execution = await pipeline.execute({
        callId: 'c2',
        name: 'bank:probe',
        args: { channel: 'fax' },
      })
      expect(execution.result.code).toBe('tool-args-invalid')
    })
  })
})

describe('契约接缝 · 出参（TC-W03-04）', () => {
  it('出参缺 balanceCents → tool-result-invalid，且 tool/result 落 isError', async () => {
    await withPipeline(SOURCE, async ({ pipeline, registry, events }) => {
      registry.register(
        tool({
          name: 'bank:probe',
          execute: async () => ({ account: 'a-1' }), // 少 balanceCents
        }),
      )

      const execution = await pipeline.execute({
        callId: 'c3',
        name: 'bank:probe',
        args: { account: 'a-1', amount: 800 },
      })

      expect(execution.result.isError).toBe(true)
      expect(execution.result.code).toBe('tool-result-invalid')
      const settled = events().find((event) => event.type === 'tool/result') as unknown as {
        data: { isError: boolean; code?: string }
      }
      expect(settled.data.isError).toBe(true)
      expect(settled.data.code).toBe('tool-result-invalid')
    })
  })

  it('出参金额不是整数分 → tool-result-invalid', async () => {
    await withPipeline(SOURCE, async ({ pipeline, registry }) => {
      registry.register(
        tool({ name: 'bank:probe', execute: async () => ({ balanceCents: 100.5 }) }),
      )
      const execution = await pipeline.execute({
        callId: 'c4',
        name: 'bank:probe',
        args: { account: 'a-1', amount: 800 },
      })
      expect(execution.result.code).toBe('tool-result-invalid')
    })
  })

  it('入参与出参都合规时照常成功', async () => {
    await withPipeline(SOURCE, async ({ pipeline, registry }) => {
      registry.register(
        tool({ name: 'bank:probe', execute: async () => ({ balanceCents: 80_000 }) }),
      )
      const execution = await pipeline.execute({
        callId: 'c5',
        name: 'bank:probe',
        args: { account: 'a-1', amount: 800 },
      })
      expect(execution.result.isError).toBe(false)
    })
  })
})
