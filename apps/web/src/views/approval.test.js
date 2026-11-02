/**
 * 审批弹窗用例（T-WEB-003 六要素 / T-WEB-004 超时"未执行"）。
 *
 * 重点不是"弹窗好看"，是"六个字段一个都不能少"以及"拒绝必须带理由"——
 * 这两条错了，审计链就断了。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createApprovalController } from './approval.js'

/** 用例里创建的控制器（每个用例结束统一清定时器）。 */
const controllers = []

afterEach(() => {
  for (const controller of controllers.splice(0)) controller.clear()
})

/** 造一条审批帧。 */
function approval(overrides = {}) {
  return {
    kind: 'approval',
    seq: 4,
    at: 1_700_000_000_000,
    ticketId: 'ticket:call-1',
    callId: 'call-1',
    name: 'transfer_create',
    operation: '转账',
    amountText: '¥800.00',
    amountConfirmed: false,
    payeeName: '王建国',
    tier: 'yellow',
    rejectReasonRequired: true,
    ...overrides,
  }
}

/** 造控制器（记录调用）。 */
function setup(frame) {
  const root = document.createElement('div')
  document.body.append(root)
  const calls = []
  const controller = createApprovalController(root, {
    onDecision: async (...args) => {
      calls.push(args)
      return { ok: true }
    },
    onVerify: async () => ({ ok: true }),
  })
  controller.show(frame)
  controllers.push(controller)
  return { root, calls, controller }
}

describe('审批弹窗 · 六要素（T-WEB-003）', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
  })

  it('操作类型 / 金额 / 收款人 / 风险级别 / 等待时长 / 拒绝理由 齐全', () => {
    const { root } = setup(approval())
    const dialog = root.querySelector('[role="dialog"]')

    expect(dialog).not.toBeNull()
    expect(dialog.textContent).toContain('转账')
    expect(dialog.textContent).toContain('¥800.00')
    expect(dialog.textContent).toContain('王建国')
    expect(dialog.textContent).toContain('黄级')
    expect(dialog.querySelector('.approval__waited')).not.toBeNull()
    expect(dialog.querySelector('.approval__reason')).not.toBeNull()
  })

  it('有数据时补收款手机（已脱敏）与手续费；没数据不留空行', () => {
    const withData = setup(approval({ payeePhone: '139****2222', feeText: '¥0.00' }))
    const dialog = withData.root.querySelector('[role="dialog"]')
    expect(dialog.textContent).toContain('收款手机')
    expect(dialog.textContent).toContain('139****2222')
    expect(dialog.textContent).toContain('手续费')
    expect(dialog.textContent).toContain('¥0.00')

    const without = setup(approval())
    expect(without.root.querySelector('[role="dialog"]').textContent).not.toContain('收款手机')
    expect(without.root.querySelector('[role="dialog"]').textContent).not.toContain('手续费')
  })

  it('金额未确认时标灰 + 待确认', () => {
    const { root } = setup(approval())
    expect(root.querySelector('.field__value--unconfirmed')).not.toBeNull()
    expect(root.querySelector('.field__pending').textContent).toBe('待确认')
  })

  it('非金额操作（amountText / payeeName 缺省）不渲染金额与收款人行', () => {
    const { root } = setup(approval({
      name: 'card_freeze',
      operation: '冻结银行卡',
      amountText: undefined,
      payeeName: undefined,
    }))
    const dialog = root.querySelector('[role="dialog"]')
    expect(dialog.textContent).not.toContain('金额')
    expect(dialog.textContent).not.toContain('收款人')
    expect(dialog.querySelector('.field__pending')).toBeNull()
  })

  it('拒绝不填理由 → 提示且不提交', async () => {
    const { root, calls } = setup(approval())
    const buttons = [...root.querySelectorAll('.ds-dialog__foot button')]
    const reject = buttons.find((button) => button.textContent.includes('拒绝'))
    reject.click()

    expect(calls).toEqual([])
    expect(root.querySelector('.approval__hint').textContent).toContain('拒绝必须填写理由')
  })

  it('填了理由再拒绝 → 提交 rejected + 理由', async () => {
    const { root, calls } = setup(approval())
    root.querySelector('.approval__reason').value = '不是我要的收款人'
    const reject = [...root.querySelectorAll('.ds-dialog__foot button')].find((button) =>
      button.textContent.includes('拒绝'),
    )
    reject.click()
    await Promise.resolve()

    expect(calls[0]).toEqual(['ticket:call-1', 'rejected', '不是我要的收款人'])
  })

  it('批准 → allowed-once', async () => {
    const { root, calls } = setup(approval())
    const approve = [...root.querySelectorAll('.ds-dialog__foot button')].find((button) =>
      button.textContent.includes('批准'),
    )
    approve.click()
    await Promise.resolve()
    expect(calls[0]).toEqual(['ticket:call-1', 'allowed-once', undefined])
  })

  it('Esc = 取消（不是"关掉就算了"）', async () => {
    const { root, calls } = setup(approval())
    root.querySelector('[role="dialog"]').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    await Promise.resolve()
    expect(calls[0]).toEqual(['ticket:call-1', 'cancelled', undefined])
  })

  it('点击遮罩 = 取消；点击弹窗内部不取消（§5.3）', async () => {
    const outside = setup(approval())
    const backdrop = outside.root.querySelector('.approval-backdrop')
    backdrop.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    backdrop.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await Promise.resolve()
    expect(outside.calls[0]).toEqual(['ticket:call-1', 'cancelled', undefined])

    const inside = setup(approval())
    inside.root.querySelector('.approval__reason').dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await Promise.resolve()
    expect(inside.calls).toEqual([])
  })

  it('在理由框里拖选、松开时落到遮罩上 → 不算点遮罩（不误取消）', async () => {
    const { root, calls } = setup(approval())
    const textarea = root.querySelector('.approval__reason')
    const backdrop = root.querySelector('.approval-backdrop')
    // 按下在输入框、抬起在遮罩：click 会落在共同祖先（遮罩）上
    textarea.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    backdrop.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await Promise.resolve()
    expect(calls).toEqual([])
  })

  it('rejectReasonRequired=false 时不填理由也能拒绝', async () => {
    const { root, calls } = setup(approval({ rejectReasonRequired: false }))
    const reject = [...root.querySelectorAll('.ds-dialog__foot button')].find((button) =>
      button.textContent.includes('拒绝'),
    )
    reject.click()
    await Promise.resolve()
    expect(calls[0]).toEqual(['ticket:call-1', 'rejected', undefined])
  })

  it('安全默认：打开即聚焦"拒绝"', () => {
    const { root } = setup(approval())
    expect(document.activeElement.textContent).toContain('拒绝')
  })
})

