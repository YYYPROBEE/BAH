/**
 * Web 应用入口（施工单 13 §4 步 9「Vite 打包 + 独立运行验收」）。
 *
 * 装配只做四件事：建仓库 → 连 SSE → 把帧分发给三个容器 → 接上四个动作
 * （发送 / 中断 / 审批结论 / 强验证）。**没有第五件事**：
 * - 不做业务推导（服务端的帧已经推完）；
 * - 不做输入回显（等 `user/message` 帧）；
 * - 不按 profile 名开关视图（渠道差异在服务端配置里）。
 *
 * 依赖注入（`api` / `transport`）是为了 T-WEB-008：没有桌面壳、没有真实网络时，
 * 只要换掉这两个对象，五个视图照样能挂起来。
 */

import { bootstrapPasswordGate, logout, readAuthMode } from './auth.js'
import { clear, el, icon } from './dom.js'
import { approvalDecision, createStore, pendingApproval, viewKey } from './store.js'
import { connectEvents, createHttpApi } from './transport.js'
import {
  CONVERSATION_KINDS,
  renderDraft,
  renderEmptyState,
  renderFrame,
} from './views/conversation.js'
import { createApprovalController } from './views/approval.js'
import { renderAudit, renderAuditEmpty, renderAuditSummary } from './views/audit.js'
import { renderDag, renderDagEmpty } from './views/dag.js'

/** 连接状态 → 文案与色调。 */
const STATUS = {
  connecting: { label: '连接中', cls: 'is-connecting' },
  online: { label: '已连接', cls: 'is-online' },
  offline: { label: '已断开（自动重连）', cls: 'is-offline' },
}

/**
 * 把一个容器与某一类帧同步（按视图键替换，快照替换时清掉多余的）。
 *
 * @param {HTMLElement} container
 * @param {Map<string, {node: HTMLElement, frame: unknown}>} rendered
 * @param {{kind: string}[]} frames
 * @param {(frame: unknown) => HTMLElement} factory
 */
function syncContainer(container, rendered, frames, factory) {
  const seen = new Set()
  for (const frame of frames) {
    const key = viewKey(frame)
    seen.add(key)
    const entry = rendered.get(key)
    if (entry === undefined) {
      const node = factory(frame)
      rendered.set(key, { node, frame })
      container.append(node)
      continue
    }
    if (entry.frame !== frame) {
      const node = factory(frame)
      entry.node.replaceWith(node)
      rendered.set(key, { node, frame })
    }
  }
  for (const [key, entry] of rendered) {
    if (seen.has(key)) continue
    entry.node.remove()
    rendered.delete(key)
  }
}

/**
 * 挂载。
 *
 * @param {{
 *   root: HTMLElement,
 *   api?: ReturnType<typeof createHttpApi>,
 *   transport?: typeof connectEvents,
 * }} options
 */
