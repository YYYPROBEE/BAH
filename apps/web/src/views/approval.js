/**
 * 审批弹窗（施工单 13 §3.2 六要素 + §5 T-WEB-003 / 004）。
 *
 * 六要素：操作类型、金额、收款人、风险级别、等待时长、拒绝理由输入框。
 * 有数据时再补两项：收款人手机（已脱敏）与手续费（来自本 turn 的预演结果）。
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
    const reasonInput = el('textarea', {
      class: 'ds-textarea approval__reason',
      rows: 2,
      maxlength: 500,
      placeholder: '拒绝理由（拒绝时必填，会写入审计）',
      'aria-label': '拒绝理由',
    })
    const hint = el('p', { class: 'approval__hint', role: 'status' })
    const waited = el('span', { class: 'approval__waited', text: '已等待 00:00' })

    const approve = el(
      'button',
      {
        class: 'ds-btn ds-btn--brand ds-btn--md',
        type: 'button',
        onclick: async () => {
          if (frame.challenge !== undefined) {
            hint.textContent = '红级操作必须先完成强验证'
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
          if (reason.length === 0) {
            hint.textContent = '拒绝必须填写理由'
            reasonInput.focus()
            return
          }
          await submit('rejected', reason)
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
                  hint.textContent = result.ok ? '验证通过，可批准执行' : `验证未通过：${result.reason}`
                  approve.disabled = !result.ok
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
              await submit('cancelled')
            },
          }, [icon('close', 16)]),
        ]),
        el('div', { class: 'ds-dialog__body' }, [
          el('dl', { class: 'approval__grid' }, [
            field('操作类型', frame.operation),
            amountField(frame),
            field('收款人', frame.payeeName ?? '—'),
            ...(frame.payeePhone === undefined ? [] : [field('收款手机', frame.payeePhone)]),
            ...(frame.feeText === undefined ? [] : [field('手续费', frame.feeText)]),
            el('div', { class: 'field' }, [
              el('dt', { class: 'field__label', text: '风险级别' }),
              el('dd', { class: 'field__value' }, [el('span', { class: tier.cls, text: tier.label })]),
            ]),
            el('div', { class: 'field' }, [
              el('dt', { class: 'field__label', text: '等待时长' }),
              el('dd', { class: 'field__value' }, [waited]),
            ]),
          ]),
          el('label', { class: 'approval__reason-label', for: 'approval-reason', text: '拒绝理由' }),
          reasonInput,
          hint,
          ...(challengeBox === null ? [] : [challengeBox]),
          el('p', {
            class: 'approval__note',
            text: '票据时效由服务端裁决；界面不计时判决，超时会显示「未执行」。',
          }),
        ]),
        el('div', { class: 'ds-dialog__foot' }, [reject, approve]),
      ],
    )

    reasonInput.id = 'approval-reason'
    if (frame.challenge !== undefined) approve.disabled = true

    const overlay = el('div', { class: 'ds-backdrop approval-backdrop' }, [dialog])
    const startedAt = Date.now()
    const timer = setInterval(() => {
      waited.textContent = `已等待 ${clock(Date.now() - startedAt)}`
    }, 1000)

    /** 提交结论。 */
    async function submit(decision, reason) {
      approve.disabled = true
      reject.disabled = true
      hint.textContent = '提交中…'
      const result = await handlers.onDecision(frame.ticketId, decision, reason)
      if (!result.ok) {
        hint.textContent = `提交失败：${result.reason}`
        approve.disabled = false
        reject.disabled = false
      }
    }

    // 焦点锁定 + Esc 取消
    const onKeydown = (event) => {
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
    // 提示位（`role="status"`）不能停在"提交中…"：结论帧已经到达，这里不收尾的话，
    // 同一个弹窗里会同时出现"提交中…"和"已批准（一次性）"两句互相打脸的话。
    const hint = current.node.querySelector('.approval__hint')
    if (hint !== null) hint.textContent = '结论已生效'
    const dialog = current.node.querySelector('.approval')
    if (dialog !== null) {
      dialog.dataset.state = frame.decision
      dialog.setAttribute('aria-label', DECISION_LABEL[frame.decision] ?? frame.decision)
    }
    const foot = current.node.querySelector('.ds-dialog__foot')
    if (foot !== null) {
      foot.replaceChildren(
        el('div', { class: `approval__result approval__result--${frame.decision}` }, [
          icon(frame.decision === 'allowed-once' ? 'check' : 'error', 16),
          el('strong', { text: DECISION_LABEL[frame.decision] ?? frame.decision }),
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
    current.ticketId = `${frame.ticketId}:closed`
  }

  return { show, close, clear: destroy, isOpen: () => current !== null }
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
