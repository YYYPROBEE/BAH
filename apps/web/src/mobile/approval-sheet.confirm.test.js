/**
 * 移动审批抽屉 · 打字确认（ADR-0008）。
 *
 * 与桌面弹窗同一条规则：`confirmText` 由帧下发，前端只负责"要求打字 + 不匹配不提交"；
 * 判定仍在服务端。移动端额外钉一条顺序——**确认词先于强验证**，
 * 词打错时不该无谓消耗一次人脸/短信验证。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { OPEN_MS, createApprovalSheet } from './approval-sheet.js'

function approvalFrame(overrides = {}) {
  return {
    kind: 'approval',
    seq: 7,
    at: 1_000,
    ticketId: 'tk-1',
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

describe('移动审批抽屉 · 打字确认', () => {
  let host
  let resultHost
  let reminderHost
  let decide
  let verify
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
  })

  afterEach(() => {
    vi.useRealTimers()
    host.remove()
    resultHost.remove()
    reminderHost.remove()
  })

  function mount(frame) {
    const sheet = createApprovalSheet(
      host,
      { decide, verify, onError: vi.fn() },
      { clock: () => nowMs, reminderHost, resultHost, gestureDeps: { trackWidth: () => 100 } },
    )
    sheet.show(frame)
    vi.advanceTimersByTime(OPEN_MS)
    return sheet
  }

  const q = (role) => host.querySelector(`[data-role="${role}"]`)

  async function flush() {
    for (let index = 0; index < 8; index += 1) await Promise.resolve()
  }

  it('帧带 confirmText ⇒ 渲染 role=confirm 的输入框（占位与 aria 同词）', () => {
    mount(approvalFrame())
    const input = q('confirm')

    expect(input).not.toBeNull()
    expect(input.getAttribute('placeholder')).toBe('逐字输入「删除」以确认')
    expect(input.getAttribute('aria-label')).toBe('确认词：删除')
  })

  it('帧无 confirmText ⇒ 不渲染确认输入框', () => {
    mount(approvalFrame({ name: 'transfer_create', confirmText: undefined }))

    expect(q('confirm')).toBeNull()
  })

  it('确认词不匹配 ⇒ 零提交、错误提示、焦点移回输入框', async () => {
    mount(approvalFrame())
    const input = q('confirm')
    input.value = '删'

    q('approve').dispatchEvent(new Event('click'))
    await flush()

    expect(decide).not.toHaveBeenCalled()
    expect(q('error').hidden).toBe(false)
    expect(q('error').textContent).toBe('请逐字输入「删除」以确认')
    expect(document.activeElement).toBe(input)
  })

  it('确认词匹配（首尾空白忽略）⇒ 作为第 4 参交给服务端', async () => {
    mount(approvalFrame())
    q('confirm').value = ' 删除 '

    q('approve').dispatchEvent(new Event('click'))
    await flush()

    expect(decide).toHaveBeenCalledTimes(1)
    expect(decide.mock.calls[0]).toEqual(['tk-1', 'allowed-once', undefined, '删除'])
  })

  it('红级 + 确认词：词不对时先被确认闸拦下，不发强验证', async () => {
    mount(approvalFrame({ tier: 'red', challenge: 'face' }))
    q('confirm').value = '撤销'

    q('approve').dispatchEvent(new Event('click'))
    await flush()

    expect(verify).not.toHaveBeenCalled()
    expect(decide).not.toHaveBeenCalled()
    expect(q('error').textContent).toBe('请逐字输入「删除」以确认')
  })
})
