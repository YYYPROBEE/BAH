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
function mount(api = fakeApi(), extra = {}) {
  const root = document.createElement('div')
  document.body.append(root)
  const transport = fakeTransport()
  const app = mountApp({ root, api, transport, ...extra })
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
  delete globalThis.bahDesktop
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

  it('choice 帧渲染成可点的选择题卡；点选发的是选项 label，不本地造气泡', async () => {
    const api = fakeApi()
    const { root, transport } = mount(api)
    transport.push({
      kind: 'choice',
      seq: 1,
      at: 1,
      callId: 'call-ask',
      prompt: '要转给谁？请给出收款人姓名。',
      options: [
        { id: '王建国', label: '王建国' },
        { id: '张伟', label: '张伟' },
      ],
      allowFreeText: true,
    })

    const card = root.querySelector('[data-role="choice"]')
    expect(card).not.toBeNull()
    expect(card.textContent).toContain('要转给谁')

    card.querySelector('[data-option-id="张伟"]').click()
    await Promise.resolve()
    await Promise.resolve()

    expect(api.calls).toEqual([['turn', '张伟']])
    expect(card.dataset.state).toBe('picked')
    // 桌面纪律：用户消息等 user/message 帧，不在本地插气泡
    expect(root.querySelectorAll('.message').length).toBe(0)
  })

  it('同一 callId 的第二次追问替换旧卡，新卡追加在已有节点之后（离线 router 硬编码 callId 的护栏）', () => {
    const { root, transport } = mount()
    transport.push({
      kind: 'choice',
      seq: 1,
      at: 1,
      callId: 'call-ask',
      prompt: '第一次追问',
      options: [{ id: 'a', label: '王建国' }],
      allowFreeText: true,
    })
    transport.push({ kind: 'message', seq: 2, at: 2, role: 'user', blocks: [{ type: 'text', text: '张伟' }] })
    transport.push({
      kind: 'choice',
      seq: 3,
      at: 3,
      callId: 'call-ask',
      prompt: '第二次追问',
      options: [{ id: 'b', label: '张伟' }],
      allowFreeText: true,
    })

    const cards = root.querySelectorAll('[data-role="choice"]')
    expect(cards).toHaveLength(1)
    expect(cards[0].textContent).toContain('第二次追问')
    // 新卡必须出现在流末尾，而不是留在旧卡的历史位置
    expect(root.querySelector('#conversation').lastElementChild).toBe(cards[0])
  })

  it('effects 帧渲染为只读清单（零按钮零链接）', () => {
    const { root, transport } = mount()
    transport.push({
      kind: 'effects',
      seq: 1,
      at: 1,
      turn: 1,
      items: [
        { callId: 'call-create', name: 'transfer_create', title: '转账', amountText: '¥30.00', durationMs: 4049, tone: 'success' },
      ],
    })
    const effects = root.querySelector('[data-role="effects"]')
    expect(effects).not.toBeNull()
    expect(effects.textContent).toContain('已发生的操作')
    expect(effects.textContent).toContain('¥30.00')
    expect(effects.querySelectorAll('button, a')).toHaveLength(0)
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

  it('连接状态可见（连接中 → 已连接 → 已断开），断线同时升起横幅', () => {
    const { root, transport } = mount()
    const text = () => root.querySelector('.app-header__status-text').textContent
    expect(text()).toBe('连接中')
    transport.status('online')
    expect(text()).toBe('已连接')
    transport.status('offline')
    expect(text()).toBe('已断开（自动重连）')
    // P2-2：断线不能只有顶栏 11px 文案；横幅不承诺"正在重连"（重试 10 次后已停）
    const banner = root.querySelector('.app-banner')
    expect(banner.hidden).toBe(false)
    expect(banner.textContent).toContain('连接已断开')
    expect(banner.textContent).toContain('可能不是最新')
  })

  it('服务重启换会话号 → 顶栏跟着换，并提示"会话已重置"', () => {
    const { root, transport } = mount()
    transport.push(snapshot())
    expect(root.querySelector('.app-header__session').textContent).toContain('s-test')

    transport.push({ kind: 'snapshot', sessionId: 's-new', maxSeq: 0, frames: [] })
    expect(root.querySelector('.app-header__session').textContent).toContain('s-new')
    expect(root.textContent).toContain('会话已重置')
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
  it('「转人工」走 POST /api/handoff；接管帧到达后入口禁用', async () => {
    const calls = []
    const control = {
      handoff: async (reason) => {
        calls.push(reason)
        return { ok: true, status: 200, data: { active: true } }
      },
      handoffStatus: async () => ({ ok: true, status: 200, data: { active: false } }),
      resume: async () => ({ ok: true, status: 200, data: {} }),
      fork: async () => ({ ok: true, status: 200, data: {} }),
    }
    const { root, transport } = mount(fakeApi(), { control })
    const button = [...root.querySelectorAll('.composer button')].find((item) =>
      item.textContent.includes('转人工'),
    )
    expect(button).not.toBeUndefined()
    expect(button.disabled).toBe(false)

    button.click()
    await Promise.resolve()
    await Promise.resolve()
    expect(calls).toEqual(['客户请求人工'])
    expect(root.textContent).toContain('已提交转人工请求')
    // 成功即保持禁用：帧还没到时重新点亮，等于允许再点一次去撞 409
    expect(button.disabled).toBe(true)
    // 无关帧触发的 sync 也不能把它重新点亮
    transport.push({ kind: 'message', seq: 2, at: 2, role: 'assistant', blocks: [{ type: 'text', text: '好' }] })
    expect(button.disabled).toBe(true)

    transport.push({ kind: 'handoff', seq: 1, at: 1, active: true, operator: '坐席小周' })
    expect(button.disabled).toBe(true)
    expect(root.querySelector('#handoff-banner').hidden).toBe(false)

    // 交回帧到达后入口恢复可用
    transport.push({ kind: 'handoff', seq: 3, at: 3, active: false })
    expect(button.disabled).toBe(false)
  })

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

  it('标签页补齐 ARIA 关系，方向键可切换', () => {
    const { root } = mount()
    const [dagTab, auditTab] = root.querySelectorAll('.panel__tabs .ds-tab')
    expect(dagTab.getAttribute('aria-controls')).toBe('panel-dag')
    expect(auditTab.getAttribute('aria-controls')).toBe('panel-audit-box')
    expect(root.querySelector('#panel-dag').getAttribute('role')).toBe('tabpanel')
    expect(root.querySelector('#panel-audit-box').getAttribute('role')).toBe('tabpanel')

    dagTab.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
    expect(auditTab.getAttribute('aria-selected')).toBe('true')
    expect(auditTab.tabIndex).toBe(0)
    expect(root.querySelector('#panel-audit-box').hidden).toBe(false)
  })

  it('计数条只出现在审计页，切到调用图时一并隐藏', () => {
    const { root, transport } = mount()
    transport.push(snapshot())
    const summary = root.querySelector('.panel__summary')
    expect(summary.closest('#panel-audit-box')).not.toBeNull()
    expect(root.querySelector('#panel-audit-box').hidden).toBe(true)
  })

  it('DAG 帧没有节点时走空态，不留空白 SVG', () => {
    const { root, transport } = mount()
    transport.push({ kind: 'dag', seq: 1, at: 1, turn: 1, nodes: [], edges: [], summary: '第 1 轮 · 0 个调用' })
    expect(root.querySelector('#panel-dag svg.dag')).toBeNull()
    expect(root.querySelector('#panel-dag .ds-empty')).not.toBeNull()
  })

  it('/api/session 返回非 JSON 时顶栏不显示 undefined', async () => {
    const api = fakeApi({ session: async () => ({ ok: true, status: 200, data: null }) })
    const { root } = mount(api)
    await Promise.resolve()
    await Promise.resolve()
    expect(root.querySelector('.app-header__session').textContent).toBe('会话 —')
  })

  it('空输入不发请求', async () => {
    const api = fakeApi()
    const { root } = mount(api)
    root.querySelector('.composer__input').value = '   '
    root.querySelector('#composer').dispatchEvent(new Event('submit', { cancelable: true }))
    await Promise.resolve()
    expect(api.calls).toEqual([])
  })

  it('在飞时再次提交不重复发请求（连按 Enter / 双击）', async () => {
    const calls = []
    let release = () => undefined
    const api = {
      ...fakeApi(),
      turn: (text) => {
        calls.push(text)
        return new Promise((resolve) => {
          release = () => resolve({ ok: true, status: 202, data: { ok: true } })
        })
      },
    }
    const { root } = mount(api)
    const form = root.querySelector('#composer')
    root.querySelector('.composer__input').value = '查余额'

    form.dispatchEvent(new Event('submit', { cancelable: true }))
    form.dispatchEvent(new Event('submit', { cancelable: true }))
    await Promise.resolve()

    expect(calls).toEqual(['查余额'])
    release()
  })

  it('输入法组合中的 Enter 不发送（中文选词不误提交）', () => {
    const api = fakeApi()
    const { root } = mount(api)
    const input = root.querySelector('.composer__input')
    input.value = '转账'
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true }))
    expect(api.calls).toEqual([])
  })

  it('会话 ID 从 /api/session 读到后显示在顶栏', async () => {
    const { root } = mount()
    await vi.waitFor(() => {
      expect(root.querySelector('.app-header__session').textContent).toContain('s-test')
    })
  })
})

