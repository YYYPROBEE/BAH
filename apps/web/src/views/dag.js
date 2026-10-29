/**
 * DAG 视图（施工单 13 §2.1「DAG 规划视图」）。
 *
 * 数据源是 `tool/call` + `tool/result` 派生的**调用图**（偏差 R-WEB-D1：`plan/*` 事件属施工单 14）。
 * 验收口径不变：节点带权限级别、失败节点下游灰显并标"已阻断"。
 *
 * 为什么手写 SVG 而不引图形库：纯原生约束（施工单 13 §0 第 4 条），
 * 而且这张图只有"分层 + 连线"两件事，布局 30 行就够。
 *
 * 可访问性：`role="img"` + `aria-label` 摘要 + 每个节点 `<title>`，
 * 屏幕阅读器不能只看到一张空图。
 */

import { el } from '../dom.js'

/** 节点横向间距 / 纵向间距（px）。 */
const DX = 156
const DY = 56
const PAD = 16
const NODE_W = 128
const NODE_H = 36

/** 状态 → 视觉（描边/填充/文案）。B2：plan 节点状态与 `PLAN_NODE_STATES` 对齐。 */
const STATE = {
  ok: { label: '完成', stroke: 'var(--border-neutral-l2)', fill: 'var(--bg-base-secondary)', text: 'var(--text-default)' },
  pending: { label: '待执行', stroke: 'var(--status-warning-default)', fill: 'var(--bg-base-default)', text: 'var(--text-default)' },
  denied: { label: '已拦截', stroke: 'var(--status-error-default)', fill: 'var(--status-error-surface-l1)', text: 'var(--status-error-default)' },
  blocked: { label: '已阻断', stroke: 'var(--border-neutral-l1)', fill: 'var(--bg-base-default)', text: 'var(--text-disabled)' },
  running: { label: '执行中', stroke: 'var(--status-warning-default)', fill: 'var(--bg-base-default)', text: 'var(--text-default)' },
  failed: { label: '失败', stroke: 'var(--status-error-default)', fill: 'var(--status-error-surface-l1)', text: 'var(--status-error-default)' },
  // incident（外部不可用）与 failed 必须可区分：用警示色 + 独立文案
  incident: { label: '外部故障', stroke: 'var(--status-warning-default)', fill: 'var(--status-warning-surface-l1, var(--bg-base-default))', text: 'var(--status-warning-default)' },
  skipped: { label: '已跳过', stroke: 'var(--border-neutral-l1)', fill: 'var(--bg-base-default)', text: 'var(--text-disabled)' },
  cancelled: { label: '已取消', stroke: 'var(--border-neutral-l1)', fill: 'var(--bg-base-default)', text: 'var(--text-disabled)' },
}

/** 权限级别 → 短标签。 */
const TIER = { green: '绿', yellow: '黄', red: '红', unknown: '?' }

/**
 * DAG 帧 → SVG 节点。
 *
 * @param {Record<string, any>} frame
 * @returns {SVGElement}
 */