describe('审批弹窗 · 红级强验证', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
  })

  it('有挑战时批准按钮先禁用，验证通过后可用且真能提交', async () => {
    const frame = approval({ tier: 'red', challenge: 'face' })
    const { root, calls } = setup(frame)
    const approve = [...root.querySelectorAll('.ds-dialog__foot button')].find((button) =>
      button.textContent.includes('批准'),
    )
    expect(approve.disabled).toBe(true)

    root.querySelector('.approval__challenge button').click()
    await Promise.resolve()
    await Promise.resolve()
    expect(approve.disabled).toBe(false)
    expect(root.querySelector('.approval__hint').textContent).toContain('验证通过')

    // 验证通过后必须真的能批准：否则红级路径永远到不了 allowed-once
    approve.click()
    await Promise.resolve()
    expect(calls[0]).toEqual(['ticket:call-1', 'allowed-once', undefined])
  })

  it('红级：提交失败不解锁"批准"（挑战态不因回滚被绕过）', async () => {
    const root = document.createElement('div')
    document.body.append(root)
    const controller = createApprovalController(root, {
      onDecision: async () => ({ ok: false, reason: 'already-decided' }),
      onVerify: async () => ({ ok: true }),
    })
    controller.show(approval({ tier: 'red', challenge: 'face' }))
    controllers.push(controller)

    const approve = [...root.querySelectorAll('.ds-dialog__foot button')].find((button) =>
      button.textContent.includes('批准'),
    )
    expect(approve.disabled).toBe(true)

    root.querySelector('[role="dialog"]').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    await Promise.resolve()
    await Promise.resolve()

    expect(root.querySelector('.approval__hint').textContent).toContain('提交失败')
    expect(approve.disabled).toBe(true)
  })

  it('提交在飞时按 Esc 不再发第二条结论', async () => {
    const root = document.createElement('div')
    document.body.append(root)
    const decisions = []
    let release = () => undefined
    const controller = createApprovalController(root, {
      onDecision: (ticketId, decision) => {
        decisions.push(decision)
        return new Promise((resolve) => {
          release = () => resolve({ ok: true })
        })
      },
      onVerify: async () => ({ ok: true }),
    })
    controller.show(approval())
    controllers.push(controller)

    const approve = [...root.querySelectorAll('.ds-dialog__foot button')].find((button) =>
      button.textContent.includes('批准'),
    )
    approve.click()
    await Promise.resolve()
    expect(decisions).toEqual(['allowed-once'])

    root.querySelector('[role="dialog"]').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    await Promise.resolve()
    expect(decisions).toEqual(['allowed-once'])

    release()
  })
})

