/**
 * 审批弹窗 · 服务端明细（`ApprovalFrame.details`）。
 *
 * 断三件事：
 * 1. 明细逐行渲染（标签 + 值 + 强调），金额只出现一次（不再与六要素的金额行重复）；
 * 2. 没有明细时行为与原来完全一致（六要素照旧，不出现空的明细块）；
 * 3. **不用左侧竖色条表达状态**：风险值用 `ds-tag`，明细块不带内联边框。
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createApprovalController } from './approval.js'

/** 用例里创建的控制器（每个用例结束统一清定时器）。 */
const controllers = []

afterEach(() => {
  for (const controller of controllers.splice(0)) controller.clear()
})

/** 造一条审批帧（默认带明细）。 */
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
      { label: '附言', value: '房租' },
    ],
    ...overrides,
  }
}

/** 造控制器并展示一帧。 */
function setup(frame) {
  const root = document.createElement('div')
  document.body.append(root)
  const controller = createApprovalController(root, {
    onDecision: async () => ({ ok: true }),
    onVerify: async () => ({ ok: true }),
  })
  controller.show(frame)
  controllers.push(controller)
  return { root }
}

/** 明细块的 `{ 标签: 值 }`。 */
function detailMap(root) {
  const block = root.querySelector('[data-role="details"]')
  expect(block).not.toBeNull()
  const entries = [...block.querySelectorAll('.field')].map((field) => [
    field.querySelector('.field__label')?.textContent,
    field.querySelector('.field__value')?.textContent,
  ])
  return Object.fromEntries(entries)
}

describe('审批弹窗 · 服务端明细', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
  })

  it('逐行渲染明细（标签 → 值）', () => {
    const { root } = setup(approval())
    const map = detailMap(root)
    expect(map['金额']).toBe('¥800.00')
    expect(map['收款人']).toBe('王建国（139****2222）')
    expect(map['当日已用']).toBe('¥0.00')
    expect(map['当日剩余']).toBe('¥1,000.00')
    expect(map['手续费']).toBe('¥0.00')
    expect(map['附言']).toBe('房租')
  })

  it('金额只出现一次：有明细时六要素不再重复渲染金额/收款人/手续费', () => {
    const { root } = setup(approval())
    const labels = [...root.querySelectorAll('.field__label')].map((node) => node.textContent)
    // 六要素里保留的只有「操作类型 / 风险级别 / 等待时长」
    expect(labels.filter((label) => label === '金额')).toHaveLength(1)
    expect(labels.filter((label) => label === '收款人')).toHaveLength(1)
    expect(labels.filter((label) => label === '手续费')).toHaveLength(1)
    expect(labels).toContain('操作类型')
    expect(labels).toContain('风险级别')
  })

  it('非金额操作（卡片冻结）不显示空金额区，只显示状态变更明细', () => {
    const { root } = setup(
      approval({
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
    const labels = [...root.querySelectorAll('.field__label')].map((node) => node.textContent)
    expect(labels).not.toContain('金额')
    const map = detailMap(root)
    expect(map['状态变更']).toBe('正常 → 已冻结')
  })

  it('风险值用 ds-tag，不使用左侧竖色条（无内联边框）', () => {
    const { root } = setup(approval())
    const block = root.querySelector('[data-role="details"]')
    expect(block.getAttribute('style')).toBeNull()
    const riskish = root.querySelector('[data-emphasis="risk"] .field__value .ds-tag')
    // 本帧没有 risk 行：这条断言只在风险帧上生效
    expect(riskish).toBeNull()

    const riskFrame = setup(
      approval({
        details: [{ label: '状态变更', value: '正常 → 已冻结', emphasis: 'risk' }],
      }),
    )
    const tag = riskFrame.root.querySelector('[data-emphasis="risk"] .ds-tag')
    expect(tag?.textContent).toBe('正常 → 已冻结')
    // 任何明细行都不得带内联边框（左侧色条的典型写法）
    for (const field of riskFrame.root.querySelectorAll('[data-role="details"] .field')) {
      expect(field.getAttribute('style')).toBeNull()
    }
  })

  it('金额明细走等宽字体，日期用 <time>', () => {
    const { root } = setup(
      approval({
        details: [
          { label: '金额', value: '¥800.00', emphasis: 'amount' },
          { label: '下一次扣费', value: '2026-10-24', emphasis: 'date' },
        ],
      }),
    )
    expect(root.querySelector('[data-emphasis="amount"] .field__value--mono')).not.toBeNull()
    expect(root.querySelector('[data-emphasis="date"] time')?.textContent).toBe('2026-10-24')
  })

  it('没有明细：不渲染明细块，六要素照旧（老帧不受影响）', () => {
    const { root } = setup(approval({ details: undefined }))
    expect(root.querySelector('[data-role="details"]')).toBeNull()
    const labels = [...root.querySelectorAll('.field__label')].map((node) => node.textContent)
    expect(labels).toContain('金额')
    expect(labels).toContain('收款人')
    expect(labels).toContain('收款手机')
    expect(labels).toContain('手续费')
  })

  it('明细被截断时给出提示（完整内容见审计）', () => {
    const { root } = setup(approval({ detailsTruncated: true }))
    expect(root.textContent).toContain('明细较多')
  })
})
