/**
 * 观测面板渲染（03 §S3.1 的 12 条 + 成本换算 / 截断 / 陈旧提示）。
 *
 * 视图层是纯函数：用例只塞 state、读 DOM，不碰网络与时钟。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

import { renderObserve } from './observe.js'

/** 完整 SLO 八项（顺序与 `SLO_METRICS` 一致）。 */
const SLO_NAMES = [
  'compFailureRate',
  'danglingP95',
  'posNegMismatchRate',
  'dlqDepth',
  'chainBreak',
  'rto',
  'reconHeartbeat',
  'residualDiffRate',
]

function slo(overrides = {}) {
  const out = {}
  for (const name of SLO_NAMES) {
    out[name] = { value: 0, verdict: 'ok', unit: 'count', soft: 1, hard: 2 }
  }
  return { ...out, ...overrides }
}

function metrics(overrides = {}) {
  return {
    turns: 3,
    tools: { calls: 10, errors: 1, durationMs: { p50: 40, p95: 120 } },
    cost: { configured: false, currency: 'micro_yuan', total: 0, byTurn: [], budget: { turn: null, session: null } },
    slo: slo(),
    ...overrides,
  }
}

function span(overrides = {}) {
  return {
    spanId: 's1',
    parentSpanId: null,
    name: 'turn',
    startMs: 0,
    endMs: 100,
    status: 'ok',
    attributes: { turn: 1 },
    ...overrides,
  }
}

function trace(overrides = {}) {
  return {
    clock: 'trusted',
    roots: [
      {
        span: span(),
        depth: 0,
        children: [{ span: span({ spanId: 's2', parentSpanId: 's1', name: 'tool.execute', startMs: 10, endMs: 60 }), depth: 1, children: [] }],
      },
    ],
    ...overrides,
  }
}

function state(overrides = {}) {
  return {
    metrics: metrics(),
    trace: trace(),
    status: 'online',
    staleSec: null,
    error: null,
    ...overrides,
  }
}

/** 挂一个容器并渲染。 */
function render(next = state()) {
  const box = document.createElement('div')
  document.body.append(box)
  const handle = renderObserve(box, next)
  return { box, handle }
}

beforeEach(() => {
  document.body.innerHTML = ''
})

describe('观测面板 · 空态与错误态', () => {
  it('metrics=null 且未连接：显示连接空态，不抛', () => {
    const { box } = render(state({ metrics: null, trace: null, status: 'connecting' }))
    expect(box.textContent).toContain('观测面板需要连接后可读')
    expect(box.querySelector('.obs__kpi')).toBeNull()
  })

  it('turns=0 且没有 span：显示无数据空态，不渲染一排 0', () => {
    const { box } = render(state({ metrics: metrics({ turns: 0 }), trace: { clock: 'trusted', roots: [] } }))
    expect(box.textContent).toContain('本会话还没有结束的轮次')
    expect(box.querySelector('.obs__kpi')).toBeNull()
  })

  it('端点失败：显示 code + 重试，并保留上一次的数字', () => {
    const onRefresh = vi.fn()
    const { box } = render(state({ error: { code: 'network-error', reason: '断网' }, onRefresh }))
    expect(box.textContent).toContain('指标读取失败（network-error）')
    expect(box.querySelectorAll('.obs__kpi')).toHaveLength(4)
    expect(box.querySelector('.obs__kpi .obs__kpi-value').textContent).toBe('3')
    box.querySelector('.obs__error button').click()
    expect(onRefresh).toHaveBeenCalledTimes(1)
  })
})

describe('观测面板 · 四张 KPI', () => {
  it('工具错误率：calls=0 显示「—」而不是 0%', () => {
    const { box } = render(state({ metrics: metrics({ tools: { calls: 0, errors: 0, durationMs: { p50: null, p95: null } } }) }))
    const value = box.querySelector('.obs__kpi:nth-child(2) .obs__kpi-value')
    expect(value.textContent).toBe('—')
  })

  it('工具错误率：>0.3 用危险色', () => {
    const { box } = render(state({ metrics: metrics({ tools: { calls: 10, errors: 4, durationMs: { p50: 1, p95: 2 } } }) }))
    const value = box.querySelector('.obs__kpi:nth-child(2) .obs__kpi-value')
    expect(value.textContent).toBe('40.0%')
    expect(value.classList.contains('is-danger')).toBe(true)
  })

  it('工具 p95：null 显示「无样本」，不显示 0ms', () => {
    const { box } = render(state({ metrics: metrics({ tools: { calls: 2, errors: 0, durationMs: { p50: null, p95: null } } }) }))
    const value = box.querySelector('.obs__kpi:nth-child(3) .obs__kpi-value')
    expect(value.textContent).toBe('无样本')
    expect(value.closest('.obs__kpi').textContent).toContain('p50 无样本')
  })

  it('工具 p95：>3000 用危险色', () => {
    const { box } = render(state({ metrics: metrics({ tools: { calls: 2, errors: 0, durationMs: { p50: 10, p95: 5000 } } }) }))
    expect(box.querySelector('.obs__kpi:nth-child(3) .obs__kpi-value').classList.contains('is-danger')).toBe(true)
  })

  it('成本：configured=false 解释「本地 provider · 无上游账单」，不显示免费', () => {
    const { box } = render(state({ metrics: metrics({ cost: { configured: false, total: 0 } }) }))
    const card = box.querySelector('.obs__kpi:nth-child(4)')
    expect(card.textContent).toContain('¥0.00')
    expect(card.textContent).toContain('本地 provider · 无上游账单')
    expect(card.textContent).not.toContain('免费')
  })

  it('成本：整数微元换算成两位小数（1234567 微元 = ¥1.23）', () => {
    const { box } = render(state({ metrics: metrics({ cost: { configured: true, total: 1234567 } }) }))
    const card = box.querySelector('.obs__kpi:nth-child(4)')
    expect(card.textContent).toContain('¥1.23')
    expect(card.textContent).toContain('pricing 已配置')
  })
})

