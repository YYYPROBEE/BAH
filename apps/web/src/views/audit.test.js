/**
 * 审计计数条用例（T-WEB-009 计数口径）。
 *
 * 为什么单独立一条：计数条是答辩时"三秒指给人看"的那三个数字，
 * 它和时间线打架比"没数字"更糟——曾经超时未应答显示 `0 拒绝 0 阻断`，
 * 而同一屏的时间线明写"票据已阻断 / 无人应答（视为拒绝）"。
 * 判据的事实源是投影端 `packages/channels/src/web/audit.ts`，这里按它的真实帧形造数据。
 */

import { describe, expect, it } from 'vitest'

import { renderAuditSummary } from './audit.js'

/** 造一条审计帧（字段与投影端一一对应）。 */
function audit(overrides) {
  return {
    kind: 'audit',
    seq: 1,
    at: 1_700_000_000_000,
    timeText: '08:00:00',
    category: 'approval',
    label: '审批请求',
    summary: '请求执行 transfer_create · ¥800.00',
    ticketId: 'ticket:call-1',
    ...overrides,
  }
}

/** 计数条 → { 审批, 拒绝, 阻断 }。 */
function counts(frames) {
  const node = renderAuditSummary(frames)
  const values = [...node.querySelectorAll('.audit__stat-value')].map((e) => Number(e.textContent))
  const labels = [...node.querySelectorAll('.audit__stat-label')].map((e) => e.textContent)
  return Object.fromEntries(labels.map((label, i) => [label, values[i]]))
}

describe('renderAuditSummary', () => {
  it('批准路径：1 审批 0 拒绝 0 阻断', () => {
    const frames = [
      audit({ seq: 1 }),
      audit({ seq: 2, category: 'ticket', label: '票据已批准', summary: 'transfer_create' }),
      audit({ seq: 3, label: '审批结论', summary: '已批准（一次性）' }),
      audit({ seq: 4, category: 'tool', label: '工具完成', summary: 'transfer_create' }),
    ]
    expect(counts(frames)).toEqual({ 审批: 1, 拒绝: 0, 阻断: 0 })
  })

  it('显式拒绝：结论带理由也要计成 1 拒绝', () => {
    const frames = [
      audit({ seq: 1 }),
      audit({ seq: 2, label: '审批结论', summary: '已拒绝 · 演示：测试拒绝路径', code: 'approval-rejected' }),
      audit({ seq: 3, category: 'tool', label: '工具未执行', summary: 'transfer_create 未执行：演示：测试拒绝路径', code: 'approval-rejected' }),
    ]
    expect(counts(frames)).toEqual({ 审批: 1, 拒绝: 1, 阻断: 0 })
  })

  it('超时未应答：视为拒绝计 1 拒绝，票据阻断计 1 阻断（回归用例）', () => {
    const frames = [
      audit({ seq: 1 }),
      audit({ seq: 2, category: 'ticket', label: '票据已签发', summary: 'transfer_create' }),
      audit({ seq: 3, category: 'ticket', label: '票据已阻断', summary: 'transfer_create', code: 'approval-timeout' }),
      audit({ seq: 4, label: '审批结论', summary: '无人应答（视为拒绝） · approval-timeout', code: 'approval-unavailable' }),
      audit({ seq: 5, category: 'tool', label: '工具未执行', summary: 'transfer_create 未执行：approval-timeout', code: 'approval-unavailable' }),
      audit({ seq: 6, category: 'turn', label: '轮次结束', summary: 'aborted', code: 'aborted' }),
    ]
    expect(counts(frames)).toEqual({ 审批: 1, 拒绝: 1, 阻断: 1 })
  })

  it('同一次事故不出两个阻断（票据阻断 + 轮次 blocked 去重）', () => {
    const frames = [
      audit({ seq: 1 }),
      audit({ seq: 2, category: 'ticket', label: '票据已阻断', summary: 'transfer_create', code: 'approval-timeout' }),
      audit({ seq: 3, category: 'turn', label: '轮次结束', summary: 'blocked', code: 'blocked', ticketId: 'ticket:call-1' }),
    ]
    expect(counts(frames)).toEqual({ 审批: 1, 拒绝: 0, 阻断: 1 })
  })

  it('取消不计拒绝：Esc/关窗是本地动作，不是判决被否', () => {
    const frames = [
      audit({ seq: 1 }),
      audit({ seq: 2, label: '审批结论', summary: '已取消', code: 'approval-cancelled' }),
    ]
    expect(counts(frames)).toEqual({ 审批: 1, 拒绝: 0, 阻断: 0 })
  })
})
