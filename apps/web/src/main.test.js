/**
 * 应用装配用例（T-WEB-008 独立运行）。
 *
 * "独立运行"的验收口径：没有桌面壳、没有真实网络，只要换掉 `api` 与 `transport`，
 * 五个视图（对话 / 工具卡 / 审批 / DAG / 审计）全部能挂起来。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

import { mountApp } from './main.js'

/** 假接口：记录调用，按需返回。 */
function fakeApi(overrides = {}) {
  const calls = []
  const ok = { ok: true, status: 200, data: { sessionId: 's-test' } }
  return {
    calls,
    session: async () => ok,
    health: async () => ok,
    turn: async (text) => {
      calls.push(['turn', text])
      return { ok: true, status: 202, data: { ok: true } }
    },
    interrupt: async (reason) => {
      calls.push(['interrupt', reason])
      return { ok: true, status: 200 }
    },
    decide: async (ticketId, decision, reason) => {
      calls.push(['decide', ticketId, decision, reason])
      return { ok: true, status: 200 }
    },
    verify: async (ticketId) => {
      calls.push(['verify', ticketId])
      return { ok: true, status: 200 }
    },
    ...overrides,
  }
}

/** 假传输：把 `onFrame` 抓出来，测试自己推帧。 */
function fakeTransport() {
  let handlers = null
  const transport = (options) => {
    handlers = options
    return { close: () => undefined }
  }
  transport.push = (frame) => handlers?.onFrame(frame)
  transport.fault = (fault) => handlers?.onFault(fault)
  transport.status = (status) => handlers?.onStatus(status)
  return transport
}

/** 起一个应用。 */
function mount(api = fakeApi()) {
  const root = document.createElement('div')
  document.body.append(root)
  const transport = fakeTransport()
  const app = mountApp({ root, api, transport })
  return { root, api, transport, app }
}

/** 完整快照（四视图各来一条）。 */
function snapshot() {
  return {
    kind: 'snapshot',
    sessionId: 's-test',
    maxSeq: 8,
    frames: [
      { kind: 'turn', seq: 1, at: 1, turn: 1, phase: 'start' },
      { kind: 'message', seq: 2, at: 2, role: 'user', blocks: [{ type: 'text', text: '给王建国转 800 元' }] },
      {
        kind: 'tool',
        seq: 3,
        at: 3,
        callId: 'call-1',
        name: 'transfer_create',
        title: '转账',
        state: 'done',
        tier: 'yellow',
        amountConfirmed: true,
        card: {
          kind: 'tool.transfer_create',
          template: 'transfer',
          title: '转账',
          fields: [{ label: '金额', value: '¥800.00', amount: true, mono: true }],
          tags: [],
        },
      },
      {
        kind: 'dag',
        seq: 4,
        at: 4,
        turn: 1,
        nodes: [{ id: 'call:call-1', label: 'transfer_create', kind: 'call', step: 1, tier: 'yellow', state: 'ok' }],
        edges: [],
        summary: '第 1 轮 · 1 个调用',
      },
      {
        kind: 'audit',
        seq: 5,
        at: 5,
        timeText: '01:02:03',
        category: 'approval',
        label: '审批请求',
        summary: '请求执行 transfer_create · ¥800.00',
      },
      { kind: 'message', seq: 8, at: 8, role: 'assistant', blocks: [{ type: 'text', text: '已完成' }] },
    ],
  }
}

beforeEach(() => {
  document.body.innerHTML = ''
})

