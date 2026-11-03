/**
 * 输入区。
 *
 * 组合关系：chips 行（quick-phrases）+ IME 提示条与属性装配（ime-input）+ 主输入框 +
 * 发送 / 中断 + 错误行。四个子件都是本目录内的模块，共享层（transport/store/dom）只 import。
 *
 * 两条硬纪律：
 * 1. **Enter 发送前必须先问 IME 组合态**——组合中的回车是输入法选词，不是发送。
 *    这是移动端 H5 最经典的假 bug：中文用户按回车选字，半句拼音就被当成消息发出去了。
 *    标准 `event.isComposing` 与 Safari/旧内核的 `keyCode === 229` 都算组合中（桌面壳同款判据），
 *    再叠一层 `ime.isComposing()`——因为 `visibilitychange` 之后浏览器可能不再派发
 *    `compositionend`，此时 `event.isComposing` 会一直为真而我们的状态机已被显式复位。
 * 2. **状态必须可见**：接管期 202（只落账不驱动）与 429（限流）各有专属文案，
 *    不静默吞错、不弹 alert——"发送成功但其实没人处理"是移动端最坏的假成功。
 */

import { el, icon } from '../dom.js'
import { createImeInput } from './ime-input.js'
import { createQuickPhrases } from './quick-phrases.js'

/** 输入框自增高上限（约 5 行 × 20px 行高；与 mobile.css 的 max-height 同值）。 */
export const MAX_INPUT_HEIGHT_PX = 100

/**
 * 同一句话的防重窗口（ms）。
 *
 * `inFlight` 只覆盖一次 HTTP 往返：离线 router 的 202 在几十毫秒内就回来，
 * 连点 chips 的第二次点击已经不受它保护。这个窗口专门吸收"手抖双击"，
 * 不阻止用户在上一轮结束后正常再发一句同样的话。
 */
export const DUPLICATE_WINDOW_MS = 600

/**
 * @param {HTMLElement} host `layout.regions.dock`
 * @param {object} deps
 * @param {(text: string) => Promise<{ok: boolean, code: string, message: string, retryAfterSeconds?: number}>} deps.submit
 *        shell 归一化后的 `POST /api/turn`
 * @param {(reason: string) => Promise<{ok: boolean, code: string, message: string}>} deps.interrupt
 * @param {{ items: ReadonlyArray<{ text: string, intent?: string }> }} [deps.phrases]
 *        chips 配置（**由 shell 注入**，视图层零硬编码文案）；缺省不渲染 chips 行
 * @param {{ storage?: Storage }} [deps.imeDeps] 测试注入假 storage
 * @param {() => void} [deps.onOpenServices] 打开“服务与帮助”抽屉；缺省不渲染入口
 * @param {(info: { code: string, message: string }) => void} [deps.onError]
 * @param {(text: string) => void} [deps.echo] 发送前的本地回显（与其余四条发送入口同一份实现）
 * @param {() => void} [deps.onReload] 凭证失效时的"重新加载页面"动作
 */
