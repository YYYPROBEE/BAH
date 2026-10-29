/**
 * 底部抽屉审批（施工单 02 §3.4）。
 *
 * 与桌面弹窗（`views/approval.js`）的关系是**契约对齐、DOM 与状态机独立**（§9.2）：
 * 渲染字段集逐项等于 `ApprovalFrame`（`packages/channels/src/web/frames.ts:135-162`），
 * 端点与校验规则同源（`POST /api/approval/:ticketId`、`POST /api/verify/:ticketId`、
 * `MAX_REASON = 500`），但呈现结构是移动端专属的：锚定底部、安全区、手势条、倒计时。
 * **不 import 桌面控制器**——跨壳 import 控制器就是"双壳共用一套状态机"，
 * 那正是 00 D1 否决响应式单壳的理由反过来咬人。
 *
 * ── 半途关闭一律零 decision（E4 的核心不变量）──────────────────────────
 * ESC / 点背景 / 关闭钮 / 票据到期，都只关视图，**不发任何结论**：票据在服务端仍然有效，
 * 桌面端或另一个标签页还能应答它。这与桌面壳刻意不同——桌面把关闭当 `cancelled` 提交，
 * 移动端窄屏上误触背景的概率高得多，"误触 = 把一笔转账取消掉"是不可接受的代价。
 * 代价如实承认：关掉之后票据还活着却看不见了 ⇒ 用 dock 上的"仍有一笔待确认"提醒条回收口。
 *
 * ── 强验证也是 UI 约束（2026-10-29 实测，与 D11 手势同档）───────────────
 * `http-adapter.ts` 的 `decide()` 不校验 `verify()` 是否通过；本模块在界面层拦
 * （有 `challenge` 就必须先验证成功才提交批准），与桌面壳同款。**不得**在对外材料里
 * 把它写成服务端防线。详见 `gesture-confirm.js` 头注释与 02-adversarial-review.md C1。
 */

import { el, icon } from '../dom.js'
import { createGestureConfirm } from './gesture-confirm.js'

/** 拒绝理由上限（与 `packages/channels/src/http-adapter.ts:126` 的 `MAX_REASON` 同值）。 */
export const MAX_REASON = 500

/** 抽屉入场时长：与 `mobile.css` 的 `.m-sheet` transition 同值；reduced-motion 下为 0（同步进 open）。 */
export const OPEN_MS = 200

/** 倒计时进入"紧迫"前景的剩余秒数（TC-MOB-06）。 */
const URGENT_SECONDS = 60

/** 读屏播报倒计时的两个节点（不逐秒播报，否则读屏用户被数字轰炸）。 */
const COUNTDOWN_ANNOUNCE_SECONDS = [60, 10]

/** 级别 → 徽标（与桌面 `views/approval.js` 的 TIER 同口径）。 */
const TIER = {
  green: { label: '绿级', cls: 'ds-tag' },
  yellow: { label: '黄级', cls: 'ds-tag ds-tag--warning' },
  red: { label: '红级', cls: 'ds-tag ds-tag--danger' },
  unknown: { label: '级别未知', cls: 'ds-tag' },
}

/** 挑战渠道文案（与桌面同源）。 */
const CHALLENGE = { face: '人脸识别', sms: '短信验证码', ushield: 'U 盾' }

/** 结论文案：优先用帧里的 `label`（服务端已译好），前端不维护第二份映射。 */
const DECISION_LABEL = {
  'allowed-once': '已批准（一次性）',
  rejected: '已拒绝',
  cancelled: '已取消',
  unavailable: '无人应答（视为拒绝）',
}

/** ms → mm:ss。 */
function clockText(ms) {
  const total = Math.max(0, Math.floor(ms / 1000))
  const mm = String(Math.floor(total / 60)).padStart(2, '0')
  const ss = String(total % 60).padStart(2, '0')
  return `${mm}:${ss}`
}

