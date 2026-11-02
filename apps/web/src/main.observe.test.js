/**
 * 观测 tab 的接线（03 §4.5）：入口只加节点与第三分支，既有两 tab 语义不变。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { mountApp } from './main.js'

/** 假接口：6 个既有方法 + 观测两个。 */
function fakeApi(overrides = {}) {
  const calls = []
  return {
    calls,
    session: async () => ({ ok: true, status: 200, data: { sessionId: 's-test' } }),
    health: async () => ({ ok: true, status: 200, data: {} }),
    turn: async (text) => {
      calls.push(['turn', text])
      return { ok: true, status: 202, data: { ok: true } }
    },
    interrupt: async () => ({ ok: true, status: 200 }),
    decide: async () => ({ ok: true, status: 200 }),
    verify: async () => ({ ok: true, status: 200 }),
    metrics: async () => {
      calls.push(['metrics'])
      return {
        ok: true,
        status: 200,
        data: {
          turns: 2,
          tools: { calls: 3, errors: 0, durationMs: { p50: 5, p95: 9 } },
          cost: { configured: false, total: 0 },
          slo: null,
        },
      }
    },
    trace: async () => {
      calls.push(['trace'])
      return { ok: true, status: 200, data: { clock: 'trusted', roots: [] } }
    },
    ...overrides,
  }
}

/** 假传输：不连 SSE。 */
function fakeTransport() {
  const transport = () => ({ close: () => undefined })
  transport.push = () => undefined
  return transport
}

function mount(api = fakeApi()) {
  const root = document.createElement('div')
  document.body.append(root)
  const app = mountApp({ root, api, transport: fakeTransport() })
  return { root, api, app }
}

beforeEach(() => {
  document.body.innerHTML = ''
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('观测 tab · 结构', () => {
  it('第三个 tab 追加在末尾，容器存在且默认隐藏', () => {
    const { root } = mount()
    const tabs = root.querySelectorAll('.panel__tabs .ds-tab')
    expect(tabs).toHaveLength(3)
    expect(tabs[2].id).toBe('tab-observe')
    expect(root.querySelector('#panel-observe').hidden).toBe(true)
    expect(root.querySelector('#panel-observe').getAttribute('role')).toBe('tabpanel')
  })

  it('点击观测：三 tab 的 aria-selected 同步，其他面板隐藏', () => {
    const { root } = mount()
    const [dagTab, auditTab, observeTab] = root.querySelectorAll('.panel__tabs .ds-tab')
    observeTab.click()

    expect(observeTab.getAttribute('aria-selected')).toBe('true')
    expect(dagTab.getAttribute('aria-selected')).toBe('false')
    expect(auditTab.getAttribute('aria-selected')).toBe('false')
    expect(root.querySelector('#panel-observe').hidden).toBe(false)
    expect(root.querySelector('#panel-dag').hidden).toBe(true)
    expect(root.querySelector('#panel-audit-box').hidden).toBe(true)
  })

  it('方向键三 tab 环绕（dag ← observe）', () => {
    const { root } = mount()
    const [dagTab, , observeTab] = root.querySelectorAll('.panel__tabs .ds-tab')
    dagTab.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }))
    expect(observeTab.getAttribute('aria-selected')).toBe('true')
  })
})

describe('观测 tab · 轮询启停', () => {
  it('打开观测才发请求，切走立即停表', async () => {
    const { root, api } = mount()
    const [, auditTab, observeTab] = root.querySelectorAll('.panel__tabs .ds-tab')

    expect(api.calls.filter((call) => call[0] === 'metrics')).toHaveLength(0)

    observeTab.click()
    await vi.advanceTimersByTimeAsync(0)
    expect(api.calls.filter((call) => call[0] === 'metrics')).toHaveLength(1)

    auditTab.click()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(api.calls.filter((call) => call[0] === 'metrics')).toHaveLength(1)
  })

  it('观测面板渲染四张卡（数据到达后）', async () => {
    const { root } = mount()
    const [, , observeTab] = root.querySelectorAll('.panel__tabs .ds-tab')
    observeTab.click()
    await vi.advanceTimersByTimeAsync(0)
    expect(root.querySelectorAll('#panel-observe .obs__kpi')).toHaveLength(4)
  })

  it('mountApp 暴露 observe 控制器，close() 可停表', () => {
    const { app } = mount()
    expect(typeof app.observe.start).toBe('function')
    expect(typeof app.observe.state).toBe('function')
    app.close()
  })
})
