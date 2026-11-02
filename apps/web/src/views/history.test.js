/**
 * 历史对话渲染件（2026-11-02）。
 *
 * 断言重点是**只读语义**：历史视图里不许出现任何能写回服务端的入口
 * （审批按钮、选择题作答、风险问卷提交）。这不是样式偏好——审批卡上的按钮会
 * `POST /api/approval/<ticketId>` 打到**当前**会话，而票据属于历史会话，
 * 真点下去是 `403 foreign-ticket`，同号票据时是跨会话误批。
 */

import { describe, expect, it, vi } from 'vitest'

import { el } from '../dom.js'
import {
  historyStamp,
  renderHistoryList,
  renderHistoryEmpty,
  renderHistoryError,
  renderHistoryLoading,
  renderHistoryPanel,
  renderReadonlyFrames,
  renderReadonlyView,
  renderRecordRow,
} from './history.js'

const ITEM = {
  sessionId: 's-a',
  title: '转 500 给他',
  startedAt: 1_700_000_000_000,
  lastAt: 1_700_000_060_000,
  events: 42,
  turns: 3,
  current: false,
}

describe('historyStamp', () => {
  it('正常时间戳给 MM-DD HH:mm', () => {
    const at = new Date(2026, 10, 2, 9, 7).getTime()
    expect(historyStamp(at)).toBe('11-02 09:07')
  })

  it.each([0, -1, Number.NaN, undefined, null])('%s 一律回破折号', (value) => {
    expect(historyStamp(value)).toBe('—')
  })
})

describe('列表', () => {
  it('一条摘要渲染标题与元信息，点击回调带 sessionId', () => {
    const onOpen = vi.fn()
    const list = renderHistoryList([ITEM], onOpen)
    expect(list.querySelectorAll('[data-role="history-item"]')).toHaveLength(1)
    expect(list.textContent).toContain('转 500 给他')
    expect(list.textContent).toContain('42 条')
    expect(list.textContent).toContain('3 轮')
    list.querySelector('[data-role="history-item"]').click()
    expect(onOpen).toHaveBeenCalledWith('s-a')
  })

  it('当前会话带"当前"徽标，别的没有', () => {
    const list = renderHistoryList([ITEM, { ...ITEM, sessionId: 's-b', current: true }], () => {})
    expect(list.querySelectorAll('.history__badge')).toHaveLength(1)
    expect(list.querySelector('.history__badge').textContent).toBe('当前')
  })

  it('空态 / 加载态 / 错误态文案可区分', () => {
    expect(renderHistoryEmpty().textContent).toContain('还没有历史会话')
    expect(renderHistoryLoading().textContent).toContain('正在读取')
    expect(renderHistoryError('后端没装持久化').textContent).toContain('后端没装持久化')
    // 空理由不吞成空白：给一句兜底
    expect(renderHistoryError('').textContent).toContain('读取历史失败')
  })
})

describe('面板', () => {
  const noop = () => {}

  it('loading 优先于 items', () => {
    const panel = renderHistoryPanel({ loading: true, items: [ITEM], onOpen: noop })
    expect(panel.querySelector('[data-role="history-loading"]')).not.toBeNull()
    expect(panel.querySelector('[data-role="history-item"]')).toBeNull()
  })

  it('error 优先于 loading', () => {
    const panel = renderHistoryPanel({ error: '超时', loading: true, onOpen: noop })
    expect(panel.querySelector('[data-role="history-error"]')).not.toBeNull()
  })

  it('有数据时渲染列表', () => {
    const panel = renderHistoryPanel({ items: [ITEM], onOpen: noop })
    expect(panel.querySelectorAll('[data-role="history-item"]')).toHaveLength(1)
  })

  it('空数组走空态', () => {
    const panel = renderHistoryPanel({ items: [], onOpen: noop })
    expect(panel.querySelector('[data-role="history-empty"]')).not.toBeNull()
  })

  it('不给 onRefresh 就不渲染刷新按钮', () => {
    expect(renderHistoryPanel({ items: [], onOpen: noop }).querySelector('[data-role="history-refresh"]')).toBeNull()
    const withRefresh = renderHistoryPanel({ items: [], onOpen: noop, onRefresh: noop })
    expect(withRefresh.querySelector('[data-role="history-refresh"]')).not.toBeNull()
  })

  it('底部固定说明"不可接着聊"——这是本版本的真实边界', () => {
    const panel = renderHistoryPanel({ items: [], onOpen: noop })
    expect(panel.textContent).toContain('可查看过去的对话记录')
  })
})