export function renderDag(frame) {
  const nodes = frame.nodes ?? []
  const edges = frame.edges ?? []

  // 分层坐标：x 按 step，y 按同 step 内的出现顺序
  const positions = new Map()
  const perStep = new Map()
  let maxStep = 0
  for (const node of nodes) {
    const index = perStep.get(node.step) ?? 0
    perStep.set(node.step, index + 1)
    positions.set(node.id, { x: PAD + node.step * DX, y: PAD + index * DY })
    maxStep = Math.max(maxStep, node.step)
  }

  const width = PAD * 2 + (maxStep + 1) * DX
  const height = PAD * 2 + Math.max(1, ...[...perStep.values()]) * DY

  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.setAttribute('class', 'dag')
  svg.setAttribute('viewBox', `0 0 ${String(width)} ${String(height)}`)
  // 自然尺寸 + 容器横向滚动，**不**随 400px 面板等比缩放：
  // `width:100%` 会把 5 节点图压到 scale 0.56，12px 标签实际显示约 6px。
  svg.setAttribute('width', String(width))
  svg.setAttribute('height', String(height))
  svg.setAttribute('role', 'img')
  svg.setAttribute('aria-label', `调用图：${frame.summary}`)

  // 先画边（在节点下面）
  for (const edge of edges) {
    const from = positions.get(edge.from)
    const to = positions.get(edge.to)
    if (from === undefined || to === undefined) continue
    const line = document.createElementNS('http://www.w3.org/2000/svg', 'path')
    const x1 = from.x + NODE_W
    const y1 = from.y + NODE_H / 2
    const x2 = to.x
    const y2 = to.y + NODE_H / 2
    const mid = (x1 + x2) / 2
    line.setAttribute('d', `M ${String(x1)} ${String(y1)} C ${String(mid)} ${String(y1)}, ${String(mid)} ${String(y2)}, ${String(x2)} ${String(y2)}`)
    line.setAttribute('class', 'dag__edge')
    svg.append(line)
  }

  for (const node of nodes) {
    const position = positions.get(node.id)
    if (position === undefined) continue
    const visual = STATE[node.state] ?? STATE.pending

    const group = document.createElementNS('http://www.w3.org/2000/svg', 'g')
    group.setAttribute('class', `dag__node dag__node--${node.state}`)
    group.setAttribute('data-node-id', node.id)
    group.setAttribute('data-state', node.state)
    group.setAttribute('data-blocked', node.state === 'blocked' ? 'true' : 'false')

    const title = document.createElementNS('http://www.w3.org/2000/svg', 'title')
    title.textContent = `${node.label}（${visual.label}${node.kind === 'call' ? ` · ${TIER[node.tier] ?? '?'}级` : ''}）`
    group.append(title)

    const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect')
    rect.setAttribute('x', String(position.x))
    rect.setAttribute('y', String(position.y))
    rect.setAttribute('width', String(NODE_W))
    rect.setAttribute('height', String(NODE_H))
    rect.setAttribute('rx', '8')
    rect.setAttribute('fill', visual.fill)
    rect.setAttribute('stroke', visual.stroke)
    rect.setAttribute('stroke-width', node.state === 'blocked' ? '1' : '1.5')
    if (node.state === 'blocked') rect.setAttribute('stroke-dasharray', '4 3')
    group.append(rect)

    const label = document.createElementNS('http://www.w3.org/2000/svg', 'text')
    label.setAttribute('class', 'dag__label')
    label.setAttribute('x', String(position.x + 10))
    label.setAttribute('y', String(position.y + 23))
    label.setAttribute('fill', visual.text)
    // 字号走 CSS 令牌（`--body-sm-font-size`）：硬编码 12px 与文档字阶脱钩。
    label.textContent = truncate(node.label, 12)
    group.append(label)

    const badge = document.createElementNS('http://www.w3.org/2000/svg', 'text')
    badge.setAttribute('class', 'dag__badge')
    badge.setAttribute('x', String(position.x + NODE_W - 10))
    badge.setAttribute('y', String(position.y + 23))
    badge.setAttribute('text-anchor', 'end')
    badge.setAttribute('fill', 'var(--text-tertiary)')
    badge.textContent = node.kind === 'call' ? (TIER[node.tier] ?? '?') : ''
    group.append(badge)

    svg.append(group)
  }

  return svg
}

/** 超长标签截断（图里不换行，避免高度不可控）。 */
function truncate(text, max) {
  const value = String(text)
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`
}

/** 空态（还没有调用）。 */
export function renderDagEmpty() {
  return el('div', { class: 'ds-empty' }, [
    el('p', { class: 'ds-empty__title', text: '还没有调用' }),
    el('p', { class: 'ds-empty__desc', text: '工具调用出现后，这里会画出节点与权限级别。' }),
  ])
}
