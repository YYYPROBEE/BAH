/**
 * 对话流用例（§5.1）+ 消息渲染（B3 / I17：人工坐席气泡、交接语系统提示条）。
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

  it('运行时上下文默认折叠，点「展开」才显示正文', () => {
    const node = renderMessage(message({ source: 'runtime-context' }))
    const body = node.querySelector('.bubble__body')
    const toggle = node.querySelector('.message__toggle')
    expect(body.hidden).toBe(true)
    expect(toggle.getAttribute('aria-expanded')).toBe('false')

    toggle.click()
    expect(body.hidden).toBe(false)
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    expect(toggle.textContent).toBe('收起')
  })

  it('接管期客户留言画成 user 气泡并标注"等待坐席处理"（不是运行时上下文）', () => {
    const node = renderMessage(
      message({ source: 'handoff-waiting', blocks: [{ type: 'text', text: '那我等你消息' }] }),
    )
    expect(node.className).toContain('message--user')
    expect(node.className).toContain('message--handoff-waiting')
    expect(node.className).not.toContain('message--correction')
    expect(node.textContent).toContain('那我等你消息')
    expect(node.textContent).toContain('等待坐席处理')
    expect(node.textContent).not.toContain('运行时上下文')
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
  it('六类帧都有对应节点；未知帧有兜底文案', () => {
    expect(renderFrame({ kind: 'turn', turn: 1, phase: 'start' }).className).toContain('turn-divider')
    expect(renderFrame(message()).className).toContain('message')
    expect(renderFrame({ kind: 'notice', seq: 1, level: 'info', title: '提示' }).className).toContain('notice')
    expect(renderFrame({ kind: 'tool', seq: 1, callId: 'c', state: 'pending', title: '转账' }).className).toContain('tool-card')
    expect(
      renderFrame({
        kind: 'choice',
        seq: 2,
        at: 2,
        callId: 'call-ask',
        prompt: '要转给谁？',
        options: [{ id: 'a', label: '王建国' }],
        allowFreeText: true,
      }).className,
    ).toContain('choice-card')
    expect(
      renderFrame({
        kind: 'effects',
        seq: 3,
        at: 3,
        turn: 1,
        items: [{ callId: 'c1', name: 'transfer_create', title: '转账', tone: 'success' }],
      }).className,
    ).toContain('effects')
    expect(renderFrame({ kind: 'mystery', seq: 1 }).textContent).toContain('未知帧')
  })

  it('choice 帧把交互依赖透传给卡片（点选走注入的 submit）', async () => {
    const node = renderFrame(
      {
        kind: 'choice',
        seq: 2,
        at: 2,
        callId: 'call-ask',
        prompt: '要转给谁？',
        options: [{ id: 'a', label: '王建国' }],
        allowFreeText: true,
      },
      { submit: async () => ({ ok: true }) },
    )
    const option = node.querySelector('[data-role="choice-option"]')
    expect(option.disabled).toBe(false)
    option.click()
    await Promise.resolve()
    expect(node.dataset.state).toBe('picked')
  })

  it('对话流收六类帧（审计 / DAG 各归各的面板；goal/todo 桌面不产生）', () => {
    expect([...CONVERSATION_KINDS].sort()).toEqual(['choice', 'effects', 'message', 'notice', 'tool', 'turn'])
  })
})

describe('renderMessage · operator / handover', () => {
  it('I17 role=operator → .message--operator，meta 是坐席名而不是 BAH', () => {
    const node = renderMessage({
      kind: 'message',
      seq: 9,
      at: 1,
      role: 'operator',
      operator: '坐席小周',
      blocks: [{ type: 'text', text: '您好，我是人工坐席' }],
    })
    expect(node.className).toContain('message--operator')
    expect(node.className).not.toContain('message--assistant')
    const meta = node.querySelector('.message__meta')
    expect(meta.textContent).toContain('坐席小周')
    expect(meta.textContent).not.toContain('BAH')
    expect(node.querySelector('.bubble__text').textContent).toBe('您好，我是人工坐席')
  })

  it('operator 缺显示名时用"人工坐席"兜底', () => {
    const node = renderMessage({
      kind: 'message',
      seq: 1,
      at: 1,
      role: 'operator',
      blocks: [{ type: 'text', text: '在吗' }],
    })
    expect(node.querySelector('.message__meta').textContent).toContain('人工坐席')
  })

  it('handoff-handover 的 user/message → 系统提示条（不是用户气泡）', () => {
    const node = renderMessage({
      kind: 'message',
      seq: 10,
      at: 1,
      role: 'user',
      source: 'handoff-handover',
      blocks: [{ type: 'text', text: '【人工坐席交接】已核对收款人' }],
    })
    expect(node.className).toContain('message--correction')
    expect(node.className).not.toContain('message--user')
    expect(node.querySelector('.message__meta').textContent).toContain('系统交接（已交回智能助手）')
  })

  it('普通用户 / 助手气泡不收影响', () => {
    const user = renderMessage({ kind: 'message', seq: 1, at: 1, role: 'user', blocks: [{ type: 'text', text: '你好' }] })
    expect(user.className).toContain('message--user')
    const assistant = renderMessage({
      kind: 'message',
      seq: 2,
      at: 1,
      role: 'assistant',
      blocks: [{ type: 'text', text: '你好' }],
    })
    expect(assistant.className).toContain('message--assistant')
  })
})