describe('mountApp · 独立运行（T-WEB-008）', () => {
  it('没有桌面壳也能挂出骨架：对话 / 面板 / 输入区 / 遮罩根', () => {
    const { root } = mount()
    expect(root.querySelector('#conversation')).not.toBeNull()
    expect(root.querySelector('#panel-dag')).not.toBeNull()
    expect(root.querySelector('#panel-audit')).not.toBeNull()
    expect(root.querySelector('#composer')).not.toBeNull()
    expect(root.querySelector('#overlay-root')).not.toBeNull()
    expect(root.querySelector('.conversation__empty')).not.toBeNull()
  })

  it('快照到达后四视图同时有内容', () => {
    const { root, transport } = mount()
    transport.push(snapshot())

    expect(root.querySelectorAll('.message').length).toBe(2)
    expect(root.querySelector('.tool-card').dataset.state).toBe('done')
    expect(root.querySelector('#panel-dag svg.dag')).not.toBeNull()
    expect(root.querySelector('.audit__item')).not.toBeNull()
    expect(root.querySelector('.conversation__empty')).toBeNull()
  })

  it('审批帧弹出六要素；结论帧收尾为"未执行"', () => {
    const { root, transport } = mount()
    transport.push(snapshot())
    transport.push({
      kind: 'approval',
      seq: 9,
      at: 9,
      ticketId: 'ticket:call-2',
      callId: 'call-2',
      name: 'transfer_create',
      operation: '转账',
      amountText: '¥800.00',
      amountConfirmed: false,
      payeeName: '王建国',
      tier: 'yellow',
      rejectReasonRequired: true,
    })

    const dialog = root.querySelector('[role="dialog"]')
    expect(dialog).not.toBeNull()
    expect(dialog.textContent).toContain('王建国')

    transport.push({
      kind: 'approval-closed',
      seq: 10,
      at: 10,
      ticketId: 'ticket:call-2',
      decision: 'unavailable',
      label: '无人应答（视为拒绝）',
    })
    expect(root.querySelector('[role="dialog"]').textContent).toContain('未执行')
  })

  it('提交调接口；失败不出气泡（状态只来自帧）', async () => {
    const api = fakeApi()
    const { root } = mount(api)
    const input = root.querySelector('.composer__input')
    input.value = '查余额'
    root.querySelector('#composer').dispatchEvent(new Event('submit', { cancelable: true }))
    await Promise.resolve()
    await Promise.resolve()

    expect(api.calls).toEqual([['turn', '查余额']])
    expect(root.querySelectorAll('.message').length).toBe(0)
  })

  it('中断按钮把理由发给后端', async () => {
    const api = fakeApi()
    const { root } = mount(api)
    const stop = [...root.querySelectorAll('.composer button')].find((button) =>
      button.textContent.includes('算了'),
    )
    stop.click()
    await Promise.resolve()
    expect(api.calls[0][0]).toBe('interrupt')
  })

  it('渠道故障显示横幅，恢复后消失', () => {
    const { root, transport } = mount()
    transport.fault({ code: 'agent-driver-failed', reason: '主循环异常' })
    expect(root.querySelector('.app-banner').hidden).toBe(false)

    transport.status('online')
    expect(root.querySelector('.app-banner').hidden).toBe(true)
  })

  it('连接状态可见（连接中 → 已连接 → 已断开）', () => {
    const { root, transport } = mount()
    const text = () => root.querySelector('.app-header__status-text').textContent
    expect(text()).toBe('连接中')
    transport.status('online')
    expect(text()).toBe('已连接')
    transport.status('offline')
    expect(text()).toBe('已断开（自动重连）')
  })

  it('流式草稿随 delta 增长，权威消息到达后消失', () => {
    const { root, transport } = mount()
    transport.push({ kind: 'delta', at: 1, text: '已为' })
    transport.push({ kind: 'delta', at: 2, text: '你完成' })
    expect(root.querySelector('[data-draft="true"]').textContent).toContain('已为你完成')

    transport.push({
      kind: 'message',
      seq: 1,
      at: 3,
      role: 'assistant',
      blocks: [{ type: 'text', text: '已为你完成转账' }],
    })
    expect(root.querySelector('[data-draft="true"]')).toBeNull()
  })
})

describe('mountApp · 交互细节', () => {
  it('"回到上一步"显式禁用（施工单 14 未落地，不假装可用）', () => {
    const { root } = mount()
    const back = [...root.querySelectorAll('.composer button')].find((button) =>
      button.textContent.includes('回到上一步'),
    )
    expect(back.disabled).toBe(true)
    expect(back.title).toContain('施工单 14')
  })

  it('审计标签页可切换（默认调用图）', () => {
    const { root } = mount()
    const [dagTab, auditTab] = root.querySelectorAll('.panel__tabs .ds-tab')
    auditTab.click()
    expect(dagTab.getAttribute('aria-selected')).toBe('false')
    expect(root.querySelector('#panel-audit-box').hidden).toBe(false)
    expect(root.querySelector('#panel-dag').hidden).toBe(true)
  })

  it('空输入不发请求', async () => {
    const api = fakeApi()
    const { root } = mount(api)
    root.querySelector('.composer__input').value = '   '
    root.querySelector('#composer').dispatchEvent(new Event('submit', { cancelable: true }))
    await Promise.resolve()
    expect(api.calls).toEqual([])
  })

  it('会话 ID 从 /api/session 读到后显示在顶栏', async () => {
    const { root } = mount()
    await vi.waitFor(() => {
      expect(root.querySelector('.app-header__session').textContent).toContain('s-test')
    })
  })
})
