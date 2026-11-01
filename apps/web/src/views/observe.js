/**
 * 观测面板（可观测性 03 §3）：metrics + SLO + trace → DOM。
 *
 * 纪律：
 * 1. **纯渲染**：不做请求、不读时钟、不设定时器（门禁 `verify-observability-ui` 判据 1）；
 * 2. **null 不冒充 0**：`p95 === null` 显示「无样本」，`slo === null` 显示整表空态，
 *    `cost.configured === false` 显示「本地 provider · 无上游账单」；
 * 3. **判决由服务端给**：SLO 行直接用 `sample.verdict`，前端不重算阈值；
 * 4. 不许左侧色带（`verify-no-left-accent`）：错误只用名称前的小圆点。
 */

import { clear, el } from '../dom.js'

/** 与 `@bah/saga` 的 `SLO_METRICS` 同序（纯 JS 无打包器，硬编码并由用例钉住）。 */
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

/** `span.name` 前缀 → 系列色类名（03 单的 `cat` 字段在代码里不存在，以 name 为准）。 */
const CAT_CLASS = {
  http: 'obs__cat-http',
  llm: 'obs__cat-llm',
  tool: 'obs__cat-tool',
  approval: 'obs__cat-approval',
  plan: 'obs__cat-plan',
  saga: 'obs__cat-saga',
}

/** 瀑布最多渲染行数（其余折叠成一行计数）。 */
const MAX_ROWS = 300

/** 每个容器的展开态（跨轮询保留；键是容器，值是 spanId 集合）。 */
const expandedByContainer = new WeakMap()