/**
 * 造底部抽屉审批。
 *
 * @param {HTMLElement} host 遮罩挂载点（`layout.regions.overlayHost`）
 * @param {object} handlers 两个 handler 都收 shell 归一化后的结构化错误对象
 *        `{ ok, code, message, retryAfterSeconds? }`（§3.0）；shell 负责把 `transport.js`
 *        的 `{ ok, status, code, reason }` 翻成它——**本模块不认 HTTP 状态码**，
 *        认状态码就等于在前端复刻一份服务端的错误分类。
 * @param {(ticketId: string, decision: string, reason?: string) => Promise<{ok: boolean, code?: string, message?: string, retryAfterSeconds?: number}>} handlers.decide
 *        decision 用 `transport.js` 的同一套字面量（`allowed-once` / `rejected`），不另造方言。
 * @param {(ticketId: string) => Promise<{ok: boolean, code?: string, message?: string}>} handlers.verify
 *        挑战渠道由服务端按票据决定，前端只呈现 `frame.challenge`。
 * @param {(error: {code: string, message: string}) => void} [handlers.onError]
 * @param {object} [deps]
 * @param {Window} [deps.win]
 * @param {() => number} [deps.clock] 当前时刻（ms）；缺省 `Date.now`
 * @param {{ gestureConfirm?: boolean }} [deps.capabilities] 能力位（D4）
 * @param {HTMLElement} [deps.reminderHost] 半途关闭后的"仍有一笔待确认"提醒条挂载点（dock）
 * @param {HTMLElement} [deps.resultHost] 服务端关单后的结论条挂载点（feed）
 * @param {object} [deps.gestureDeps] 透传给 `createGestureConfirm` 的测试注入位
 * @param {boolean} [deps.reducedMotion] 测试注入；缺省读 `matchMedia`
 */
