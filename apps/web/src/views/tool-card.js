/**
 * 工具卡片。
 *
 * 三态用**三重编码**表达，不只靠颜色（色弱/投影仪下也能读）：
 * 颜色（`--status-*`）+ 文案（待执行/已完成/已拦截/执行失败）+ 图标。
 *
 * 金额降级是硬规则：字段带 `amount: true` 且 `frame.amountConfirmed === false` 时，
 * 值标灰、追加"待确认"徽标、并给 `aria-label` —— 灰本身不表达语义。
 */

import { el, icon } from '../dom.js'
import { reasonLabelOf } from '../format.js'

/** 状态 → 文案与色调。 */
const STATE = {
  pending: { label: '待执行', tone: 'warning', icon: 'clock' },
  done: { label: '已完成', tone: 'success', icon: 'check' },
  denied: { label: '已拦截', tone: 'danger', icon: 'error' },
}

/** 权限级别文案。 */
const TIER = { green: '绿级', yellow: '黄级', red: '红级', unknown: '级别未知' }

/** 状态 → 徽标 class。 */
function tagClass(tone) {
  return tone === 'success'
    ? 'ds-tag ds-tag--success'
    : tone === 'danger'
      ? 'ds-tag ds-tag--danger'
      : tone === 'warning'
        ? 'ds-tag ds-tag--warning'
        : tone === 'brand'
          ? 'ds-tag ds-tag--brand'
          : 'ds-tag'
}

/** 字段色调 → class（`default` 不额外着色）。 */
function toneClass(tone) {
  return tone === undefined || tone === 'default' ? '' : `field__value--${tone}`
}

/**
 * 把工具正文里的合规提示整理成客户可读的一句话。
 *
 * 原始正文形如「风险提示：wealth-risk-v1（必须向用户展示，理财非存款、投资有风险）」：
 * 「必须向用户展示」是给模型的指令，不该出现在客户界面；ID 由旁边的 chip 单独展示。
 * 只去掉这层包装，不改写任何风险表述；认不出格式就原样显示。
 */
function disclaimerTextOf(raw) {
  const text = String(raw ?? '').trim()
  const cleaned = text
    .replace(/^风险提示[：:]\s*\S+?\s*[（(]\s*/, '')
    .replace(/^必须向用户展示[，,、]?\s*/, '')
    .replace(/\s*[）)]\s*$/, '')
    .trim()
  return cleaned === '' ? text : cleaned
}

/**
 * 工具帧 → 卡片节点。
 *
 * @param {Record<string, any>} frame
 * @returns {HTMLElement}
 */