/** 数字或 `null`（不把 undefined/NaN 当 0）。 */
function num(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/** 微元 → 元的显示串：整数分一次取整，只在显示层。 */
function yuanText(totalMicro) {
  const fen = Math.round(totalMicro / 10_000)
  const whole = Math.floor(fen / 100)
  return `¥${String(whole)}.${String(fen % 100).padStart(2, '0')}`
}

/** 数字去掉无意义的尾零（31.50 → 31.5，1.00 → 1）。 */
function trimNumber(value) {
  return Number.isInteger(value) ? String(value) : value.toFixed(2).replace(/\.?0+$/, '')
}

/**
 * 时长 → 可读文本。
 *
 * 阈值原样直出没有信息量：`86400000 ms` 要读者自己去除，`0.00036506944444444445 天`
 * 更是把 31.5 秒写成 20 位小数。面板只有 ~350px 宽，按量级折算成天/小时/分/秒。
 */
function durationText(ms) {
  if (ms >= 86_400_000) return `${trimNumber(ms / 86_400_000)} 天`
  if (ms >= 3_600_000) return `${trimNumber(ms / 3_600_000)} 小时`
  if (ms >= 60_000) return `${trimNumber(ms / 60_000)} 分`
  if (ms >= 1_000) return `${trimNumber(ms / 1_000)} 秒`
  return `${trimNumber(ms)} 毫秒`
}

/** SLO 值按单位格式化（`null` = 无数据，不显示 0）。 */
function sloText(value, unit) {
  if (value === null) return '无数据'
  if (unit === 'ratio') return `${(value * 100).toFixed(1)}%`
  if (unit === 'ms') return durationText(value)
  if (unit === 'days') return durationText(value * 86_400_000)
  return trimNumber(value)
}

/** 判决 → 样式类（ok/alert/P0/no-data 四值闭集）。 */
function verdictClass(verdict) {
  if (verdict === 'ok') return 'is-ok'
  if (verdict === 'alert') return 'is-alert'
  if (verdict === 'P0') return 'is-danger'
  return 'is-muted'
}

/** 判决 → 色点类（与文字同色；不依赖第四列也能看出越阈）。 */
function verdictDot(verdict) {
  if (verdict === 'ok') return 'obs__dot--ok'
  if (verdict === 'alert') return 'obs__dot--alert'
  if (verdict === 'P0') return 'obs__dot--danger'
  return 'obs__dot--muted'
}

/** 森林展平：`[{ span, depth }]`。 */
function flatten(roots) {
  const rows = []
  const walk = (node, depth) => {
    rows.push({ span: node.span ?? {}, depth })
    for (const child of node.children ?? []) walk(child, depth + 1)
  }
  for (const root of roots ?? []) walk(root, 0)
  return rows
}

/** 一棵 KPI 卡。 */
function kpiCard(label, value, hint, cls) {
  return el('div', { class: 'obs__kpi' }, [
    el('div', { class: 'obs__kpi-label', text: label }),
    el('div', { class: `obs__kpi-value${cls === undefined ? '' : ` ${cls}`}`, text: value }),
    el('div', { class: 'obs__kpi-hint', text: hint }),
  ])
}

/** KPI 四卡。 */
function kpiSection(metrics, trace) {
  const turns = num(metrics?.turns)
  const steps = trace == null ? null : flatten(trace.roots).filter((row) => row.span.name === 'step').length

  const calls = num(metrics?.tools?.calls) ?? 0
  const errors = num(metrics?.tools?.errors) ?? 0
  const rate = calls === 0 ? null : errors / calls
  const rateCls = rate === null ? undefined : rate > 0.3 ? 'is-danger' : rate > 0.1 ? 'is-alert' : undefined
  const rateText = rate === null ? '—' : `${(rate * 100).toFixed(1)}%`

  const p95 = num(metrics?.tools?.durationMs?.p95)
  const p50 = num(metrics?.tools?.durationMs?.p50)
  const p95Cls = p95 === null ? undefined : p95 > 3000 ? 'is-danger' : p95 > 1000 ? 'is-alert' : undefined
  const p95Text = p95 === null ? '无样本' : `${String(p95)} ms`
  const p95Hint = p50 === null ? 'p50 无样本' : `p50 = ${String(p50)} ms`

  const configured = metrics?.cost?.configured === true
  const total = num(metrics?.cost?.total)
  const costText = total === null ? '—' : yuanText(total)
  const costHint = configured ? 'pricing 已配置 · 累计' : '本地 provider · 无上游账单'

  return el('div', { class: 'obs__kpis' }, [
    kpiCard('轮次', turns === null ? '—' : String(turns), steps === null ? 'steps —' : `steps ${String(steps)}`),
    kpiCard('工具错误率', rateText, `${String(errors)}/${String(calls)}`, rateCls),
    kpiCard('工具 p95', p95Text, p95Hint, p95Cls),
    kpiCard('成本', costText, costHint, configured ? undefined : 'is-muted'),
  ])
}

/**
 * 一行 SLO：两行堆叠，**不是**五列表格。
 *
 * 右侧面板固定 ~400px，扣掉内边距只剩 ~350px：五列（指标 + 值 + soft + hard + 判决）
 * 实测把判决列挤出面板 111px，八行判决全部不可。改成第一行"色点 + 指标 + 判决"、
 * 第二行"值 / soft / hard"，判决色点同时挂在指标名前，不依赖任何一列的位置。
 */
function sloRow(name, sample) {
  const verdict = sample.verdict ?? 'no-data'
  const cls = verdictClass(verdict)
  const unit = sample.unit
  return el('div', { class: 'obs__slo-row', dataset: { metric: name, verdict } }, [
    el('div', { class: 'obs__slo-head' }, [
      el('span', { class: `obs__dot ${verdictDot(verdict)}`, 'aria-hidden': 'true' }),
      el('span', { class: 'obs__slo-name obs__mono', text: name }),
      el('span', { class: `obs__slo-verdict obs__verdict ${cls}`, text: verdict }),
    ]),
    el('div', { class: 'obs__slo-values' }, [
      el('span', { class: 'obs__slo-value obs__mono', text: `值 ${sloText(num(sample.value), unit)}` }),
      el('span', { class: 'obs__mono', text: `soft ${sloText(num(sample.soft), unit)}` }),
      el('span', { class: 'obs__mono', text: `hard ${sloText(num(sample.hard), unit)}` }),
    ]),
  ])
}

/** SLO 八行；`null` = 本 profile 没装 saga（整表空态，不渲染 0）。 */
function sloSection(slo) {
  if (slo === null || slo === undefined) {
    return el('section', { class: 'obs__slo' }, [
      el('h3', { class: 'obs__title', text: 'SLO 八指标' }),
      el('p', { class: 'obs__empty', text: '本 profile 未装配 saga 平面（SLO 不可用）' }),
    ])
  }

  return el('section', { class: 'obs__slo' }, [
    el('h3', { class: 'obs__title', text: 'SLO 八指标' }),
    el(
      'div',
      { class: 'obs__slo-list' },
      SLO_NAMES.map((name) => sloRow(name, slo[name] ?? {})),
    ),
  ])
}

/** 属性摘要（一行，标题用）。 */
function summaryOf(span) {
  const attrs = span.attributes ?? {}
  const keys = ['tool', 'status', 'code', 'model', 'route', 'kind']
  const parts = []
  for (const key of keys) {
    if (attrs[key] === undefined) continue
    parts.push(`${key}=${String(attrs[key])}`)
  }
  return parts.join(' ')
}

/** 瀑布行（点击展开属性）。 */
function traceRow(row, maxDuration, expanded) {
  const span = row.span
  const spanId = String(span.spanId ?? '')
  const duration = span.endMs === null || span.endMs === undefined ? null : Math.max(0, span.endMs - span.startMs)
  const open = duration === null
  const width = open ? 100 : duration === 0 ? 0 : Math.min(100, (duration / maxDuration) * 100)
  const cat = String(span.name ?? '').split('.')[0]
  const catClass = CAT_CLASS[cat] ?? 'obs__cat-slate'

  const name = el('span', { class: 'obs__row-name' }, [
    ...(span.status === 'error' ? [el('span', { class: 'obs__dot obs__dot--error', 'aria-hidden': 'true' })] : []),
    el('span', { class: 'obs__row-text', text: `${String(span.name ?? 'span')}${open ? '…' : ''}` }),
    ...(summaryOf(span) === '' ? [] : [el('span', { class: 'obs__row-summary', text: summaryOf(span) })]),
  ])

  const bar = el('span', { class: 'obs__bar' }, [
    el('span', {
      class: `obs__bar-fill ${catClass}`,
      style: { width: `${String(width)}%` },
      title: open ? '未闭合：可能仍在执行或进程已退出' : `${String(duration)} ms`,
    }),
  ])

  const open0 = expanded.has(spanId)
  // `role=button` + `tabindex=0`：这一行可以用鼠标点开，就必须也能用键盘打开
  // （走查实测：没有 tabindex 时 `element.tabIndex === -1`，Tab 永远到不了）。
  const node = el(
    'div',
    { class: 'obs__row', role: 'button', tabindex: '0', 'aria-expanded': open0 ? 'true' : 'false' },
    [name, bar],
  )
  node.style.setProperty('padding-inline-start', `${String(row.depth * 16)}px`)

  const attrs = Object.entries(span.attributes ?? {})
  const detail = el(
    'dl',
    { class: 'obs__attrs' },
    attrs.length === 0
      ? [el('dd', { text: '无属性' })]
      : attrs.flatMap(([key, value]) => [
          el('dt', { text: key }),
          el('dd', { text: String(value) }),
        ]),
  )
  detail.hidden = !open0
  node.classList.toggle('is-expanded', open0)
  node.append(detail)

  const toggle = () => {
    const open = expanded.has(spanId)
    if (open) expanded.delete(spanId)
    else expanded.add(spanId)
    detail.hidden = open
    node.classList.toggle('is-expanded', !open)
    node.setAttribute('aria-expanded', open ? 'false' : 'true')
  }
  node.addEventListener('click', toggle)
  node.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return
    event.preventDefault()
    toggle()
  })
  return node
}