describe('非对话帧降级', () => {
  it('审批请求与结论各一行，都不带按钮', () => {
    const request = renderRecordRow({ kind: 'approval', operation: '转账', amountText: '¥500.00' })
    expect(request.textContent).toContain('请求审批：转账 · ¥500.00')
    expect(request.querySelector('button')).toBeNull()

    const closed = renderRecordRow({ kind: 'approval-closed', label: '已批准' })
    expect(closed.textContent).toContain('审批结论：已批准')
    expect(closed.querySelector('button')).toBeNull()
  })

  it('审批帧缺字段时有兜底文案', () => {
    expect(renderRecordRow({ kind: 'approval' }).textContent).toContain('请求审批：操作')
    expect(renderRecordRow({ kind: 'approval-closed' }).textContent).toContain('审批结论：已处理')
  })

  it('dag 数节点，goal / todo 带关键数', () => {
    expect(renderRecordRow({ kind: 'dag', nodes: [1, 2, 3] }).textContent).toContain('3 个节点')
    expect(renderRecordRow({ kind: 'dag' }).textContent).toContain('0 个节点')
    expect(renderRecordRow({ kind: 'goal', title: '攒首付' }).textContent).toContain('目标：攒首付')
    expect(renderRecordRow({ kind: 'goal' }).textContent).toContain('未命名')
    expect(renderRecordRow({ kind: 'todo', openCount: 2 }).textContent).toContain('2 项未完成')
    expect(renderRecordRow({ kind: 'todo' }).textContent).toContain('0 项未完成')
  })

  it('交接按 active 分文案，超时告警有独立文案', () => {
    expect(renderRecordRow({ kind: 'handoff', active: true }).textContent).toContain('已接入坐席')
    expect(renderRecordRow({ kind: 'handoff', active: false }).textContent).toContain('已交回')
    expect(renderRecordRow({ kind: 'handoff-warn' }).textContent).toContain('接管超时告警')
  })

  it('选择题与风险问卷降级成"不可作答"——不留交互入口', () => {
    for (const kind of ['choice', 'risk-questionnaire']) {
      const row = renderRecordRow({ kind })
      expect(row.textContent).toContain('历史只读，不可作答')
      expect(row.querySelector('button')).toBeNull()
    }
  })

  it('未知帧也有记录行，不抛错（旧数据里有新帧是常态）', () => {
    expect(renderRecordRow({ kind: '来自未来的帧' }).textContent).toContain('来自未来的帧')
  })
})

describe('只读帧流', () => {
  const rendered = (frame) => el('div', { class: 'stub', text: String(frame.kind) })

  it('对话帧交给注入的渲染件，其余走记录行', () => {
    const nodes = renderReadonlyFrames(
      [{ kind: 'message' }, { kind: 'approval', operation: '转账' }, { kind: 'tool' }],
      rendered,
    )
    expect(nodes).toHaveLength(3)
    expect(nodes[0].className).toBe('stub')
    expect(nodes[1].className).toBe('history-record')
    expect(nodes[2].className).toBe('stub')
  })

  it('snapshot 与 delta 被跳过；非对象也被跳过', () => {
    const nodes = renderReadonlyFrames(
      [{ kind: 'snapshot' }, { kind: 'delta' }, null, undefined, 'x', { kind: 'notice' }],
      rendered,
    )
    expect(nodes).toHaveLength(1)
  })

  it('没注入渲染件时所有帧都降级成记录行，不崩', () => {
    const nodes = renderReadonlyFrames([{ kind: 'message' }, { kind: 'tool' }])
    expect(nodes).toHaveLength(2)
    expect(nodes.every((node) => node.className === 'history-record')).toBe(true)
  })

  it('frames 为空或缺省时返回空数组', () => {
    expect(renderReadonlyFrames()).toEqual([])
    expect(renderReadonlyFrames([])).toEqual([])
  })
})

describe('只读视图', () => {
  it('横幅 + 帧流；返回按钮回调到列表', () => {
    const onBack = vi.fn()
    const view = renderReadonlyView({
      title: '转 500 给他',
      frames: [{ kind: 'message' }],
      renderFrame: (frame) => el('div', { class: 'stub', text: frame.kind }),
      onBack,
    })
    expect(view.querySelector('[data-role="history-banner"]').textContent).toContain('只读历史')
    expect(view.querySelectorAll('[data-role="history-feed"] .stub')).toHaveLength(1)
    view.querySelector('[data-role="history-back"]').click()
    expect(onBack).toHaveBeenCalledTimes(1)
  })

  it('标题缺省时用"历史会话"，onBack 缺省时不崩', () => {
    const view = renderReadonlyView({})
    expect(view.textContent).toContain('只读历史：历史会话')
    view.querySelector('[data-role="history-back"]').click()
  })
})