export function mountApp(options) {
  const root = options.root
  const api = options.api ?? createHttpApi()
  const connect = options.transport ?? connectEvents
  const store = createStore()

  const sessionLabel = el('span', { class: 'app-header__session', text: '会话 —' })
  const statusDot = el('span', { class: 'app-header__status is-connecting' }, [
    el('span', { class: 'app-header__dot' }),
    el('span', { class: 'app-header__status-text', text: STATUS.connecting.label }),
  ])

  const conversation = el('section', {
    class: 'conversation',
    id: 'conversation',
    'aria-label': '对话流',
  })
  const dagBox = el('div', { class: 'panel__section', id: 'panel-dag' })
  const auditList = el('ol', { class: 'audit__list', id: 'panel-audit' })
  const auditBox = el('div', { class: 'panel__section', id: 'panel-audit-box', hidden: true }, [auditList])
  const auditSummary = el('div', { class: 'panel__summary' })
  const overlay = el('div', { class: 'overlay-root', id: 'overlay-root' })
  const toasts = el('div', { class: 'toasts', role: 'status', 'aria-live': 'polite' })

  const tabDag = el('button', { class: 'ds-tab is-active', type: 'button', role: 'tab', 'aria-selected': 'true' }, ['调用图'])
  const tabAudit = el('button', { class: 'ds-tab', type: 'button', role: 'tab', 'aria-selected': 'false' }, ['审计'])

  const composerInput = el('textarea', {
    class: 'ds-textarea composer__input',
    rows: 1,
    placeholder: '说点什么，例如「给王建国转 800 元」（Enter 发送，Shift+Enter 换行）',
    'aria-label': '输入消息',
  })
  const sendButton = el('button', {
    class: 'ds-btn ds-btn--brand ds-btn--md composer__send',
    type: 'submit',
    'aria-label': '发送',
  }, [icon('send', 16)])
  const stopButton = el(
    'button',
    { class: 'ds-btn ds-btn--secondary ds-btn--sm', type: 'button', 'aria-label': '中断本轮' },
    [icon('stop', 14), '算了'],
  )
  const backButton = el(
    'button',
    {
      class: 'ds-btn ds-btn--ghost ds-btn--sm',
      type: 'button',
      disabled: true,
      title: '会话分叉属施工单 14（未落地）；此处显式禁用，避免假装可用',
    },
    [icon('branch', 14), '回到上一步'],
  )

  const composer = el('form', { class: 'composer', id: 'composer' }, [
    composerInput,
    el('div', { class: 'composer__actions' }, [stopButton, backButton, sendButton]),
  ])

  const panel = el('aside', { class: 'panel', 'aria-label': '运行观察' }, [
    el('div', { class: 'panel__tabs ds-tabs', role: 'tablist' }, [tabDag, tabAudit]),
    auditSummary,
    dagBox,
    auditBox,
  ])

  const banner = el('div', { class: 'app-banner', hidden: true })

  // 退出登录：只在 password 模式出现（static 模式没有"登录"这回事，多一个按钮只会误导）
  const logoutButton =
    readAuthMode() === 'password'
      ? el(
          'button',
          {
            class: 'ds-btn ds-btn--ghost ds-btn--sm',
            type: 'button',
            title: '退出登录并清除本地会话',
            onClick: () => {
              void logout()
            },
          },
          [icon('user', 14), '退出'],
        )
      : null

  const shell = el('div', { class: 'app-shell' }, [
    el('header', { class: 'app-header' }, [
      el('div', { class: 'app-header__brand' }, [
        el('span', { class: 'app-header__logo' }, [icon('ai', 20)]),
        el('div', {}, [
          el('div', { class: 'app-header__title', text: 'BAH · 银行智能体' }),
          el('div', { class: 'app-header__subtitle', text: 'Web 渠道 · 纯原生渲染 · 事件驱动' }),
        ]),
      ]),
      el('div', { class: 'app-header__meta' }, [sessionLabel, statusDot, logoutButton]),
    ]),
    banner,
    el('div', { class: 'app-body' }, [
      el('div', { class: 'app-left' }, [conversation, composer]),
      panel,
    ]),
  ])

  clear(root)
  root.append(shell, overlay, toasts)

  /** 会话 / DAG / 审计三个容器的节点缓存。 */
  const rendered = new Map()
  const dagRendered = new Map()
  const auditRendered = new Map()

  const approvals = createApprovalController(overlay, {
    async onDecision(ticketId, decision, reason) {
      const result = await api.decide(ticketId, decision, reason)
      if (!result.ok) notify(`提交失败：${result.reason}`, 'danger')
      return result
    },
    async onVerify(ticketId) {
      const result = await api.verify(ticketId)
      if (!result.ok) notify(`验证失败：${result.reason}`, 'danger')
      return result
    },
  })

  /** 顶部横幅。 */
  function setBanner(text) {
    if (text === null) {
      banner.hidden = true
      banner.replaceChildren()
      return
    }
    banner.hidden = false
    banner.replaceChildren(
      el('div', { class: 'ds-alert ds-alert--warning' }, [
        el('span', { class: 'ds-alert__icon' }, [icon('error', 16)]),
        el('div', {}, [
          el('div', { class: 'ds-alert__title', text: '连接异常' }),
          el('p', { class: 'ds-alert__desc', text }),
        ]),
      ]),
    )
  }

  /** 轻提示。 */
  function notify(message, level = 'info') {
    const node = el('div', { class: `toast toast--${level}`, text: message })
    toasts.append(node)
    setTimeout(() => node.remove(), 4000)
  }

  /** 全量同步（幂等；每帧都可能触发一次）。 */
  function sync(state) {
    // ① 对话流
    const conversationFrames = state.frames.filter((frame) => CONVERSATION_KINDS.has(frame.kind))
    syncContainer(conversation, rendered, conversationFrames, renderFrame)

    // 草稿气泡
    const draft = conversation.querySelector('[data-draft="true"]')
    if (state.streamText.length === 0) draft?.remove()
    else if (draft === null) conversation.append(renderDraft(state.streamText))
    else draft.querySelector('.bubble__text').textContent = state.streamText

    const empty = conversation.querySelector('.conversation__empty')
    if (conversationFrames.length === 0 && state.streamText.length === 0) {
      if (empty === null) conversation.append(renderEmptyState())
    } else empty?.remove()

    // ② DAG（只画最近一轮）
    const dags = state.frames.filter((frame) => frame.kind === 'dag')
    const latestDag = dags[dags.length - 1]
    if (latestDag === undefined) {
      if (dagBox.firstChild === null) dagBox.append(renderDagEmpty())
    } else {
      syncContainer(dagBox, dagRendered, [latestDag], renderDag)
      dagBox.querySelector('.ds-empty')?.remove()
    }

    // ③ 审计（升序，保持因果阅读顺序）
    const audits = state.frames.filter((frame) => frame.kind === 'audit')
    auditSummary.replaceChildren(renderAuditSummary(state.frames))
    if (audits.length === 0) {
      if (auditList.firstChild === null) auditList.append(renderAuditEmpty())
    } else {
      syncContainer(auditList, auditRendered, audits, renderAudit)
      auditList.querySelector('.ds-empty')?.remove()
      auditList.lastElementChild?.scrollIntoView?.({ block: 'nearest' })
    }

    // ④ 审批：先收尾，再开新
    for (const frame of state.frames) {
      if (frame.kind === 'approval-closed') approvals.close(frame)
    }
    const pending = pendingApproval(state.frames)
    if (pending !== null) approvals.show(pending)

    // ⑤ 状态
    const status = STATUS[state.status] ?? STATUS.connecting
    statusDot.className = `app-header__status ${status.cls}`
    statusDot.querySelector('.app-header__status-text').textContent = status.label
    setBanner(state.fault === null ? null : state.fault.reason)
  }

  store.subscribe(sync)

  // 发送
  composer.addEventListener('submit', async (event) => {
    event.preventDefault()
    const text = composerInput.value.trim()
    if (text.length === 0) return
    sendButton.disabled = true
    const result = await api.turn(text)
    sendButton.disabled = false
    if (!result.ok) {
      notify(result.reason, 'danger')
      return
    }
    composerInput.value = ''
    composerInput.style.height = ''
  })

  composerInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      composer.requestSubmit()
    }
  })

  composerInput.addEventListener('input', () => {
    composerInput.style.height = 'auto'
    composerInput.style.height = `${String(Math.min(composerInput.scrollHeight, 160))}px`
  })

  stopButton.addEventListener('click', async () => {
    const result = await api.interrupt('用户点击"算了"')
    if (!result.ok) {
      notify(result.reason, 'danger')
      return
    }
    // 服务端 `POST /api/interrupt` 一律回 `{ok:true}`（空闲时是幂等空操作），
    // 所以这里只说"已提交"，不假装"打断了一轮"——按钮点下去什么都不发生是最坏的一种"看起来能用"。
    notify('中断请求已提交', 'info')
  })

  // 标签页
  function selectTab(which) {
    const dag = which === 'dag'
    tabDag.classList.toggle('is-active', dag)
    tabAudit.classList.toggle('is-active', !dag)
    tabDag.setAttribute('aria-selected', String(dag))
    tabAudit.setAttribute('aria-selected', String(!dag))
    dagBox.hidden = !dag
    auditBox.hidden = dag
  }
  tabDag.addEventListener('click', () => selectTab('dag'))
  tabAudit.addEventListener('click', () => selectTab('audit'))

  // 会话信息（失败不阻断：界面仍可从 SSE 取数）
  void api.session().then((result) => {
    if (result.ok) sessionLabel.textContent = `会话 ${String(result.data.sessionId)}`
  })

  const connection = connect({
    since: 0,
    onFrame: (frame) => store.apply(frame),
    onFault: (fault) => store.setFault(fault),
    onStatus: (status) => {
      store.setStatus(status)
      if (status === 'online') store.setFault(null)
    },
  })

  sync(store.state())

  return { store, api, close: () => connection.close() }
}

/**
 * 自动挂载（浏览器里 `#app` 存在时；测试导入不会触发）。
 *
 * 认证模式由服务端注入的 meta 决定（TA-28/TA-31）：
 * - `password`：先 `GET /api/auth/me`，401 渲染登录卡片，200 才挂主界面；
 * - 其它 / 没有 meta：**同步挂载**，与改动前逐字一致（web 用例与截图靠它）。
 */
const root = document.querySelector('#app')
if (root instanceof HTMLElement) {
  if (readAuthMode() === 'password') {
    void bootstrapPasswordGate({ root, mount: () => mountApp({ root }) })
  } else {
    mountApp({ root })
  }
}

/** 供测试与调试使用。 */
export { approvalDecision }
