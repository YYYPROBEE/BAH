/**
 * 消息渲染（B3 / I17）：人工坐席气泡、交接语系统提示条。
 */

import { describe, expect, it } from 'vitest'

import { renderMessage } from './conversation.js'

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
