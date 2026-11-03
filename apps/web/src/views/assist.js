/**
 * 客户侧的信任与效率件（移动 / 桌面共用同一份文案与结构）。
 *
 * 这里只产节点，不持有状态：安全横幅是否收起、大字与播报开关、每条反馈的结论
 * 都由装配层从 `prefs.js` 读入再传进来，避免两个壳各写一套默认值。
 *
 * 两条硬约束：
 * 1. **不造能力**：业务入口只列当前工具目录真的能办的六件事；信用卡还款/分期/利率
 *    在演示环境没有对应工具，写进“暂未开放”，不做一个点了只会追问的假按钮。
 * 2. **反馈不冒充上传**：没有服务端反馈端点，界面必须写明“仅本机”。
 */

import { el, icon } from '../dom.js'

/**
 * 常用业务入口（六项都能被离线 router 接住：余额 / 转账 / 卡片 / 账单 / 理财 / 订阅）。
 *
 * `text` 是发给 `POST /api/turn` 的原话，和用户手打完全同一条路径——不绕过任何审批。
 */
export const QUICK_ACTIONS = Object.freeze([
  Object.freeze({ id: 'balance', label: '查余额', hint: '账户与可用额度', text: '查一下我的余额' }),
  Object.freeze({ id: 'transfer', label: '转账汇款', hint: '收款人 + 金额', text: '我要转账' }),
  Object.freeze({ id: 'lost-card', label: '挂失银行卡', hint: '卡片即刻停用', text: '我要挂失银行卡' }),
  Object.freeze({ id: 'bill', label: '账单分析', hint: '本月 / 近三月', text: '分析一下我这个月的账单' }),
  Object.freeze({ id: 'wealth', label: '理财产品', hint: '产品与风险', text: '看看理财产品' }),
  Object.freeze({ id: 'subscription', label: '订阅管理', hint: '自动扣款', text: '查一下我的订阅' }),
])

/** 防诈提示（横幅与帮助面板共用同一句，避免两处口径分叉）。 */
export const SAFETY = Object.freeze({
  title: '安全提醒',
  text: '银行不会索要密码、短信验证码，也不会要求你把钱转到“安全账户”。',
})

/** 服务范围与免责声明。 */
export const SERVICE_SCOPE = Object.freeze({
  intro: '我是智能助手，不是人工柜台。当前可以办理：',
  hours: '智能助手随时可用；人工坐席服务时间以银行公告为准。',
  can: Object.freeze([
    '账户余额、交易流水与账单分析',
    '转账汇款、挂失/冻结卡片',
    '理财产品查询与风险测评',
    '订阅与自动扣款查询',
    '产品与政策知识问答',
  ]),
  unavailable: Object.freeze([
    '信用卡还款、账单分期、存款利率查询：演示环境尚未接入对应工具，请以手机银行或柜台为准',
    '开户、销户、投诉工单：需要人工核身或专门工单系统，请转人工坐席',
  ]),
  limits: '转账、挂失等高风险操作会先出审批票据，并通过人脸 / 短信 / U 盾强验证；AI 不能替你跳过验证。',
  policy:
    '本页面为赛事演示环境，不办理真实资金业务。产品费率、活动规则与监管要求以银行官方公布为准；AI 回答不构成合同、承诺或投资建议。',
})

/** 反馈提示与落点说明。 */
export const FEEDBACK_PROMPT = '这条回答有帮助吗？'
export const FEEDBACK_LOCAL_NOTE = '已记录（仅本机）'

/**
 * 答后快捷追问：按最近一轮会话内容给两条可原样发送的用户消息。
 *
 * 规则表与服务端的演示意图同域（余额 / 转账 / 理财 / 订阅 / 卡片 / 账单），
 * 保证点了之后真的能办，而不是抛一个只会被追问的假入口。
 */
const FOLLOW_UP_FALLBACK = Object.freeze(['查一下我的余额', '分析一下我这个月的账单'])

