/**
 * 移动端计划卡（G7）：同桌面 `views/plan-card.js` 的四块信息，按 375×812 重排。
 *
 * 纪律：状态只认帧；不新增推导；不出现左竖色条（状态用 `.ds-tag`）。
 */

import { el } from '../dom.js'

const STATE = {
  armed: { label: '已授权', cls: 'ds-tag ds-tag--brand' },
  due: { label: '已到期', cls: 'ds-tag ds-tag--warning' },
  running: { label: '执行中', cls: 'ds-tag ds-tag--warning' },
  done: { label: '已完成', cls: 'ds-tag ds-tag--success' },
  failed: { label: '未达成', cls: 'ds-tag ds-tag--danger' },
  cancelled: { label: '已撤销', cls: 'ds-tag' },
  // 与桌面 `views/plan-card.js` 同口径（提示词 4-2）
  expired: { label: '已过期', cls: 'ds-tag' },
  'needs-reconfirm': { label: '待重新确认', cls: 'ds-tag ds-tag--warning' },
}

const TIER = { strict: '严格', standard: '标准', wide: '宽档' }

const CONDITION = {
  ok: { label: '成立', cls: 'ds-tag ds-tag--success' },
  failed: { label: '失守', cls: 'ds-tag ds-tag--danger' },
  unknown: { label: '待复验', cls: 'ds-tag' },
}

const VERDICT = {
  'window-expired': '窗口已过期',
  'condition-failed': '条件已变化',
  'plan-cancelled': '计划已撤销',
  'window-clock-ahead': '判定时刻越界',
  'details-changed': '明细与批准时不一致',
  'tier-not-allowed': '该档位不允许自动执行',
}

/** 补偿结果 → 人话（ADR-0013）。 */
const COMPENSATION = {
  reversed: '已冲正',
  'reversal-failed': '冲正失败',
  'reversal-unavailable': '冲正不可用',
}

function compensationText(compensation) {
  const label = COMPENSATION[compensation.kind] ?? String(compensation.kind)
  const money =
    typeof compensation.amountCents === 'number'
      ? ` ¥${(compensation.amountCents / 100).toFixed(2)}`
      : ''
  const txn = typeof compensation.txnId === 'string' ? `（原流水 ${compensation.txnId}）` : ''
  const code = typeof compensation.code === 'string' ? `（${compensation.code}）` : ''
  return `${label}${money}${txn}${code}`
}

function formatAt(epochMs) {
  const shifted = new Date(epochMs + 8 * 60 * 60 * 1000)
  const pad = (value) => String(value).padStart(2, '0')
  return (
    `${String(shifted.getUTCFullYear())}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())} ` +
    `${pad(shifted.getUTCHours())}:${pad(shifted.getUTCMinutes())}`
  )
}

/**
 * 计划卡帧 → 节点（移动端）。
 *
 * @param {Record<string, any>} frame
 * @returns {HTMLElement}
 */
export function renderPlanCard(frame) {
  const state = STATE[frame.state] ?? STATE.armed
  const tier = TIER[frame.tier] ?? frame.tier
  const conditions = Array.isArray(frame.conditions) ? frame.conditions : []

  return el(
    'section',
    {
      class: 'm-plan-card',
      dataset: { role: 'plan-card', windowId: String(frame.windowId), state: String(frame.state) },
      'aria-label': `计划卡：${String(frame.title)}`,
    },
    [
      el('header', { class: 'm-plan-card__head' }, [
        el('strong', { class: 'm-plan-card__title', text: String(frame.title) }),
        el('span', { class: state.cls, text: state.label }),
      ]),
      el('p', { class: 'm-plan-card__meta', text: `${tier}档 · 预算 ${String(frame.budgetText)}` }),
      el('p', { class: 'm-plan-card__meta', text: `到期 ${formatAt(Number(frame.dueAt))}（判定时钟）` }),
      el('p', {
        class: 'm-plan-card__meta',
        text: `${String(frame.occurrence)} · ${String(frame.nodeCount)} 个节点`,
      }),
      el(
        'ul',
        { class: 'm-plan-card__conditions' },
        conditions.map((condition) => {
          const view = CONDITION[condition.state] ?? CONDITION.unknown
          return el('li', { class: 'm-plan-card__condition' }, [
            el('span', { class: 'm-plan-card__condition-kind', text: String(condition.kind) }),
            el('span', { class: 'm-plan-card__condition-expected', text: String(condition.expected) }),
            el('span', { class: view.cls, text: view.label }),
          ])
        }),
      ),
      ...(frame.lastVerdict === undefined
        ? []
        : [
            el('p', {
              class: 'm-plan-card__verdict',
              role: 'status',
              text: `最近判决：${VERDICT[frame.lastVerdict.code] ?? String(frame.lastVerdict.code)}`,
            }),
          ]),
      ...(frame.compensation === undefined
        ? []
        : [
            el('p', {
              class: 'm-plan-card__compensation',
              role: 'status',
              text: compensationText(frame.compensation),
            }),
          ]),
    ],
  )
}
