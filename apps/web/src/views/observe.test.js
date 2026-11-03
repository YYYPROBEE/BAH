/**
 * 观测面板渲染（03 §S3.1 的 12 条 + 截断 / 陈旧提示）。
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
    expect(box.querySelectorAll('.obs__kpi')).toHaveLength(3)
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

})

describe('观测面板 · SLO 八行', () => {
  it('八行固定顺序与 SLO_METRICS 一致', () => {
    const { box } = render()
    const names = [...box.querySelectorAll('.obs__slo-row .obs__slo-name')].map((node) => node.textContent)
    expect(names).toEqual(SLO_NAMES)
  })

  it('两行堆叠：值 / soft / hard 在第二行，判决在第一行右侧', () => {
    const { box } = render()
    const row = box.querySelector('.obs__slo-row')
    const head = row.querySelector('.obs__slo-head')
    expect(head.querySelector('.obs__dot')).not.toBeNull()
    expect(head.querySelector('.obs__slo-verdict').textContent).toBe('ok')
    expect(row.querySelector('.obs__slo-values').textContent).toContain('值 0')
    expect(row.querySelector('.obs__slo-values').textContent).toContain('soft 1')
    expect(row.querySelector('.obs__slo-values').textContent).toContain('hard 2')
    // 没有五列表格：400px 列宽放不下
    expect(box.querySelector('.obs__slo table')).toBeNull()
  })

  it('value=null：「无数据」，判决 no-data 用灰，色点同灰', () => {
    const { box } = render(
      state({ metrics: metrics({ slo: slo({ rto: { value: null, verdict: 'no-data', unit: 'ms', soft: 1, hard: 2 } }) }) }),
    )
    const row = box.querySelector('.obs__slo-row[data-metric="rto"]')
    expect(row.querySelector('.obs__slo-values').textContent).toContain('值 无数据')
    expect(row.querySelector('.obs__slo-verdict').textContent).toBe('no-data')
    expect(row.querySelector('.obs__slo-verdict').classList.contains('is-muted')).toBe(true)
    expect(row.querySelector('.obs__dot').classList.contains('obs__dot--muted')).toBe(true)
  })

  it('单位折叠：ms 按量级折算、days 不再直出 20 位小数', () => {
    const { box } = render(
      state({
        metrics: metrics({
          slo: slo({
            danglingP95: { value: 86_400_000, verdict: 'P0', unit: 'ms', soft: 1, hard: 2 },
            rto: { value: 300_000, verdict: 'alert', unit: 'ms', soft: 300_000, hard: 300_000 },
            reconHeartbeat: { value: 31.5 / 86_400, verdict: 'ok', unit: 'days', soft: 1, hard: 7 },
          }),
        }),
      }),
    )
    expect(box.querySelector('[data-metric="danglingP95"] .obs__slo-values').textContent).toContain('1 天')
    expect(box.querySelector('[data-metric="rto"] .obs__slo-values').textContent).toContain('5 分')
    expect(box.querySelector('[data-metric="reconHeartbeat"] .obs__slo-values').textContent).toContain('31.5 秒')
    expect(box.textContent).not.toContain('86400000')
    expect(box.textContent).not.toContain('0.000365')
  })

  it('slo=null：整表空态「本 profile 未装配 saga 平面」，不渲染 0', () => {
    const { box } = render(state({ metrics: metrics({ slo: null }) }))
    expect(box.textContent).toContain('本 profile 未装配 saga 平面（SLO 不可用）')
    expect(box.querySelector('.obs__slo-list')).toBeNull()
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

  it('行是键盘可达的按钮：tabindex=0、role=button、Enter/Space 展开并同步 aria-expanded', () => {
    const { box } = render()
    const row = box.querySelector('.obs__row')
    expect(row.getAttribute('role')).toBe('button')
    expect(row.tabIndex).toBe(0)
    expect(row.getAttribute('aria-expanded')).toBe('false')

    row.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    expect(row.getAttribute('aria-expanded')).toBe('true')
    expect(row.querySelector('.obs__attrs').hidden).toBe(false)

    row.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }))
    expect(row.getAttribute('aria-expanded')).toBe('false')
    expect(row.querySelector('.obs__attrs').hidden).toBe(true)
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