const FOLLOW_UP_RULES = Object.freeze([
  Object.freeze({
    match: /理财|基金|持仓|收益|赎回|风险(?:测评|等级)?|wealth_/i,
    items: Object.freeze(['看看我的理财持仓', '看看在售的理财产品']),
  }),
  Object.freeze({
    match: /订阅|代扣|自动续费|会员|扣款|sub_/i,
    items: Object.freeze(['查一下我的订阅', '取消视频会员订阅']),
  }),
  Object.freeze({
    match: /挂失|银行卡|卡片|card_/i,
    items: Object.freeze(['查一下我的卡片状态', '把尾号 1234 的卡冻结']),
  }),
  Object.freeze({
    match: /账单|支出|消费|收支|bill_/i,
    items: Object.freeze(['分析一下近三个月的账单', '出一份本月账单报告']),
  }),
  Object.freeze({
    match: /转账|汇款|收款人|打款|transfer_/i,
    items: Object.freeze(['查一下我的余额', '分析一下我这个月的账单']),
  }),
  Object.freeze({
    match: /余额|账户|可用额度|account_/i,
    items: Object.freeze(['分析一下我这个月的账单', '看看在售的理财产品']),
  }),
])

/** 消息正文（只取文本块，跳过图片与未知块）。 */
function messageText(frame) {
  return (frame.blocks ?? [])
    .filter((block) => block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
    .trim()
}

/** 是否是用户真实发言（运行时上下文 / 系统纠正 / 交接语都不算）。 */
function isUserSpeech(frame) {
  if (frame.kind !== 'message' || frame.role !== 'user') return false
  return frame.source === undefined || frame.source === 'user' || frame.source === 'handoff-waiting'
}

/** 最近一轮的上下文：从上一条用户消息起算，避免上一轮关键词带偏建议。 */
function followUpHaystack(frames, lastUserIndex) {
  const start = lastUserIndex >= 0 ? lastUserIndex : Math.max(0, frames.length - 6)
  const parts = []
  for (const frame of frames.slice(start)) {
    if (frame.kind === 'message') {
      // 运行时上下文 / 系统纠正 / 交接语不是用户说过的话：把它们纳入关键词会把
      // "余额"回答带偏到上下文里偶然出现的"订阅/扣款"。
      if (frame.role === 'user' && !isUserSpeech(frame)) continue
      const text = messageText(frame)
      if (text !== '') parts.push(text)
      for (const call of frame.toolCalls ?? []) parts.push(String(call.name ?? ''))
      continue
    }
    if (frame.kind === 'tool') {
      parts.push(String(frame.name ?? ''), String(frame.card?.title ?? frame.title ?? ''))
      continue
    }
    if (frame.kind === 'effects') {
      for (const item of frame.items ?? []) parts.push(String(item.name ?? ''), String(item.title ?? ''))
      continue
    }
    if (frame.kind === 'plan-card') parts.push(String(frame.title ?? '计划'))
  }
  return parts.join('\n')
}

/**
 * 从助手最后一句话里抽"它正在问的那个动作"。
 *
 * 例：
 * - "需要我把 w-1 和 w-2 放在一起详细比较一下吗？" → "把 w-1 和 w-2 放在一起详细比较一下"
 * - "要不要我按「近三个月」口径重新分析一次，这样能把 10 月的支出一起算进去？" →
 *   "按「近三个月」口径重新分析一次"
 *
 * 只认带"需要我 / 要不要我 / 是否要 / 要我 / 需要"的提问；"您看哪个？"这类没有
 * 明确动作的开放问题不硬编选项，仍交给业务域规则。
 */
function questionOfferOf(text) {
  const normalized = String(text ?? '').replace(/\s+/g, ' ').trim()
  if (normalized === '') return null
  const questions = normalized.match(/[^。！!？?]*[？?]/g) ?? []
  const question = questions.at(-1)?.trim() ?? ''
  if (question === '') return null

  const match = /(?:需要我|要不要我|是否要|要我|需要)\s*(.+?)(?:吗|呢)?[？?]$/.exec(question)
  if (match === null) return null
  let offer = (match[1] ?? '').trim().replace(/^[，,、\s]+|[，,、\s]+$/g, '')
  if (offer === '') return null
  // 只取第一个动作分句：后面的"这样能…"是解释，不该塞进按钮。
  offer = (offer.split(/[，,]/)[0] ?? offer).trim()
  if (offer === '') return null
  return offer.slice(0, 100)
}

/**
 * 两条按会话内容推导的追问。
 *
 * 优先级：助手最后一句正在提问 → 两条直接回答它（需要 / 不用）；否则按最近一轮的业务域
 * 给两条只读下一步。这样按钮不会在"要不要我对比 w-1 和 w-2？"下面还推荐"查余额"。
 *
 * @param {ReadonlyArray<Record<string, any>>} frames
 * @returns {string[]}
 */
export function suggestFollowUps(frames = []) {
  let lastUserIndex = -1
  frames.forEach((frame, index) => {
    if (isUserSpeech(frame)) lastUserIndex = index
  })

  const lastUserText = lastUserIndex >= 0 ? messageText(frames[lastUserIndex]) : ''
  let lastAnswerText = ''
  for (let index = frames.length - 1; index >= 0; index -= 1) {
    const frame = frames[index]
    if (
      frame.kind === 'message' &&
      (frame.role === 'assistant' || frame.role === 'operator') &&
      messageText(frame) !== ''
    ) {
      lastAnswerText = messageText(frame)
      break
    }
  }

  const offer = questionOfferOf(lastAnswerText)
  if (offer !== null) {
    const affirmative = `需要，${offer}`
    const negative = '不用了，先看看别的'
    if (affirmative !== lastUserText) return [affirmative, negative]
  }

  // 助手在问"哪一张卡"时，按钮应直接回答它；继续推"查卡片状态 / 冻结卡片"
  // 会答非所问（实测：挂失场景下把已经挂失的卡又推了一次冻结）。
  const askedWhichCard = /哪一张|哪张卡|要处理的是哪/.test(lastAnswerText)
  const tails = [...new Set([...lastAnswerText.matchAll(/尾号\s*(\d{4})/g)].map((match) => match[1]))]
  if (askedWhichCard && tails.length > 0) {
    return tails.slice(0, 2).map((tail) => `尾号 ${tail} 的卡`)
  }

  const haystack = followUpHaystack(frames, lastUserIndex)
  const rule = FOLLOW_UP_RULES.find((entry) => entry.match.test(haystack))
  const candidates = [...(rule?.items ?? FOLLOW_UP_FALLBACK)]

  const picked = []
  for (const item of candidates) {
    if (picked.includes(item) || item === lastUserText) continue
    picked.push(item)
  }
  for (const item of FOLLOW_UP_FALLBACK) {
    if (picked.length >= 2) break
    if (!picked.includes(item) && item !== lastUserText) picked.push(item)
  }
  return picked.slice(0, 2)
}

/**
 * 对话末条回答的判定：只有"最后一轮已回答且没有待选卡"时才在末尾出反馈与追问。
 *
 * @param {ReadonlyArray<Record<string, any>>} frames
 * @param {{ running?: boolean, streamText?: string, handoffActive?: boolean }} [options]
 * @returns {{ frame: Record<string, any>, suggestions: string[] } | null}
 */
export function answerFooterModel(frames = [], options = {}) {
  if (options.running === true) return null
  if (typeof options.streamText === 'string' && options.streamText.length > 0) return null
  if (options.handoffActive === true) return null

  let lastUserIndex = -1
  let lastChoiceIndex = -1
  let lastAnswer = null
  let lastAnswerIndex = -1

  frames.forEach((frame, index) => {
    if (isUserSpeech(frame)) lastUserIndex = index
    if (frame.kind === 'choice') lastChoiceIndex = index
    if (
      frame.kind === 'message' &&
      (frame.role === 'assistant' || frame.role === 'operator') &&
      messageText(frame) !== ''
    ) {
      lastAnswer = frame
      lastAnswerIndex = index
    }
  })

  if (lastAnswer === null) return null
  if (lastAnswerIndex < lastUserIndex) return null
  if (lastChoiceIndex > lastUserIndex) return null
  return {
    frame: lastAnswer,
    suggestions: suggestFollowUps(frames),
    // 给模型建议端点用的最近一轮原文（规则回退也用它做卡片选择）
    context: {
      user: lastUserIndex >= 0 ? messageText(frames[lastUserIndex]) : '',
      assistant: messageText(lastAnswer),
    },
  }
}

/**
 * 两条可快捷发送的追问。
 *
 * @param {{ items: ReadonlyArray<string>, onPick?: (text: string) => Promise<unknown> | unknown }} options
 */
export function renderFollowUps(options) {
  const buttons = []
  let busy = false
  const list = el('div', { class: 'follow-ups__list', dataset: { role: 'follow-ups' } })

  async function pick(text) {
    if (busy) return
    busy = true
    for (const button of buttons) button.disabled = true
    try {
      await options.onPick?.(text)
    } finally {
      busy = false
      for (const button of buttons) button.disabled = false
    }
  }

  for (const item of options.items ?? []) {
    const button = el('button', {
      class: 'follow-up',
      type: 'button',
      dataset: { role: 'follow-up' },
      'aria-label': `发送：${item}`,
    }, [el('span', { text: item }), icon('right', 14)])
    button.addEventListener('click', () => void pick(item))
    buttons.push(button)
    list.append(button)
  }

  return el('section', { class: 'follow-ups', 'aria-label': '接着问' }, [
    el('span', { class: 'follow-ups__label', text: '接着问：' }),
    list,
  ])
}

/**
 * 对话末尾的收口块：唯一一条反馈行 + 两条快捷追问。
 *
 * @param {{
 *   value?: 'up'|'down'|null,
 *   onRate?: (value: 'up'|'down') => 'up'|'down'|null,
 *   suggestions?: ReadonlyArray<string>,
 *   onPick?: (text: string) => Promise<unknown> | unknown,
 * }} options
 */
export function renderAnswerFooter(options = {}) {
  return el('section', { class: 'answer-footer', dataset: { role: 'answer-footer' } }, [
    renderFeedbackRow({ value: options.value, onRate: options.onRate }),
    renderFollowUps({ items: options.suggestions ?? [], onPick: options.onPick }),
  ])
}

/**
 * 防诈横幅。
 *
 * @param {{ onDismiss?: () => void }} [options]
 */
export function renderSafetyBanner(options = {}) {
  const close = el('button', {
    class: 'assist-safety__close',
    type: 'button',
    'aria-label': '收起安全提醒',
    dataset: { role: 'safety-dismiss' },
  }, [icon('close-small', 16)])
  close.addEventListener('click', () => options.onDismiss?.())

  return el('section', {
    class: 'ds-alert ds-alert--warning assist-safety',
    role: 'note',
    dataset: { role: 'safety-banner' },
  }, [
    el('span', { class: 'ds-alert__icon' }, [icon('shield', 16)]),
    el('div', { class: 'assist-safety__body' }, [
      el('div', { class: 'ds-alert__title', text: SAFETY.title }),
      el('p', { class: 'ds-alert__desc', text: SAFETY.text }),
    ]),
    close,
  ])
}

/**
 * 顶栏安全提醒（桌面壳）。
 *
 * 整条横幅占一行会把对话往下压，也会在宽屏上被误读成右侧审计面板的一部分；
 * 顶栏只留一条可收起的提示，全文在 `title` 里，窄屏自然省略，不抢消息区。
 *
 * @param {{ onDismiss?: () => void }} [options]
 */
export function renderSafetyChip(options = {}) {
  const close = el('button', {
    class: 'app-header__safety-close',
    type: 'button',
    'aria-label': '收起安全提醒',
    dataset: { role: 'safety-dismiss' },
  }, [icon('close-small', 14)])
  close.addEventListener('click', () => options.onDismiss?.())

  return el('div', {
    class: 'app-header__safety',
    role: 'note',
    dataset: { role: 'safety-banner' },
    title: `${SAFETY.title}：${SAFETY.text}`,
  }, [
    icon('shield', 14),
    el('span', { class: 'app-header__safety-label', text: `${SAFETY.title}：` }),
    el('span', { class: 'app-header__safety-text', text: SAFETY.text }),
    close,
  ])
}

/**
 * 常用业务宫格。
 *
 * 点击一颗 = 发一条普通用户消息；等待期间全组禁用，防止连点造出两轮转账请求。
 *
 * @param {{ onPick: (text: string) => Promise<unknown> | unknown, compact?: boolean }} options
 */
export function renderQuickActions(options) {
  const buttons = []
  let busy = false

  const grid = el('div', {
    class: `assist-actions${options.compact === true ? ' assist-actions--compact' : ''}`,
    dataset: { role: 'quick-actions' },
  })

  async function pick(item) {
    if (busy) return
    busy = true
    for (const button of buttons) button.disabled = true
    try {
      await options.onPick?.(item.text)
    } finally {
      busy = false
      for (const button of buttons) button.disabled = false
    }
  }

  for (const item of QUICK_ACTIONS) {
    const button = el('button', {
      class: 'assist-action',
      type: 'button',
      dataset: { role: 'quick-action', action: item.id },
      'aria-label': `${item.label}：${item.hint}`,
    }, [
      el('span', { class: 'assist-action__label', text: item.label }),
      el('span', { class: 'assist-action__hint', text: item.hint }),
    ])
    button.addEventListener('click', () => void pick(item))
    buttons.push(button)
    grid.append(button)
  }

  return el('section', { class: 'assist-block', 'aria-label': '常用业务' }, [
    el('h3', { class: 'assist-block__title', text: '常用业务' }),
    grid,
  ])
}

/**
 * 服务范围 / 免责声明。
 *
 * @param {{ collapsible?: boolean, open?: boolean }} [options]
 */
export function renderServiceScope(options = {}) {
  const body = el('div', { class: 'assist-scope__body' }, [
    el('p', { class: 'assist-scope__intro', text: SERVICE_SCOPE.intro }),
    el('p', { class: 'assist-scope__hours', text: SERVICE_SCOPE.hours }),
    el('ul', { class: 'assist-scope__list' }, SERVICE_SCOPE.can.map((text) => el('li', { text }))),
    el('p', { class: 'assist-scope__label', text: '暂未开放' }),
    el('ul', { class: 'assist-scope__list assist-scope__list--muted' }, SERVICE_SCOPE.unavailable.map((text) => el('li', { text }))),
    el('div', { class: 'ds-alert ds-alert--info assist-scope__limit' }, [
      el('span', { class: 'ds-alert__icon' }, [icon('lock', 16)]),
      el('p', { class: 'ds-alert__desc', text: SERVICE_SCOPE.limits }),
    ]),
    el('p', { class: 'assist-scope__policy', text: SERVICE_SCOPE.policy }),
  ])

  if (options.collapsible === true) {
    return el('details', { class: 'assist-block assist-block--scope', open: options.open === true }, [
      el('summary', { class: 'assist-block__summary', text: '服务范围与免责声明' }),
      body,
    ])
  }
  return el('section', { class: 'assist-block assist-block--scope', 'aria-label': '服务范围与免责声明' }, [
    el('h3', { class: 'assist-block__title', text: '服务范围与免责声明' }),
    body,
  ])
}

/**
 * 一条助手消息的反馈行。
 *
 * @param {{ value?: 'up'|'down'|null, onRate?: (value: 'up'|'down') => 'up'|'down'|null }} options
 */
export function renderFeedbackRow(options = {}) {
  let current = options.value === 'up' || options.value === 'down' ? options.value : null
  const note = el('span', {
    class: 'assist-feedback__note',
    dataset: { role: 'feedback-note' },
    text: current === null ? '' : FEEDBACK_LOCAL_NOTE,
    hidden: current === null,
  })

  const up = el('button', {
    class: 'assist-feedback__btn',
    type: 'button',
    dataset: { role: 'feedback-up', value: 'up' },
    'aria-label': '这条回答有帮助',
  }, [icon('like', 14), el('span', { text: '有帮助' })])
  const down = el('button', {
    class: 'assist-feedback__btn',
    type: 'button',
    dataset: { role: 'feedback-down', value: 'down' },
    'aria-label': '这条回答没帮助',
  }, [icon('dislike', 14), el('span', { text: '没帮助' })])

  function paint() {
    for (const [button, value] of [[up, 'up'], [down, 'down']]) {
      const active = current === value
      button.classList.toggle('is-active', active)
      button.setAttribute('aria-pressed', active ? 'true' : 'false')
    }
    note.hidden = current === null
    note.textContent = current === null ? '' : FEEDBACK_LOCAL_NOTE
  }

  for (const [button, value] of [[up, 'up'], [down, 'down']]) {
    button.addEventListener('click', () => {
      const result = options.onRate?.(value)
      current = result === 'up' || result === 'down' ? result : null
      paint()
    })
  }

  paint()
  return el('div', {
    class: 'assist-feedback',
    role: 'group',
    'aria-label': '回答反馈',
    dataset: { role: 'feedback' },
  }, [el('span', { class: 'assist-feedback__prompt', text: FEEDBACK_PROMPT }), up, down, note])
}

/**
 * 服务面板（移动抽屉与桌面帮助弹窗共用的内容体）。
 *
 * @param {{
 *   onPick?: (text: string) => Promise<unknown> | unknown,
 *   fontLarge?: boolean,
 *   speechEnabled?: boolean,
 *   speechSupported?: boolean,
 *   onToggleFont?: () => boolean,
 *   onToggleSpeech?: () => boolean,
 *   collapsibleScope?: boolean,
 * }} options
 */
export function renderAssistPanel(options = {}) {
  const toggles = []

  function toggleButton(kind, label, iconName, state, onToggle) {
    const stateText = el('span', { class: 'assist-toggle__state', text: state ? '已开启' : '未开启' })
    const button = el('button', {
      class: `assist-toggle${state ? ' is-on' : ''}`,
      type: 'button',
      dataset: { role: `toggle-${kind}` },
      'aria-pressed': state ? 'true' : 'false',
    }, [icon(iconName, 16), el('span', { class: 'assist-toggle__label', text: label }), stateText])
    button.addEventListener('click', () => {
      const next = onToggle?.() === true
      button.classList.toggle('is-on', next)
      button.setAttribute('aria-pressed', next ? 'true' : 'false')
      stateText.textContent = next ? '已开启' : '未开启'
    })
    toggles.push(button)
    return button
  }

  toggles.push(
    toggleButton('font', '大字模式', 'font', options.fontLarge === true, options.onToggleFont),
  )
  if (options.speechSupported === true) {
    toggles.push(toggleButton('speech', '语音播报', 'speak-on', options.speechEnabled === true, options.onToggleSpeech))
  }

  return el('div', { class: 'assist-panel' }, [
    renderQuickActions({ onPick: options.onPick ?? (() => undefined), compact: true }),
    el('section', { class: 'assist-block', 'aria-label': '辅助功能' }, [
      el('h3', { class: 'assist-block__title', text: '辅助功能' }),
      el('div', { class: 'assist-toggles' }, toggles),
    ]),
    renderServiceScope({ collapsible: options.collapsibleScope === true }),
    el('p', { class: 'assist-safety-note' }, [icon('shield', 14), el('span', { text: SAFETY.text })]),
  ])
}
