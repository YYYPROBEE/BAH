/**
 * 审批弹窗。
 *
 * 六要素：操作类型、金额、收款人、风险级别、等待时长、拒绝理由输入框。
 * 有数据时再补两项：收款人手机（已脱敏）与手续费（来自本 turn 的预演结果）。
 * 非金额操作（卡片冻结/挂失等）不渲染金额与收款人行，避免出现 ¥0.00 / “—”。
 *
 * 两个刻意的决定：
 * 1. **不做倒计时**：`approval/asked` 不带票据 TTL（偏差 R-WEB-D8），编一个倒计时等于
 *    在资金操作上说假话。这里显示"已等待"，真正的超时由服务端裁决（`approval/decided`）。
 * 2. **客户端不判超时**：倒计时归零不等于拒绝，结论只认 `approval-closed` 帧；
 *    `unavailable` 时界面显示"未执行"（T-WEB-004）。
 *
 * 可访问性：打开即聚焦"拒绝"（安全默认），Tab 锁定在弹窗内，Esc = 取消。
 */

import { el, icon } from '../dom.js'

/** 结论 → 文案。 */
const DECISION_LABEL = {
  'allowed-once': '已批准（一次性）',
  rejected: '已拒绝',
  cancelled: '已取消',
  unavailable: '无人应答（视为拒绝）',
}

/** 级别 → 徽标。 */
const TIER = {
  green: { label: '绿级', cls: 'ds-tag' },
  yellow: { label: '黄级', cls: 'ds-tag ds-tag--warning' },
  red: { label: '红级', cls: 'ds-tag ds-tag--danger' },
  unknown: { label: '级别未知', cls: 'ds-tag' },
}

/** 挑战渠道文案。 */
const CHALLENGE = { face: '人脸识别', sms: '短信验证码', ushield: 'U 盾' }

/** mm:ss。 */
function clock(ms) {
  const total = Math.max(0, Math.floor(ms / 1000))
  const mm = String(Math.floor(total / 60)).padStart(2, '0')
  const ss = String(total % 60).padStart(2, '0')
  return `${mm}:${ss}`
}

/**
 * 造审批弹窗控制器。
 *
 * @param {HTMLElement} root 遮罩挂载点
 * @param {{
 *   onDecision: (ticketId: string, decision: string, reason?: string) => Promise<any>,
 *   onVerify: (ticketId: string) => Promise<any>,
 * }} handlers
 */
