/**
 * 工具卡片（施工单 13 §2.1「三态」+ §2.2「金额降级」）。
 *
 * 三态用**三重编码**表达，不只靠颜色（色弱/投影仪下也能读）：
 * 颜色（`--status-*`）+ 文案（待执行/已完成/已拦截/执行失败）+ 图标。
 *
 * 金额降级是硬规则：字段带 `amount: true` 且 `frame.amountConfirmed === false` 时，
 * 值标灰、追加"待确认"徽标、并给 `aria-label` —— 灰本身不表达语义。
 */

import { el, icon } from '../dom.js'

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
        : 'ds-tag'
}

/**
 * 工具帧 → 卡片节点。
 *
 * @param {Record<string, any>} frame
 * @returns {HTMLElement}
 */
export function renderTool(frame) {
  const state = STATE[frame.state] ?? STATE.pending
  const stateLabel = frame.reasonKind === 'failed' ? '执行失败' : state.label
  const card = frame.card

  const fields = (card?.fields ?? []).map((field) => renderField(field, frame.amountConfirmed))

  return el(
    'section',
    {
      class: `ds-card tool-card tool-card--${frame.state}`,
      dataset: { callId: frame.callId, state: frame.state, tier: frame.tier },
      'aria-label': `${frame.title}：${stateLabel}`,
    },
    [
      el('header', { class: 'tool-card__head' }, [
        el('span', { class: 'tool-card__icon' }, [icon(state.icon, 16)]),
        el('div', { class: 'tool-card__heading' }, [
          el('strong', { class: 'tool-card__title', text: card?.title ?? frame.title }),
          el('span', { class: tagClass(state.tone), text: stateLabel }),
          el('span', {
            class: `ds-tag ${frame.tier === 'red' ? 'ds-tag--danger' : frame.tier === 'yellow' ? 'ds-tag--warning' : ''}`.trim(),
            text: TIER[frame.tier] ?? TIER.unknown,
          }),
        ]),
        el('code', { class: 'tool-card__id', text: frame.callId }),
      ]),

      ...(fields.length === 0 ? [] : [el('dl', { class: 'tool-card__fields' }, fields)]),

      ...(card?.body === undefined
        ? []
        : [el('pre', { class: 'tool-card__body', text: card.body })]),

      ...(card?.disclaimer === undefined
        ? []
        : [
            el('div', { class: 'ds-alert ds-alert--warning tool-card__disclaimer' }, [
              el('span', { class: 'ds-alert__icon' }, [icon('error', 16)]),
              el('div', {}, [
                el('div', { class: 'ds-alert__title', text: '风险提示（必须展示）' }),
                el('p', { class: 'ds-alert__desc', text: card.disclaimer.text }),
                el('code', { class: 'ds-code', text: card.disclaimer.id }),
              ]),
            ]),
          ]),

      ...(frame.code === undefined && frame.reason === undefined
        ? []
        : [
            el('footer', { class: 'tool-card__foot' }, [
              ...(frame.code === undefined ? [] : [el('code', { class: 'ds-code', text: frame.code })]),
              ...(frame.reason === undefined ? [] : [el('span', { text: frame.reason })]),
              ...(frame.durationMs === undefined
                ? []
                : [el('span', { class: 'tool-card__duration', text: `${String(frame.durationMs)}ms` })]),
            ]),
          ]),
    ],
  )
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
