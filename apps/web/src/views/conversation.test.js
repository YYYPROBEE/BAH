/**
 * 对话流用例（§5.1）。
 *
 * 为什么这个文件此前一直是空白：五个视图里只有它没有 `*.test.js`，
 * 于是"只有工具调用的助手消息永远停在'调用工具中…'"（B-12）和
 * "缺 endKind 时渲染成第 N 轮 · undefined"（B-21）两条都没人发现。
 */

import { describe, expect, it } from 'vitest'

import {
  CONVERSATION_KINDS,
  renderDraft,
  renderEmptyState,
  renderFrame,
  renderMessage,
  renderNotice,
  renderTurn,
} from './conversation.js'

/** 造一条消息帧。 */
function message(overrides = {}) {
  return {
    kind: 'message',
    seq: 3,
    at: 1_700_000_000_000,
    role: 'user',
    blocks: [{ type: 'text', text: '给王建国转 800 元' }],
    ...overrides,
  }
}

describe('对话流 · 轮次分割线', () => {
  it('开始显示"进行中"，结束显示结束原因', () => {
    expect(renderTurn({ kind: 'turn', turn: 1, phase: 'start' }).textContent).toContain('第 1 轮 · 进行中')
    expect(renderTurn({ kind: 'turn', turn: 1, phase: 'end', endKind: 'failed' }).textContent).toContain('第 1 轮 · 失败')
    expect(renderTurn({ kind: 'turn', turn: 1, phase: 'end', endKind: 'guard-stopped' }).textContent).toContain('已判停')
  })

  it('缺 endKind 时不渲染 undefined', () => {
    const node = renderTurn({ kind: 'turn', turn: 2, phase: 'end' })
    expect(node.textContent).toContain('第 2 轮 · 已结束')
    expect(node.textContent).not.toContain('undefined')
  })

  it('turn=0 是"准备"（还没开始第一轮）', () => {
    expect(renderTurn({ kind: 'turn', turn: 0, phase: 'start' }).textContent).toContain('准备')
  })
})

describe('对话流 · 消息气泡', () => {
  it('用户消息带角色、序号与正文', () => {
    const node = renderMessage(message())
    expect(node.className).toContain('message--user')
    expect(node.dataset.role).toBe('user')
    expect(node.textContent).toContain('给王建国转 800 元')
    expect(node.textContent).toContain('#3')
  })

  it('只有工具调用的助手消息说"发起工具调用"（不假装还在进行）', () => {
    const node = renderMessage(message({ role: 'assistant', blocks: [], toolCalls: [{ callId: 'call-1', name: 'transfer_create' }] }))
    expect(node.className).toContain('message--tool-only')
    expect(node.textContent).toContain('发起工具调用')
    expect(node.textContent).not.toContain('调用工具中')
  })

  it('上下文类用户消息用纠正样式（不是用户说过的话）', () => {
    const node = renderMessage(message({ source: 'runtime-context' }))
    expect(node.className).toContain('message--correction')
    expect(node.dataset.source).toBe('runtime-context')
    expect(node.textContent).toContain('运行时上下文')
  })

  it('非文本块留摘要，不丢"有内容"这个事实', () => {
    const node = renderMessage(message({ role: 'assistant', blocks: [{ type: 'other', summary: 'tool_use' }] }))
    expect(node.textContent).toContain('[tool_use]')
  })
})

describe('对话流 · 草稿与空态', () => {
  it('草稿带 data-draft（供装配层替换）', () => {
    const node = renderDraft('已经为您')
    expect(node.dataset.draft).toBe('true')
    expect(node.textContent).toContain('生成中')
    expect(node.textContent).toContain('已经为您')
  })

  it('空态给出三幕演示入口', () => {
    const node = renderEmptyState()
    expect(node.className).toContain('conversation__empty')
    expect(node.textContent).toContain('还没有对话')
    expect(node.textContent).toContain('给王建国转 800 元')
  })
})

describe('对话流 · 行内提示', () => {
  it('danger 用 danger 变体并带理由码', () => {
    const node = renderNotice({ kind: 'notice', seq: 7, level: 'danger', title: '本轮失败', code: 'tool-failed' })
    expect(node.className).toContain('ds-alert--danger')
    expect(node.querySelector('.ds-code').textContent).toBe('tool-failed')
  })

  it('未知级别退回 info', () => {
    const node = renderNotice({ kind: 'notice', seq: 8, level: 'mystery', title: '提示' })
    expect(node.className).toContain('ds-alert--info')
  })
})

describe('对话流 · 帧分发', () => {
  it('四类帧都有对应节点；未知帧有兜底文案', () => {
    expect(renderFrame({ kind: 'turn', turn: 1, phase: 'start' }).className).toContain('turn-divider')
    expect(renderFrame(message()).className).toContain('message')
    expect(renderFrame({ kind: 'notice', seq: 1, level: 'info', title: '提示' }).className).toContain('notice')
    expect(renderFrame({ kind: 'tool', seq: 1, callId: 'c', state: 'pending', title: '转账' }).className).toContain('tool-card')
    expect(renderFrame({ kind: 'mystery', seq: 1 }).textContent).toContain('未知帧')
  })

  it('对话流只收四类帧（审计 / DAG 各归各的面板）', () => {
    expect([...CONVERSATION_KINDS].sort()).toEqual(['message', 'notice', 'tool', 'turn'])
  })
})
