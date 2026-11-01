/**
 * `askForNonBankTools`：非银行工具的人工审批包装。
 *
 * 这是**唯一**给非银行写工具补黄级审批的实现（`bank/tools/governance` 对非银行工具直接放行）。
 * 三条锚点：
 * 1. **顺序**：先 `await next()` 再 ask——下游的 deny / 内层 ask 不能被外层审批盖住；
 * 2. **最小票据**：只把「参数指纹 + TTL」交上去，不把参数原文塞进票据；
 * 3. **可逆**：dispose 后判决恢复默认 allow（注册即可逆是本仓的编码纪律第 1 条）。
 */

import { canonicalJson, sha256Hex } from '@bah/util'
import { createTestContext } from '@bah/test-support'
import { afterEach, describe, expect, it } from 'vitest'

import type { PreExecuteInput, PreExecuteVerdict } from '@bah/runtime'
import type { TestContext } from '@bah/test-support'

import { askForNonBankTools } from './ask.ts'

const TTL = 60_000

let test: TestContext | undefined

afterEach(async () => {
  await test?.dispose()
  test = undefined
})

function input(name: string, args: Readonly<Record<string, unknown>> = { id: 'f-1' }): PreExecuteInput {
  return { call: { callId: 'c-1', name, args }, verdict: { kind: 'allow' } }
}

async function bootAsk(
  policy: { names: readonly string[]; ttlMs: number } = { names: ['fact_forget'], ttlMs: TTL },
): Promise<TestContext> {
  const created = createTestContext()
  askForNonBankTools(created.ctx, policy)
  await created.start()
  test = created
  return created
}

describe('非名单工具原样放行', () => {
  it('不改写判决，也不产生票据', async () => {
    const { ctx } = await bootAsk()
    const out = await ctx.events.waterfall('tools/pre-execute', input('todo_write'))
    expect(out.verdict).toEqual({ kind: 'allow' })
  })

  it('名单为空时所有工具都放行', async () => {
    const { ctx } = await bootAsk({ names: [], ttlMs: TTL })
    const out = await ctx.events.waterfall('tools/pre-execute', input('fact_forget'))
    expect(out.verdict).toEqual({ kind: 'allow' })
  })
})

describe('名单工具升级为 ask', () => {
  it('下游 allow → ask，票据带参数指纹与 TTL', async () => {
    const { ctx } = await bootAsk()
    const payload = input('fact_forget', { id: 'f-9', relation: 'like' })
    const out = await ctx.events.waterfall('tools/pre-execute', payload)
    expect(out.verdict).toEqual({
      kind: 'ask',
      ticket: {
        fingerprint: sha256Hex(canonicalJson(payload.call.args)),
        ttlMs: TTL,
      },
    })
    // 票据里不含参数原文（审计只认摘要）
    expect(JSON.stringify(out.verdict)).not.toContain('f-9')
    expect(JSON.stringify(out.verdict)).not.toContain('like')
  })

  it('参数键序不影响指纹（canonicalJson）', async () => {
    const { ctx } = await bootAsk()
    const left = await ctx.events.waterfall(
      'tools/pre-execute',
      input('fact_forget', { a: 1, b: 'x' }),
    )
    const right = await ctx.events.waterfall(
      'tools/pre-execute',
      input('fact_forget', { b: 'x', a: 1 }),
    )
    expect(left.verdict).toMatchObject({ kind: 'ask' })
    expect(right.verdict).toMatchObject({ kind: 'ask' })
    if (left.verdict.kind !== 'ask' || right.verdict.kind !== 'ask') throw new Error('unreachable')
    expect(left.verdict.ticket.fingerprint).toBe(right.verdict.ticket.fingerprint)
  })

  it('参数不同 → 指纹不同（换参数不能复用同一张票据）', async () => {
    const { ctx } = await bootAsk()
    const left = await ctx.events.waterfall('tools/pre-execute', input('fact_forget', { id: 'a' }))
    const right = await ctx.events.waterfall('tools/pre-execute', input('fact_forget', { id: 'b' }))
    if (left.verdict.kind !== 'ask' || right.verdict.kind !== 'ask') throw new Error('unreachable')
    expect(left.verdict.ticket.fingerprint).not.toBe(right.verdict.ticket.fingerprint)
  })
})

describe('判决顺序：下游优先', () => {
  it('下游 deny 不会被外层 ask 盖住', async () => {
    const { ctx } = await bootAsk()
    const deny: PreExecuteVerdict = { kind: 'deny', reason: '无权限', code: 'no-identity' }
    ctx.events.on('tools/pre-execute', (value) => ({ ...value, verdict: deny }))

    const out = await ctx.events.waterfall('tools/pre-execute', input('fact_forget'))
    expect(out.verdict).toEqual(deny)
  })

  it('下游已有内层 ask 时保留内层票据（不重复包装）', async () => {
    const { ctx } = await bootAsk()
    const inner: PreExecuteVerdict = {
      kind: 'ask',
      ticket: { fingerprint: 'inner-fp', ttlMs: 1_000 },
      challenge: 'sms',
    }
    ctx.events.on('tools/pre-execute', (value) => ({ ...value, verdict: inner }))

    const out = await ctx.events.waterfall('tools/pre-execute', input('fact_forget'))
    expect(out.verdict).toEqual(inner)
  })
})

describe('可逆', () => {
  it('dispose 后判决恢复默认 allow', async () => {
    const { ctx } = await bootAsk()
    expect((await ctx.events.waterfall('tools/pre-execute', input('fact_forget'))).verdict.kind).toBe(
      'ask',
    )
    await ctx.dispose()
    test = undefined
    expect((await ctx.events.waterfall('tools/pre-execute', input('fact_forget'))).verdict).toEqual({
      kind: 'allow',
    })
  })
})
