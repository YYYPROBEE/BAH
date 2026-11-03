/**
 * DAG 视图。
 *
 * 数据源是 `tool/call` + `tool/result` 派生的**调用图**（偏差 R-WEB-D1：`plan/*` 事件属）。
 * 验收口径不变：节点带权限级别、失败节点下游灰显并标"已阻断"。
 *
 * 为什么手写 SVG 而不引图形库：纯原生约束，
 * 而且这张图只有"分层 + 连线"两件事，布局 30 行就够。
 *
 * 可访问性：`role="img"` + `aria-label` 摘要 + 每个节点 `<title>`，
 * 屏幕阅读器不能只看到一张空图。
 */

import { el } from '../dom.js'

/**
 * 纵向布局常量（px）。
 *
 * 这张图只出现在桌面右侧 400px 面板：横向铺层会直接把步数变成横向滚动条，
 * 而面板本来就有富余高度。所以按 step 从上往下排，节点宽度吃满侧栏内容区，
 * 不再随层数向右生长。
 */
const GAP_Y = 24
const PAD = 16
const NODE_W = 240
const NODE_H = 40

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

/** 工具名 → 中文短名（调用图统一“中文 · english”，让非工程读者也能读）。 */
const TOOL_LABEL = {
  account_list: '账户列表',
  account_balance: '余额查询',
  txn_query: '流水查询',
  bill_analyze: '账单分析',
  bill_report: '账单报告',
  analysis_calc: '计算',
  transfer_preview: '转账试算',
  transfer_create: '转账',
  transfer_schedule: '定时转账',
  aa_create: 'AA 收款',
  wealth_list: '理财产品',
  wealth_compare: '产品对比',
  wealth_purchase: '理财申购',
  risk_assess: '风险测评',
  wealth_positions: '理财持仓',
  wealth_redeem: '理财赎回',
  verify_face: '人脸验证',
  verify_sms: '短信验证',
  verify_ushield: 'U 盾验证',
  card_report_lost: '挂失银行卡',
  fund_lock: '资金锁定',
  sub_cancel: '取消订阅',
  sub_list: '订阅查询',
  sub_watch: '订阅提醒',
  sub_authorize: '关闭代扣',
  card_freeze: '冻结卡片',
  card_unfreeze: '解冻卡片',
  card_apply: '申请卡片',
  card_limit_set: '调整限额',
  card_restriction: '交易限制',
  password_change: '修改密码',
  merchant_search: '商户搜索',
  merchant_order: '商户下单',
  birthday_plan: '生日计划',
  plan_wake: '计划唤醒',
  goal_set: '设定目标',
  todo_write: '更新清单',
  intent_resolve: '意图澄清',
  prompt_ask: '追问',
}

/** 状态 → 英文短标签（只进 title，与可见中文并存）。 */
const STATE_EN = {
  ok: 'Done',
  pending: 'Pending',
  denied: 'Denied',
  blocked: 'Blocked',
  running: 'Running',
  failed: 'Failed',
  incident: 'Incident',
  skipped: 'Skipped',
  cancelled: 'Cancelled',
}

/** 节点标签 → 中英双文（步骤节点补 Step N；工具调用补中文名）。 */
export function bilingualNodeLabel(node) {
  const raw = String(node.label ?? '')
  const step = /^步骤\s*(\d+)$/.exec(raw)
  if (step !== null) return `${raw} · Step ${step[1]}`
  if (node.kind !== 'call') return raw
  const zh = TOOL_LABEL[raw]
  return zh === undefined ? raw : `${zh} · ${raw}`
}

/**
 * DAG 帧 → SVG 节点。
 *
 * @param {Record<string, any>} frame
 * @returns {SVGElement}
 */
export function renderDag(frame) {
  const nodes = frame.nodes ?? []
  const edges = frame.edges ?? []

  // 纵向坐标：按 step 从上往下排；同一 step 内保持原始顺序（并行节点也顺序下排，
  // 因为 400px 侧栏放不下两列 240px 节点，硬分列又会回到横向滚动）。
  const ordered = nodes
    .map((node, index) => ({ node, index }))
    .sort((a, b) => a.node.step - b.node.step || a.index - b.index)
    .map((entry) => entry.node)

  const positions = new Map()
  ordered.forEach((node, index) => {
    positions.set(node.id, {
      x: PAD,
      y: PAD + index * (NODE_H + GAP_Y),
    })
  })

  const width = PAD * 2 + NODE_W
  const height =
    PAD * 2 + Math.max(1, ordered.length) * NODE_H + Math.max(0, ordered.length - 1) * GAP_Y

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
    // 从上一节点底边中点连到下一节点顶边中点，垂直向下；中间控制点让跨节点连线
    // 保持在同一列里，不会斜穿面板。
    const x1 = from.x + NODE_W / 2
    const y1 = from.y + NODE_H
    const x2 = to.x + NODE_W / 2
    const y2 = to.y
    const midY = (y1 + y2) / 2
    line.setAttribute('d', `M ${String(x1)} ${String(y1)} C ${String(x1)} ${String(midY)}, ${String(x2)} ${String(midY)}, ${String(x2)} ${String(y2)}`)
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
    title.textContent = `${bilingualNodeLabel(node)}（${visual.label} / ${STATE_EN[node.state] ?? 'Pending'}${node.kind === 'call' ? ` · ${TIER[node.tier] ?? '?'}级` : ''}）`
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
    label.setAttribute('x', String(position.x + 12))
    label.setAttribute('y', String(position.y + 26))
    label.setAttribute('fill', visual.text)
    // 字号走 CSS 令牌（`--body-sm-font-size`）：硬编码 12px 与文档字阶脱钩。
    label.textContent = truncate(bilingualNodeLabel(node), 30)
    group.append(label)

    const badge = document.createElementNS('http://www.w3.org/2000/svg', 'text')
    badge.setAttribute('class', 'dag__badge')
    badge.setAttribute('x', String(position.x + NODE_W - 12))
    badge.setAttribute('y', String(position.y + 26))
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
