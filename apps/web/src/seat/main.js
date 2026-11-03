/**
 * 坐席工作台入口装配（B2/B5）。
 *
 * 只做四件事：凭证闸 → 读摘要/队列 → 连 SSE → 挂四个视图。
 * 业务事实全部来自服务端（摘要、心跳、帧），前端不推导接管状态。
 *
 * 依赖注入（`gate` / `createApi` / `connect`）是为了 `main.test.js`：
 * 没有浏览器存储与真实网络时，三条路径（无凭证 / idle / serving）照样能跑。
 */

import { BRAND } from '../brand.js'
import { clear, el, icon } from '../dom.js'
import { createStore } from '../store.js'
import { connectEvents } from '../transport.js'
import { createSeatApi } from './api.js'
import { gate as browserGate } from './gate.js'
import { createComposerView } from './views/composer.js'
import { createQueueView } from './views/queue.js'
import { createStatusView } from './views/status.js'
import { createThreadView } from './views/thread.js'

/** 心跳间隔（服务端权威的 waitedMs / overdue 靠它刷新）。 */
export const HEARTBEAT_MS = 15_000

/**
 * 挂载坐席台。
 *
 * @param {{
 *   root: HTMLElement,
 *   gate?: ReturnType<typeof browserGate>,
 *   createApi?: (config: { token: string }) => any,
 *   connect?: typeof connectEvents,
 *   confirmResume?: (message: string) => boolean,
 * }} options
 */