describe('mountApp · 对话收口与定位', () => {
  it('安全提醒在顶栏（不占会话行、不与右侧审计面板并排），输入框提示统一', () => {
    const { root } = mount()
    const safety = root.querySelector('[data-role="safety"]')
    expect(safety).not.toBeNull()
    expect(safety.closest('.app-header')).not.toBeNull()
    expect(safety.closest('.app-left')).toBeNull()
    expect(safety.closest('.panel')).toBeNull()
    expect(root.querySelector('.composer__input').placeholder).toBe('在这里输入消息')
  })

  it('对话完成后只在末尾出现一次反馈行 + 两条追问；新一轮开始即收起', async () => {
    const api = fakeApi()
    const { root, transport } = mount(api)
    transport.push({
      kind: 'snapshot',
      sessionId: 's-test',
      maxSeq: 5,
      frames: [
        { kind: 'turn', seq: 1, at: 1, turn: 1, phase: 'start' },
        { kind: 'message', seq: 2, at: 2, role: 'user', blocks: [{ type: 'text', text: '看看理财产品' }] },
        { kind: 'message', seq: 3, at: 3, role: 'assistant', blocks: [{ type: 'text', text: '我先查一下。' }] },
        {
          kind: 'message',
          seq: 4,
          at: 4,
          role: 'assistant',
          blocks: [{ type: 'text', text: '在售理财产品有稳盈90天等。' }],
        },
        { kind: 'turn', seq: 5, at: 5, turn: 1, phase: 'end', endKind: 'completed' },
      ],
    })

    const conversation = root.querySelector('#conversation')
    const footers = root.querySelectorAll('[data-role="answer-footer"]')
    expect(footers).toHaveLength(1)
    expect(conversation.lastElementChild).toBe(footers[0])
    // 反馈不再挂在每一条助手消息里
    expect(root.querySelectorAll('.message [data-role="feedback"]')).toHaveLength(0)
    expect(root.querySelectorAll('[data-role="feedback"]')).toHaveLength(1)
    const followUps = [...root.querySelectorAll('[data-role="follow-up"]')]
    expect(followUps).toHaveLength(2)
    expect(followUps.map((button) => button.textContent)).toEqual(['看看我的理财持仓', '看看在售的理财产品'])

    followUps[0].click()
    await Promise.resolve()
    await Promise.resolve()
    expect(api.calls).toEqual([['turn', '看看我的理财持仓']])

    transport.push({ kind: 'turn', seq: 6, at: 6, turn: 2, phase: 'start' })
    expect(root.querySelector('[data-role="answer-footer"]')).toBeNull()
  })

  it('运行中的一轮不提前出反馈；用户刚追问、助手未答时也不出', () => {
    const { root, transport } = mount()
    transport.push({ kind: 'turn', seq: 1, at: 1, turn: 1, phase: 'start' })
    transport.push({
      kind: 'message',
      seq: 2,
      at: 2,
      role: 'assistant',
      blocks: [{ type: 'text', text: '正在为您查询。' }],
    })
    expect(root.querySelector('[data-role="answer-footer"]')).toBeNull()

    transport.push({ kind: 'turn', seq: 3, at: 3, turn: 1, phase: 'end', endKind: 'completed' })
    expect(root.querySelector('[data-role="answer-footer"]')).not.toBeNull()

    transport.push({ kind: 'message', seq: 4, at: 4, role: 'user', blocks: [{ type: 'text', text: '那理财呢' }] })
    expect(root.querySelector('[data-role="answer-footer"]')).toBeNull()
  })

  it('新消息贴底；用户上翻后不抢滚动；发送动作强制回到底部', async () => {
    const api = fakeApi()
    const { root, transport } = mount(api)
    const conversation = root.querySelector('#conversation')
    Object.defineProperty(conversation, 'scrollHeight', { configurable: true, get: () => 1200 })
    Object.defineProperty(conversation, 'clientHeight', { configurable: true, get: () => 400 })

    transport.push({ kind: 'message', seq: 1, at: 1, role: 'user', blocks: [{ type: 'text', text: '你好' }] })
    expect(conversation.scrollTop).toBe(1200)

    conversation.scrollTop = 100
    conversation.dispatchEvent(new Event('scroll'))
    transport.push({ kind: 'message', seq: 2, at: 2, role: 'assistant', blocks: [{ type: 'text', text: '您好' }] })
    expect(conversation.scrollTop).toBe(100)

    const input = root.querySelector('.composer__input')
    input.value = '查余额'
    root.querySelector('#composer').dispatchEvent(new Event('submit', { cancelable: true }))
    expect(conversation.scrollTop).toBe(1200)
    await Promise.resolve()
    await Promise.resolve()
    expect(api.calls).toEqual([['turn', '查余额']])
  })
})

