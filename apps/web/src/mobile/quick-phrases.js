/**
 * 快捷短语 chips（施工单 02 §3.6 / 00 D10 第 5 条）。
 *
 * 它是移动端演示的**主入口**，不是辅助功能：离线、确定性、不会因识别错误当场翻车，
 * 还能让 03 单的四类意图（模糊复现 / 省略槽位 / 隐含意图 / 歧义消解）在答辩现场一键复现。
 *
 * 两条纪律：
 * 1. **文案可配置**——由 shell 注入，视图层零硬编码（与"部署相关阈值不得硬编码"同源）；
 * 2. 点一颗 chip 就是**发一条普通用户消息**（`POST /api/turn`），与 D6 点选同一条路径。
 *    它**不绕过任何审批**：黄/红级操作照样出票据、照样要手势与强验证（C4-③）。
 */

import { clear, el, icon } from '../dom.js'

/**
 * 造 chips 行。
 *
 * @param {HTMLElement} host composer 输入区上方的 chips 行
 * @param {object} opts
 * @param {{ items: ReadonlyArray<{ text: string, intent?: string }> }} opts.phrases 配置来源
 * @param {(text: string) => void} opts.onPick 点击即作为一条 `user/message` 发送
 */
export function createQuickPhrases(host, opts) {
  const row = el('div', { class: 'm-chips', dataset: { role: 'quick-phrases' } })
  host.append(row)

  function render() {
    clear(row)
    for (const item of opts.phrases?.items ?? []) {
      const chip = el('button', {
        class: 'm-chip',
        type: 'button',
        dataset: { role: 'chip', intent: item.intent ?? '' },
      }, [icon('chat', 16), el('span', { text: item.text })])
      chip.addEventListener('click', () => opts.onPick(item.text))
      row.append(chip)
    }
  }

  render()

  return {
    render,
    node: row,
    dispose() {
      row.remove()
    },
  }
}
