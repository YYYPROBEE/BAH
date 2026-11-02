/**
 * Web 应用入口。
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
import { BRAND } from './brand.js'
import { clear, el, icon } from './dom.js'
import { createObservability } from './observability.js'
import { formatWaited } from './format.js'
import { applyFontScale, createFeedbackStore, createPrefs, feedbackKeyOf, isLargeFont, PREF_KEYS } from './prefs.js'
import { createSpeaker } from './speech.js'
import { scrollToBottom } from './scroll.js'
import { approvalDecision, createStore, pendingApproval, viewKey } from './store.js'
import { connectEvents, createHttpApi, createSessionControlClient } from './transport.js'
import {
  answerFooterModel,
  renderAnswerFooter,
  renderAssistPanel,
  renderQuickActions,
  renderSafetyChip,
} from './views/assist.js'
import { createDialog } from './views/dialog.js'
import {
  CONVERSATION_KINDS,
  orderToolFrames,
  renderDraft,
  renderEmptyState,
  renderFrame,
} from './views/conversation.js'
import { createApprovalController } from './views/approval.js'
import { renderAudit, renderAuditCounts, renderAuditEmpty, renderAuditSummary } from './views/audit.js'
import { renderDag, renderDagEmpty } from './views/dag.js'
import { renderHistoryPanel, renderReadonlyView } from './views/history.js'
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
  // 只有含工具卡的流才需要按 `orderToolFrames` 重排；普通对话保持既有顺序，
  // 避免把"同一 callId 的新选择题卡必须在末尾"这类既有约束打乱。
  if (frames.some((frame) => frame.kind === 'tool')) {
    const desired = frames.map((frame) => rendered.get(viewKey(frame))?.node).filter(Boolean)
    for (let index = 0; index < desired.length; index += 1) {
      const node = desired[index]
      if (container.children[index] !== node) container.insertBefore(node, container.children[index] ?? null)
    }
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
  const prefs = createPrefs()
  const feedbackStore = createFeedbackStore(prefs)
  const speaker = createSpeaker(typeof window === 'undefined' ? undefined : window)
  applyFontScale(typeof document === 'undefined' ? undefined : document, isLargeFont(prefs) ? 'large' : 'normal')
  speaker.setEnabled(prefs.get(PREF_KEYS.speech) === '1')

  const feedbackDeps = {
    value: (frame) => feedbackStore.get(feedbackKeyOf(store.state().sessionId, frame.seq)),
    rate: (frame, value) => feedbackStore.rate(feedbackKeyOf(store.state().sessionId, frame.seq), value),
  }

  const sessionLabel = el('span', { class: 'app-header__session', text: '会话 —' })
  const statusDot = el('span', { class: 'app-header__status is-connecting' }, [
    el('span', { class: 'app-header__dot' }),
    el('span', { class: 'app-header__status-text', text: STATUS.connecting.label }),
  ])

  // 只有 Electron 桌面壳有 preload 桥；普通 Web / 移动没有真正的"新会话"能力
  // （宿主单进程单会话），因此不渲染这个按钮，不造一个点了只刷新页面的假入口。
  const desktopBridge = typeof globalThis === 'undefined' ? undefined : globalThis.bahDesktop
  const newConversationTool =
    typeof desktopBridge?.newConversation === 'function'
      ? el('button', {
          class: 'app-header__tool app-header__tool--labeled',
          type: 'button',
          'aria-label': '新对话',
          title: '开始新对话（重启桌面客户端）',
          dataset: { role: 'new-conversation' },
        }, [icon('message', 16), el('span', { class: 'app-header__tool-label', text: '新对话' })])
      : null

  const helpTool = el('button', {
    class: 'app-header__tool',
    type: 'button',
    'aria-label': '服务与帮助',
    title: '服务与帮助',
    dataset: { role: 'help' },
  }, [icon('help', 16)])
  /**
   * 历史对话入口（2026-11-02）。
   *
   * 与"新对话"不同，这个按钮**不需要宿主能力**：它只读 `GET /api/sessions`，
   * web / mobile / desktop 三份壳的 HTTP 面完全一样，所以无条件渲染。
   */
  const historyTool = el('button', {
    class: 'app-header__tool app-header__tool--labeled',
    type: 'button',
    'aria-label': '历史对话',
    title: '历史对话（只读）',
    dataset: { role: 'history' },
  }, [icon('clock', 16), el('span', { class: 'app-header__tool-label', text: '历史' })])
  const fontTool = el('button', {
    class: `app-header__tool${isLargeFont(prefs) ? ' is-on' : ''}`,
    type: 'button',
    'aria-label': '大字模式',
    'aria-pressed': isLargeFont(prefs) ? 'true' : 'false',
    title: '大字模式（适老化）',
    dataset: { role: 'font-scale' },
  }, [icon('font', 16)])
  const speakTool = el('button', {
    class: `app-header__tool${speaker.enabled ? ' is-on' : ''}`,
    type: 'button',
    'aria-label': '语音播报',
    'aria-pressed': speaker.enabled ? 'true' : 'false',
    title: '语音播报助手回复',
    dataset: { role: 'speech' },
    hidden: !speaker.supported,
  }, [icon(speaker.enabled ? 'speak-on' : 'speak-off', 16)])

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
    placeholder: '在这里输入消息',
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
      title: '会话分叉属（未落地）；此处显式禁用，避免假装可用',
    },
    [icon('back', 14), '回到上一步'],
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
    [icon('person', 14), '转人工'],
  )

  const composerStatusText = el('span', { class: 'composer__status-text', text: '助手正在处理…' })
  const composerStatus = el('p', {
    class: 'composer__status',
    role: 'status',
    dataset: { role: 'composer-status' },
    hidden: true,
  }, [icon('clock', 14), composerStatusText])

  const composerErrorText = el('span', { class: 'composer__error-text', dataset: { role: 'composer-error-text' } })
  const composerRetry = el('button', {
    class: 'composer__retry',
    type: 'button',
    'aria-label': '重试发送',
    title: '重试发送',
    dataset: { role: 'composer-retry' },
    hidden: true,
  }, [icon('refresh', 14)])
  const composerError = el('div', {
    class: 'composer__error',
    role: 'alert',
    dataset: { role: 'composer-error' },
    hidden: true,
  }, [composerErrorText, composerRetry])

  const composer = el('form', { class: 'composer', id: 'composer' }, [
    composerStatus,
    el('div', { class: 'composer__row' }, [
      composerInput,
      el('div', { class: 'composer__actions' }, [stopButton, handoffButton, backButton, sendButton]),
    ]),
    el('p', {
      class: 'composer__disclaimer',
      text: '费率与政策以银行官方公布为准 · 高风险操作需出示审批票据并完成强验证',
    }),
    composerError,
  ])

  const quickBar = el('div', { class: 'quick-bar' }, [
    renderQuickActions({ onPick: (text) => submitText(text) }),
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
  const safetyDismissed = prefs.get(PREF_KEYS.safetyDismissed) === '1'
  // 2026-11-01 走查：安全提醒移到顶栏中间，不再占会话区一行、也不再横跨到右侧审计面板。
  const safetyBanner = el('div', { class: 'app-header__safety-slot', dataset: { role: 'safety' }, hidden: safetyDismissed }, [
    renderSafetyChip({
      onDismiss: () => {
        prefs.set(PREF_KEYS.safetyDismissed, '1')
        safetyBanner.hidden = true
        safetyBanner.replaceChildren()
      },
    }),
  ])

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
          [icon('logout', 14), '退出'],
        )
      : null

  const shell = el('div', { class: 'app-shell' }, [
    el('header', { class: 'app-header' }, [
      el('div', { class: 'app-header__brand' }, [
        el('span', { class: 'app-header__logo' }, [icon('bank', 20)]),
        el('div', { class: 'app-header__title', text: BRAND.name }),
      ]),
      safetyBanner,
      el('div', { class: 'app-header__meta' }, [
        sessionLabel,
        statusDot,
        ...(newConversationTool === null ? [] : [newConversationTool]),
        historyTool,
        helpTool,
        fontTool,
        speakTool,
        logoutButton,
      ]),
    ]),
    banner,
    handoffBanner,
    el('div', { class: 'app-body' }, [
      el('div', { class: 'app-left' }, [conversation, quickBar, composer]),
      panel,
    ]),
  ])

  clear(root)
  root.append(shell, overlay, toasts)

  /** 会话 / DAG / 审计三个容器的节点缓存。 */
  const rendered = new Map()
  const dagRendered = new Map()
  const auditRendered = new Map()

  /**
   * 滚动策略（2026-11-01 走查）：发送时跳到新消息，回答开始后停止跟随。
   *
   * 之前是"只要在底部就每帧贴底"：回答流式变长时视口一直被拽到底，用户往上翻读前文
   * 会被反复拉回去。现在只在两个时刻主动滚动：
   * 1. 出现新的用户消息（或用户点发送）→ 跳到底部，让刚说的话可见；
   * 2. 当前轮的第一段助手正文出现 → 把这段正文的顶部滚进视口，然后**冻结**。
   * 之后的 delta / 工具帧 / 轮次结束 / 反馈块一律不再滚动，用户看哪儿就停在哪儿。
   */
  let scrollInitialized = false
  let lastUserSeq = 0

  function isUserSpeechFrame(frame) {
    return (
      frame.kind === 'message' &&
      frame.role === 'user' &&
      (frame.source === undefined || frame.source === 'user' || frame.source === 'handoff-waiting')
    )
  }

  function latestUserSeqOf(frames) {
    let latest = 0
    for (const frame of frames) {
      if (isUserSpeechFrame(frame) && typeof frame.seq === 'number') latest = Math.max(latest, frame.seq)
    }
    return latest
  }

  function scrollConversationToTopOf(node) {
    if (node === null || node === undefined) return
    const container = conversation.getBoundingClientRect()
    const target = conversation.scrollTop + node.getBoundingClientRect().top - container.top - 8
    // 与 scrollToBottom 同一条纪律：程序化定位必须瞬时，不能和 CSS smooth 抢滚动。
    const previous = conversation.style.scrollBehavior
    conversation.style.scrollBehavior = 'auto'
    conversation.scrollTop = Math.max(0, target)
    conversation.style.scrollBehavior = previous
  }

  function syncConversationScroll(conversationFrames, state) {
    const latestUser = latestUserSeqOf(conversationFrames)

    if (!scrollInitialized) {
      if (conversationFrames.length === 0 && state.streamText.length === 0) return
      scrollInitialized = true
      lastUserSeq = latestUser
      scrollToBottom(conversation)
      return
    }

    if (latestUser > lastUserSeq) {
      lastUserSeq = latestUser
      // 发送后把最新一条用户消息钉在视口顶部：回答从它下面长出来，
      // 用户不需要在"自己刚说的话"被顶出屏幕后再往回找。
      const node = conversation.querySelector(`.message--user[data-seq="${String(latestUser)}"]`)
      if (node !== null) scrollConversationToTopOf(node)
      else scrollToBottom(conversation)
    }
  }

  /** 对话末尾的收口块（唯一反馈行 + 两条追问）：只在最后一轮完成且没有待选卡时出现。 */
  let answerFooter = null
  let answerFooterKey = null
  let lastAnswerModel = null
  const modelSuggestions = new Map()
  const suggestionAttempted = new Set()
  const suggestionPending = new Set()

  /** 以"会话 + 回答序号"为键缓存模型建议：同一轮只请求一次，失败也缓存空数组。 */
  function suggestionKeyOf(model) {
    return `${String(store.state().sessionId)}:${String(model.frame.seq)}`
  }

  function requestModelSuggestions(model, key) {
    if (suggestionAttempted.has(key) || suggestionPending.has(key)) return
    // 测试桩 / 旧宿主没这条 API：标记已尝试，保留规则回退。
    if (typeof api.suggest !== 'function') {
      suggestionAttempted.add(key)
      return
    }
    suggestionAttempted.add(key)
    suggestionPending.add(key)
    const context = model.context ?? { user: '', assistant: '' }
    void api
      .suggest(context)
      .then((result) => {
        const items =
          result.ok && Array.isArray(result.data?.suggestions)
            ? result.data.suggestions
                .map((item) => String(item ?? '').trim())
                .filter((item) => item !== '')
                .slice(0, 2)
            : []
        // 空结果不写入 Map：让 syncAnswerFooter 继续用规则回退，而不是把按钮清空。
        if (items.length > 0) {
          modelSuggestions.set(key, items)
          // 仍然是同一轮才替换；已经翻到下一轮就丢弃这次结果。
          if (lastAnswerModel !== null && lastAnswerModel.key === key) {
            syncAnswerFooter(lastAnswerModel.model)
          }
        }
      })
      .catch(() => {
        // 模型不可用：保留规则回退，不把“没有建议”渲染成空标签。
      })
      .finally(() => {
        suggestionPending.delete(key)
      })
  }

  function syncAnswerFooter(model) {
    if (model === null) {
      answerFooter?.remove()
      answerFooter = null
      answerFooterKey = null
      lastAnswerModel = null
      return
    }

    // 会话号也进键：服务重启后 seq 可能重复，不能把上一个会话的反馈状态带进新会话。
    const requestKey = suggestionKeyOf(model)
    lastAnswerModel = { key: requestKey, model }
    const suggestions = modelSuggestions.get(requestKey) ?? model.suggestions
    const key = `${requestKey}:${suggestions.join('|')}`
    const build = () =>
      renderAnswerFooter({
        value: feedbackDeps.value(model.frame),
        onRate: (value) => feedbackDeps.rate(model.frame, value),
        suggestions,
        onPick: (text) => submitText(text),
      })

    if (answerFooter === null) {
      answerFooterKey = key
      answerFooter = build()
    } else if (key !== answerFooterKey) {
      const next = build()
      answerFooter.replaceWith(next)
      answerFooter = next
      answerFooterKey = key
    }
    // 新帧会追加在末尾；每次 sync 把收口块挪到最后，保证它永远是会话流的最后一项。
    if (conversation.lastElementChild !== answerFooter) conversation.append(answerFooter)
    // 模型建议是异步的：先把规则回退渲染出来，拿到非空结果后再原地替换。
    if (!suggestionAttempted.has(requestKey)) requestModelSuggestions(model, requestKey)
  }

  const approvals = createApprovalController(overlay, {
    async onDecision(ticketId, decision, reason, confirmText) {
      const result = await api.decide(ticketId, decision, reason, confirmText)
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
            el('span', { class: 'ds-alert__icon' }, [icon('person', 16)]),
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

  /** 帮助弹窗（服务范围 / 无障碍 / 常用业务）。 */
  const helpDialog = createDialog(overlay)

  /**
   * 历史对话弹窗（2026-11-02）。
   *
   * 复用 `createDialog` 而不是自造遮罩：焦点陷阱、Esc 关闭、关闭后归还焦点都是既有能力，
   * 再造一份就一定有一份会漏。列表与只读回放共用一个弹窗实例——回放是从列表点进去的
   * 下一层，另开一个弹窗会让"返回上一步"变成"关掉再开"。
   */
  const historyDialog = createDialog(overlay)

  /** 历史列表（`?limit` 与后端缺省一致，20 条够一屏翻）。 */
  async function openHistory() {
    historyDialog.show({
      title: '历史对话',
      body: renderHistoryPanel({
        loading: true,
        onOpen: (sessionId) => void openHistorySession(sessionId),
        onRefresh: () => void openHistory(),
      }),
    })
    const result = await api.sessions(20)
    if (!result.ok) {
      historyDialog.show({
        title: '历史对话',
        body: renderHistoryPanel({
          error: result.reason,
          onOpen: (sessionId) => void openHistorySession(sessionId),
          onRefresh: () => void openHistory(),
        }),
      })
      return
    }
    historyDialog.show({
      title: '历史对话',
      body: renderHistoryPanel({
        items: result.data?.sessions ?? [],
        onOpen: (sessionId) => void openHistorySession(sessionId),
        onRefresh: () => void openHistory(),
      }),
    })
  }

  /** 打开一个历史会话（只读）。失败就退回列表并说明理由，不留一个空白弹窗。 */
  async function openHistorySession(sessionId) {
    const result = await api.sessionTranscript(sessionId)
    if (!result.ok) {
      notify(result.reason ?? '这个会话打不开', 'error')
      await openHistory()
      return
    }
    const data = result.data ?? {}
    historyDialog.show({
      title: `历史 · ${typeof data.title === 'string' ? data.title : sessionId}`,
      body: renderReadonlyView({
        title: typeof data.title === 'string' ? data.title : sessionId,
        frames: data.snapshot?.frames ?? [],
        // deps 传空：历史视图里没有任何可写动作（选择题、风险问卷都不给作答入口）
        renderFrame: (frame) => renderFrame(frame, {}),
        onBack: () => void openHistory(),
      }),
    })
  }

  historyTool.addEventListener('click', () => void openHistory())

  function toggleFont() {
    const next = !isLargeFont(prefs)
    prefs.set(PREF_KEYS.fontScale, next ? 'large' : 'normal')
    applyFontScale(document, next ? 'large' : 'normal')
    fontTool.classList.toggle('is-on', next)
    fontTool.setAttribute('aria-pressed', next ? 'true' : 'false')
    return next
  }

  function toggleSpeech() {
    const next = !speaker.enabled
    speaker.setEnabled(next)
    prefs.set(PREF_KEYS.speech, next ? '1' : '0')
    speakTool.classList.toggle('is-on', next)
    speakTool.setAttribute('aria-pressed', next ? 'true' : 'false')
    speakTool.replaceChildren(icon(next ? 'speak-on' : 'speak-off', 16))
    if (!next) speaker.stop()
    return next
  }

  function openHelp() {
    helpDialog.show({
      title: '服务与帮助',
      body: renderAssistPanel({
        onPick: async (text) => {
          helpDialog.close()
          await submitText(text)
        },
        fontLarge: isLargeFont(prefs),
        speechEnabled: speaker.enabled,
        speechSupported: speaker.supported,
        collapsibleScope: false,
        onToggleFont: toggleFont,
        onToggleSpeech: toggleSpeech,
      }),
    })
  }

  helpTool.addEventListener('click', openHelp)
  fontTool.addEventListener('click', toggleFont)
  speakTool.addEventListener('click', toggleSpeech)

  if (newConversationTool !== null) {
    newConversationTool.addEventListener('click', () => {
      const bridge = globalThis.bahDesktop
      if (typeof bridge?.newConversation !== 'function') return
      const confirmed =
        typeof globalThis.confirm === 'function'
          ? globalThis.confirm('开始新对话会重启桌面客户端；当前对话会保留在会话日志中。继续吗？')
          : true
      if (confirmed) bridge.newConversation()
    })
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
    // 工具卡跟到发起它的助手消息后面：避免"卡在上、'我查一下'在下"造成下面没内容。
    const conversationFrames = orderToolFrames(
      state.frames.filter((frame) => CONVERSATION_KINDS.has(frame.kind)),
    )
    const toolFramesByCall = new Map(
      state.frames.filter((frame) => frame.kind === 'tool').map((frame) => [frame.callId, frame]),
    )
    syncContainer(conversation, rendered, conversationFrames, (frame) =>
      renderFrame(frame, { ...choiceDeps, toolFrameFor: (callId) => toolFramesByCall.get(callId) }),
    )

    // 一律以"最后一轮是否还在跑"决定收口块：运行中 / 流式草稿 / 接管中都不出反馈与追问。
    const running = state.frames.some(
      (frame) =>
        frame.kind === 'turn' &&
        frame.phase === 'start' &&
        !state.frames.some((other) => other.kind === 'turn' && other.turn === frame.turn && other.phase === 'end'),
    )

    // 草稿气泡
    const draft = conversation.querySelector('[data-draft="true"]')
    if (state.streamText.length === 0) draft?.remove()
    else if (draft === null) conversation.append(renderDraft(state.streamText))
    else draft.querySelector('.bubble__text').textContent = state.streamText

    const empty = conversation.querySelector('.conversation__empty')
    if (conversationFrames.length === 0 && state.streamText.length === 0) {
      if (empty === null) conversation.append(renderEmptyState())
    } else empty?.remove()

    // ② 对话末尾的反馈与追问（只在最后一轮完成、没有流式草稿、没有待选卡时出现）
    syncAnswerFooter(
      answerFooterModel(state.frames, {
        running,
        streamText: state.streamText,
        handoffActive: state.handoff?.active === true,
      }),
    )

    // ③ DAG（只画最近一轮；有帧但没节点也走空态，不留一张空白 SVG）
    const dags = state.frames.filter((frame) => frame.kind === 'dag')
    const latestDag = dags[dags.length - 1]
    if (latestDag === undefined || (latestDag.nodes ?? []).length === 0) {
      syncContainer(dagBox, dagRendered, [], renderDag)
      if (dagBox.firstChild === null) dagBox.append(renderDagEmpty())
    } else {
      syncContainer(dagBox, dagRendered, [latestDag], renderDag)
      dagBox.querySelector('.ds-empty')?.remove()
    }

    // ④ 审计（升序，保持因果阅读顺序）
    const audits = state.frames.filter((frame) => frame.kind === 'audit')
    auditSummary.replaceChildren(renderAuditSummary(state.frames), renderAuditCounts(state.frames))
    if (audits.length === 0) {
      if (auditList.firstChild === null) auditList.append(renderAuditEmpty())
    } else {
      syncContainer(auditList, auditRendered, audits, renderAudit)
      auditList.querySelector('.ds-empty')?.remove()
      auditList.lastElementChild?.scrollIntoView?.({ block: 'nearest' })
    }

    // ⑤ 审批：先收尾，再开新
    for (const frame of state.frames) {
      if (frame.kind === 'approval-closed') approvals.close(frame)
    }
    const pending = pendingApproval(state.frames)
    if (pending !== null) approvals.show(pending)

    // ⑥ 状态
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

    // ⑦ 处理状态 + 滚动策略 + 语音播报（播报只在用户开启时进行，历史消息不进基线）
    composerStatus.hidden = !running
    syncConversationScroll(conversationFrames, state)
    maybeSpeak(state)
  }

  /** 已播报到的助手消息序号（快照 = 历史基线，不朗读历史）。 */
  let spokenSeq = 0

  function latestAssistantSeq(frames) {
    let latest = 0
    for (const frame of frames ?? []) {
      if (frame.kind === 'message' && frame.role === 'assistant' && typeof frame.seq === 'number') {
        latest = Math.max(latest, frame.seq)
      }
    }
    return latest
  }

  function maybeSpeak(state) {
    let latest = null
    for (const frame of state.frames) {
      if (frame.kind === 'message' && frame.role === 'assistant') latest = frame
    }
    if (latest === null) return
    if (typeof latest.seq !== 'number' || latest.seq <= spokenSeq) return
    spokenSeq = latest.seq
    if (!speaker.enabled) return
    const text = (latest.blocks ?? [])
      .filter((block) => block.type === 'text' && typeof block.text === 'string')
      .map((block) => block.text)
      .join('\n')
    speaker.speak(text)
  }

  store.subscribe(sync)

  // 发送
  //
  // `sendButton.disabled` 只挡住鼠标，挡不住表单再次 submit（连按 Enter / 双击）：
  // 同一句话会提交两轮，银行场景下就是两次工具调用、两次审批。用标志位把入口关死。
  let inFlight = false
  let lastFailedText = null

  function showComposerError(message, retryText) {
    lastFailedText = retryText ?? null
    composerErrorText.textContent = message
    composerError.hidden = false
    composerRetry.hidden = retryText === undefined
  }

  function clearComposerError() {
    lastFailedText = null
    composerError.hidden = true
    composerErrorText.textContent = ''
    composerRetry.hidden = true
  }

  /**
   * 提交一轮。`fromComposer` 才清空输入框：快捷业务/帮助弹窗发出的消息
   * 不能把用户正在打的草稿一并清掉。
   */
  async function submitText(rawText, fromComposer = false) {
    if (inFlight) return
    const text = String(rawText ?? '').trim()
    if (text.length === 0) return
    inFlight = true
    sendButton.disabled = true
    composerRetry.disabled = true
    clearComposerError()
    // 发送后等 user/message 帧到达，再由 syncConversationScroll 把这条消息滚到顶部；
    // 这里只记录发送前的序号，避免把旧会话的"最新用户消息"误判成新消息。
    scrollInitialized = true
    lastUserSeq = latestUserSeqOf(store.state().frames)
    try {
      const result = await api.turn(text)
      if (!result.ok) {
        // 失败保留原话与输入框内容，并给一键重试：不逼用户重打一遍
        showComposerError(String(result.reason ?? result.code ?? '发送失败'), text)
        return
      }
      if (fromComposer) {
        composerInput.value = ''
        composerInput.style.height = ''
      }
    } finally {
      inFlight = false
      sendButton.disabled = false
      composerRetry.disabled = false
    }
  }

  composer.addEventListener('submit', async (event) => {
    event.preventDefault()
    await submitText(composerInput.value, true)
  })

  composerRetry.addEventListener('click', () => {
    if (lastFailedText === null) return
    const fromInput = composerInput.value.trim() === lastFailedText
    void submitText(lastFailedText, fromInput)
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
    onFrame: (frame) => {
      // 快照是历史：先推播报基线，再让 sync 看到它（否则会朗读整段历史）。
      if (frame.kind === 'snapshot') spokenSeq = latestAssistantSeq(frame.frames)
      store.apply(frame)
    },
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
    speaker,
    close: () => {
      obs.stop()
      connection.close()
      helpDialog.dispose()
      speaker.dispose()
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