describe('mountApp · 桌面壳新对话', () => {
  it('普通 Web 不显示新对话按钮（没有真实新会话能力）', () => {
    const { root } = mount()
    expect(root.querySelector('[data-role="new-conversation"]')).toBeNull()
  })

  it('桌面桥存在时显示按钮；确认后只调用零载荷桥接', () => {
    const newConversation = vi.fn()
    globalThis.bahDesktop = { newConversation }
    const originalWindowConfirm = window.confirm
    const originalGlobalConfirm = globalThis.confirm
    const confirm = vi.fn(() => true)
    window.confirm = confirm
    globalThis.confirm = confirm

    try {
      const { root } = mount()
      const button = root.querySelector('[data-role="new-conversation"]')
      expect(button).not.toBeNull()
      expect(button.textContent).toContain('新对话')
      button.click()
      expect(confirm).toHaveBeenCalledTimes(1)
      expect(newConversation).toHaveBeenCalledTimes(1)
    } finally {
      window.confirm = originalWindowConfirm
      globalThis.confirm = originalGlobalConfirm
      delete globalThis.bahDesktop
    }
  })

  it('取消确认时不调用桥接', () => {
    const newConversation = vi.fn()
    globalThis.bahDesktop = { newConversation }
    const originalWindowConfirm = window.confirm
    const originalGlobalConfirm = globalThis.confirm
    const decline = () => false
    window.confirm = decline
    globalThis.confirm = decline

    try {
      const { root } = mount()
      root.querySelector('[data-role="new-conversation"]').click()
      expect(newConversation).not.toHaveBeenCalled()
    } finally {
      window.confirm = originalWindowConfirm
      globalThis.confirm = originalGlobalConfirm
      delete globalThis.bahDesktop
    }
  })
})
