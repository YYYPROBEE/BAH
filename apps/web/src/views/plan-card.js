/**
 * 计划卡视图（G7）：「我（Agent）在替你做什么」的只读卡片。
 *
 * 数据来自 `plan-card` 帧（投影自 `plan_arm` / `plan_disarm` / `plan_wake` 的 tool/result），
 * 本文件**不推导**任何状态——状态以帧为准。
 *
 * 视觉：`design/bah-ds` 的令牌与类，Light-only；禁用左竖色条标状态（用 `.ds-tag`）。
 * 四块固定顺序：授权档与预算 / 到期与实例 / 条件快照 / 状态与判决。
 */

import { el, icon } from '../dom.js'

/** 状态 → 文案与徽标类。 */
const STATE = {
  armed: { label: '已授权', cls: 'ds-tag ds-tag--brand' },
  due: { label: '已到期', cls: 'ds-tag ds-tag--warning' },
  running: { label: '执行中', cls: 'ds-tag ds-tag--warning' },
  done: { label: '已完成', cls: 'ds-tag ds-tag--success' },
  failed: { label: '未达成', cls: 'ds-tag ds-tag--danger' },
  cancelled: { label: '已撤销', cls: 'ds-tag' },
}

/** 授权档 → 文案。 */
const TIER = { strict: '严格', standard: '标准', wide: '宽档' }

/** 条件状态 → 文案与色调。 */
const CONDITION = {
  ok: { label: '成立', cls: 'ds-tag ds-tag--success' },
  failed: { label: '失守', cls: 'ds-tag ds-tag--danger' },
  unknown: { label: '待复验', cls: 'ds-tag' },
}

/** 判决码 → 人话。 */
const VERDICT = {
  'window-expired': '窗口已过期',
  'condition-failed': '条件已变化',
  'plan-cancelled': '计划已撤销',
  'window-clock-ahead': '判定时刻越界',
}

/** epoch ms → `YYYY-MM-DD HH:mm`（UTC+8；只做展示，不参与判定）。 */
function formatAt(epochMs) {
  const shifted = new Date(epochMs + 8 * 60 * 60 * 1000)
  const pad = (value) => String(value).padStart(2, '0')
  return (
    `${String(shifted.getUTCFullYear())}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())} ` +
    `${pad(shifted.getUTCHours())}:${pad(shifted.getUTCMinutes())}`
  )
}

/**
 * 一条计划卡帧 → 节点。
 *
 * @param {Record<string, any>} frame
 * @returns {HTMLElement}
 */
export function renderPlanCard(frame) {
  const state = STATE[frame.state] ?? STATE.armed
  const tier = TIER[frame.tier] ?? frame.tier
  const conditions = Array.isArray(frame.conditions) ? frame.conditions : []

  const conditionRows = conditions.map((condition) => {
    const view = CONDITION[condition.state] ?? CONDITION.unknown
    return el('li', { class: 'plan-card__condition', dataset: { kind: String(condition.kind) } }, [
      el('span', { class: 'plan-card__condition-kind', text: String(condition.kind) }),
      el('span', { class: 'plan-card__condition-expected', text: String(condition.expected) }),
      el('span', { class: view.cls, text: view.label }),
      ...(condition.actual === undefined
        ? []
        : [el('span', { class: 'plan-card__condition-actual', text: `实际 ${String(condition.actual)}` })]),
    ])
  })

  const verdict =
    frame.lastVerdict === undefined
      ? []
      : [
          el('p', { class: 'plan-card__verdict', role: 'status' }, [
            icon('warning', 14),
            `最近一次判决：${VERDICT[frame.lastVerdict.code] ?? String(frame.lastVerdict.code)}`,
          ]),
        ]

  return el(
    'section',
    {
      class: 'plan-card',
      dataset: { role: 'plan-card', windowId: String(frame.windowId), state: String(frame.state) },
      'aria-label': `计划卡：${String(frame.title)}`,
    },
    [
      el('header', { class: 'plan-card__head' }, [
        el('h3', { class: 'plan-card__title', text: String(frame.title) }),
        el('span', { class: state.cls, text: state.label }),
      ]),
      el('dl', { class: 'plan-card__facts' }, [
        el('div', { class: 'plan-card__fact' }, [
          el('dt', { text: '授权档' }),
          el('dd', { text: `${tier} · 预算 ${String(frame.budgetText)}` }),
        ]),
        el('div', { class: 'plan-card__fact' }, [
          el('dt', { text: '到期（判定时钟）' }),
          el('dd', { text: formatAt(Number(frame.dueAt)) }),
        ]),
        el('div', { class: 'plan-card__fact' }, [
          el('dt', { text: '实例' }),
          el('dd', { text: `${String(frame.occurrence)} · ${String(frame.nodeCount)} 个节点` }),
        ]),
        el('div', { class: 'plan-card__fact' }, [
          el('dt', { text: '计划摘要' }),
          el('dd', { class: 'plan-card__digest', text: String(frame.digest).slice(0, 16) }),
        ]),
      ]),
      el('div', { class: 'plan-card__conditions' }, [
        el('h4', { class: 'plan-card__section-title', text: '条件快照' }),
        conditionRows.length === 0
          ? el('p', { class: 'plan-card__empty', text: '本计划没有附加条件（仅受预算与到期约束）。' })
          : el('ul', { class: 'plan-card__condition-list' }, conditionRows),
      ]),
      ...verdict,
    ],
  )
}
