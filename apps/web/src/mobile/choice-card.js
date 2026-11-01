/**
 * 选择题卡片。
 *
 * D6 的语义边界必须钉死在这里：**追问不走审批通道**。本卡片不认票据、不认 responder，
 * 点一个候选就是把**选项文本**当普通用户消息发 `POST /api/turn`——与手打一句话完全同一条路径。
 * 所以 `ChoiceFrame` 刻意不含 `ticketId`（`frames.ts:259-277` 的注释同一条理由）：
 * 有票据就会被误当成审批，而"我把追问当审批放行了"是银行语境里最难解释的一类事故。
 *
 * "手动输入"是**出口不是选项**：点它不发消息，只把焦点交给 composer 输入框。
 * 少了这个出口，用户遇到三个候选都不对时就被卡死了（00 D6 明文要求必含）。
 */

import { clear, el, icon } from '../dom.js'

/**
 * @param {HTMLElement} host feed 里的选择题槽位
 * @param {object} deps
 * @param {(text: string) => Promise<{ok: boolean, code: string, message: string}>} deps.submit
 *        shell 归一化后的 `POST /api/turn`（结构化错误对象，§3.0）
 * @param {(text: string) => HTMLElement} deps.echo 本地回显一条待定的用户消息（返回节点，去重由 shell 负责）
 * @param {() => void} deps.focusComposer "手动输入"出口
 */
export function createChoiceCard(host, deps) {
  const node = el('div', { dataset: { role: 'choice-slot' } })
  host.append(node)

  /** 当前帧（同帧重复 show 幂等；SSE 重连补发时不重置用户的点选结果）。 */
  let currentFrame = null
  let inFlight = false
  let picked = false

  function renderPicked(frame, label) {
    picked = true
    clear(node)
    node.append(
      el('div', { class: 'm-choice', dataset: { role: 'choice', callId: frame.callId, state: 'picked' } }, [
        el('p', { class: 'm-choice__prompt', text: frame.prompt }),
        el('p', { class: 'ds-tag ds-tag--success', text: `已选择：${label}` }),
      ]),
    )
  }

  /**
   * 呈现一张选择题帧。
   *
   * @param {Record<string, any>} frame `ChoiceFrame`
   */
  function show(frame) {
    if (currentFrame === frame) return node
    currentFrame = frame
    inFlight = false
    picked = false
    clear(node)

    const errorText = el('span', { class: 'm-choice-error__text', dataset: { role: 'choice-error-text' } })
    const retryButton = el('button', {
      class: 'm-choice-retry',
      type: 'button',
      'aria-label': '重试发送',
      title: '重试发送',
      dataset: { role: 'choice-retry' },
      hidden: true,
    }, [icon('refresh', 14)])
    const errorNode = el('div', { class: 'm-choice-error', role: 'alert', dataset: { role: 'choice-error' }, hidden: true }, [
      errorText,
      retryButton,
    ])
    /** 最近一次失败可重发的选项文本（重试只重发这一条，不猜别的）。 */
    let failedLabel = null
    retryButton.addEventListener('click', () => {
      if (failedLabel === null) return
      errorNode.hidden = true
      retryButton.hidden = true
      void pick(failedLabel)
    })
    const options = (frame.options ?? []).slice(0, 3)
    const buttons = []

    const freeButton = el('button', {
      class: 'm-choice-option m-choice-option--free',
      type: 'button',
      dataset: { role: 'choice-free' },
    }, [icon('doc', 16), el('span', { class: 'm-choice-option__text' }, [el('span', { text: '手动输入' })])])
    freeButton.addEventListener('click', () => {
      // 出口：零请求，只交焦点（TC-MOB-26）
      deps.focusComposer()
    })

    for (const option of options) {
      const button = el('button', {
        class: 'm-choice-option',
        type: 'button',
        dataset: { role: 'choice-option', optionId: String(option.id) },
      }, [
        icon('right', 16),
        el('span', { class: 'm-choice-option__text' }, [
          el('span', { text: option.label }),
          ...(option.hint === undefined ? [] : [el('span', { class: 'm-choice-option__hint', text: option.hint })]),
        ]),
      ])
      button.addEventListener('click', () => void pick(option.label))
      buttons.push(button)
    }
    buttons.push(freeButton)

    async function pick(label) {
      if (inFlight) return
      inFlight = true
      errorNode.hidden = true
      retryButton.hidden = true
      // 防双击：点一下立刻全部禁用（窄屏上双击比桌面常见得多）
      for (const button of buttons) button.disabled = true
      deps.echo(label)
      const result = await deps.submit(label)
      if (result?.ok === true) {
        failedLabel = null
        renderPicked(frame, label)
        return
      }
      // 失败：恢复可点 + inline 错误（不静默吞错，§3.0）；同一条可一键重发
      inFlight = false
      failedLabel = label
      for (const button of buttons) button.disabled = false
      errorNode.hidden = false
      errorText.textContent = `发送失败：${String(result?.message ?? result?.code ?? 'unknown')}`
      retryButton.hidden = false
    }

    node.append(
      el('div', { class: 'm-choice', dataset: { role: 'choice', callId: frame.callId, state: 'open' } }, [
        el('p', { class: 'm-choice__prompt', text: frame.prompt }),
        el('div', { class: 'm-choice__options', dataset: { role: 'choice-options' } }, buttons),
        errorNode,
      ]),
    )
    return node
  }

  return {
    show,
    node,
    get frame() {
      return currentFrame
    },
    /** 仍在等用户点选（已选或未出题都为 false）——shell 据此把选项卡滚进视口。 */
    get open() {
      return currentFrame !== null && !picked
    },
    dispose() {
      currentFrame = null
      picked = false
      node.remove()
    },
  }
}
