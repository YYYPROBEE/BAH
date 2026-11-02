/**
 * 已发生操作清单。
 *
 * 用途很具体：**中断之后回答"到底已经做了什么"**。窄屏上用户点了"算了"或者切后台断了线，
 * 回来最想知道的不是"计划是什么"，而是"钱动了没有"。所以这个清单是**只读**的——
 * 一个按钮都没有（TC-MOB-27 用"零 button / 零 a"断言钉住），
 * 撤销/冲正属于 saga 补偿面，不在呈现层给一个看起来能点的入口。
 *
 * 前端不加工任何金额与手机号：帧里的文本已是后端格式化 + 脱敏的结果，
 * 这里再算一次就是第二真相源（`frames.ts:346-374` 的字段追溯注释同一条纪律）。
 */

import { clear, el } from '../dom.js'

/**
 * @param {HTMLElement} host feed 里的清单槽位
 */
export function createEffectsList(host) {
  const node = el('div', { class: 'm-effects', dataset: { role: 'effects' }, hidden: true }, [
    el('p', { class: 'm-effects__title', text: '已发生的操作' }),
  ])
  const groups = el('div', { dataset: { role: 'effects-groups' } })
  node.append(groups)
  host.append(node)

  /** turn → 帧（帧键 `effects:<turn>`，同轮新帧替换旧帧）。 */
  const byTurn = new Map()

  function renderGroup(turn, frame) {
    const items = (frame.items ?? []).map((item) =>
      el('li', { class: 'm-effects__item', dataset: { role: 'effect-item', callId: String(item.callId) } }, [
        el('span', { class: 'm-effects__name', text: item.title }),
        ...(item.amountText === undefined ? [] : [el('span', { class: 'm-effects__amount', text: item.amountText })]),
        el('span', { class: 'ds-tag', text: item.name }),
        ...(item.durationMs === undefined
          ? []
          : [el('span', { class: 'm-effects__meta', text: `${String(item.durationMs)}ms` })]),
      ]),
    )
    return el('div', { class: 'm-effects__group', dataset: { role: 'effects-group', turn: String(turn) } }, [
      el('p', { class: 'm-effects__group-label', text: `第 ${String(turn)} 轮` }),
      el('ul', { class: 'm-effects__list' }, items),
    ])
  }

  function rerender() {
    clear(groups)
    // 倒序：最新一轮在最上面（中断后第一眼要看的是"刚才那一下做了什么"）
    const turns = [...byTurn.keys()].sort((left, right) => right - left)
    for (const turn of turns) {
      const frame = byTurn.get(turn)
      if (frame === undefined) continue
      groups.append(renderGroup(turn, frame))
    }
    node.hidden = byTurn.size === 0
  }

  return {
    /**
     * 追加/替换一轮的清单。
     *
     * @param {Record<string, any>} frame `EffectsFrame`
     */
    append(frame) {
      byTurn.set(frame.turn, frame)
      rerender()
      return node
    },
    node,
    get turns() {
      return [...byTurn.keys()].sort((left, right) => right - left)
    },
    dispose() {
      byTurn.clear()
      node.remove()
    },
  }
}
