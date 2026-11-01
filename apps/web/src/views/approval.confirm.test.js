/**
 * 审批弹窗 · 打字确认（ADR-0008）。
 *
 * `fact_forget` / `plan_disarm` 这类删除、撤销操作要求逐字输入确认词。
 * 判定在服务端（`http-adapter.decide`），前端这一层的职责只有两条：
 * 把帧里的 `confirmText` 渲染成输入框，并在词不匹配时**不发起提交**。
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createApprovalController } from './approval.js'

const controllers = []

afterEach(() => {
  for (const controller of controllers.splice(0)) controller.clear()
})

/** 造一条带确认词的审批帧。 */
function approval(overrides = {}) {
  return {
    kind: 'approval',
    seq: 4,
    at: 1_700_000_000_000,
    ticketId: 'ticket:call-1',
    callId: 'call-1',
    name: 'fact_forget',
    operation: '删除生活事实',
    amountText: '¥ —',
    amountConfirmed: false,
    payeeName: '—',
    tier: 'yellow',
    rejectReasonRequired: true,
    confirmText: '删除',
    ...overrides,
  }
}

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

const approveButton = (root) =>
  [...root.querySelectorAll('.ds-dialog__foot button')].find((button) =>
    button.textContent.includes('批准'),
  )

describe('审批弹窗 · 打字确认', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
  })

  it('帧带 confirmText ⇒ 渲染确认输入框（占位与 aria 都指向同一词）', () => {
    const { root } = setup(approval())
    const input = root.querySelector('.approval__confirm')

    expect(input).not.toBeNull()
    expect(input.getAttribute('placeholder')).toBe('逐字输入「删除」以确认')
    expect(input.getAttribute('aria-label')).toBe('确认词：删除')
  })

  it('帧无 confirmText ⇒ 不渲染确认输入框', () => {
    const { root } = setup(approval({ name: 'transfer_create', confirmText: undefined }))

    expect(root.querySelector('.approval__confirm')).toBeNull()
  })

  it('确认词不匹配 ⇒ 零提交、提示逐字输入并把焦点移回输入框', async () => {
    const { root, calls } = setup(approval())
    const input = root.querySelector('.approval__confirm')
    input.value = '删'

    approveButton(root).click()
    await Promise.resolve()

    expect(calls).toEqual([])
    expect(root.querySelector('.approval__hint').textContent).toBe('请逐字输入「删除」')
    expect(document.activeElement).toBe(input)
  })

  it('确认词匹配（首尾空白忽略）⇒ 作为第 4 参交给服务端', async () => {
    const { root, calls } = setup(approval())
    root.querySelector('.approval__confirm').value = ' 删除 '

    approveButton(root).click()
    await Promise.resolve()
    await Promise.resolve()

    expect(calls[0]).toEqual(['ticket:call-1', 'allowed-once', undefined, '删除'])
  })
})
