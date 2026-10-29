/**
 * 底部抽屉审批用例（TC-MOB-01..08、TC-MOB-28 抽屉半边、TC-MOB-30 抽屉半边）。
 *
 * 桩纪律：只注入 `clock`（倒计时）、`reducedMotion`（matchMedia 桩的等价物）、
 * `gestureDeps.trackWidth`（jsdom 无 CSS 布局）与两个 handler spy。
 * **生产组装路径不经过这里**——shell.js 用真实 `window` 与真实 transport（A1 探针）。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { MAX_REASON, OPEN_MS, createApprovalSheet } from './approval-sheet.js'

/** `ApprovalFrame` 夹具：字段集与 `packages/channels/src/web/frames.ts:135-162` 逐项对齐。 */
function approvalFrame(overrides = {}) {
  return {
    kind: 'approval',
    seq: 7,
    at: 1_000,
    ticketId: 'tk-1',
    callId: 'call-1',
    name: 'transfer_create',
    operation: '转账',
    amountText: '¥ 800.00',
    amountConfirmed: false,
    payeeName: '王建国',
    payeePhone: '138****4321',
    feeText: '¥ 0.00',
    tier: 'yellow',
    rejectReasonRequired: true,
    ...overrides,
  }
}

function closedFrame(overrides = {}) {
  return {
    kind: 'approval-closed',
    seq: 8,
    at: 2_000,
    ticketId: 'tk-1',
    decision: 'allowed-once',
    label: '已批准（一次性）',
    ...overrides,
  }
}

