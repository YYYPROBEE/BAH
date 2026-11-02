/**
 * 审计计数条用例（T-WEB-009 计数口径）。
 *
 * 为什么单独立一条：计数条是对外说明时"三秒指给人看"的那几个数字，
 * 它和时间线打架比"没数字"更糟——曾经超时未应答显示 `0 拒绝 0 阻断`，
 * 而同一屏的时间线明写"票据已阻断 / 无人应答（视为拒绝）"。
 * 判据的事实源是投影端 `packages/channels/src/web/audit.ts`，这里按它的真实帧形造数据。
 */

import { describe, expect, it } from 'vitest'

import { countAuditCategories, renderAudit, renderAuditCounts, renderAuditSummary } from './audit.js'

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

/** 计数条 → { 审批, 拒绝, 取消, 阻断 }。 */
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
    expect(counts(frames)).toEqual({ 审批: 1, 拒绝: 0, 取消: 0, 阻断: 0 })
  })

  it('显式拒绝：结论带理由也要计成 1 拒绝', () => {
    const frames = [
      audit({ seq: 1 }),
      audit({ seq: 2, label: '审批结论', summary: '已拒绝 · 演示：测试拒绝路径', code: 'approval-rejected' }),
      audit({ seq: 3, category: 'tool', label: '工具未执行', summary: 'transfer_create 未执行：演示：测试拒绝路径', code: 'approval-rejected' }),
    ]
    expect(counts(frames)).toEqual({ 审批: 1, 拒绝: 1, 取消: 0, 阻断: 0 })
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
    expect(counts(frames)).toEqual({ 审批: 1, 拒绝: 1, 取消: 0, 阻断: 1 })
  })

  it('同一次事故不出两个阻断（票据阻断 + 轮次 blocked 去重）', () => {
    // 帧形态按投影端真实产出：`turn/end` 的审计帧**不带** ticketId（载荷只有 `{ turn, reason }`）。
    const frames = [
      audit({ seq: 1 }),
      audit({ seq: 2, category: 'ticket', label: '票据已阻断', summary: 'transfer_create', code: 'approval-timeout' }),
      audit({ seq: 3, category: 'turn', label: '轮次结束', summary: 'blocked', code: 'blocked' }),
    ]
    expect(counts(frames)).toEqual({ 审批: 1, 拒绝: 0, 取消: 0, 阻断: 1 })
  })

  it('没有票据的 guard-stop：轮次 blocked 单独计 1 阻断', () => {
    const frames = [
      audit({ seq: 1, category: 'turn', label: '轮次结束', summary: 'guard-stopped', code: 'guard-stopped' }),
      audit({ seq: 2, category: 'turn', label: '轮次结束', summary: 'blocked', code: 'blocked' }),
    ]
    expect(counts(frames)).toEqual({ 审批: 0, 拒绝: 0, 取消: 0, 阻断: 1 })
  })

  it('两次独立阻断（各自票据 + 轮次）仍计 2，不会被去重吞掉', () => {
    const frames = [
      audit({ seq: 1, category: 'ticket', label: '票据已阻断', summary: 'transfer_create', code: 'approval-timeout', ticketId: 'ticket:a' }),
      audit({ seq: 2, category: 'turn', label: '轮次结束', summary: 'blocked', code: 'blocked' }),
      audit({ seq: 3, category: 'ticket', label: '票据已阻断', summary: 'wealth_purchase', code: 'approval-rejected', ticketId: 'ticket:b' }),
      audit({ seq: 4, category: 'turn', label: '轮次结束', summary: 'blocked', code: 'blocked' }),
    ]
    expect(counts(frames)).toEqual({ 审批: 0, 拒绝: 0, 取消: 0, 阻断: 2 })
  })

  it('工具结果理由码叫 blocked 不算轮次阻断', () => {
    const frames = [
      audit({ seq: 1, category: 'tool', label: '工具未执行', summary: 'transfer_create 未执行', code: 'blocked' }),
    ]
    expect(counts(frames)).toEqual({ 审批: 0, 拒绝: 0, 取消: 0, 阻断: 0 })
  })

  it('取消不计拒绝，但单独计一格「取消」：点遮罩绕过理由必须留痕', () => {
    const frames = [
      audit({ seq: 1 }),
      audit({ seq: 2, label: '审批结论', summary: '已取消', code: 'approval-cancelled' }),
    ]
    expect(counts(frames)).toEqual({ 审批: 1, 拒绝: 0, 取消: 1, 阻断: 0 })
  })

  it('summary 缺失不抛错（字段不全的帧不能拆掉整个面板）', () => {
    const frames = [audit({ seq: 1, summary: undefined })]
    expect(() => counts(frames)).not.toThrow()
    expect(counts(frames)).toEqual({ 审批: 1, 拒绝: 0, 取消: 0, 阻断: 0 })
  })
})