export function mountSeat(options) {
  const root = options.root
  const gate = options.gate ?? browserGate
  const createApi = options.createApi ?? ((config) => createSeatApi(config))
  const connect = options.connect ?? connectEvents

  const store = createStore()
  const toasts = el('div', { class: 'toasts', role: 'status', 'aria-live': 'polite' })

  let api = null
  let connection = null
  let heartbeatTimer
  let token = ''
  let summary = null
  let queue = null
  let heartbeat = null
  let status = 'connecting'

  /** 轻提示（与客户页同一套 `.toast`）。 */
  function notify(message, level = 'info') {
    const node = el('div', { class: `toast toast--${level}`, text: message })
    toasts.append(node)
    setTimeout(() => node.remove(), 4000)
  }

  async function onClaim() {
    if (api === null) return
    const result = await api.claim()
    if (handleAuth(result)) return
    if (!result.ok) {
      notify(`认领失败：${String(result.code)}`, 'danger')
      return
    }
    summary = result.data
    render()
  }

  async function onSend(text) {
    if (api === null) return { ok: false, code: 'no-session' }
    const result = await api.say(text)
    if (handleAuth(result)) return result
    // 不乐观渲染：成功与否都等 SSE 推 handoff/operator-message
    if (result.ok) void refreshSummary()
    return result
  }

  async function onResume(handover) {
    if (api === null) return { ok: false, code: 'no-session' }
    const result = await api.resume(handover)
    if (handleAuth(result)) return result
    if (result.ok) {
      summary = result.data
      void refreshQueue()
      render()
    }
    return result
  }

  const statusView = createStatusView()
  const queueView = createQueueView({ onClaim })
  const threadView = createThreadView()
  const composerView = createComposerView({
    onSend,
    onResume,
    notify,
    ...(options.confirmResume === undefined ? {} : { confirmResume: options.confirmResume }),
  })

  const gateOverlay = el('div', { class: 'seat-gate', id: 'seat-gate' })
  const shell = el('div', { class: 'seat-shell', hidden: true }, [
    statusView.node,
    el('div', { class: 'seat-body' }, [queueView.node, threadView.node]),
    composerView.node,
  ])

  clear(root)
  root.append(shell, gateOverlay, toasts)

  /** 把当前服务端状态与帧交给四个视图。 */
  function render() {
    const state = store.state()
    statusView.update({ sessionId: summary?.sessionId, status })
    queueView.update({ summary, heartbeat, queue })
    threadView.update({ frames: state.frames, handoff: state.handoff })
    composerView.update({ summary, heartbeat })
  }

  store.subscribe(render)

  /** 凭证无效 / 轮换：清 token、关连接、回输入框。 */
  function handleAuth(result) {
    if (result.status !== 401) return false
    stopSession()
    showGate('凭证无效或已轮换')
    return true
  }

  /** 停掉一条已建立的会话（不清摘要本身，切回 gate 时由 showGate 处理）。 */
  function stopSession() {
    if (connection !== null) {
      connection.close()
      connection = null
    }
    if (heartbeatTimer !== undefined) {
      clearInterval(heartbeatTimer)
      heartbeatTimer = undefined
    }
    token = ''
    api = null
    summary = null
    queue = null
    heartbeat = null
    status = 'connecting'
    store.reset()
    render()
  }

  /** 无 token / token 失效时的输入闸。 */
  function showGate(message) {
    shell.hidden = true
    gateOverlay.hidden = false
    const input = el('input', {
      class: 'ds-input seat-gate__input',
      type: 'password',
      placeholder: '粘贴坐席凭证',
      autocomplete: 'off',
      'aria-label': '坐席凭证',
    })
    const error = message === undefined || message === '' ? null : el('p', { class: 'seat-gate__error', text: message })
    const button = el('button', { class: 'ds-btn ds-btn--brand ds-btn--md', type: 'submit' }, [icon('login', 16), '进入工作台'])
    const form = el('form', { class: 'seat-gate__form' }, [input, button])
    form.addEventListener('submit', async (event) => {
      event.preventDefault()
      const value = input.value.trim()
      if (value === '') return
      button.disabled = true
      const persisted = gate.saveToken(value)
      await useToken(value)
      button.disabled = false
      if (!persisted) notify('当前浏览器无法记住凭证，刷新后需重输', 'warning')
    })
    gateOverlay.replaceChildren(
      el('div', { class: 'seat-gate__card' }, [
        el('div', { class: 'seat-gate__brand' }, [icon('bank', 24), BRAND.seat]),
        el('p', {
          class: 'seat-gate__desc',
          text: '粘贴 BAH_OPERATOR_TOKEN。凭证只存在本标签页（sessionStorage），关闭标签即失效。',
        }),
        ...(error === null ? [] : [error]),
        form,
      ]),
    )
    input.focus?.()
  }

  /** 用一枚 token 建 API → 探活 → 进工作台。 */
  async function useToken(value) {
    token = value
    api = createApi({ token: value })
    const probe = await api.handoff()
    if (!probe.ok) {
      if (probe.status === 401) {
        gate.clearToken()
        api = null
        token = ''
        showGate('凭证无效或已轮换')
        return
      }
      api = null
      token = ''
      showGate(`无法连接：${String(probe.reason ?? probe.code)}`)
      return
    }
    summary = probe.data
    gateOverlay.hidden = true
    shell.hidden = false
    connectSession()
    await Promise.all([refreshQueue(), beat()])
    startHeartbeat()
    render()
  }

  /** 建立 SSE（`since=0` 拿全量快照，与客户页同一套 transport）。 */
  function connectSession() {
    if (connection !== null || api === null) return
    connection = connect({
      since: 0,
      token,
      onFrame: (frame) => {
        store.apply(frame)
        if (frame.kind === 'handoff') {
          void refreshSummary()
          void refreshQueue()
        }
      },
      onFault: () => {
        status = 'offline'
        render()
      },
      onStatus: (next) => {
        status = next
        render()
      },
    })
  }

  async function refreshSummary() {
    if (api === null) return
    const result = await api.handoff()
    if (handleAuth(result)) return
    if (result.ok) {
      summary = result.data
      render()
    }
  }

  async function refreshQueue() {
    if (api === null) return
    const result = await api.queue()
    if (handleAuth(result)) return
    if (result.ok) {
      queue = result.data
      render()
    }
  }

  async function beat() {
    if (api === null) return
    const result = await api.heartbeat()
    if (handleAuth(result)) return
    if (result.ok) {
      heartbeat = result.data
      render()
    }
  }

  function startHeartbeat() {
    if (heartbeatTimer !== undefined) return
    heartbeatTimer = setInterval(() => {
      void beat()
    }, HEARTBEAT_MS)
  }

  // 后台标签页不跑心跳、不断线；回到前台再连（避免"后台把 overdue 刷花"）。
  document.addEventListener('visibilitychange', () => {
    if (api === null) return
    if (document.hidden) {
      if (connection !== null) {
        connection.close()
        connection = null
      }
      if (heartbeatTimer !== undefined) {
        clearInterval(heartbeatTimer)
        heartbeatTimer = undefined
      }
      return
    }
    connectSession()
    void refreshSummary()
    void refreshQueue()
    startHeartbeat()
  })

  // 启动：有 token 就直接探活，没有就显示输入框（服务端**不注入**，首次必然如此）。
  const saved = gate.readToken()
  if (saved === '') {
    showGate('')
  } else {
    void useToken(saved)
  }

  render()

  return {
    store,
    summary: () => summary,
    destroy: () => {
      stopSession()
      root.replaceChildren()
    },
  }
}

/** 自动挂载（浏览器里 `#seat` 存在时；测试导入不会触发）。 */
const root = typeof document === 'undefined' ? null : document.querySelector('#seat')
if (root instanceof HTMLElement) {
  mountSeat({ root })
}