describe('底部抽屉审批', () => {
  let host
  let resultHost
  let reminderHost
  let decide
  let verify
  let onError
  let nowMs

  beforeEach(() => {
    vi.useFakeTimers()
    nowMs = 1_000_000
    host = document.createElement('div')
    resultHost = document.createElement('div')
    reminderHost = document.createElement('div')
    document.body.append(host, resultHost, reminderHost)
    decide = vi.fn(async () => ({ ok: true, code: 'ok', message: '' }))
    verify = vi.fn(async () => ({ ok: true, code: 'ok', message: '' }))
    onError = vi.fn()
  })

  afterEach(() => {
    vi.useRealTimers()
    host.remove()
    resultHost.remove()
    reminderHost.remove()
  })

  /** 造抽屉并推进到 open。 */
  function mount(frame = approvalFrame(), overrides = {}) {
    const sheet = createApprovalSheet(
      host,
      { decide, verify, onError },
      {
        clock: () => nowMs,
        reminderHost,
        resultHost,
        gestureDeps: { trackWidth: () => 100 },
        ...overrides,
      },
    )
    sheet.show(frame)
    if (overrides.reducedMotion !== true) vi.advanceTimersByTime(OPEN_MS)
    return sheet
  }

  const q = (role) => host.querySelector(`[data-role="${role}"]`)
  const text = (role) => q(role)?.textContent ?? null

  /**
   * 只冲微任务，不动定时器。
   *
   * 用 `vi.runAllTimersAsync()` 会撞墙：抽屉的倒计时是 `setInterval`，永远到期，
   * "跑完所有定时器"在这种场景下没有终点。
   */
  async function flush() {
    for (let index = 0; index < 8; index += 1) await Promise.resolve()
  }

  /** 逐秒推进（时钟与假定时器一起走）。 */
  function tickSeconds(seconds) {
    for (let index = 0; index < seconds; index += 1) {
      nowMs += 1000
      vi.advanceTimersByTime(1000)
    }
  }

  it('TC-MOB-01 ApprovalFrame 字段集逐项出现在 DOM，一个不多一个不少', () => {
    mount()

    expect(text('sheet')).toContain('转账')
    expect(host.textContent).toContain('¥ 800.00')
    expect(host.textContent).toContain('王建国')
    // 手机号是后端脱敏后的原文：前端不加工、不尝试还原
    expect(host.textContent).toContain('138****4321')
    expect(host.textContent).toContain('¥ 0.00')
    expect(host.textContent).toContain('黄级')
    expect(q('sheet').dataset.ticketId).toBe('tk-1')
    expect(q('sheet').dataset.callId).toBe('call-1')
    expect(q('sheet').dataset.name).toBe('transfer_create')
  })

  it('TC-MOB-01 amountConfirmed=false ⇒ 金额挂"待核实"警告标签（审批帧恒为 false 是口径不是漏推导）', () => {
    mount()
    const pending = host.querySelector('.field__pending')

    expect(pending).not.toBeNull()
    expect(pending.textContent).toBe('待核实')
    expect(pending.classList.contains('ds-tag--warning')).toBe(true)
    expect(host.querySelector('[data-label="金额"] .field__value').classList.contains('field__value--unconfirmed')).toBe(true)
  })

  it('TC-MOB-01 可选字段缺席时不渲染空行（payeePhone/feeText 为 undefined）', () => {
    mount(approvalFrame({ payeePhone: undefined, feeText: undefined }))
    const labels = [...host.querySelectorAll('.field')].map((node) => node.dataset.label)

    // 票据时效行走的是 `.m-sheet-countdown`（不是 `.field`），所以不在这份 label 清单里
    expect(labels).toEqual(['操作类型', '金额', '收款人', '风险级别'])
  })

  it('TC-MOB-01 可选字段齐备时逐行都在（收款手机 + 手续费）', () => {
    mount()
    const labels = [...host.querySelectorAll('.field')].map((node) => node.dataset.label)

    expect(labels).toEqual(['操作类型', '金额', '收款人', '收款手机', '手续费', '风险级别'])
    expect(host.querySelector('.m-sheet-countdown')).not.toBeNull()
  })

  it('TC-MOB-01 有 expiresAt 时呈现倒计时，没有时退化成"已等待"（不编造 TTL）', () => {
    mount(approvalFrame({ expiresAt: nowMs + 120_000 }))
    expect(text('countdown')).toBe('剩余 02:00')

    host.replaceChildren()
    const plain = createApprovalSheet(host, { decide, verify }, { clock: () => nowMs })
    plain.show(approvalFrame())
    vi.advanceTimersByTime(OPEN_MS)
    expect(text('countdown')).toBe('已等待 00:00')
    tickSeconds(3)
    expect(text('countdown')).toBe('已等待 00:03')
  })

  it('TC-MOB-02 状态机 closed→opening→open：opening 期按钮不可交互', () => {
    const sheet = createApprovalSheet(host, { decide, verify }, { clock: () => nowMs })
    expect(sheet.state).toBe('closed')

    sheet.show(approvalFrame())
    expect(sheet.state).toBe('opening')
    expect(q('approve').disabled).toBe(true)
    expect(q('reject').disabled).toBe(true)

    vi.advanceTimersByTime(OPEN_MS)
    expect(sheet.state).toBe('open')
    expect(q('approve').disabled).toBe(false)
    expect(q('reject').disabled).toBe(false)
  })

  it('TC-MOB-02 reduced-motion ⇒ 同步进 open，不等过渡（R5：不依赖 transitionend）', () => {
    const sheet = mount(approvalFrame(), { reducedMotion: true })

    expect(sheet.state).toBe('open')
    expect(q('approve').disabled).toBe(false)
  })

  it('TC-MOB-03 批准（非红级）⇒ decide 恰一次、结论帧到达后 closed', async () => {
    const sheet = mount()
    q('approve').dispatchEvent(new Event('click'))
    await flush()

    expect(decide).toHaveBeenCalledTimes(1)
    expect(decide).toHaveBeenCalledWith('tk-1', 'allowed-once', undefined)
    expect(verify).toHaveBeenCalledTimes(0)
    expect(sheet.state).toBe('submitting')

    sheet.closeByServer(closedFrame())
    expect(sheet.state).toBe('closed')
    expect(resultHost.textContent).toContain('已批准（一次性）')
  })

  it('TC-MOB-03 结论帧重复喂入不会在 feed 里堆出一排同样的结论条', () => {
    const sheet = mount()
    sheet.closeByServer(closedFrame())
    sheet.closeByServer(closedFrame())

    expect(resultHost.querySelectorAll('[data-role="result"]').length).toBe(1)
  })

  it('TC-MOB-04 拒绝理由必填且为空/全空白 ⇒ decide 零调用', () => {
    mount()
    q('reject').dispatchEvent(new Event('click'))
    expect(decide).toHaveBeenCalledTimes(0)
    expect(text('error')).toBe('拒绝必须填写理由（会写入审计）')

    q('reason').value = '   '
    q('reason').dispatchEvent(new Event('input'))
    q('reject').dispatchEvent(new Event('click'))
    expect(decide).toHaveBeenCalledTimes(0)
  })

  it('TC-MOB-04 理由 501 字 ⇒ 值被截到 500、计数显示 500/500', async () => {
    mount()
    const reason = q('reason')
    reason.value = 'a'.repeat(501)
    reason.dispatchEvent(new Event('input'))

    expect(reason.value.length).toBe(MAX_REASON)
    expect(text('reason-count')).toBe('500/500')
    expect(reason.getAttribute('maxlength')).toBe('500')

    q('reject').dispatchEvent(new Event('click'))
    await flush()
    expect(decide).toHaveBeenCalledWith('tk-1', 'rejected', 'a'.repeat(500))
  })

  it('TC-MOB-04 rejectReasonRequired=false 时空理由也放行（前端不一律强制）', async () => {
    mount(approvalFrame({ rejectReasonRequired: false }))
    q('reject').dispatchEvent(new Event('click'))
    await flush()

    expect(decide).toHaveBeenCalledTimes(1)
    expect(decide).toHaveBeenCalledWith('tk-1', 'rejected', undefined)
  })

  it('TC-MOB-05 ESC ⇒ closed 且零 decision，并留下"仍有一笔待确认"回收口', () => {
    const sheet = mount()
    q('sheet').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))

    expect(sheet.state).toBe('closed')
    expect(decide).toHaveBeenCalledTimes(0)
    expect(verify).toHaveBeenCalledTimes(0)
    expect(reminderHost.textContent).toContain('仍有一笔待确认：转账')
  })

  it('TC-MOB-05 背景点击（按下与抬起都在背景）⇒ closed 且零 decision', () => {
    const sheet = mount()
    const backdrop = q('backdrop')
    backdrop.dispatchEvent(new Event('mousedown', { bubbles: true }))
    backdrop.dispatchEvent(new Event('click', { bubbles: true }))

    expect(sheet.state).toBe('closed')
    expect(decide).toHaveBeenCalledTimes(0)
  })

  it('TC-MOB-05 抽屉内部点击不关（在理由框里拖选文本松手滑到遮罩也不算）', () => {
    const sheet = mount()
    const backdrop = q('backdrop')
    q('reason').dispatchEvent(new Event('mousedown', { bubbles: true }))
    backdrop.dispatchEvent(new Event('click', { bubbles: true }))

    expect(sheet.state).toBe('open')
    expect(decide).toHaveBeenCalledTimes(0)
  })

  it('TC-MOB-05 同帧再 show 可重开且字段完整（半途关闭不毁票据）', async () => {
    const frame = approvalFrame()
    const sheet = mount(frame)
    sheet.closeByUser()
    expect(sheet.state).toBe('closed')

    sheet.show(frame)
    vi.advanceTimersByTime(OPEN_MS)

    expect(sheet.state).toBe('open')
    expect(host.textContent).toContain('¥ 800.00')
    expect(host.textContent).toContain('138****4321')
    expect(decide).toHaveBeenCalledTimes(0)

    // 提醒条随重开消失（票据又可见了，留两条入口是噪音）
    q('reject').dispatchEvent(new Event('click'))
    q('reason').value = '不转了'
    q('reason').dispatchEvent(new Event('input'))
    q('reject').dispatchEvent(new Event('click'))
    await flush()
    expect(decide).toHaveBeenCalledTimes(1)
  })

  it('TC-MOB-05 offer 尊重半途关闭：同一张票不再自动重开', () => {
    const frame = approvalFrame()
    const sheet = mount(frame)
    sheet.closeByUser()

    expect(sheet.offer(frame)).toBeNull()
    expect(sheet.state).toBe('closed')

    // 点提醒条 = 显式意图 ⇒ 重开
    reminderHost.querySelector('button').dispatchEvent(new Event('click'))
    vi.advanceTimersByTime(OPEN_MS)
    expect(sheet.state).toBe('open')
  })

  it('TC-MOB-06 expiresAt 到期 ⇒ 自动 closed + 可见交代 + decide 零调用', () => {
    const sheet = mount(approvalFrame({ expiresAt: nowMs + 5_000 }))
    tickSeconds(5)

    expect(sheet.state).toBe('closed')
    expect(decide).toHaveBeenCalledTimes(0)
    expect(resultHost.textContent).toContain('票据在本地已过期，未提交任何结论')
  })

  it('TC-MOB-06 一开始就已过期的票据不开抽屉（开一个只能看的抽屉更骗人）', () => {
    const sheet = mount(approvalFrame({ expiresAt: nowMs - 1 }))

    expect(sheet.state).toBe('closed')
    expect(q('sheet')).toBeNull()
    expect(resultHost.textContent).toContain('票据在本地已过期')
  })

  it('TC-MOB-06 剩余 ≤60s 切紧迫前景；live 区只在 60s/10s 两个节点播报', () => {
    mount(approvalFrame({ expiresAt: nowMs + 120_000 }))
    const live = q('countdown-live')
    const countdown = host.querySelector('.m-sheet-countdown')
    let last = live.textContent
    let changes = 0

    for (let second = 0; second < 120; second += 1) {
      tickSeconds(1)
      if (live.textContent !== last) {
        changes += 1
        last = live.textContent
      }
    }

    expect(changes).toBe(2)
    expect(countdown.classList.contains('m-sheet-countdown--urgent')).toBe(true)
  })

  it('TC-MOB-06 剩余 >60s 时不套紧迫前景', () => {
    mount(approvalFrame({ expiresAt: nowMs + 120_000 }))
    tickSeconds(10)

    expect(host.querySelector('.m-sheet-countdown').classList.contains('m-sheet-countdown--urgent')).toBe(false)
    expect(text('countdown')).toBe('剩余 01:50')
  })

  it('TC-MOB-07 有挑战时：批准先走 verify，verify 通过才 decide', async () => {
    mount(approvalFrame({ tier: 'red', challenge: 'ushield' }))
    expect(host.textContent).toContain('需要U 盾强验证')

    q('approve').dispatchEvent(new Event('click'))
    await flush()

    expect(verify).toHaveBeenCalledTimes(1)
    expect(verify).toHaveBeenCalledWith('tk-1')
    expect(decide).toHaveBeenCalledTimes(1)
    expect(decide).toHaveBeenCalledWith('tk-1', 'allowed-once', undefined)
  })

  it('TC-MOB-07 verify 未通过 ⇒ decide 零调用、回 open、inline 报错', async () => {
    verify.mockResolvedValue({ ok: false, code: 'verify-failed', message: '人脸比对失败' })
    const sheet = mount(approvalFrame({ tier: 'red', challenge: 'face' }))

    q('approve').dispatchEvent(new Event('click'))
    await flush()

    expect(verify).toHaveBeenCalledTimes(1)
    expect(decide).toHaveBeenCalledTimes(0)
    expect(sheet.state).toBe('open')
    expect(text('error')).toContain('强验证未通过：人脸比对失败')
    expect(onError).toHaveBeenCalledWith({ code: 'verify-failed', message: '人脸比对失败' })
  })

  it('TC-MOB-08 焦点陷阱：Tab 末→首、Shift+Tab 首→末', () => {
    mount()
    const dialog = q('sheet')
    const focusables = [...dialog.querySelectorAll('button, textarea, input, [tabindex]:not([tabindex="-1"])')]
      .filter((node) => node.disabled !== true)
    const first = focusables[0]
    const last = focusables[focusables.length - 1]
    expect(focusables.length).toBeGreaterThanOrEqual(3)

    last.focus()
    dialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }))
    expect(document.activeElement).toBe(first)

    first.focus()
    dialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true }))
    expect(document.activeElement).toBe(last)
  })

  it('TC-MOB-08 打开即聚焦"拒绝"（安全默认），关闭后归还 show 前的焦点', () => {
    const outside = document.createElement('button')
    document.body.append(outside)
    outside.focus()
    expect(document.activeElement).toBe(outside)

    const sheet = mount()
    expect(document.activeElement).toBe(q('reject'))

    sheet.closeByUser()
    expect(document.activeElement).toBe(outside)
    outside.remove()
  })

  it('TC-MOB-08 对话框语义齐全：role=dialog + aria-modal + aria-labelledby 指向真标题', () => {
    mount()
    const dialog = q('sheet')

    expect(dialog.getAttribute('role')).toBe('dialog')
    expect(dialog.getAttribute('aria-modal')).toBe('true')
    expect(dialog.getAttribute('aria-labelledby')).toBe('m-sheet-title')
    expect(host.querySelector('#m-sheet-title')?.textContent).toBe('操作确认')
    expect(q('error').getAttribute('role')).toBe('alert')
  })

  it('TC-MOB-28 decide 收 409 ⇒ 抽屉仍 open + 人工接管文案', async () => {
    decide.mockResolvedValue({ ok: false, code: 'turn-conflict-handoff', message: '会话已交人工接管' })
    const sheet = mount()

    q('approve').dispatchEvent(new Event('click'))
    await flush()

    expect(sheet.state).toBe('open')
    expect(text('error')).toBe('当前会话已由人工接管，消息暂不可发送。')
    expect(q('approve').disabled).toBe(false)
  })

  it('TC-MOB-28 decide 收 429 ⇒ 提交钮按 retryAfterSeconds 禁用并倒计时', async () => {
    decide.mockResolvedValue({ ok: false, code: 'turn-rate-limited', message: '太频繁', retryAfterSeconds: 3 })
    const sheet = mount()

    q('approve').dispatchEvent(new Event('click'))
    await flush()
    expect(text('error')).toContain('3 秒')
    expect(q('approve').disabled).toBe(true)

    tickSeconds(3)
    expect(q('approve').disabled).toBe(false)
    expect(sheet.state).toBe('open')
  })

  it('decide 网络失败 ⇒ 回 open 并可重试（不静默吞错）', async () => {
    decide.mockResolvedValue({ ok: false, code: 'network-error', message: '网络不可达' })
    const sheet = mount()

    q('approve').dispatchEvent(new Event('click'))
    await flush()

    expect(sheet.state).toBe('open')
    expect(text('error')).toBe('提交失败：网络不可达')
    expect(onError).toHaveBeenCalledTimes(1)

    decide.mockResolvedValue({ ok: true })
    q('approve').dispatchEvent(new Event('click'))
    await flush()
    expect(decide).toHaveBeenCalledTimes(2)
  })

  it('在飞锁：连点批准只提交一次（第二次以 already-decided 被服务端驳回会打架）', async () => {
    let release
    decide.mockImplementation(() => new Promise((resolve) => { release = resolve }))
    const sheet = mount()

    q('approve').dispatchEvent(new Event('click'))
    q('approve').dispatchEvent(new Event('click'))
    release({ ok: true })
    await flush()

    expect(decide).toHaveBeenCalledTimes(1)
    expect(sheet.state).toBe('submitting')
  })

  it('能力位 gestureConfirm=true 时挂手势条，未滑到底则批准钮不可用（防误触，非鉴权）', async () => {
    const sheet = mount(approvalFrame(), { capabilities: { gestureConfirm: true } })
    expect(q('gesture')).not.toBeNull()
    expect(q('approve').disabled).toBe(true)

    q('thumb').dispatchEvent(pointerEvent('pointerdown', 0))
    q('thumb').dispatchEvent(pointerEvent('pointermove', 90))
    q('thumb').dispatchEvent(pointerEvent('pointerup', 90))
    expect(q('approve').disabled).toBe(false)

    q('approve').dispatchEvent(new Event('click'))
    await flush()
    expect(decide).toHaveBeenCalledTimes(1)
    expect(sheet.state).toBe('submitting')
  })

  it('手势半途松手 ⇒ 批准钮保持锁定，零 decision', () => {
    mount(approvalFrame(), { capabilities: { gestureConfirm: true } })

    q('thumb').dispatchEvent(pointerEvent('pointerdown', 0))
    q('thumb').dispatchEvent(pointerEvent('pointermove', 60))
    q('thumb').dispatchEvent(pointerEvent('pointerup', 60))

    expect(q('approve').disabled).toBe(true)
    expect(decide).toHaveBeenCalledTimes(0)
  })

  it('到位但未松手 ≠ 确认：批准钮仍锁定（"到位即确认"被否决的判据）', () => {
    mount(approvalFrame(), { capabilities: { gestureConfirm: true } })

    q('thumb').dispatchEvent(pointerEvent('pointerdown', 0))
    q('thumb').dispatchEvent(pointerEvent('pointermove', 90))
    expect(q('approve').disabled).toBe(true)

    q('thumb').dispatchEvent(pointerEvent('pointerup', 90))
    expect(q('approve').disabled).toBe(false)
    expect(decide).toHaveBeenCalledTimes(0)
  })

  it('TC-MOB-30 reduced-motion 下抽屉无过渡状态但功能不减（倒计时/结论/关闭全在）', async () => {
    const sheet = mount(approvalFrame({ expiresAt: nowMs + 120_000 }), { reducedMotion: true })

    expect(sheet.state).toBe('open')
    expect(text('countdown')).toBe('剩余 02:00')
    tickSeconds(1)
    expect(text('countdown')).toBe('剩余 01:59')

    q('approve').dispatchEvent(new Event('click'))
    await flush()
    expect(decide).toHaveBeenCalledTimes(1)
  })

  it('服务端关单时抽屉开着 ⇒ 关闭并呈现服务端结论（零本地 decision）', () => {
    const sheet = mount()
    sheet.closeByServer(closedFrame({ decision: 'unavailable', label: '无人应答（视为拒绝）' }))

    expect(sheet.state).toBe('closed')
    expect(decide).toHaveBeenCalledTimes(0)
    expect(resultHost.textContent).toContain('无人应答（视为拒绝）')
    expect(resultHost.textContent).toContain('未执行')
  })

  it('dispose 摘掉遮罩与提醒条，不留游离节点', () => {
    const sheet = mount()
    sheet.closeByUser()
    expect(reminderHost.querySelector('[data-role="reminder"]')).not.toBeNull()

    sheet.dispose()
    expect(host.querySelector('[data-role="backdrop"]')).toBeNull()
    expect(reminderHost.querySelector('[data-role="reminder"]')).toBeNull()
  })
})

/** 造一个 pointer 事件（jsdom 无 PointerEvent 构造器）。 */
function pointerEvent(type, x) {
  const event = new Event(type, { bubbles: true })
  Object.assign(event, { clientX: x, pointerId: 1 })
  return event
}
