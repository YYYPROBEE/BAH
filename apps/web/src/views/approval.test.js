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

  it('安全默认：打开即聚焦"拒绝"', () => {
    const { root } = setup(approval())
    expect(document.activeElement.textContent).toContain('拒绝')
  })
})

describe('审批弹窗 · 红级强验证', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
  })

  it('有挑战时批准按钮先禁用，验证通过后可用', async () => {
    const frame = approval({ tier: 'red', challenge: 'face' })
    const { root } = setup(frame)
    const approve = [...root.querySelectorAll('.ds-dialog__foot button')].find((button) =>
      button.textContent.includes('批准'),
    )
    expect(approve.disabled).toBe(true)

    root.querySelector('.approval__challenge button').click()
    await Promise.resolve()
    await Promise.resolve()
    expect(approve.disabled).toBe(false)
    expect(root.querySelector('.approval__hint').textContent).toContain('验证通过')
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
})
