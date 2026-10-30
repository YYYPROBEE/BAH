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
import { createObservability } from './observability.js'
import { formatWaited } from './format.js'
import { approvalDecision, createStore, pendingApproval, viewKey } from './store.js'
import { connectEvents, createHttpApi, createSessionControlClient } from './transport.js'
import {
  CONVERSATION_KINDS,
  renderDraft,
  renderEmptyState,
  renderFrame,
} from './views/conversation.js'
import { createApprovalController } from './views/approval.js'
import { renderAudit, renderAuditEmpty, renderAuditSummary } from './views/audit.js'
import { renderDag, renderDagEmpty } from './views/dag.js'
import { renderObserve } from './views/observe.js'

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
 *   control?: ReturnType<typeof createSessionControlClient>,
 * }} options
 */
export function mountApp(options) {
  const root = options.root
  const api = options.api ?? createHttpApi()
  const connect = options.transport ?? connectEvents
  // 会话控制端点（04 单）：桌面壳此前从不调用 `handoff()`，服务端能力在、界面没有入口。
  // 显式可注入是为了用例不碰真实网络（与 api / transport 同一套依赖注入）。
  const control = options.control ?? createSessionControlClient()
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
  const dagBox = el('div', {
    class: 'panel__section',
    id: 'panel-dag',
    role: 'tabpanel',
    'aria-labelledby': 'tab-dag',
  })
  const auditSummary = el('div', { class: 'panel__summary' })
  const auditList = el('ol', { class: 'audit__list', id: 'panel-audit' })
  const auditBox = el('div', {
    class: 'panel__section panel__section--audit',
    id: 'panel-audit-box',
    role: 'tabpanel',
    'aria-labelledby': 'tab-audit',
    hidden: true,
  }, [auditSummary, auditList])
  const overlay = el('div', { class: 'overlay-root', id: 'overlay-root' })
  const toasts = el('div', { class: 'toasts', role: 'status', 'aria-live': 'polite' })
  const obsBox = el('div', {
    class: 'panel__section',
    id: 'panel-observe',
    role: 'tabpanel',
    'aria-labelledby': 'tab-observe',
    hidden: true,
  })

  const tabDag = el('button', {
    class: 'ds-tab is-active',
    type: 'button',
    role: 'tab',
    id: 'tab-dag',
    'aria-selected': 'true',
    'aria-controls': 'panel-dag',
    tabindex: '0',
  }, ['调用图'])
  const tabAudit = el('button', {
    class: 'ds-tab',
    type: 'button',
    role: 'tab',
    id: 'tab-audit',
    'aria-selected': 'false',
    'aria-controls': 'panel-audit-box',
    tabindex: '-1',
  }, ['审计'])
  const tabObserve = el('button', {
    class: 'ds-tab',
    type: 'button',
    role: 'tab',
    id: 'tab-observe',
    'aria-selected': 'false',
    'aria-controls': 'panel-observe',
    tabindex: '-1',
  }, ['观测'])
  const tabsBar = el('div', { class: 'panel__tabs ds-tabs', role: 'tablist' }, [tabDag, tabAudit, tabObserve])

  const composerInput = el('textarea', {
    class: 'ds-textarea composer__input',
    rows: 1,
    placeholder: '说点什么，例如「给王建国转 800 元」（Enter 发送，Shift+Enter 换行）',
    'aria-label': '输入消息',
  })
  /** 接管期间换成"消息会转给坐席"；交回后恢复。 */
  const COMPOSER_PLACEHOLDER = composerInput.placeholder
  const HANDOFF_PLACEHOLDER = '坐席正在处理，你的消息会转给坐席'
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
  // 转人工：服务端 `POST /api/handoff` 一直是通的，桌面壳此前没有任何入口，
  // 于是"客户请求人工"这一幕只能在移动壳演。失败要给 toast，禁用态由接管帧决定。
  const handoffButton = el(
    'button',
    {
      class: 'ds-btn ds-btn--ghost ds-btn--sm',
      type: 'button',
      title: '请求人工坐席接管',
    },
    [icon('agent', 14), '转人工'],
  )

  const composer = el('form', { class: 'composer', id: 'composer' }, [
    composerInput,
    el('div', { class: 'composer__actions' }, [stopButton, handoffButton, backButton, sendButton]),
  ])

  const panel = el('aside', { class: 'panel', 'aria-label': '运行观察' }, [
    tabsBar,
    dagBox,
    auditBox,
    obsBox,
  ])

  const banner = el('div', { class: 'app-banner', hidden: true })
  // D13：接管横幅是**另一个节点**，不复用 setBanner（后者写死了"连接异常"）。
  const handoffBanner = el('div', { class: 'app-banner', id: 'handoff-banner', hidden: true })

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
    handoffBanner,
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

  /** 接管横幅的计时器与一次性"已交回"提示。 */
  let handoffTimer
  let resumedNoticeTimer
  let handoffWasActive = false
  /** 转人工请求在飞（防连点重复 POST）。 */
  let handoffInFlight = false
  /**
   * 转人工已被受理、但接管帧还没到（成功后保持入口禁用）。
   *
   * 不能只靠 `handoffButton.disabled`：任何无关帧都会触发一次 sync，
   * `syncHandoffBanner` 的"未接管"分支会把它重新点亮。
   */
  let handoffAccepted = false

  /**
   * 同步接管横幅（D13：独立节点；`setBanner` 只负责连接异常）。
   *
   * `Date.now()` 在这里是**展示计时**，不是业务事实：权威等待时长在服务端
   * `summary.waitedMs` / `heartbeat.waitedMs`，前端这一秒只是为了"在等"可感知。
   */
  function syncHandoffBanner(handoff, warn) {
    if (handoff !== null && handoff !== undefined && handoff.active === true) {
      if (resumedNoticeTimer !== undefined) {
        clearTimeout(resumedNoticeTimer)
        resumedNoticeTimer = undefined
      }
      handoffWasActive = true
      handoffAccepted = false
      composerInput.placeholder = HANDOFF_PLACEHOLDER
      // 已在接管中：入口禁用（服务端重复请求会回 409，界面不该先给一个假入口）
      handoffButton.disabled = true
      handoffButton.title = '已在人工接管中'
      // 超时告警只在**本次接管**之后才算数（上一轮的红标不能跟到新接管）
      const freshWarn = warn !== null && warn !== undefined && warn.seq > handoff.seq ? warn : null
      const tick = () => {
        const waited = formatWaited(Date.now() - (typeof handoff.at === 'number' ? handoff.at : Date.now()))
        const overdue = freshWarn === null ? '' : ` · 已等待超过 ${String(Math.max(1, Math.round(freshWarn.slaMs / 60_000)))} 分钟`
        handoffBanner.replaceChildren(
          el('div', { class: 'ds-alert ds-alert--info' }, [
            el('span', { class: 'ds-alert__icon' }, [icon('agent', 16)]),
            el('div', {}, [
              el('div', { class: 'ds-alert__title', text: '已转人工坐席' }),
              el('p', {
                class: 'ds-alert__desc',
                text: `等待 ${waited} · 坐席回复会以「${handoff.operator ?? '人工坐席'}」标识${overdue}`,
              }),
            ]),
          ]),
        )
        handoffBanner.hidden = false
      }
      tick()
      if (handoffTimer === undefined) handoffTimer = setInterval(tick, 1000)
      return
    }

    if (handoffTimer !== undefined) {
      clearInterval(handoffTimer)
      handoffTimer = undefined
    }
    composerInput.placeholder = COMPOSER_PLACEHOLDER
    // 收到权威的"未接管"帧（含快照里的 active:false）才解除成功后的临时禁用；
    // 没有任何接管帧（store.handoff 为 null）时保持禁用，避免再点一次撞 409。
    if (handoff !== null && handoff !== undefined) handoffAccepted = false
    handoffButton.disabled = handoffInFlight || handoffAccepted
    handoffButton.title = '请求人工坐席接管'
    // 从"接管中"切到"已交回"：一次性提示 3 秒；之后到来的帧不许把它提前抹掉
    if (handoffWasActive) {
      handoffWasActive = false
      handoffBanner.replaceChildren(
        el('div', { class: 'ds-alert ds-alert--success' }, [
          el('span', { class: 'ds-alert__icon' }, [icon('check', 16)]),
          el('div', {}, [
            el('div', { class: 'ds-alert__title', text: '已交回智能助手' }),
            el('p', { class: 'ds-alert__desc', text: '之后的回复由智能助手继续' }),
          ]),
        ]),
      )
      handoffBanner.hidden = false
      resumedNoticeTimer = setTimeout(() => {
        resumedNoticeTimer = undefined
        handoffBanner.hidden = true
        handoffBanner.replaceChildren()
      }, 3000)
      return
    }
    if (resumedNoticeTimer !== undefined) return
    handoffBanner.hidden = true
    handoffBanner.replaceChildren()
  }

  /** 轻提示。 */
  function notify(message, level = 'info') {
    const node = el('div', { class: `toast toast--${level}`, text: message })
    toasts.append(node)
    setTimeout(() => node.remove(), 4000)
  }

  /** 上一份快照的会话号：服务重启后快照换了会话，界面必须说出"会话已重置"。 */
  let lastSessionId = null

  /**
   * 会话号同步。
   *
   * `api.session()` 只在挂载时读一次；之后的权威来源是每份快照的 `sessionId`。
   * 服务重启 + 断线重连后快照会换号（历史蒸发），不提示等于让客户以为"刚才的对话丢了"。
   */
  function syncSession(state) {
    const next = state.sessionId
    if (typeof next !== 'string' || next.length === 0) return
    if (lastSessionId !== null && lastSessionId !== next) {
      notify('会话已重置（服务重启），此前的对话历史不再显示', 'warning')
      // 新会话没有旧的接管状态：解除"成功后等帧"的临时禁用。
      handoffAccepted = false
    }
    lastSessionId = next
    sessionLabel.textContent = `会话 ${next}`
  }

  /**
   * 选择题卡的发送通道（`choice` 帧）。
   *
   * 与 composer 走同一条 `POST /api/turn`：点选 = 把选项 label 当普通用户消息发出去，
   * 不本地回显（用户消息等 `user/message` 帧）。"手动输入"出口只交还焦点，零请求。
   */
  const choiceDeps = {
    submit: async (text) => {
      const result = await api.turn(text)
      return result.ok ? { ok: true } : { ok: false, code: result.code, message: result.reason }
    },
    focusComposer: () => composerInput.focus(),
  }

  /** 全量同步（幂等；每帧都可能触发一次）。 */
  function sync(state) {
    // ① 对话流
    const conversationFrames = state.frames.filter((frame) => CONVERSATION_KINDS.has(frame.kind))
    syncContainer(conversation, rendered, conversationFrames, (frame) => renderFrame(frame, choiceDeps))

    // 草稿气泡
    const draft = conversation.querySelector('[data-draft="true"]')
    if (state.streamText.length === 0) draft?.remove()
    else if (draft === null) conversation.append(renderDraft(state.streamText))
    else draft.querySelector('.bubble__text').textContent = state.streamText

    const empty = conversation.querySelector('.conversation__empty')
    if (conversationFrames.length === 0 && state.streamText.length === 0) {
      if (empty === null) conversation.append(renderEmptyState())
    } else empty?.remove()

    // ② DAG（只画最近一轮；有帧但没节点也走空态，不留一张空白 SVG）
    const dags = state.frames.filter((frame) => frame.kind === 'dag')
    const latestDag = dags[dags.length - 1]
    if (latestDag === undefined || (latestDag.nodes ?? []).length === 0) {
      syncContainer(dagBox, dagRendered, [], renderDag)
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
    // 断线也要横幅：顶栏 11px 文案在 1440 宽屏上等于没有提示（走查 P2-2）。
    // `fault` 是服务端主动发的事件，`offline` 是 SSE 断开的本地事实，两者都要说话。
    setBanner(
      state.status === 'offline'
        ? (state.fault?.reason ?? '与服务器的连接已断开，界面数据可能不是最新')
        : state.fault === null
          ? null
          : state.fault.reason,
    )
    syncSession(state)
    syncHandoffBanner(state.handoff, state.handoffWarn)
  }

  store.subscribe(sync)

  // 发送
  //
  // `sendButton.disabled` 只挡住鼠标，挡不住表单再次 submit（连按 Enter / 双击）：
  // 同一句话会提交两轮，银行场景下就是两次工具调用、两次审批。用标志位把入口关死。
  let inFlight = false
  composer.addEventListener('submit', async (event) => {
    event.preventDefault()
    if (inFlight) return
    const text = composerInput.value.trim()
    if (text.length === 0) return
    inFlight = true
    sendButton.disabled = true
    try {
      const result = await api.turn(text)
      if (!result.ok) {
        notify(result.reason, 'danger')
        return
      }
      composerInput.value = ''
      composerInput.style.height = ''
    } finally {
      inFlight = false
      sendButton.disabled = false
    }
  })

  composerInput.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' || event.shiftKey) return
    // 中文输入法选词也是 Enter：`isComposing`（标准）与 keyCode 229（Safari/旧内核）都算输入中，
    // 否则拼音选词回车会把没写完的话直接发出去。
    if (event.isComposing || event.keyCode === 229) return
    event.preventDefault()
    composer.requestSubmit()
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

  // 转人工：成功不等 optimistic 渲染——横幅由 `handoff/requested` 帧点亮（与移动壳同一口径）。
  handoffButton.addEventListener('click', async () => {
    if (handoffInFlight) return
    handoffInFlight = true
    handoffButton.disabled = true
    let accepted = false
    try {
      const result = await control.handoff('客户请求人工')
      if (!result.ok) {
        notify(`转人工失败：${result.reason}`, 'danger')
        return
      }
      accepted = true
      notify('已提交转人工请求，等待坐席接入', 'info')
    } finally {
      handoffInFlight = false
      // 成功就保持禁用，等接管帧 / 交回帧来推翻它：帧还没到时重新点亮，
      // 等于允许用户再点一次去撞 409。
      handoffAccepted = accepted
      if (!accepted && store.state().handoff?.active !== true) handoffButton.disabled = false
    }
  })

  // 观测面板轮询控制器：拉取式（U-1 不许新增 SSE 帧）；非观测 tab 不发请求
  const obs = createObservability({
    api,
    onState: (state) => renderObserve(obsBox, { ...state, onRefresh: () => obs.refreshOnce() }),
  })

  // 标签页（`role=tab` + `aria-controls` + 方向键，键盘用户不必按住 Tab 逐个穿）
  const TAB_ORDER = ['dag', 'audit', 'observe']
  const TAB_BUTTONS = { dag: tabDag, audit: tabAudit, observe: tabObserve }
  let currentTab = 'dag'

  function selectTab(which) {
    currentTab = which
    for (const name of TAB_ORDER) {
      const active = name === which
      TAB_BUTTONS[name].classList.toggle('is-active', active)
      TAB_BUTTONS[name].setAttribute('aria-selected', String(active))
      TAB_BUTTONS[name].setAttribute('tabindex', active ? '0' : '-1')
    }
    dagBox.hidden = which !== 'dag'
    auditBox.hidden = which !== 'audit'
    obsBox.hidden = which !== 'observe'
    if (which === 'observe') obs.start()
    else obs.stop()
  }
  tabDag.addEventListener('click', () => selectTab('dag'))
  tabAudit.addEventListener('click', () => selectTab('audit'))
  tabObserve.addEventListener('click', () => selectTab('observe'))
  tabsBar.addEventListener('keydown', (event) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
    event.preventDefault()
    const step = event.key === 'ArrowLeft' ? -1 : 1
    const index = (TAB_ORDER.indexOf(currentTab) + step + TAB_ORDER.length) % TAB_ORDER.length
    const target = TAB_ORDER[index]
    selectTab(target)
    TAB_BUTTONS[target].focus()
  })

  // 会话信息（失败不阻断：界面仍可从 SSE 取数）
  void api.session().then((result) => {
    const sessionId = result.ok ? result.data?.sessionId : undefined
    // 200 但 body 不是 JSON 时 `data` 为 null：判空后再渲染，别让顶栏显示 "会话 undefined"
    if (typeof sessionId === 'string' && sessionId.length > 0) {
      sessionLabel.textContent = `会话 ${sessionId}`
    }
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

  return {
    store,
    api,
    observe: obs,
    close: () => {
      obs.stop()
      connection.close()
    },
  }
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