describe('renderAudit · 时刻口径', () => {
  it('时刻不进折叠行，title 与明细保留本地/UTC', () => {
    const at = 1_700_000_000_000
    const node = renderAudit(audit({ at, timeText: '22:13:20' }))
    const date = new Date(at)
    const local = [date.getHours(), date.getMinutes(), date.getSeconds()]
      .map((value) => String(value).padStart(2, '0'))
      .join(':')

    expect(node.querySelector('.audit__time')).toBeNull()
    expect(node.getAttribute('title')).toContain(local)
    expect(node.getAttribute('title')).toContain('UTC 22:13:20')
    const detail = node.querySelector('.audit__expand-body').textContent
    expect(detail).toContain('时间')
    expect(detail).toContain(local)
    expect(detail).toContain('UTC 22:13:20')
  })

  it('没有 at 时用帧里的 timeText 兜底（不渲染 NaN:NaN:NaN）', () => {
    const node = renderAudit(audit({ at: undefined, timeText: '08:00:00' }))
    const detail = node.querySelector('.audit__expand-body').textContent
    expect(detail).toContain('08:00:00')
    expect(detail).not.toContain('NaN')
  })
})

describe('renderAudit · 分类文案', () => {
  it('订阅域事件显示「订阅」，不退回英文 category', () => {
    const node = renderAudit(audit({ category: 'subscription', label: '订阅清单', summary: '2 项订阅 · 推断 1 条' }))

    expect(node.querySelector('.audit__category').textContent).toBe('订阅')
    expect(node.querySelector('.audit__category--subscription')).not.toBeNull()
  })

  it('风险测评两键（R-6）：标签与摘要照投影端的原文渲染，分类复用「工具」', () => {
    const assess = renderAudit(
      audit({ category: 'tool', label: '风险测评', summary: '风险测评：R2 → R5（5 题）', toolName: 'risk_assess' }),
    )
    expect(assess.querySelector('.audit__category').textContent).toBe('工具')
    expect(assess.querySelector('.audit__category--tool')).not.toBeNull()
    expect(assess.querySelector('.audit__label').textContent).toBe('风险测评')
    expect(assess.querySelector('.audit__detail').textContent).toBe('风险测评：R2 → R5（5 题）')

    const questions = renderAudit(
      audit({
        category: 'tool',
        label: '查看风险问卷',
        summary: '查看风险问卷 · 5 题 · risk-q/v1',
        toolName: 'risk_assess',
      }),
    )
    expect(questions.querySelector('.audit__label').textContent).toBe('查看风险问卷')
    expect(questions.querySelector('.audit__detail').textContent).toBe('查看风险问卷 · 5 题 · risk-q/v1')
    // 没有理由码就不渲染 code 节点（不拿空字符串占位）
    expect(questions.querySelector('.audit__code')).toBeNull()
  })
})

describe('审计分类计数', () => {
  it('按固定顺序统计，未知分类排最后', () => {
    const frames = [
      audit({ category: 'tool' }),
      audit({ category: 'safety' }),
      audit({ category: 'safety' }),
      audit({ category: 'approval' }),
      audit({ category: 'mystery' }),
    ]
    expect(countAuditCategories(frames)).toEqual([
      { category: 'safety', label: '安全防护', count: 2 },
      { category: 'tool', label: '工具调用', count: 1 },
      { category: 'approval', label: '审批', count: 1 },
      { category: 'mystery', label: 'mystery', count: 1 },
    ])
  })

  it('计数条只数审计帧，别的帧不参与', () => {
    const node = renderAuditCounts([
      audit({ category: 'safety' }),
      audit({ category: 'tool' }),
      { kind: 'message', seq: 9, role: 'assistant', blocks: [] },
    ])
    expect([...node.querySelectorAll('.audit__count')].map((item) => item.textContent)).toEqual([
      '安全防护1',
      '工具调用1',
    ])
  })
})

describe('renderAudit · 明细展开与零计数说明', () => {
  it('有 detail 时默认收起，展开后按标签/值显示；无 detail 不渲染空展开钮', () => {
    const node = renderAudit(
      audit({
        category: 'safety',
        label: '安全防护',
        summary: 'sentry/trace · tool-call · account_balance',
        detail: [
          { label: '类型', value: 'tool-call' },
          { label: '工具', value: 'account_balance' },
        ],
      }),
    )
    const details = node.querySelector('details.audit__expand')
    expect(details).not.toBeNull()
    expect(details.open).toBe(false)
    details.open = true
    expect([...details.querySelectorAll('dt')].map((item) => item.textContent)).toEqual(['时间', '类型', '工具'])
    expect([...details.querySelectorAll('dd')].slice(1).map((item) => item.textContent)).toEqual(['tool-call', 'account_balance'])
    expect([...renderAudit(audit()).querySelectorAll('dt')].map((item) => item.textContent)).toEqual(['时间'])
  })

  it('四个判决计数全零且有审计时，明确说明"没有审批事件"而不是静默零', () => {
    const node = renderAuditSummary([
      audit({ category: 'safety', label: '安全防护', summary: 'sentry/trace · tool-call' }),
      audit({ category: 'tool', label: '工具完成', summary: 'account_balance' }),
    ])
    expect(node.textContent).toContain('没有审批事件')
    expect(node.textContent).toContain('只读工具')
  })
})
