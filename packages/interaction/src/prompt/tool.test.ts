import { describe, expect, it } from 'vitest'

import type { SessionId, ToolExecContext } from '@bah/core'
import { BahError, validateAgainstSchema } from '@bah/util'

import { MANUAL_CHOICE } from './candidates.ts'
import { PROMPT_ASK_SCHEMA } from './result-schema.ts'
import { MAX_ASK_PER_SLOT, PROMPT_ASK_TOOL, createPromptAskTool } from './tool.ts'
import type { PromptAskDeps, PromptAskLedger } from './deps.ts'

function ctx(): ToolExecContext {
  return {
    sessionId: 's-1' as SessionId,
    callId: 'call-ask',
    signal: new AbortController().signal,
  }
}

function ledger(): { readonly deps: PromptAskDeps; readonly counts: Map<string, number> } {
  const counts = new Map<string, number>()
  const api: PromptAskLedger = {
    count: (_sessionId, slot) => counts.get(slot) ?? 0,
    increment: (_sessionId, slot) => {
      counts.set(slot, (counts.get(slot) ?? 0) + 1)
    },
  }
  return { deps: { ledger: api }, counts }
}

const twoCandidates = [
  { label: '王建国', value: 'p-wang' },
  { label: '张伟', value: 'p-zhang' },
]

describe('prompt_ask 工具（TC-INT-27/29/30）', () => {
  it('正常追问：候选 ≤3 + 手动输入，出参过契约 schema', async () => {
    const { deps, counts } = ledger()
    const tool = createPromptAskTool(deps)
    expect(tool.name).toBe(PROMPT_ASK_TOOL)
    expect(tool.tier.level).toBe('green')
    expect(tool.sideEffect).toBe('none')

    const result = await tool.execute(
      { question: '要转给谁？', candidates: twoCandidates, slot: 'payee' },
      ctx(),
    )
    expect(result.choices).toHaveLength(3)
    expect(result.choices.at(-1)).toEqual(MANUAL_CHOICE)
    expect(result.degraded).toBe(false)
    expect(result.askExhausted).toBe(false)
    expect(counts.get('payee')).toBe(1)
    expect(validateAgainstSchema(PROMPT_ASK_SCHEMA, result, 'result')).toBeUndefined()
  })

  it('TC-INT-29 同槽位第 3 次起降级为开放式并标记 exhausted', async () => {
    const { deps } = ledger()
    const tool = createPromptAskTool(deps)
    const args = { question: '要转给谁？', candidates: twoCandidates, slot: 'payee' }

    const first = await tool.execute(args, ctx())
    const second = await tool.execute(args, ctx())
    const third = await tool.execute(args, ctx())

    expect(first.askExhausted).toBe(false)
    expect(second.askExhausted).toBe(false)
    expect(third.askExhausted).toBe(true)
    expect(third.degraded).toBe(true)
    expect(third.choices).toEqual([MANUAL_CHOICE])
    expect(MAX_ASK_PER_SLOT).toBe(2)
  })

  it('TC-INT-30 换槽位重新计数（不被「payee 问两次」拖累）', async () => {
    const { deps } = ledger()
    const tool = createPromptAskTool(deps)
    await tool.execute({ question: 'a', candidates: twoCandidates, slot: 'payee' }, ctx())
    await tool.execute({ question: 'b', candidates: twoCandidates, slot: 'payee' }, ctx())
    const other = await tool.execute({ question: 'c', candidates: twoCandidates, slot: 'amountCents' }, ctx())
    expect(other.askExhausted).toBe(false)
  })

  it('未传 slot 时按固定键计数（不静默跳过上限）', async () => {
    const { deps, counts } = ledger()
    const tool = createPromptAskTool(deps)
    await tool.execute({ question: 'a', candidates: twoCandidates }, ctx())
    await tool.execute({ question: 'b', candidates: twoCandidates }, ctx())
    const third = await tool.execute({ question: 'c', candidates: twoCandidates }, ctx())
    expect(third.askExhausted).toBe(true)
    expect(counts.get('_unspecified')).toBe(2)
  })

  it('TC-INT-27 空候选降级为开放式提问（degraded=true）', async () => {
    const { deps } = ledger()
    const tool = createPromptAskTool(deps)
    const result = await tool.execute({ question: '请直接输入收款人姓名', candidates: [], slot: 'payee' }, ctx())
    expect(result.degraded).toBe(true)
    expect(result.askExhausted).toBe(false)
    expect(result.choices).toEqual([MANUAL_CHOICE])
    expect(result.allowFreeText).toBe(true)
  })

  it('非「无候选」的错误必须冒泡（不吞掉坏数据）', async () => {
    const { deps } = ledger()
    const tool = createPromptAskTool(deps)
    await expect(
      tool.execute({ question: 'q', candidates: [{ label: '张\n伟', value: 'v' }], slot: 'payee' }, ctx()),
    ).rejects.toBeInstanceOf(BahError)
  })


  it('不声明 projectContent：出参走默认 JSON 渲染（eval 与回放能取到逐字段原值）', async () => {
    const tool = createPromptAskTool(ledger().deps)
    expect(tool.projectContent).toBeUndefined()
    const result = await tool.execute(
      { question: '要转给谁？', candidates: twoCandidates, slot: 'payee' },
      ctx(),
    )
    // JSON 序列化后仍逐字段可读：这是 eval 的 tool-result 断言的通路
    expect(JSON.parse(JSON.stringify(result))).toMatchObject({
      question: '要转给谁？',
      allowFreeText: true,
      degraded: false,
      askExhausted: false,
    })
  })
})