/** 瀑布（含冻结时钟提示与空态）。 */
function traceSection(container, trace) {
  const section = el('section', { class: 'obs__trace' }, [
    el('h3', { class: 'obs__title', text: '轨迹（当前会话）' }),
  ])

  if (trace == null || flatten(trace.roots).length === 0) {
    section.append(el('p', { class: 'obs__empty', text: '还没有轨迹：跑一轮对话后再看' }))
    return section
  }

  if (trace.clock === 'frozen') {
    section.append(
      el('p', { class: 'obs__frozen', text: '快照回放：事件时间戳被冻结，时长不可用（仅结构可信）' }),
    )
  }

  const rows = flatten(trace.roots)
  const durations = rows
    .map((row) => (row.span.endMs === null || row.span.endMs === undefined ? null : row.span.endMs - row.span.startMs))
    .filter((value) => value !== null)
  const maxDuration = Math.max(1, ...durations)
  const expanded = expandedByContainer.get(container) ?? new Set()

  const list = el('div', { class: 'obs__rows' })
  for (const row of rows.slice(0, MAX_ROWS)) list.append(traceRow(row, maxDuration, expanded))
  section.append(list)

  if (rows.length > MAX_ROWS) {
    section.append(el('p', { class: 'obs__more', text: `还有 ${String(rows.length - MAX_ROWS)} 行` }))
  }
  if (trace.clock === 'frozen') list.classList.add('is-frozen')
  return section
}

