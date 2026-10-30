/**
 * 已发生操作清单（`effects` 帧，桌面壳）。
 *
 * 用途固定：中断 / 断线之后回答"到底已经做了什么"。所以清单是**只读**的——
 * 零按钮、零链接：撤销与冲正属于 saga 补偿面，不在呈现层给一个看起来能点的入口。
 *
 * 金额、工具名、耗时都不做二次加工：帧里已是后端格式化（`formatCents`）与脱敏后的结果，
 * 前端再算一次就是第二个真相源。
 *
 * 准确性前提（`projectEffects` 的双判据）：`web` profile 未注入 `writeToolNames`，只按
 * tier 单判据收写操作 ⇒ 绿级写操作可能漏、黄级读操作可能误收。这张卡不是资金审计，
 * 真正的审计链在 `audit.jsonl` / 审计面板。
 */

import { el, icon } from '../dom.js'

/**
 * `effects` 帧 → 清单节点。
 *
 * @param {Record<string, any>} frame
 * @returns {HTMLElement}
 */
export function renderEffects(frame) {
  const items = (frame.items ?? []).map((item) =>
    el('li', { class: 'effects__item', dataset: { role: 'effect-item', callId: String(item.callId) } }, [
      el('span', { class: 'effects__name', text: item.title }),
      ...(item.amountText === undefined ? [] : [el('span', { class: 'effects__amount', text: item.amountText })]),
      el('span', { class: 'ds-tag', text: item.name }),
      ...(item.durationMs === undefined
        ? []
        : [el('span', { class: 'effects__meta', text: `${String(item.durationMs)}ms` })]),
    ]),
  )

  return el(
    'section',
    {
      class: 'ds-card effects',
      dataset: { role: 'effects', turn: String(frame.turn) },
      'aria-label': '已发生的操作',
    },
    [
      el('header', { class: 'effects__head' }, [
        el('span', { class: 'effects__icon' }, [icon('check', 16)]),
        el('strong', { class: 'effects__title', text: '已发生的操作' }),
        el('span', { class: 'effects__turn', text: `第 ${String(frame.turn)} 轮` }),
      ]),
      el('ul', { class: 'effects__list' }, items),
    ],
  )
}
