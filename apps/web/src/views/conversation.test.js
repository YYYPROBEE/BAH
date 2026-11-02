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
  orderToolFrames,
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

  it('对话流收八类帧（审计 / DAG 各归各的面板；goal/todo 桌面不产生；G7 计划卡 / 风险问卷进对话流）', () => {
    expect([...CONVERSATION_KINDS].sort()).toEqual([
      'choice',
      'effects',
      'message',
      'notice',
      'plan-card',
      'risk-questionnaire',
      'tool',
      'turn',
    ])
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

describe('对话流 · 助手正文表格', () => {
  it('GFM 管道表格渲染成带对齐的真表格，不再是一段竖线文本', () => {
    const node = renderMessage(
      message({
        role: 'assistant',
        blocks: [
          {
            type: 'text',
            text: ['本月收支：', '', '| 项目 | 金额 |', '| --- | ---: |', '| 收入 | ¥8,000.00 |', '| 支出 | ¥3,200.00 |'].join(
              '\n',
            ),
          },
        ],
      }),
    )
    expect(node.querySelector('table.md-table')).not.toBeNull()
    expect(node.querySelectorAll('th')).toHaveLength(2)
    expect(node.querySelectorAll('td')).toHaveLength(4)
    expect(node.textContent).toContain('¥8,000.00')
    expect(node.textContent).not.toContain('| --- |')
  })

  it('每条消息都不再挂反馈行（反馈只在对话末尾出现一次）', () => {
    const node = renderMessage(
      message({ role: 'assistant', blocks: [{ type: 'text', text: '余额 100 元' }] }),
      { feedback: { value: () => null, rate: () => null } },
    )
    expect(node.querySelector('[data-role="feedback"]')).toBeNull()
    expect(node.textContent).toContain('余额 100 元')
  })
})

/** 造一条工具帧（`state` / `card` 按需覆盖）。 */
function toolFrame(overrides = {}) {
  return {
    kind: 'tool',
    seq: 4,
    at: 1_700_000_000_004,
    callId: 'c-1',
    name: 'account_list',
    title: '账户',
    state: 'done',
    ...overrides,
  }
}

/** 造一条带工具调用的消息帧；`blocks` 缺省给一句正文。 */
function assistantWithCalls(calls, blocks = [{ type: 'text', text: '我查一下账户' }]) {
  return { kind: 'message', seq: 3, at: 1_700_000_000_003, role: 'assistant', blocks, toolCalls: calls }
}

/** 由工具帧建 `toolFrameFor` 依赖（与 main.js 的 `toolFramesByCall` 同形态）。 */
function frameIndex(frames) {
  const byCall = new Map(frames.map((frame) => [frame.callId, frame]))
  return { toolFrameFor: (callId) => byCall.get(callId) }
}

describe('对话流 · 工具卡跟随发起它的助手消息', () => {
  const kinds = (frames) => frames.map((frame) => `${String(frame.kind)}:${String(frame.callId ?? frame.role ?? '')}`)

  it('事件日志把工具结果落在助手消息之前时，展示顺序把卡挪到消息后面', () => {
    const tool = toolFrame({ callId: 'c-1' })
    const user = message({ role: 'user', blocks: [{ type: 'text', text: '查余额' }] })
    const assistant = assistantWithCalls([{ callId: 'c-1', name: 'account_list' }])
    expect(kinds(orderToolFrames([tool, user, assistant]))).toEqual(['message:user', 'message:assistant', 'tool:c-1'])
  })

  it('一条消息引用多个调用时，卡片按调用顺序排（不按落账顺序）', () => {
    const second = toolFrame({ callId: 'c-2' })
    const first = toolFrame({ callId: 'c-1' })
    const assistant = assistantWithCalls([
      { callId: 'c-1', name: 'account_list' },
      { callId: 'c-2', name: 'transaction_list' },
    ])
    expect(kinds(orderToolFrames([second, first, assistant]))).toEqual([
      'message:assistant',
      'tool:c-1',
      'tool:c-2',
    ])
  })

  it('没有工具帧时原样返回，且不改入参数组', () => {
    const user = message()
    const assistant = assistantWithCalls([])
    const input = [user, assistant]
    const out = orderToolFrames(input)
    expect(out).not.toBe(input)
    expect(out).toEqual(input)
    expect(input).toHaveLength(2)
  })

  it('没有助手消息引用的工具帧留在末尾，不吞掉', () => {
    const orphan = toolFrame({ callId: 'c-9' })
    const notice = { kind: 'notice', seq: 7, level: 'info', text: '已判停' }
    const out = orderToolFrames([orphan, notice])
    expect(kinds(out)).toEqual(['notice:', 'tool:c-9'])
  })

  it('同一工具帧被两条助手消息引用时只出现一次', () => {
    const tool = toolFrame({ callId: 'c-1' })
    const first = assistantWithCalls([{ callId: 'c-1', name: 'account_list' }], [{ type: 'text', text: '第一次' }])
    const second = assistantWithCalls([{ callId: 'c-1', name: 'account_list' }], [{ type: 'text', text: '第二次' }])
    expect(kinds(orderToolFrames([first, second, tool]))).toEqual([
      'message:assistant',
      'tool:c-1',
      'message:assistant',
    ])
  })

  it('引用里混进空项不炸（缺 callId 的调用没有卡可挂）', () => {
    const tool = toolFrame({ callId: 'c-1' })
    const assistant = assistantWithCalls([null, { name: 'account_list' }, { callId: 'c-1' }])
    expect(kinds(orderToolFrames([tool, assistant]))).toEqual(['message:assistant', 'tool:c-1'])
  })
})

describe('对话流 · 助手消息展开工具结果', () => {
  it('已完成的调用展开状态、标题、字段与表格', () => {
    const tool = toolFrame({
      card: {
        title: '账户列表',
        fields: [{ label: '尾号', value: '1234' }],
        table: { headers: ['账户', '余额'], rows: [['储蓄账户', '¥1,200.00']] },
      },
    })
    const node = renderMessage(assistantWithCalls([{ callId: 'c-1', name: 'account_list' }]), frameIndex([tool]))

    const tag = node.querySelector('.message__call-result-head .ds-tag')
    expect(tag.textContent).toBe('已完成')
    expect(tag.className).toContain('ds-tag--success')
    expect(node.querySelector('.message__call-result-title').textContent).toBe('账户列表')
    expect(node.querySelector('.message__call-head .ds-tag').textContent).toBe('account_list')
    expect(node.querySelector('.message__call-id').textContent).toBe('c-1')
    expect(node.querySelectorAll('.message__call-field')).toHaveLength(1)
    expect(node.querySelector('.message__call-field-value').textContent).toBe('1234')
    expect(node.querySelectorAll('.message__call-table tbody tr')).toHaveLength(1)
    expect(node.textContent).toContain('¥1,200.00')
  })

  it('被拦截的调用标 danger 并带出 reason 与 code', () => {
    const tool = toolFrame({ state: 'denied', reason: '超出单笔限额', code: 'tier-red' })
    const node = renderMessage(assistantWithCalls([{ callId: 'c-1', name: 'transfer' }]), frameIndex([tool]))

    const tag = node.querySelector('.message__call-result-head .ds-tag')
    expect(tag.textContent).toBe('已拦截')
    expect(tag.className).toContain('ds-tag--danger')
    expect(node.querySelector('.message__call-reason').textContent).toBe('超出单笔限额')
    expect(node.querySelector('.ds-code').textContent).toBe('tier-red')
    // 卡片本身兜底成工具标题（card.title 缺省时不给空标题）
    expect(node.querySelector('.message__call-result-title').textContent).toBe('账户')
    expect(node.querySelectorAll('.message__call-field')).toHaveLength(0)
  })

  it('待执行 / 未知状态一律"待执行"+warning，与工具卡的兜底同口径', () => {
    for (const state of ['pending', 'running', undefined]) {
      const tool = toolFrame({ state, card: { title: '账户' } })
      const node = renderMessage(assistantWithCalls([{ callId: 'c-1', name: 'account_list' }]), frameIndex([tool]))
      const tag = node.querySelector('.message__call-result-head .ds-tag')
      expect(tag.textContent).toBe('待执行')
      expect(tag.className).toContain('ds-tag--warning')
    }
  })

  it('字段只展开前 8 条、表格只渲染前 6 行（不把整份流水塞进气泡）', () => {
    const tool = toolFrame({
      card: {
        title: '交易流水',
        fields: Array.from({ length: 12 }, (_, i) => ({ label: `L${String(i)}`, value: `V${String(i)}` })),
        table: {
          headers: ['日期', '金额'],
          rows: Array.from({ length: 9 }, (_, i) => [`2026-11-0${String(i)}`, String(i)]),
        },
      },
    })
    const node = renderMessage(assistantWithCalls([{ callId: 'c-1', name: 'transaction_list' }]), frameIndex([tool]))
    expect(node.querySelectorAll('.message__call-field')).toHaveLength(8)
    expect(node.querySelectorAll('.message__call-table tbody tr')).toHaveLength(6)
    expect(node.querySelectorAll('.message__call-table thead th')).toHaveLength(2)
  })

  it('查不到对应工具帧时只列工具名与调用 ID，不产生空结果块', () => {
    const node = renderMessage(assistantWithCalls([{ callId: 'c-9', name: 'unknown_tool' }]), {
      toolFrameFor: () => undefined,
    })
    expect(node.querySelector('.message__call-result')).toBeNull()
    expect(node.querySelector('.message__call-head').textContent).toContain('unknown_tool')
    expect(node.querySelector('.message__call-id').textContent).toBe('c-9')
  })

  it('其他端不传 toolFrameFor 时照旧渲染（缺依赖不炸）', () => {
    const node = renderMessage(assistantWithCalls([{ callId: 'c-1', name: 'account_list' }]))
    expect(node.querySelector('.message__call-result')).toBeNull()
    expect(node.textContent).toContain('account_list')
  })

  it('只有工具调用、没有正文的助手消息同样展开结果', () => {
    const tool = toolFrame({ card: { title: '账户', fields: [{ label: '余额', value: '¥1,200.00' }] } })
    const node = renderMessage(assistantWithCalls([{ callId: 'c-1', name: 'account_list' }], []), frameIndex([tool]))
    expect(node.className).toContain('message--tool-only')
    expect(node.querySelector('.message__call-result')).not.toBeNull()
    expect(node.textContent).toContain('¥1,200.00')
  })
})