/** 页脚：陈旧提示 + 手动刷新。 */
function footer(state) {
  const parts = []
  if (state.staleSec !== null && state.staleSec !== undefined) {
    parts.push(el('span', { class: 'obs__stale', text: `数据陈旧 ${String(state.staleSec)}s` }))
  }
  parts.push(
    el('button', {
      class: 'ds-btn ds-btn--ghost ds-btn--sm obs__refresh',
      type: 'button',
      text: '手动刷新',
      onclick: state.onRefresh,
    }),
  )
  return el('footer', { class: 'obs__foot' }, parts)
}

/** 重试按钮（未连接 / 端点失败共用）。 */
function retryButton(state) {
  return el('button', {
    class: 'ds-btn ds-btn--secondary ds-btn--sm',
    type: 'button',
    text: '重试',
    onclick: state.onRefresh,
  })
}

/**
 * 渲染观测面板。
 *
 * @param {HTMLElement} container
 * @param {{ metrics: object|null, trace: object|null, status: 'connecting'|'online'|'offline',
 *           staleSec: number|null, error: {code:string,reason:string}|null,
 *           onRefresh?: () => void }} state
 * @returns {{ destroy: () => void }}
 */
export function renderObserve(container, state) {
  clear(container)
  if (!expandedByContainer.has(container)) expandedByContainer.set(container, new Set())

  /** 清空容器并释放展开态。 */
  const destroy = () => {
    clear(container)
    expandedByContainer.delete(container)
  }

  const metrics = state.metrics ?? null
  const trace = state.trace ?? null

  // 未连接且从未拿到数据：只给连接提示（不渲染一排假 0）
  if (state.status !== 'online' && metrics === null) {
    container.append(
      el('div', { class: 'ds-empty obs__empty-state' }, [
        el('p', { class: 'ds-empty__title', text: '观测面板需要连接后可读' }),
        el('p', { class: 'ds-empty__desc', text: '连接恢复后自动加载；也可以手动重试。' }),
        retryButton(state),
      ]),
    )
    return { destroy }
  }

  const box = el('div', { class: 'obs' })

  if (state.error !== null && state.error !== undefined) {
    const code = state.error.code ?? 'unknown'
    box.append(
      el('div', { class: 'obs__error' }, [
        el('span', { text: `指标读取失败（${String(code)}）` }),
        retryButton(state),
      ]),
    )
  }

  const spanCount = trace == null ? 0 : flatten(trace.roots).length
  if (metrics !== null && (num(metrics.turns) ?? 0) === 0 && spanCount === 0) {
    box.append(
      el('div', { class: 'ds-empty obs__empty-state' }, [
        el('p', { class: 'ds-empty__title', text: '本会话还没有结束的轮次' }),
        el('p', { class: 'ds-empty__desc', text: '跑一轮对话后再回来看。' }),
      ]),
    )
    container.append(box)
    return { destroy }
  }

  box.append(kpiSection(metrics, trace))
  box.append(sloSection(metrics?.slo ?? null))
  box.append(traceSection(container, trace))
  box.append(footer(state))
  container.append(box)

  return { destroy }
}
