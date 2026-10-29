/**
 * IME 适配层（施工单 02 §3.6 / 00 D10 二次定稿）。
 *
 * 语音输入走**设备系统输入法的听写**：音频采集与识别都发生在操作系统 / 输入法层，
 * 网页只从 `input` 事件里拿到**文本**。因此本模块不做任何语音识别、不申请任何媒体权限、
 * 不构造任何浏览器语音 API —— 页面代码里连它们的名字都不出现（TC-MOB-18 与 C4-① 用
 * 源码字面量 grep 钉死这条；名字写进注释也算命中，所以这里刻意只描述"不做什么"）。
 *
 * 这也解释了为什么 `Permissions-Policy: microphone=()` 一寸都不用改：那条策略管的是
 * 页面上下文的媒体采集，而听写根本不进页面上下文。安全面零变化、隐私面零新增。
 *
 * 本模块只做三件事：
 * 1. 装配输入框属性（关掉自动更正/拼写检查——它们是移动端 H5 破坏金额、账号、户名的头号原因）；
 * 2. 维护**组合态**状态机（组合期间的回车是输入法选词，不是发送）；
 * 3. 渲染一行可关提示（关闭偏好只存 localStorage，不上服务端）。
 */

import { el, icon } from '../dom.js'

/** 提示关闭偏好的唯一键名。只存 localStorage，不上服务端（D10 隐私三条之③）。 */
export const HINT_STORAGE_KEY = 'bah.m.imeHintDismissed'

/** 提示文案（一行，不用 emoji；图标走 DS 本地 svg）。 */
export const HINT_TEXT = '点键盘上的麦克风图标即可说话'

/**
 * 装配一个输入框的 IME 属性。
 *
 * @param {HTMLInputElement|HTMLTextAreaElement} input
 * @param {'text'|'amount'} [kind] `amount` 另给 `inputmode="decimal"`——移动端会直接弹数字键盘。
 *
 * ⚠ 如实登记：本单生产路径只用 `kind='text'`（composer 的主输入框）与审批抽屉的拒绝理由框；
 * `'amount'` 是给 03/04 单"金额内联输入"预留的接线位，当前**只有测试覆盖**，没有生产调用点。
 * 不谎称已接线（00 §9.2 D 类探针）。
 */
export function applyImeAttributes(input, kind = 'text') {
  input.setAttribute('enterkeyhint', 'send')
  input.setAttribute('autocomplete', 'off')
  input.setAttribute('autocorrect', 'off')
  input.setAttribute('spellcheck', 'false')
  if (kind === 'amount') input.setAttribute('inputmode', 'decimal')
}

/**
 * 造 IME 适配层。
 *
 * @param {HTMLElement} host 提示条的挂载点（composer 输入区）
 * @param {object} opts
 * @param {HTMLInputElement|HTMLTextAreaElement} opts.input 待装配的主输入框
 * @param {'text'|'amount'} [opts.kind]
 * @param {{ storage?: Storage }} [opts.deps] 测试可注入假 storage
 * @returns {{ isComposing(): boolean, resetComposing(): void, hint: HTMLElement|null, dispose(): void }}
 */
export function createImeInput(host, opts) {
  const input = opts.input
  const kind = opts.kind ?? 'text'
  const storage = opts.deps?.storage ?? globalThis.localStorage
  applyImeAttributes(input, kind)

  /**
   * 组合态：**只信 `compositionstart` / `compositionend`**，不在 `input` 事件里推断。
   *
   * WHY：iOS Safari 与 Android Chrome 的 `compositionend` 与末次 `input` 先后顺序不同
   * （R2）。用 `input` 推断会在其中一种时序上把"选词已完成"误判成"还在组合"，
   * 于是回车永远发不出去；反过来则会把拼音阶段的半句话当成完整消息发出去
   * ——移动端最经典的两个假 bug，都出在"猜"上。
   */
  let composing = false

  const onStart = () => {
    composing = true
  }
  // 组合期间不发送、不校验、不解析槽位、不发任何请求（§3.6 状态机表 + C4-④）
  const onUpdate = () => {}
  const onEnd = () => {
    // 结束时**不自动发送**：用户须显式回车或点发送钮，否则选词就成了提交
    composing = false
  }

  input.addEventListener('compositionstart', onStart)
  input.addEventListener('compositionupdate', onUpdate)
  input.addEventListener('compositionend', onEnd)

  let hint = null
  let closeButton = null

  function dismissed() {
    if (storage === undefined || storage === null) return false
    try {
      return storage.getItem(HINT_STORAGE_KEY) !== null
    } catch {
      // storage 被禁用（隐私模式）时按"没关过"处理：提示多显示一次，不是事故
      return false
    }
  }

  if (!dismissed()) {
    closeButton = el('button', {
      class: 'm-ime-hint__close',
      type: 'button',
      dataset: { role: 'ime-hint-close' },
      'aria-label': '不再提示',
    }, [icon('close-small', 14)])
    hint = el('div', { class: 'm-ime-hint', dataset: { role: 'ime-hint' } }, [
      el('span', { class: 'icon icon--mic', 'aria-hidden': 'true' }),
      el('span', { class: 'm-ime-hint__text', text: HINT_TEXT }),
      closeButton,
    ])
    closeButton.addEventListener('click', () => {
      try {
        storage?.setItem(HINT_STORAGE_KEY, '1')
      } catch {
        // 写不进去也不该让按钮失灵：节点照样移除，下次进来还会再显示一次
      }
      hint?.remove()
      hint = null
    })
    host.append(hint)
  }

  return {
    isComposing: () => composing,
    /**
     * 组合态复位：`visibilitychange` 到 hidden 时必须调（§3.9）。
     *
     * WHY：切后台时浏览器不一定派发 `compositionend`，组合态就此卡住 ⇒
     * 回到前台后每一次回车都被当成"输入法选词"，发送被永久锁死。
     * 这是个只会真机复现、CI 里看不出来的死锁，所以显式复位而不是等事件。
     */
    resetComposing() {
      composing = false
    },
    /** 提示条节点（关闭后为 null）——做成 getter，否则拿到的是构造时的快照。 */
    get hint() {
      return hint
    },
    dispose() {
      input.removeEventListener('compositionstart', onStart)
      input.removeEventListener('compositionupdate', onUpdate)
      input.removeEventListener('compositionend', onEnd)
      hint?.remove()
      hint = null
    },
  }
}
