/**
 * 移动抽屉 · 服务端明细（`ApprovalFrame.details`）。
 *
 * 与桌面壳（`views/approval.details.test.js`）同口径，但**不共用状态机**：
 * 这里只测"明细画出来没有、金额有没有重复、有没有用左侧色条"。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { OPEN_MS, createApprovalSheet } from './approval-sheet.js'

/** 带明细的审批帧。 */
function approvalFrame(overrides = {}) {
  return {
    kind: 'approval',
    seq: 7,
    at: 1_000,
    ticketId: 'tk-1',
    callId: 'call-1',
    name: 'transfer_create',
    operation: '转账',
    amountText: '¥800.00',
    amountConfirmed: true,
    payeeName: '王建国',
    payeePhone: '139****2222',
    feeText: '¥0.00',
    tier: 'yellow',
    rejectReasonRequired: true,
    details: [
      { label: '金额', value: '¥800.00', emphasis: 'amount' },
      { label: '收款人', value: '王建国（139****2222）' },
      { label: '当日已用', value: '¥0.00', emphasis: 'amount' },
      { label: '当日剩余', value: '¥1,000.00', emphasis: 'amount' },
      { label: '手续费', value: '¥0.00', emphasis: 'amount' },
    ],
    ...overrides,
  }
}

let host
let nowMs

beforeEach(() => {
  vi.useFakeTimers()
  nowMs = 1_000_000
  host = document.createElement('div')
  document.body.append(host)
})

afterEach(() => {
  vi.useRealTimers()
  host.remove()
})

/** 造抽屉并推进到 open。 */
function mount(frame) {
  const sheet = createApprovalSheet(
    host,
    { decide: vi.fn(async () => ({ ok: true })), verify: vi.fn(async () => ({ ok: true })) },
    { clock: () => nowMs, gestureDeps: { trackWidth: () => 100 } },
  )
  sheet.show(frame)
  vi.advanceTimersByTime(OPEN_MS)
  return sheet
}

/** 明细块 → `{ 标签: 值 }`。 */
function detailMap() {
  const block = host.querySelector('[data-role="details"]')
  expect(block).not.toBeNull()
  return Object.fromEntries(
    [...block.querySelectorAll('.field')].map((field) => [
      field.querySelector('.field__label')?.textContent,
      field.querySelector('.field__value')?.textContent,
    ]),
  )
}

describe('移动抽屉 · 服务端明细', () => {
  it('逐行渲染明细', () => {
    mount(approvalFrame())
    const map = detailMap()
    expect(map['金额']).toBe('¥800.00')
    expect(map['收款人']).toBe('王建国（139****2222）')
    expect(map['当日剩余']).toBe('¥1,000.00')
    expect(map['手续费']).toBe('¥0.00')
  })

  it('金额不重复：有明细时事实列表里不再渲染金额/收款人/手续费', () => {
    mount(approvalFrame())
    const labels = [...host.querySelectorAll('.field__label')].map((node) => node.textContent)
    expect(labels.filter((label) => label === '金额')).toHaveLength(1)
    expect(labels.filter((label) => label === '收款人')).toHaveLength(1)
    expect(labels).toContain('操作类型')
    expect(labels).toContain('风险级别')
  })

  it('卡片冻结：没有金额行，明细显示卡尾号与状态变更', () => {
    mount(
      approvalFrame({
        name: 'card_freeze',
        operation: '冻结卡片',
        amountText: undefined,
        payeeName: undefined,
        payeePhone: undefined,
        feeText: undefined,
        details: [
          { label: '卡片', value: '尾号 1234（实体卡）' },
          { label: '状态变更', value: '正常 → 已冻结', emphasis: 'risk' },
        ],
      }),
    )
    const labels = [...host.querySelectorAll('.field__label')].map((node) => node.textContent)
    expect(labels).not.toContain('金额')
    expect(detailMap()['状态变更']).toBe('正常 → 已冻结')
  })

  it('风险值用 ds-tag，明细行不带内联边框（不用左侧色条表示状态）', () => {
    mount(
      approvalFrame({
        details: [{ label: '状态变更', value: '正常 → 已冻结', emphasis: 'risk' }],
      }),
    )
    const tag = host.querySelector('[data-emphasis="risk"] .ds-tag')
    expect(tag?.textContent).toBe('正常 → 已冻结')
    for (const field of host.querySelectorAll('[data-role="details"] .field')) {
      expect(field.getAttribute('style')).toBeNull()
    }
  })

  it('没有明细：不渲染明细块，事实列表照旧', () => {
    mount(approvalFrame({ details: undefined }))
    expect(host.querySelector('[data-role="details"]')).toBeNull()
    const labels = [...host.querySelectorAll('.field__label')].map((node) => node.textContent)
    expect(labels).toContain('金额')
    expect(labels).toContain('收款手机')
  })

  it('明细被截断时给出提示', () => {
    mount(approvalFrame({ detailsTruncated: true }))
    expect(host.textContent).toContain('明细较多')
  })
})