export function renderTool(frame) {
  // 未知状态退回"待执行"：否则会产出 `tool-card--undefined` 这种没有样式的类。
  const stateKey = STATE[frame.state] === undefined ? 'pending' : frame.state
  const state = STATE[stateKey]
  const stateLabel = frame.reasonKind === 'failed' ? '执行失败' : state.label
  const card = frame.card

  const fields = (card?.fields ?? []).map((field) => renderField(field, frame.amountConfirmed))
  // 卡片徽标（"理财非存款" / "知识校验" / "未执行"）：合规与拒答标识不能只留在数据里。
  const tags = (card?.tags ?? []).map((tag) => el('span', { class: tagClass(tag.tone), text: tag.text }))
  // `analysis` 卡片可折叠（§5.2）：计算过程长，默认收起，结果字段仍在外面。
  const body =
    card?.body === undefined
      ? null
      : card.template === 'analysis'
        ? el('details', { class: 'tool-card__details' }, [
            el('summary', { class: 'tool-card__summary', text: '查看计算过程' }),
            el('pre', { class: 'tool-card__body', text: card.body }),
          ])
        : el('pre', { class: 'tool-card__body', text: card.body })

  return el(
    'section',
    {
      class: `ds-card tool-card tool-card--${stateKey}`,
      dataset: { callId: frame.callId, state: frame.state, tier: frame.tier },
      'aria-label': `${frame.title}：${stateLabel}`,
    },
    [
      el('header', { class: 'tool-card__head' }, [
        el('span', { class: 'tool-card__icon' }, [icon(state.icon, 16)]),
        el('div', { class: 'tool-card__heading' }, [
          el('strong', { class: 'tool-card__title', text: card?.title ?? frame.title }),
          ...(card?.subtitle === undefined
            ? []
            : [el('span', { class: 'tool-card__subtitle', text: card.subtitle })]),
          el('span', { class: tagClass(state.tone), text: stateLabel }),
          el('span', {
            class: `ds-tag ${frame.tier === 'red' ? 'ds-tag--danger' : frame.tier === 'yellow' ? 'ds-tag--warning' : ''}`.trim(),
            text: TIER[frame.tier] ?? TIER.unknown,
          }),
          ...tags,
        ]),
        el('code', { class: 'tool-card__id', text: frame.callId }),
      ]),

      ...(fields.length === 0 ? [] : [el('dl', { class: 'tool-card__fields' }, fields)]),

      ...(body === null ? [] : [body]),

      ...(card?.table === undefined ? [] : [renderTable(card.table)]),

      ...(card?.note === undefined ? [] : [el('p', { class: 'tool-card__note', text: card.note })]),

      ...(card?.disclaimer === undefined
        ? []
        : [
            el('div', { class: 'ds-alert ds-alert--warning tool-card__disclaimer' }, [
              el('span', { class: 'ds-alert__icon' }, [icon('error', 16)]),
              el('div', { class: 'tool-card__disclaimer-body' }, [
                el('div', { class: 'ds-alert__title', text: '风险提示' }),
                el('p', { class: 'ds-alert__desc', text: disclaimerTextOf(card.disclaimer.text) }),
                el('code', { class: 'ds-code tool-card__disclaimer-id', text: card.disclaimer.id }),
              ]),
            ]),
          ]),

      ...(frame.code === undefined && frame.reason === undefined
        ? []
        : [
            el('footer', { class: 'tool-card__foot' }, [
              ...(frame.code === undefined
                ? []
                : [el('code', { class: 'ds-code', text: reasonLabelOf(frame.code) })]),
              ...(frame.reason === undefined ? [] : [el('span', { text: reasonLabelOf(frame.reason) })]),
              ...(frame.durationMs === undefined
                ? []
                : [el('span', { class: 'tool-card__duration', text: `${String(frame.durationMs)}ms` })]),
            ]),
          ]),
    ],
  )
}

/**
 * 结构化表格（`CardView.table`，账户列表 / 交易流水用）。
 *
 * @param {{ headers: readonly string[], rows: readonly (readonly string[])[] }} table
 */
function renderTable(table) {
  return el('div', { class: 'tool-card__table ds-table-card' }, [
    el('table', { class: 'ds-table' }, [
      el('thead', {}, [el('tr', {}, table.headers.map((header) => el('th', { text: header })))]),
      el('tbody', {}, table.rows.map((row) => el('tr', {}, row.map((cell) => el('td', { text: cell }))))),
    ]),
  ])
}

/**
 * 一个字段行（金额未确认时降级）。
 *
 * @param {{ label: string, value: string, amount?: boolean, mono?: boolean, tone?: string }} field
 * @param {boolean} amountConfirmed
 */
export function renderField(field, amountConfirmed) {
  const unconfirmed = field.amount === true && amountConfirmed !== true
  const valueClass = [
    'field__value',
    field.mono === true ? 'field__value--mono' : '',
    toneClass(field.tone),
    unconfirmed ? 'field__value--unconfirmed' : '',
  ]
    .filter(Boolean)
    .join(' ')

  return el('div', { class: 'field', dataset: { label: field.label } }, [
    el('dt', { class: 'field__label', text: field.label }),
    el('dd', { class: valueClass }, [
      el('span', { text: field.value }),
      ...(unconfirmed
        ? [
            el('span', {
              class: 'ds-tag ds-tag--warning field__pending',
              text: '待确认',
              'aria-label': '金额待确认：本回合没有工具结果',
            }),
          ]
        : []),
    ]),
  ])
}