export function createComposer(host, deps) {
  const chipsRow = el('div', { dataset: { role: 'chips-row' } })
  const hintRow = el('div', { dataset: { role: 'ime-row' } })
  const errorText = el('span', {
    class: 'm-composer__error-text',
    dataset: { role: 'composer-error-text' },
  })
  const retryButton = el('button', {
    class: 'm-composer__retry',
    type: 'button',
    'aria-label': '重试发送',
    title: '重试发送',
    dataset: { role: 'composer-retry' },
    hidden: true,
  }, [icon('refresh', 14)])
  const errorNode = el('div', {
    class: 'm-composer__error',
    role: 'alert',
    dataset: { role: 'composer-error' },
    hidden: true,
  }, [errorText, retryButton])

  const input = el('textarea', {
    class: 'ds-textarea m-composer__input',
    rows: 1,
    dataset: { role: 'composer-input' },
    placeholder: '在这里输入消息',
    'aria-label': '输入消息',
  })
  const servicesButton = el('button', {
    class: 'ds-btn ds-btn--secondary ds-btn--md m-composer__services',
    type: 'button',
    dataset: { role: 'services' },
    'aria-label': '服务与帮助',
    title: '服务与帮助',
    hidden: deps.onOpenServices === undefined,
  }, [icon('menu', 24)])
  const sendButton = el('button', {
    class: 'ds-btn ds-btn--primary ds-btn--lg m-composer__send',
    type: 'button',
    dataset: { role: 'send' },
    'aria-label': '发送',
  }, [icon('send', 24)])
  const stopButton = el('button', {
    class: 'ds-btn ds-btn--secondary ds-btn--md m-composer__stop',
    type: 'button',
    dataset: { role: 'interrupt' },
    'aria-label': '中断本轮',
    hidden: true,
  }, [icon('stop', 24)])

  const row = el('div', { class: 'm-composer__row' }, [
    input,
    el('div', { class: 'm-composer__actions' }, [servicesButton, stopButton, sendButton]),
  ])
  const node = el('div', { class: 'm-composer', dataset: { role: 'composer' } }, [
    chipsRow,
    hintRow,
    row,
    errorNode,
  ])
  // 跳过链接的落点（M-13）：Tab 顺序不必先穿过头部与全部快捷入口。
  input.id = 'm-composer-input'
  host.append(node)

  const ime = createImeInput(hintRow, { input, deps: deps.imeDeps })
  const quickPhrases =
    deps.phrases === undefined ? null : createQuickPhrases(chipsRow, { phrases: deps.phrases, onPick: (text) => void send(text) })

  let inFlight = false
  let blockTimer = null
  let running = false
  /** 上一次失败、可原样重发的文本；成功后清空。 */
  let lastFailedText = null
  /** 防重窗口：同一句话在窗口内只发一次。 */
  let lastSentText = null
  let lastSentAt = 0
  /** 错误行的重试钮当前是"重发"还是"重新加载页面"。 */
  let reloadMode = false

  function setRetryLabel(label) {
    retryButton.setAttribute('aria-label', label)
    retryButton.title = label
  }

  /** 发送钮的唯一使能判据：请求在飞或本轮未收口都按"不可用"呈现，别让点了没反应。 */
  function syncSendEnabled() {
    sendButton.disabled = inFlight || running
  }

  /**
   * @param {string} message
   * @param {boolean} [info] 中性提示（不标红）
   * @param {string} [retryText] 传了才出现重试钮：错误必须可恢复，不能只让用户重打
   */
  function showError(message, info = false, retryText) {
    reloadMode = false
    setRetryLabel('重试发送')
    lastFailedText = retryText ?? null
    errorNode.hidden = false
    errorText.textContent = message
    errorNode.classList.toggle('m-composer__error--info', info)
    retryButton.hidden = retryText === undefined
  }

  /**
   * 凭证失效：错误行的动作从"重发这句"换成"重新加载页面"。
   *
   * 不弹 `window.confirm`：移动 WebView 会把它变成系统框；这里复用同一个可点位置。
   */
  function showReloadPrompt(message) {
    reloadMode = true
    lastFailedText = null
    errorNode.hidden = false
    errorText.textContent = message
    errorNode.classList.remove('m-composer__error--info')
    retryButton.hidden = false
    setRetryLabel('重新加载页面')
  }

  function clearError() {
    reloadMode = false
    setRetryLabel('重试发送')
    lastFailedText = null
    errorNode.hidden = true
    errorText.textContent = ''
    retryButton.hidden = true
  }

  function autoGrow() {
    // 自增高：先归零再量 scrollHeight，否则只会越长越高（桌面壳同一手法）
    input.style.height = 'auto'
    input.style.height = `${String(Math.min(input.scrollHeight, MAX_INPUT_HEIGHT_PX))}px`
  }

  /**
   * 429：只禁发送钮并倒计时，不锁页（用户还能继续打字、还能看 feed）。
   *
   * @param {number} seconds 秒。HTTP `retry-after` 与界面文案（"请 N 秒后再试"）都以秒为单位，
   *        转成毫秒再除回来只是噪音（方案文档写的 `ms` 已按此登记偏差）。
   */
  function setSendBlocked(seconds) {
    const remain = Math.max(0, Math.ceil(Number(seconds)))
    if (blockTimer !== null) clearInterval(blockTimer)
    blockTimer = null
    if (remain <= 0) {
      // 没有可信的 retry-after 就不要编一个倒计时：说"稍后再试"，按钮保持可用
      showError('操作太频繁，请稍后再试。')
      return
    }
    let left = remain
    sendButton.disabled = true
    const text = () => `操作太频繁，请 ${String(left)} 秒后再试。`
    showError(text())
    blockTimer = setInterval(() => {
      left -= 1
      if (left > 0) {
        showError(text())
        return
      }
      clearInterval(blockTimer)
      blockTimer = null
      syncSendEnabled()
      clearError()
    }, 1000)
  }

  async function send(rawText) {
    const text = (rawText ?? input.value).trim()
    // 本轮未收口时不再接受第二次发送：chips 连点的主因是 `inFlight` 只盖住 HTTP 往返。
    if (text.length === 0 || inFlight || running) return
    // 手抖双击：同一句话在 600ms 内只发一次（上一轮结束后再发同一句仍允许）。
    const now = Date.now()
    if (text === lastSentText && now - lastSentAt < DUPLICATE_WINDOW_MS) return
    // 组合态里不发送（纪律 1）；chips 走的是显式点击，不受这条限制
    if (rawText === undefined && ime.isComposing()) return
    inFlight = true
    syncSendEnabled()
    clearError()
    lastSentText = text
    lastSentAt = now
    // 本地回显必须发生在请求之前：慢网下用户要先看见"我说过这句话"，
    // 失败时 `submitTurn` 会把同一节点标成"发送失败 + 重试发送"。
    deps.echo?.(text)
    const result = await deps.submit(text)
    inFlight = false
    if (result?.ok === true) {
      if (rawText === undefined) {
        input.value = ''
        autoGrow()
      }
      syncSendEnabled()
      // 接管期消息只落账、不驱动模型（服务端 202 accepted=queued-for-operator）：
      // 不说这一句，用户会以为智能体没理他（P1-2 的"可见落点"）。
      if (result.accepted === 'queued-for-operator') {
        showError('消息已记录：人工接管期间不会驱动智能体，坐席处理后会回应。', true)
      }
      return
    }
    syncSendEnabled()
    // 失败后解除防重窗口：错误行与气泡上的"重试发送"必须能立刻再发同一条。
    lastSentText = null
    const code = String(result?.code ?? 'submit-failed')
    if (code === 'turn-rate-limited') {
      // 不传 message：让倒计时用自己那套"请 N 秒后再试"，服务端的 reason 只是"太频繁"
      setSendBlocked(Number(result?.retryAfterSeconds ?? 0))
      deps.onError?.({ code, message: String(result?.message ?? code) })
      return
    }
    const message = String(result?.message ?? code)
    showError(message, false, text)
    deps.onError?.({ code, message })
  }

  sendButton.addEventListener('click', () => void send())
  servicesButton.addEventListener('click', () => deps.onOpenServices?.())
  // 重试 = 原样再发同一条。输入框里还是这句话时先清空，避免成功后留下"已发出"的假草稿。
  retryButton.addEventListener('click', () => {
    if (reloadMode) {
      deps.onReload?.()
      return
    }
    const text = lastFailedText
    if (text === null) return
    if (input.value.trim() === text) {
      input.value = ''
      autoGrow()
    }
    void send(text)
  })

  stopButton.addEventListener('click', () => {
    void deps.interrupt('用户点击"算了"').then((result) => {
      if (result?.ok !== true) {
        showError(String(result?.message ?? 'interrupt-failed'))
        return
      }
      // 服务端一律回 ok（空闲时是幂等空操作），所以只说"已提交"，不假装"打断了一轮"
      showError('中断请求已提交', true)
    })
  })

  input.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' || event.shiftKey) return
    if (event.isComposing || event.keyCode === 229 || ime.isComposing()) return
    event.preventDefault()
    void send()
  })
  input.addEventListener('input', autoGrow)

  return {
    node,
    input,
    ime,
    quickPhrases,
    send: (text) => send(text),
    setValue(text) {
      input.value = text
      autoGrow()
    },
    focusInput() {
      input.focus()
    },
    setSendBlocked,
    /** 中断钮只在"确有一轮在跑"时可见：常驻一个按不动的按钮是最坏的一种"看起来能用"。 */
    setRunning(next) {
      running = next === true
      stopButton.hidden = !running
      syncSendEnabled()
    },
    get isRunning() {
      return running
    },
    showError,
    showReloadPrompt,
    clearError,
    dispose() {
      if (blockTimer !== null) clearInterval(blockTimer)
      ime.dispose()
      quickPhrases?.dispose()
      node.remove()
    },
  }
}