export function createApprovalController(root, handlers) {
  /** 当前弹窗状态。 */
  let current = null

  function destroy() {
    if (current === null) return
    clearInterval(current.timer)
    current.node.remove()
    current = null
  }

  /**
   * 打开（或替换）弹窗。
   *
   * @param {Record<string, any>} frame
   */
  function show(frame) {
    // 同一票据重复推送（重连补发）不重开，避免把用户输入冲掉
    if (current !== null && current.ticketId === frame.ticketId) return current.node
    destroy()

    const tier = TIER[frame.tier] ?? TIER.unknown
    // 拒绝理由是否必填由帧决定（红级 / 资金类必填，其余可选），前端不一律强制。
    const reasonRequired = frame.rejectReasonRequired !== false
    const reasonInput = el('textarea', {
      class: 'ds-textarea approval__reason',
      rows: 2,
      maxlength: 500,
      placeholder: reasonRequired ? '拒绝理由（必填，会写入审计）' : '拒绝理由（可选，会写入审计）',
      'aria-label': '拒绝理由',
    })
    const hint = el('p', { class: 'approval__hint', role: 'status' })
    // 打字确认（删除 / 撤销类操作）：前端只做提示与提前拦截，**判定在服务端**。
    // 注入文本可以推动用户点"确认"，推不动用户打出一个指定的词。
    const confirmText = frame.confirmText
    const confirmInput =
      confirmText === undefined
        ? null
        : el('input', {
            class: 'ds-input approval__confirm',
            type: 'text',
            autocomplete: 'off',
            placeholder: `逐字输入「${confirmText}」以确认`,
            'aria-label': `确认词：${confirmText}`,
          })
    const waited = el('span', { class: 'approval__waited', text: '已等待 00:00' })
    // 服务端签发的执行明细（`ApprovalFrame.details`）：空数组/缺省都按"没有"处理。
    const details = Array.isArray(frame.details) ? frame.details : []
    const hasDetails = details.length > 0
    // 红级挑战是否已通过；提交是否在飞。两者决定"批准"入口与 Esc 是否可用。
    let verified = false
    let submitting = false
    const needsChallenge = frame.challenge !== undefined

    const approve = el(
      'button',
      {
        class: 'ds-btn ds-btn--brand ds-btn--md',
        type: 'button',
        onclick: async () => {
          if (needsChallenge && !verified) {
            hint.textContent = '红级操作必须先完成强验证'
            return
          }
          if (confirmInput !== null && confirmInput.value.trim() !== confirmText) {
            hint.textContent = `请逐字输入「${confirmText}」`
            confirmInput.focus()
            return
          }
          await submit('allowed-once')
        },
      },
      [icon('check', 16), '批准执行'],
    )

    const reject = el(
      'button',
      {
        class: 'ds-btn ds-btn--danger-subtle ds-btn--md',
        type: 'button',
        onclick: async () => {
          const reason = reasonInput.value.trim()
          if (reasonRequired && reason.length === 0) {
            hint.textContent = '拒绝必须填写理由'
            reasonInput.focus()
            return
          }
          await submit('rejected', reason.length === 0 ? undefined : reason)
        },
      },
      ['拒绝'],
    )

    const challengeBox =
      frame.challenge === undefined
        ? null
        : el('div', { class: 'approval__challenge', dataset: { channel: frame.challenge } }, [
            el('div', { class: 'approval__challenge-head' }, [
              icon('user', 16),
              el('strong', { text: `需要${CHALLENGE[frame.challenge] ?? frame.challenge}强验证` }),
            ]),
            el('div', { class: 'approval__viewfinder', 'aria-hidden': 'true' }, [
              el('span', { class: 'approval__scanline' }),
            ]),
            el(
              'button',
              {
                class: 'ds-btn ds-btn--secondary ds-btn--sm',
                type: 'button',
                onclick: async () => {
                  hint.textContent = '验证中…'
                  const result = await handlers.onVerify(frame.ticketId)
                  // 成功后必须把 `verified` 记下来：否则"批准"被点时会再撞一次
                  // "必须先完成强验证"的拦路话，红级路径永远走不到 allowed-once。
                  verified = result.ok === true
                  hint.textContent = verified ? '验证通过，可批准执行' : `验证未通过：${result.reason}`
                  approve.disabled = !verified
                },
              },
              ['开始验证'],
            ),
          ])

    const dialog = el(
      'div',
      {
        class: 'ds-dialog approval',
        role: 'dialog',
        'aria-modal': 'true',
        'aria-labelledby': 'approval-title',
        dataset: { ticketId: frame.ticketId },
      },
      [
        el('div', { class: 'ds-dialog__head' }, [
          el('h2', { class: 'ds-dialog__title', id: 'approval-title', text: '需要你确认这笔操作' }),
          el('button', {
            class: 'ds-btn ds-btn--icon ds-btn--ghost ds-dialog__close',
            type: 'button',
            'aria-label': '关闭（视为取消）',
            onclick: async () => {
              // 与 Esc 同口径：结论已生效后这张票在服务端不存在了，再 submit 只会拿回
              // "没有待应答的票据"，把一句吓人的失败糊在结果卡上（2026-10-31 走查）。
              // 这时 X 的语义就是"收起"，不是"再表一次态"。
              if (current !== null && current.closed === true) {
                destroy()
                return
              }
              await submit('cancelled')
            },
          }, [icon('close', 16)]),
        ]),
        el('div', { class: 'ds-dialog__body' }, [
          el('dl', { class: 'approval__grid' }, [
            field('操作类型', frame.operation),
            // 有服务端明细时，金额/收款人/手续费只从明细出——同一笔钱在同一个弹窗里
            // 出现两个来源，用户只能猜哪个是真的（也顺手修掉"非金额操作显示 ¥ —"）。
            ...(hasDetails || frame.amountText === undefined ? [] : [amountField(frame)]),
            ...(hasDetails || frame.payeeName === undefined ? [] : [field('收款人', frame.payeeName)]),
            ...(hasDetails || frame.payeePhone === undefined ? [] : [field('收款手机', frame.payeePhone)]),
            ...(hasDetails || frame.feeText === undefined ? [] : [field('手续费', frame.feeText)]),
            el('div', { class: 'field' }, [
              el('dt', { class: 'field__label', text: '风险级别' }),
              el('dd', { class: 'field__value' }, [el('span', { class: tier.cls, text: tier.label })]),
            ]),
            el('div', { class: 'field' }, [
              el('dt', { class: 'field__label', text: '等待时长' }),
              el('dd', { class: 'field__value' }, [waited]),
            ]),
          ]),
          ...(hasDetails ? [detailsBlock(frame)] : []),
          el('label', {
            class: 'approval__reason-label',
            for: 'approval-reason',
            text: `拒绝理由（${reasonRequired ? '必填' : '可选'}）`,
          }),
          reasonInput,
          hint,
          ...(challengeBox === null ? [] : [challengeBox]),
          ...(confirmInput === null ? [] : [confirmInput]),
          el('p', {
            class: 'approval__note',
            text: '票据时效由服务端裁决；界面不计时判决，超时会显示「未执行」。',
          }),
        ]),
        el('div', { class: 'ds-dialog__foot' }, [reject, approve]),
      ],
    )

    reasonInput.id = 'approval-reason'
    if (needsChallenge) approve.disabled = true

    const overlay = el('div', { class: 'ds-backdrop approval-backdrop' }, [dialog])
    // §5.3：点击遮罩 = 取消。弹窗内部的点击不能冒泡成"取消"，
    // 否则填理由时点一下输入框就把票据取消了。
    dialog.addEventListener('click', (event) => event.stopPropagation())
    // 只认"按下与抬起都在遮罩上"的点击：在理由框里拖选文本、松开时鼠标跑到遮罩上，
    // 浏览器会把 click 落在共同祖先（这里就是遮罩）——光看 click 会误判成"点了遮罩"。
    let pressedOnBackdrop = false
    overlay.addEventListener('mousedown', (event) => {
      pressedOnBackdrop = event.target === overlay
    })
    overlay.addEventListener('click', (event) => {
      const onBackdrop = pressedOnBackdrop && event.target === overlay
      pressedOnBackdrop = false
      if (onBackdrop) void submit('cancelled')
    })
    const startedAt = Date.now()
    const timer = setInterval(() => {
      waited.textContent = `已等待 ${clock(Date.now() - startedAt)}`
    }, 1000)

    /** 提交结论。 */
    async function submit(decision, reason) {
      // 在飞锁：批准 / 拒绝 / 关闭 / Esc 都走这里，否则第二次结论会以
      // `already-decided` 被服务端驳回，前端弹"提交失败"和已生效的结论打架。
      if (submitting) return
      submitting = true
      approve.disabled = true
      reject.disabled = true
      hint.textContent = '提交中…'
      // 没有确认词就保持三参调用：既有渠道/测试的签名不受影响
      const result =
        confirmInput === null
          ? await handlers.onDecision(frame.ticketId, decision, reason)
          : await handlers.onDecision(frame.ticketId, decision, reason, confirmInput.value.trim())
      // 成功：保持禁用，等 `approval-closed` 帧来收尾（`close()` 会替换按钮区）。
      if (result.ok) return
      submitting = false
      hint.textContent = `提交失败：${result.reason}`
      // 回滚要回到"提交前"的可用性：红级挑战未通过时批准必须是禁用的
      // （服务端仍会二次校验，但界面不能摆一个假入口）。
      approve.disabled = needsChallenge && !verified
      reject.disabled = false
    }

    // 焦点锁定 + Esc 取消
    const onKeydown = (event) => {
      // 结论生效后不再是"待应答"模态：Esc 只收起结果卡，Tab 不再被锁在弹窗里。
      if (current !== null && current.closed === true) {
        if (event.key === 'Escape') {
          event.preventDefault()
          destroy()
        }
        return
      }
      if (event.key === 'Escape') {
        event.preventDefault()
        void submit('cancelled')
        return
      }
      if (event.key !== 'Tab') return
      const focusables = [...dialog.querySelectorAll('button, textarea, input, [tabindex]:not([tabindex="-1"])')]
        .filter((node) => node.disabled !== true)
      if (focusables.length === 0) return
      const first = focusables[0]
      const last = focusables[focusables.length - 1]
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }
    dialog.addEventListener('keydown', onKeydown)

    root.append(overlay)
    reject.focus()

    current = { ticketId: frame.ticketId, node: overlay, timer }
    return overlay
  }

  /**
   * 收尾（结论帧到达）。
   *
   * @param {Record<string, any>} frame `approval-closed`
   */
  function close(frame) {
    if (current === null || current.ticketId !== frame.ticketId) return
    clearInterval(current.timer)
    // 结论文案以帧里的 `label` 为准（服务端已按 `decision` 译好），前端不再维护第二份映射。
    const label = frame.label ?? DECISION_LABEL[frame.decision] ?? frame.decision
    const hint = current.node.querySelector('.approval__hint')
    if (hint !== null) hint.textContent = '结论已生效'
    const dialog = current.node.querySelector('.approval')
    if (dialog !== null) {
      dialog.dataset.state = frame.decision
      dialog.setAttribute('aria-label', label)
      // 结论已生效：弹窗不再是 aria-modal（不再吞掉下方的输入与 tab 键）。
      dialog.setAttribute('aria-modal', 'false')
    }
    // 遮罩放行（P1-4）：结论生效后只剩"关掉它"，不能让全屏遮罩继续锁住对话。
    current.node.classList.add('approval-backdrop--passive')
    const foot = current.node.querySelector('.ds-dialog__foot')
    if (foot !== null) {
      foot.replaceChildren(
        el('div', { class: `approval__result approval__result--${frame.decision}` }, [
          icon(frame.decision === 'allowed-once' ? 'check' : 'error', 16),
          el('strong', { text: label }),
          ...(frame.reason === undefined ? [] : [el('span', { class: 'approval__result-reason', text: frame.reason })]),
          ...(frame.decision === 'unavailable' || frame.decision === 'cancelled'
            ? [el('span', { class: 'ds-tag ds-tag--warning', text: '未执行' })]
            : []),
        ]),
        el(
          'button',
          {
            class: 'ds-btn ds-btn--secondary ds-btn--sm',
            type: 'button',
            onclick: () => destroy(),
          },
          ['关闭'],
        ),
      )
    }
    // 结论已生效：弹窗只剩"关掉它"，不再是"待应答"（`isOpen()` 的口径）。
    current.closed = true
    current.ticketId = `${frame.ticketId}:closed`
  }

  return { show, close, clear: destroy, isOpen: () => current !== null && current.closed !== true }
}

