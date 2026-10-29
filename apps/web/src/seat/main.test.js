/**
 * 坐席台主流程（B5）：无凭证 / idle / serving → 发言 → 交回。
 *
 * 只用假 `api` 与假 `transport`；不碰真实网络与 sessionStorage。
 */

import { describe, expect, it } from 'vitest'

import { mountSeat } from './main.js'
import { HANDOVER_TEMPLATE } from './views/composer.js'

function fakeGate(token = '') {
  let value = token
  return {
    readToken: () => value,
    saveToken: (next) => {
      value = next
      return true
    },
    clearToken: () => {
      value = ''
    },
    storageBroken: () => false,
    value: () => value,
  }
}

function baseSummary(overrides = {}) {
  return {
    active: false,
    sessionId: 's-demo',
    lastSeq: 0,
    turns: 0,
    pendingTickets: 0,
    messages: [],
    waitedMs: 0,
    overdue: false,
    claimed: false,
    turnsSinceHandoff: 0,
    operatorMessages: 0,
    ...overrides,
  }
}

function fakeFactory(summary) {
  const calls = []
  const current = { ...summary }
  const api = {
    handoff: async () => ({ ok: true, status: 200, data: { ...current } }),
    queue: async () => ({
      ok: true,
      status: 200,
      data: {
        depth: current.active ? 1 : 0,
        items: current.active ? [{ sessionId: current.sessionId, claimed: current.claimed }] : [],
        note: 'single-session deployment: depth ∈ {0,1}',
      },
    }),
    heartbeat: async () => ({
      ok: true,
      status: 200,
      data: { ok: true, waitedMs: current.waitedMs, overdue: current.overdue },
    }),
    claim: async () => {
      calls.push(['claim'])
      return { ok: true, status: 200, data: { ...current, claimed: true, operator: '坐席小周' } }
    },
    say: async (text) => {
      calls.push(['say', text])
      return { ok: true, status: 200, data: { ok: true, seq: 1 } }
    },
    resume: async (handover) => {
      calls.push(['resume', handover])
      return { ok: true, status: 200, data: { ...current, active: false } }
    },
  }
  return {
    calls,
    create: (config) => {
      calls.push(['create', config.token])
      return api
    },
  }
}

function fakeTransport() {
  let handlers = null
  const connect = (options) => {
    handlers = options
    return { close: () => undefined }
  }
  connect.push = (frame) => handlers?.onFrame(frame)
  connect.status = (status) => handlers?.onStatus(status)
  return connect
}

async function flush(times = 8) {
  for (let index = 0; index < times; index += 1) await Promise.resolve()
  await new Promise((resolve) => setTimeout(resolve, 0))
}

function mount({ token, summary }) {
  const root = document.createElement('div')
  document.body.append(root)
  const factory = fakeFactory(summary)
  const transport = fakeTransport()
  const app = mountSeat({
    root,
    gate: fakeGate(token),
    createApi: factory.create,
    connect: transport,
    confirmResume: () => true,
  })
  return { root, factory, transport, app }
}

describe('seat main', () => {
  it('无凭证 → 显示输入闸，工作台隐藏，且不发任何请求', async () => {
    const { root, factory, app } = mount({ token: '', summary: baseSummary() })
    await flush()
    expect(root.querySelector('.seat-shell').hidden).toBe(true)
    expect(root.querySelector('#seat-gate').hidden).toBe(false)
    expect(root.querySelector('.seat-gate__input')).not.toBeNull()
    expect(factory.calls).toEqual([])
    app.destroy()
  })

  it('有凭证 + idle → 工作台可见，左栏显示"暂无待接管"，输入框禁用', async () => {
    const { root, app } = mount({ token: 'op-1', summary: baseSummary() })
    await flush()
    expect(root.querySelector('.seat-shell').hidden).toBe(false)
    expect(root.textContent).toContain('暂无待接管会话')
    expect(root.querySelector('.seat-composer__input').disabled).toBe(true)
    app.destroy()
  })

  it('serving → 认领 / 发言 / 交回：调用正确、SSE 帧驱动界面', async () => {
    const { root, factory, transport, app } = mount({
      token: 'op-1',
      summary: baseSummary({ active: true, reason: '客户要求人工', waitedMs: 5_000 }),
    })
    await flush()

    expect(root.textContent).toContain('s-demo')
    expect(root.textContent).toContain('未认领')
    expect(root.querySelector('.seat-composer__input').disabled).toBe(false)

    // 认领
    const claim = [...root.querySelectorAll('button')].find((button) => button.textContent.includes('认领'))
    claim.click()
    await flush()
    expect(factory.calls.some((call) => call[0] === 'claim')).toBe(true)

    // 发言
    const input = root.querySelector('.seat-composer__input')
    input.value = '您好，我是人工坐席'
    root.querySelector('.seat-composer__send-form').dispatchEvent(new Event('submit', { cancelable: true }))
    await flush()
    expect(factory.calls.some((call) => call[0] === 'say' && call[1] === '您好，我是人工坐席')).toBe(true)
    expect(input.value).toBe('')

    // SSE 推回人工消息 → 出现 operator 气泡（不乐观渲染）
    transport.push({
      kind: 'message',
      seq: 9,
      at: 1,
      role: 'operator',
      operator: '坐席小周',
      blocks: [{ type: 'text', text: '您好，我是人工坐席' }],
    })
    await flush()
    expect(root.querySelector('.message--operator')).not.toBeNull()

    // 交回（模板预填）
    const resumeButton = [...root.querySelectorAll('button')].find((button) => button.textContent.includes('交回智能助手'))
    resumeButton.click()
    await flush()
    const resumeCall = factory.calls.find((call) => call[0] === 'resume')
    expect(resumeCall?.[1]).toBe(HANDOVER_TEMPLATE)

    // SSE 推回交回帧 → 分隔线与"已交回"提示
    transport.push({ kind: 'handoff', seq: 10, at: 1, active: false, operator: '坐席小周' })
    await flush()
    expect(root.textContent).toContain('已交回智能助手')
    app.destroy()
  })
})