describe('观测面板 · SLO 表', () => {
  it('八行固定顺序与 SLO_METRICS 一致', () => {
    const { box } = render()
    const names = [...box.querySelectorAll('.obs__slo tbody tr td:first-child')].map((td) => td.textContent)
    expect(names).toEqual(SLO_NAMES)
  })

  it('value=null：值列「无数据」，判决列 no-data 用灰', () => {
    const { box } = render(
      state({ metrics: metrics({ slo: slo({ rto: { value: null, verdict: 'no-data', unit: 'ms', soft: 1, hard: 2 } }) }) }),
    )
    const row = [...box.querySelectorAll('.obs__slo tbody tr')].find((tr) => tr.textContent.includes('rto'))
    expect(row.children[1].textContent).toBe('无数据')
    expect(row.children[4].textContent).toBe('no-data')
    expect(row.children[4].classList.contains('is-muted')).toBe(true)
  })

  it('slo=null：整表空态「本 profile 未装配 saga 平面」，不渲染 0', () => {
    const { box } = render(state({ metrics: metrics({ slo: null }) }))
    expect(box.textContent).toContain('本 profile 未装配 saga 平面（SLO 不可用）')
    expect(box.querySelector('.obs__slo table')).toBeNull()
  })
})

describe('观测面板 · 轨迹瀑布', () => {
  it('trace 为空：瀑布空态', () => {
    const { box } = render(state({ trace: { clock: 'trusted', roots: [] } }))
    expect(box.textContent).toContain('还没有轨迹')
  })

  it('clock=frozen：顶部出现「时长不可用」提示', () => {
    const { box } = render(state({ trace: trace({ clock: 'frozen' }) }))
    expect(box.textContent).toContain('快照回放：事件时间戳被冻结，时长不可用（仅结构可信）')
    expect(box.querySelector('.obs__rows').classList.contains('is-frozen')).toBe(true)
  })

  it('error span：名称前有危险色圆点，且没有左侧色带', () => {
    const { box } = render(
      state({ trace: trace({ roots: [{ span: span({ status: 'error' }), depth: 0, children: [] }] }) }),
    )
    const row = box.querySelector('.obs__row')
    expect(row.querySelector('.obs__dot--error')).not.toBeNull()
    expect(row.style.borderLeft).toBe('')
    expect(row.style.borderInlineStart).toBe('')
  })

  it('点击一行展开 attributes，再点收起', () => {
    const { box } = render()
    const row = box.querySelector('.obs__row')
    const detail = row.querySelector('.obs__attrs')
    expect(detail.hidden).toBe(true)
    row.click()
    expect(detail.hidden).toBe(false)
    expect(detail.textContent).toContain('turn')
    row.click()
    expect(detail.hidden).toBe(true)
  })

  it('深度缩进：子行 padding-inline-start 大于父行', () => {
    const { box } = render()
    const [parent, child] = box.querySelectorAll('.obs__row')
    expect(parseFloat(child.style.paddingInlineStart)).toBeGreaterThan(parseFloat(parent.style.paddingInlineStart))
  })

  it('超过 300 行只渲染前 300 并提示剩余', () => {
    const roots = Array.from({ length: 320 }, (_, index) => ({
      span: span({ spanId: `s-${String(index)}`, name: 'step', startMs: index, endMs: index + 1 }),
      depth: 0,
      children: [],
    }))
    const { box } = render(state({ trace: { clock: 'trusted', roots } }))
    expect(box.querySelectorAll('.obs__row')).toHaveLength(300)
    expect(box.textContent).toContain('还有 20 行')
  })
})

describe('观测面板 · 页脚与生命周期', () => {
  it('staleSec 非空时显示「数据陈旧 Ns」与手动刷新', () => {
    const onRefresh = vi.fn()
    const { box } = render(state({ staleSec: 12, onRefresh }))
    expect(box.textContent).toContain('数据陈旧 12s')
    box.querySelector('.obs__refresh').click()
    expect(onRefresh).toHaveBeenCalledTimes(1)
  })

  it('destroy 清空容器且不抛', () => {
    const { box, handle } = render()
    handle.destroy()
    expect(box.childNodes).toHaveLength(0)
  })
})