/** 普通字段。 */
function field(label, value) {
  return el('div', { class: 'field' }, [
    el('dt', { class: 'field__label', text: label }),
    el('dd', { class: 'field__value', text: value }),
  ])
}

/** 金额字段（未确认 → 灰 + 待确认）。 */
function amountField(frame) {
  const unconfirmed = frame.amountConfirmed !== true
  return el('div', { class: 'field' }, [
    el('dt', { class: 'field__label', text: '金额' }),
    el('dd', { class: `field__value field__value--mono${unconfirmed ? ' field__value--unconfirmed' : ''}`.trim() }, [
      el('span', { text: frame.amountText ?? '¥ —' }),
      ...(unconfirmed
        ? [
            el('span', {
              class: 'ds-tag ds-tag--warning field__pending',
              text: '待确认',
              'aria-label': '金额待确认：本回合尚无工具结果',
            }),
          ]
        : []),
    ]),
  ])
}

/**
 * 执行明细块（服务端签发，`ApprovalFrame.details`）。
 *
 * 视觉口径：强调只用**字体与 `ds-tag`**，不画左侧竖色条——边条既是"颜色即状态"的
 * 二次编码，也在窄屏上吃掉本就不多的行宽（`scripts/verify-no-left-accent.ts` 门禁）。
 *
 * 这里不做任何格式化：`detail.value` 已经是服务端算好并签发的文本，
 * 前端再 `formatCents` 一次就等于建立第二份金额口径。
 */
function detailsBlock(frame) {
  const rows = frame.details.map((detail) => {
    const emphasis = detail.emphasis
    const valueClass =
      emphasis === 'amount' ? 'field__value field__value--mono' : 'field__value'
    const value =
      emphasis === 'risk'
        ? el('dd', { class: valueClass }, [
            el('span', { class: 'ds-tag ds-tag--warning', text: detail.value }),
          ])
        : emphasis === 'date'
          ? el('dd', { class: valueClass }, [el('time', { text: detail.value })])
          : el('dd', { class: valueClass, text: detail.value })
    return el('div', { class: 'field', dataset: { emphasis: emphasis ?? 'plain' } }, [
      el('dt', { class: 'field__label', text: detail.label }),
      value,
    ])
  })
  return el('section', { class: 'approval__details', dataset: { role: 'details' } }, [
    el('h3', { class: 'approval__details-title', text: '执行明细' }),
    el('dl', { class: 'approval__grid' }, rows),
    ...(frame.detailsTruncated === true
      ? [el('p', { class: 'approval__note', text: '明细较多，已省略其余项；完整内容见审计。' })]
      : []),
  ])
}