export function createApprovalSheet(host, handlers, deps = {}) {
  const win = deps.win ?? globalThis.window
  const doc = win?.document ?? globalThis.document
  const now = deps.clock ?? (() => Date.now())
  const gestureEnabled = deps.capabilities?.gestureConfirm === true

  const reducedMotion = () =>
    deps.reducedMotion ??
    (typeof win?.matchMedia === 'function'
      ? win.matchMedia('(prefers-reduced-motion: reduce)').matches
      : false)

  /** 遮罩节点常驻（防重开闪烁）；内容每次 show 重建，避免上一张票据的字段残留。 */
  const backdrop = el('div', {
    class: 'ds-backdrop m-sheet-backdrop',
    dataset: { role: 'backdrop', state: 'closed' },
    hidden: true,
  })
  host.append(backdrop)

  // 遮罩监听**只挂一次**（不是每次 open 都挂）：挂在 open 里会随重开次数累积，
  // 第 n 次点背景就会触发 n 次关闭。
  // 只认"按下与抬起都在遮罩上"：在理由框里拖选文本、松手时鼠标滑到遮罩，
  // 浏览器会把 click 落在共同祖先（遮罩）——光看 click 会误关（桌面壳踩过的坑）。
  let pressedOnBackdrop = false
  backdrop.addEventListener('mousedown', (event) => {
    pressedOnBackdrop = event.target === backdrop
  })
  backdrop.addEventListener('click', (event) => {
    const onBackdrop = pressedOnBackdrop && event.target === backdrop
    pressedOnBackdrop = false
    if (onBackdrop) closeByUser()
  })

  let state = 'closed'
  /** @type {null | { frame: any, ticketId: string, dialog: HTMLElement }} */
  let current = null
  let openTimer = null
  let tickTimer = null
  let blockTimer = null
  let gesture = null
  /** 用户半途关掉的票据（ticketId → 帧）：不再自动重开，但提醒条留着回收口。 */
  const dismissed = new Map()
  /** 已呈现过结论的票据（`closeByServer` 幂等用）。 */
  const announced = new Set()
  let reminderNode = null
  let restoreFocusTo = null
  /** 已播报过的倒计时节点（保证 TC-MOB-06 的"只播报两次"）。 */
  let announcedMarks = new Set()

  function setState(next) {
    state = next
    backdrop.dataset.state = next
  }

  function clearTimers() {
    if (openTimer !== null) clearTimeout(openTimer)
    if (tickTimer !== null) clearInterval(tickTimer)
    if (blockTimer !== null) clearInterval(blockTimer)
    openTimer = null
    tickTimer = null
    blockTimer = null
  }

  /** 一个字段行（金额行走降级：`amountConfirmed !== true` ⇒ 灰 + "待核实"）。 */
  function field(label, valueNode) {
    return el('div', { class: 'field', dataset: { label } }, [
      el('dt', { class: 'field__label', text: label }),
      el('dd', { class: 'field__value' }, [valueNode]),
    ])
  }

  function textField(label, value) {
    return field(label, el('span', { text: value }))
  }

  /** 金额行：审批帧的 `amountConfirmed` **恒为 false**（frames.ts:145-149 的口径注释），
   *  所以这里必然挂"待核实"——不是漏推导，是"待批准的数字不得渲染成已确认"。 */
  function amountField(frame) {
    const unconfirmed = frame.amountConfirmed !== true
    return el('div', { class: 'field', dataset: { label: '金额' } }, [
      el('dt', { class: 'field__label', text: '金额' }),
      el('dd', {
        class: `field__value field__value--mono${unconfirmed ? ' field__value--unconfirmed' : ''}`.trim(),
      }, [
        el('span', { text: frame.amountText ?? '¥ —' }),
        ...(unconfirmed
          ? [
              el('span', {
                class: 'ds-tag ds-tag--warning field__pending',
                text: '待核实',
                'aria-label': '金额待核实：票据尚未核销，批准执行后以工具结果为准',
              }),
            ]
          : []),
      ]),
    ])
  }

  function tierField(frame) {
    const tier = TIER[frame.tier] ?? TIER.unknown
    return field('风险级别', el('span', { class: tier.cls, text: tier.label }))
  }

  /**
   * 票据时效行。
   *
   * `expiresAt` 是**可选**字段：有它就做倒计时（客户端只做视觉，判决仍在服务端），
   * 没有它就退化成桌面壳那句"已等待 mm:ss"——**编一个不存在的 TTL 等于在资金操作上说假话**
   * （桌面 `views/approval.js` 头注释的偏差 R-WEB-D8 同一条纪律）。
   */
  function createExpiry(frame, liveNode) {
    const timeNode = el('time', { dataset: { role: 'countdown' }, text: '—' })
    const row = el('p', { class: 'm-sheet-countdown' }, [
      el('span', { class: 'icon icon--clock', 'aria-hidden': 'true' }),
      timeNode,
    ])
    const startedAt = now()
    let expired = false

    function tick() {
      if (frame.expiresAt === undefined) {
        timeNode.textContent = `已等待 ${clockText(now() - startedAt)}`
        return
      }
      const remainMs = frame.expiresAt - now()
      const remainSeconds = Math.max(0, Math.ceil(remainMs / 1000))
      timeNode.textContent = `剩余 ${clockText(remainMs)}`
      row.classList.toggle('m-sheet-countdown--urgent', remainSeconds <= URGENT_SECONDS)
      // 读屏只在 60s / 10s 两个节点播报（不逐秒）
      for (const mark of COUNTDOWN_ANNOUNCE_SECONDS) {
        if (announcedMarks.has(mark) || remainSeconds > mark) continue
        announcedMarks.add(mark)
        liveNode.textContent = `票据剩余 ${String(remainSeconds)} 秒`
      }
      if (remainMs <= 0 && !expired) {
        expired = true
        // 到期 = 半途关闭语义：**零 decision**，结论只认服务端 `approval-closed` 帧。
        // 文案落进 resultHost（feed）而不是抽屉里——抽屉马上就要关，写在里面等于没人看得见。
        announceLocal('票据在本地已过期，未提交任何结论；以服务端裁决为准。', 'unavailable')
        closeByUser()
      }
    }

    tick()
    tickTimer = setInterval(tick, 1000)
    return row
  }

  let errorNode = null
  function showError(message) {
    if (errorNode === null) return
    errorNode.hidden = false
    errorNode.textContent = message
  }
  function clearError() {
    if (errorNode === null) return
    errorNode.hidden = true
    errorNode.textContent = ''
  }

  /** 焦点陷阱：Tab 在抽屉内循环（首↔尾）。
   *  只看 `disabled`，不看 `offsetParent`——jsdom 里后者恒为 null，用它会让陷阱在测试里静默失效。 */
  function trapFocus(event, dialog) {
    if (event.key !== 'Tab') return
    const focusables = [
      ...dialog.querySelectorAll('button, textarea, input, [tabindex]:not([tabindex="-1"])'),
    ].filter((node) => node.disabled !== true)
    if (focusables.length === 0) return
    const first = focusables[0]
    const last = focusables[focusables.length - 1]
    if (event.shiftKey && doc.activeElement === first) {
      event.preventDefault()
      last.focus()
    } else if (!event.shiftKey && doc.activeElement === last) {
      event.preventDefault()
      first.focus()
    }
  }

  /** 建一张票据的抽屉内容。 */
  function build(frame) {
    const reasonRequired = frame.rejectReasonRequired === true
    const needsChallenge = frame.challenge !== undefined
    let verified = false
    let gestureConfirmed = !gestureEnabled
    let submitting = false

    const liveNode = el('p', {
      class: 'm-gesture-live',
      'aria-live': 'polite',
      dataset: { role: 'countdown-live' },
    })

    const reasonInput = el('textarea', {
      class: 'ds-textarea',
      rows: 2,
      maxlength: String(MAX_REASON),
      dataset: { role: 'reason' },
      placeholder: reasonRequired ? '拒绝理由（必填，会写入审计）' : '拒绝理由（可选，会写入审计）',
      'aria-label': '拒绝理由',
    })
    const reasonCount = el('span', {
      class: 'm-sheet-reason__count',
      dataset: { role: 'reason-count' },
      text: `0/${String(MAX_REASON)}`,
    })

    // `maxlength` 属性挡不住脚本赋值与部分输入法粘贴 ⇒ 在 JS 里再夹一次（TC-MOB-04）
    reasonInput.addEventListener('input', () => {
      if (reasonInput.value.length > MAX_REASON) {
        reasonInput.value = reasonInput.value.slice(0, MAX_REASON)
      }
      reasonCount.textContent = `${String(reasonInput.value.length)}/${String(MAX_REASON)}`
    })

    const approveButton = el('button', {
      class: 'ds-btn ds-btn--primary ds-btn--lg',
      type: 'button',
      dataset: { role: 'approve' },
      text: '批准',
    })
    const rejectButton = el('button', {
      class: 'ds-btn ds-btn--danger-subtle ds-btn--lg',
      type: 'button',
      dataset: { role: 'reject' },
      text: '拒绝',
    })
    const closeButton = el('button', {
      class: 'ds-btn ds-btn--icon ds-btn--sm m-sheet__close',
      type: 'button',
      dataset: { role: 'close' },
      'aria-label': '关闭（不提交结论）',
    }, [icon('close-small', 16)])

    const gestureHost = el('div', { dataset: { role: 'gesture' } })
    const challengeBox = needsChallenge
      ? el('div', { class: 'm-sheet-challenge', dataset: { role: 'challenge', channel: String(frame.challenge) } }, [
          el('div', { class: 'm-sheet-challenge__head' }, [
            el('span', { class: 'icon icon--warning', 'aria-hidden': 'true' }),
            el('span', { text: `需要${CHALLENGE[frame.challenge] ?? String(frame.challenge)}强验证` }),
          ]),
          el('p', {
            class: 'm-gesture__note',
            text: '强验证由服务端票据决定；未通过时批准不会提交。',
          }),
        ])
      : null

    errorNode = el('p', { class: 'm-sheet-error', role: 'alert', dataset: { role: 'error' }, hidden: true })

    const dialog = el('section', {
      class: 'ds-drawer m-sheet',
      role: 'dialog',
      'aria-modal': 'true',
      'aria-labelledby': 'm-sheet-title',
      dataset: {
        role: 'sheet',
        ticketId: frame.ticketId,
        callId: frame.callId,
        name: frame.name,
        tier: frame.tier,
      },
    }, [
      el('header', { class: 'ds-drawer__head m-sheet__head' }, [
        el('h2', { class: 'm-sheet__title', id: 'm-sheet-title', text: '操作确认' }),
        closeButton,
      ]),
      el('div', { class: 'ds-drawer__body m-sheet__body' }, [
        el('dl', { class: 'm-sheet-facts' }, [
          textField('操作类型', frame.operation),
          amountField(frame),
          textField('收款人', frame.payeeName ?? '—'),
          ...(frame.payeePhone === undefined ? [] : [textField('收款手机', frame.payeePhone)]),
          ...(frame.feeText === undefined ? [] : [textField('手续费', frame.feeText)]),
          tierField(frame),
          createExpiry(frame, liveNode),
        ]),
        ...(challengeBox === null ? [] : [challengeBox]),
        gestureEnabled ? gestureHost : null,
        el('label', { class: 'm-sheet-reason' }, [
          el('span', {
            class: 'm-sheet-reason__label',
            text: `拒绝理由（${reasonRequired ? '必填' : '可选'}）`,
          }),
          reasonInput,
          reasonCount,
        ]),
        errorNode,
        liveNode,
        el('p', {
          class: 'm-gesture__note',
          text: '关闭抽屉不会提交任何结论；票据时效由服务端裁决。',
        }),
      ]),
      el('footer', { class: 'm-sheet__actions' }, [rejectButton, approveButton]),
    ])

    function syncInterlock() {
      // 三重门：动画期不可交互（防误触）／手势未到位／提交在飞。
      // 强验证**不在这里**锁按钮：它是"点批准之后必须先过的一道"，锁死按钮会让
      // 读屏用户看到一个永远按不动的"批准"却不知道为什么（TC-MOB-07 走 onApprove 分支）。
      const blocked = submitting || state === 'opening' || state === 'verifying' || state === 'submitting'
      approveButton.disabled = blocked || !gestureConfirmed
      rejectButton.disabled = blocked
      closeButton.disabled = blocked
    }

    async function submit(decision, reason) {
      if (submitting) return
      submitting = true
      setState('submitting')
      syncInterlock()
      clearError()
      const result = await handlers.decide(frame.ticketId, decision, reason)
      if (result?.ok === true) {
        // 成功不自己关：等 `approval-closed` 帧来收尾（结论以服务端为准）
        return
      }
      submitting = false
      setState('open')
      syncInterlock()
      // `result` 是 shell 归一化后的结构化错误对象 `{ ok, code, message, retryAfterSeconds? }`（§3.0）
      const code = String(result?.code ?? 'submit-failed')
      const message = String(result?.message ?? code)
      if (code === 'turn-rate-limited') {
        const seconds = Number(result?.retryAfterSeconds ?? 0)
        showError(seconds > 0 ? `操作太频繁，请 ${String(seconds)} 秒后再试。` : '操作太频繁，请稍后再试。')
        if (seconds > 0) blockFor(seconds)
      } else if (code === 'turn-conflict-handoff') {
        showError('当前会话已由人工接管，消息暂不可发送。')
      } else {
        showError(`提交失败：${message}`)
      }
      handlers.onError?.({ code, message })
    }

    /** 429：只禁提交钮并倒计时，不锁整个抽屉（§3.9）。 */
    function blockFor(seconds) {
      approveButton.disabled = true
      rejectButton.disabled = true
      let remain = seconds
      const countdown = setInterval(() => {
        remain -= 1
        if (remain > 0) {
          showError(`操作太频繁，请 ${String(remain)} 秒后再试。`)
          return
        }
        clearInterval(countdown)
        blockTimer = null
        submitting = false
        setState('open')
        syncInterlock()
        clearError()
      }, 1000)
      blockTimer = countdown
    }

    async function onApprove() {
      if (approveButton.disabled) return
      clearError()
      // 红级：先强验证。失败/取消 ⇒ 回 open + inline 错误，**decide 零调用**（TC-MOB-07）
      if (needsChallenge && !verified) {
        setState('verifying')
        syncInterlock()
        const result = await handlers.verify(frame.ticketId)
        if (result?.ok !== true) {
          setState('open')
          submitting = false
          syncInterlock()
          showError(`强验证未通过：${String(result?.message ?? result?.code ?? 'verify-failed')}`)
          handlers.onError?.({
            code: String(result?.code ?? 'verify-failed'),
            message: String(result?.message ?? '强验证未通过'),
          })
          return
        }
        verified = true
        setState('open')
        syncInterlock()
      }
      await submit('allowed-once')
    }

    function onReject() {
      if (rejectButton.disabled) return
      const reason = reasonInput.value.trim()
      if (reasonRequired && reason.length === 0) {
        showError('拒绝必须填写理由（会写入审计）')
        reasonInput.focus()
        return
      }
      clearError()
      void submit('rejected', reason.length === 0 ? undefined : reason)
    }

    approveButton.addEventListener('click', () => void onApprove())
    rejectButton.addEventListener('click', onReject)
    closeButton.addEventListener('click', () => closeByUser())

    if (gestureEnabled) {
      gesture = createGestureConfirm(gestureHost, {
        onConfirm() {
          gestureConfirmed = true
          syncInterlock()
        },
        onAbort() {
          // 半途松手：零 decision，只把批准钮锁回去
          gestureConfirmed = false
          syncInterlock()
        },
        deps: deps.gestureDeps,
      })
    }

    dialog.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        closeByUser()
        return
      }
      trapFocus(event, dialog)
    })

    return { dialog, syncInterlock }
  }

  /** 半途关闭的回收口：dock 上一条"仍有一笔待确认"，点它重开。 */
  function renderReminder() {
    const reminderHost = deps.reminderHost
    if (reminderHost === undefined) return
    reminderNode?.remove()
    reminderNode = null
    if (dismissed.size === 0) return
    // 只显示最新一张：dock 只有一行高度，堆多条会把输入框挤出屏幕
    let ticketId = null
    let frame = null
    for (const entry of dismissed) {
      ticketId = entry[0]
      frame = entry[1]
    }
    if (ticketId === null || frame === null) return
    const reopenButton = el('button', {
      class: 'ds-btn ds-btn--secondary ds-btn--sm m-sheet-reminder__action',
      type: 'button',
      text: '去确认',
    })
    reminderNode = el('div', { class: 'm-sheet-reminder', dataset: { role: 'reminder', ticketId } }, [
      el('span', { class: 'icon icon--warning', 'aria-hidden': 'true' }),
      el('span', { text: `仍有一笔待确认：${frame.operation}` }),
      reopenButton,
    ])
    reopenButton.addEventListener('click', () => {
      dismissed.delete(ticketId)
      show(frame)
    })
    reminderHost.append(reminderNode)
  }

  /**
   * 打开一张票据（**显式意图**）：同帧重复调用幂等，不同票据替换。
   *
   * @param {Record<string, any>} frame `ApprovalFrame`
   */
  function show(frame) {
    if (current !== null && current.ticketId === frame.ticketId && state !== 'closed') {
      return current.dialog
    }
    dismissed.delete(frame.ticketId)
    renderReminder()
    announcedMarks = new Set()
    open(frame)
    return current?.dialog
  }

  /**
   * 由 store 同步驱动的"提议打开"：尊重用户的半途关闭（这张票不再自动重开）。
   * 这是它与 `show()` 的唯一区别——`show()` 是显式意图（点提醒条 / 测试），必须打开。
   */
  function offer(frame) {
    if (dismissed.has(frame.ticketId)) {
      renderReminder()
      return null
    }
    return show(frame)
  }

  function open(frame) {
    // 已经过期的票据不要开：开一个只能看不能用的抽屉，比不开更让人以为"还能救"
    if (typeof frame.expiresAt === 'number' && frame.expiresAt <= now()) {
      announcedMarks = new Set()
      announceLocal('票据在本地已过期，未提交任何结论；以服务端裁决为准。', 'unavailable')
      return
    }
    teardown()
    restoreFocusTo = doc.activeElement
    // 先登记再 build：build 里的倒计时首帧就可能判定过期并调 closeByUser，
    // 那时 current 若还是 null，"半途关闭"会被当成"没开过"而丢掉提醒条
    current = { frame, ticketId: frame.ticketId, dialog: null }
    const built = build(frame)
    current.dialog = built.dialog
    backdrop.hidden = false
    backdrop.replaceChildren(built.dialog)

    const openMs = reducedMotion() ? 0 : OPEN_MS
    if (openMs <= 0) {
      // reduced-motion：**同步**进 open，不依赖 transitionend（R5：那个事件在降级下不触发，会卡死在 opening）
      setState('open')
      built.syncInterlock()
      focusFirst(built.dialog)
    } else {
      setState('opening')
      built.syncInterlock()
      openTimer = setTimeout(() => {
        openTimer = null
        if (state !== 'opening') return
        setState('open')
        built.syncInterlock()
        focusFirst(built.dialog)
      }, openMs)
    }
  }

  /** 焦点落在"拒绝"：安全默认（与桌面 `views/approval.js` 一致），不是"第一个可聚焦元素"——
   *  窄屏上第一个是关闭钮，把焦点放那儿等于让读屏用户一回车就把票据收起来。 */
  function focusFirst(dialog) {
    const target = dialog.querySelector('[data-role="reject"]') ?? dialog.querySelector('button')
    target?.focus()
  }

  function teardown() {
    clearTimers()
    gesture?.destroy()
    gesture = null
    backdrop.replaceChildren()
    backdrop.hidden = true
    current = null
    errorNode = null
    setState('closed')
  }

  /**
   * 用户半途关闭：**零 decision**（E4）。票据仍有效 ⇒ 记进 dismissed 并挂提醒条。
   */
  function closeByUser() {
    if (current === null) return
    const { frame } = current
    teardown()
    dismissed.set(frame.ticketId, frame)
    renderReminder()
    restoreFocus()
  }

  /** 服务端关单（超时 / 他端已决 / 接管）：同样零本地 decision，只呈现结论。 */
  function closeByServer(frame) {
    const wasOpen = current !== null && current.ticketId === frame.ticketId
    dismissed.delete(frame.ticketId)
    renderReminder()
    if (wasOpen) {
      teardown()
      restoreFocus()
    }
    // 幂等：`sync` 每次 store 变化都会把所有 approval-closed 帧再喂一遍（替换语义下帧对象不变），
    // 不去重就会在 feed 里堆出一排同样的结论条
    if (announced.has(frame.ticketId)) return
    announced.add(frame.ticketId)
    const label = frame.label ?? DECISION_LABEL[frame.decision] ?? String(frame.decision)
    announceResult(frame, label)
  }

  /** 结论条：抽屉已关，结论落在 feed 里（不重开一个只读的抽屉抢焦点）。 */
  function announceResult(frame, label) {
    const resultNode = el('div', {
      class: `m-sheet-result m-sheet-result--${String(frame.decision)}`,
      dataset: { role: 'result', ticketId: frame.ticketId, decision: String(frame.decision) },
    }, [
      icon(frame.decision === 'allowed-once' ? 'check' : 'error', 16),
      el('strong', { text: label }),
      ...(frame.reason === undefined ? [] : [el('span', { text: frame.reason })]),
      ...(frame.decision === 'unavailable' || frame.decision === 'cancelled'
        ? [el('span', { class: 'ds-tag ds-tag--warning', text: '未执行' })]
        : []),
    ])
    deps.resultHost?.append(resultNode)
  }

  /** 本地事件（票据到期等）的可见交代：抽屉已经关了，话必须落在 feed 里才有人看得见。 */
  function announceLocal(message, tone) {
    deps.resultHost?.append(
      el('div', {
        class: `m-sheet-result m-sheet-result--${String(tone ?? 'cancelled')}`,
        dataset: { role: 'local-notice' },
      }, [icon('clock', 16), el('span', { text: message })]),
    )
  }

  function restoreFocus() {
    // 归还 show 前的焦点：抽屉抢走焦点却不还，键盘用户会"掉进虚空"
    if (restoreFocusTo !== null && typeof restoreFocusTo.focus === 'function') {
      restoreFocusTo.focus()
    }
    restoreFocusTo = null
  }

  return {
    show,
    offer,
    closeByUser,
    closeByServer,
    dispose() {
      teardown()
      dismissed.clear()
      announced.clear()
      reminderNode?.remove()
      reminderNode = null
      backdrop.remove()
    },
    get state() {
      return state
    },
    get ticketId() {
      return current?.ticketId ?? null
    },
    node: backdrop,
    get reminder() {
      return reminderNode
    },
    get gesture() {
      return gesture
    },
  }
}