describe('审批弹窗 · 超时（T-WEB-004）', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
  })

  it('unavailable → 显示"未执行"，不再给批准入口', () => {
    const { root, controller } = setup(approval())
    controller.close({ kind: 'approval-closed', seq: 5, ticketId: 'ticket:call-1', decision: 'unavailable', label: '无人应答（视为拒绝）' })

    const dialog = root.querySelector('[role="dialog"]')
    expect(dialog.dataset.state).toBe('unavailable')
    expect(dialog.textContent).toContain('未执行')
    expect([...dialog.querySelectorAll('button')].some((button) => button.textContent.includes('批准'))).toBe(false)
  })

  it('结论生效后遮罩放行：passive 类、aria-modal=false，Esc 直接收起结果卡', () => {
    const { root, controller } = setup(approval())
    controller.close({
      kind: 'approval-closed',
      seq: 5,
      ticketId: 'ticket:call-1',
      decision: 'allowed-once',
      label: '已批准（一次性）',
    })
    const backdrop = root.querySelector('.approval-backdrop')
    expect(backdrop.classList.contains('approval-backdrop--passive')).toBe(true)
    expect(root.querySelector('[role="dialog"]').getAttribute('aria-modal')).toBe('false')

    root.querySelector('[role="dialog"]').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    expect(root.querySelector('[role="dialog"]')).toBeNull()
  })

  it('结论生效后标题栏 X 与 Esc 同口径：只收起，不再提交已不存在的票（2026-10-31 走查）', async () => {
    const { root, calls, controller } = setup(approval())
    controller.close({
      kind: 'approval-closed',
      seq: 7,
      ticketId: 'ticket:call-1',
      decision: 'unavailable',
      label: '无人应答（视为拒绝）',
    })

    root.querySelector('.ds-dialog__close').click()
    await Promise.resolve()
    await Promise.resolve()

    expect(root.querySelector('[role="dialog"]')).toBeNull()
    // 一次结论都不能再发：发了就是"提交失败：没有待应答的票据"糊在结果卡上
    expect(calls.length).toBe(0)
  })

  it('已批准的收尾显示结论与理由', () => {
    const { root, controller } = setup(approval())
    controller.close({
      kind: 'approval-closed',
      seq: 6,
      ticketId: 'ticket:call-1',
      decision: 'rejected',
      label: '已拒绝',
      reason: '收款人不认识',
    })
    expect(root.textContent).toContain('已拒绝')
    expect(root.textContent).toContain('收款人不认识')
  })

  it('同一票据重复推送不重开（保护用户已输入的理由）', () => {
    const { root, controller } = setup(approval())
    root.querySelector('.approval__reason').value = '正在输入'
    controller.show(approval())
    expect(root.querySelector('.approval__reason').value).toBe('正在输入')
  })
})

describe('审批弹窗 · 定时器', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
    vi.useRealTimers()
  })

  it('关闭后不再有定时器（避免测试挂住 / 内存泄漏）', () => {
    const { controller } = setup(approval())
    expect(controller.isOpen()).toBe(true)
    controller.clear()
    expect(controller.isOpen()).toBe(false)
  })

  it('结论收尾后不再是"待应答"（isOpen 表示待办，不是节点存在）', () => {
    const { controller } = setup(approval())
    expect(controller.isOpen()).toBe(true)
    controller.close({
      kind: 'approval-closed',
      seq: 5,
      ticketId: 'ticket:call-1',
      decision: 'allowed-once',
      label: '已批准（一次性）',
    })
    expect(controller.isOpen()).toBe(false)
  })
})
