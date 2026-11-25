/**
 * 渠道正文过滤：窗口边车块不得进入用户可见正文（F-02/F-03 回归）。
 *
 * 边车块是给 `replayArmedPlans` 的机器可读副本；漏过滤的表现不是崩溃，
 * 而是把一段 JSON 渲染进转账卡片正文。前缀与 runtime 的
 * `WINDOW_PLAN_PREFIX` 是同一个值（浏览器包不引 runtime，测试面负责锁住）。
 */

import { describe, expect, it } from 'vitest'

import { WINDOW_PLAN_PREFIX } from '@bah/runtime'

import { blocksToText, buildCard } from './cards.ts'

const HUMAN = '已设置定时转账：明天 09:00 转 ¥500.00'
const SIDECAR = `${WINDOW_PLAN_PREFIX}${JSON.stringify({
  planId: 'p-schedule',
  windowId: 'w-call-schedule',
  dueAt: 1_761_200_000_000,
})}`

describe('blocksToText：窗口边车块', () => {
  it('跳过边车块，只留人话正文（前缀取自 runtime 同一常量）', () => {
    const text = blocksToText([
      { type: 'text', text: HUMAN },
      { type: 'text', text: SIDECAR },
    ])
    expect(text).toBe(HUMAN)
    expect(text).not.toContain('window-plan')
  })

  it('只有边车块时正文为空；图片与非文本块仍留摘要', () => {
    expect(blocksToText([{ type: 'text', text: SIDECAR }])).toBe('')
    expect(
      blocksToText([
        { type: 'text', text: SIDECAR },
        { type: 'image', mimeType: 'image/png' },
        { type: 'file' },
      ]),
    ).toBe('[图片 image/png]\n[非文本内容]')
  })

  it('只认行首前缀：正文中间出现同样标记不得被吞', () => {
    const text = `说明：${WINDOW_PLAN_PREFIX} 是内部标记，不是给用户看的`
    expect(blocksToText([{ type: 'text', text }])).toBe(text)
  })
})

describe('buildCard：边车块', () => {
  it('transfer_schedule 卡片正文不含边车 JSON，人话正文保留', () => {
    const card = buildCard({
      name: 'transfer_schedule',
      args: { amount: 500, payee: { name: '王建国' } },
      content: [
        { type: 'text', text: HUMAN },
        { type: 'text', text: SIDECAR },
      ],
      isError: false,
      amountConfirmed: true,
    })
    expect(card.body).toBe(HUMAN)
    expect(JSON.stringify(card)).not.toContain('window-plan')
    expect(JSON.stringify(card)).not.toContain('p-schedule')
  })
})