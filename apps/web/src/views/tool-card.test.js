/**
 * 工具卡片用例（T-WEB-002 三态 / T-WEB-005 金额降级）。
 *
 * 只断言"渲染出来的节点里有哪些可判定的事实"：状态属性、文案、降级标记、合规提示。
 */

import { describe, expect, it } from 'vitest'

import { renderTool } from './tool-card.js'

/** 造一条工具帧。 */
function tool(overrides = {}) {
  return {
    kind: 'tool',
    seq: 1,
    at: 1_700_000_000_000,
    callId: 'call-1',
    name: 'transfer_create',
    title: '转账',
    state: 'pending',
    tier: 'yellow',
    amountConfirmed: false,
    card: {
      kind: 'tool.transfer_create',
      template: 'transfer',
      title: '转账',
      fields: [{ label: '金额', value: '¥800.00', amount: true, mono: true }],
      tags: [],
    },
    ...overrides,
  }
}

describe('工具卡片 · 三态（T-WEB-002）', () => {
  it('待执行 / 完成 / 已拦截：状态属性 + 文案 + 色调都在', () => {
    const pending = renderTool(tool())
    expect(pending.dataset.state).toBe('pending')
    expect(pending.textContent).toContain('待执行')

    const done = renderTool(tool({ state: 'done', amountConfirmed: true }))
    expect(done.dataset.state).toBe('done')
    expect(done.textContent).toContain('已完成')

    const denied = renderTool(
      tool({ state: 'denied', reasonKind: 'denied', code: 'PRV-002', reason: '危险指令' }),
    )
    expect(denied.dataset.state).toBe('denied')
    expect(denied.textContent).toContain('已拦截')
    expect(denied.textContent).toContain('PRV-002')
  })

  it('执行失败与判决拦截的文案不同（不把内部错误说成"被拒"）', () => {
    const failed = renderTool(tool({ state: 'denied', reasonKind: 'failed', code: 'tool-failed' }))
    expect(failed.textContent).toContain('执行失败')
    expect(failed.textContent).not.toContain('已拦截')
  })

  it('权限级别随节点暴露（DAG 与卡片一致）', () => {
    expect(renderTool(tool()).dataset.tier).toBe('yellow')
    expect(renderTool(tool({ tier: 'red' })).textContent).toContain('红级')
  })
})

describe('工具卡片 · 金额降级（T-WEB-005）', () => {
  it('未确认 → 灰 + "待确认" + aria-label', () => {
    const node = renderTool(tool())
    const value = node.querySelector('.field__value')
    expect(value.className).toContain('field__value--unconfirmed')
    const tag = node.querySelector('.field__pending')
    expect(tag.textContent).toBe('待确认')
    expect(tag.getAttribute('aria-label')).toContain('金额待确认')
  })

  it('已确认 → 不加降级标记', () => {
    const node = renderTool(tool({ state: 'done', amountConfirmed: true }))
    expect(node.querySelector('.field__value--unconfirmed')).toBeNull()
    expect(node.querySelector('.field__pending')).toBeNull()
  })

  it('金额字段始终等宽（数字不抖动）', () => {
    const node = renderTool(tool({ amountConfirmed: true }))
    expect(node.querySelector('.field__value').className).toContain('field__value--mono')
  })
})

describe('工具卡片 · 合规与正文', () => {
  it('风险提示永不折叠，且带 disclaimerId', () => {
    const node = renderTool(
      tool({
        card: {
          kind: 'tool.wealth_list',
          template: 'wealth',
          title: '理财产品',
          fields: [],
          tags: [{ text: '理财非存款', tone: 'warning' }],
          disclaimer: { id: 'wealth.disclaimer.v1', text: '风险提示：理财非存款' },
        },
      }),
    )
    const alert = node.querySelector('.tool-card__disclaimer')
    expect(alert).not.toBeNull()
    expect(alert.textContent).toContain('wealth.disclaimer.v1')
    expect(alert.className).toContain('ds-alert--warning')
    // 内容列必须能收窄/撑满，ID 用 chip 类（不是全局 .ds-code 的代码块 padding）
    expect(alert.querySelector('.tool-card__disclaimer-body')).not.toBeNull()
    expect(alert.querySelector('.tool-card__disclaimer-id').textContent).toBe('wealth.disclaimer.v1')
  })

  it('风险提示去掉"必须向用户展示"的内部指令，ID 用 chip 保留', () => {
    const node = renderTool(
      tool({
        card: {
          kind: 'tool.wealth_list',
          template: 'wealth',
          title: '理财产品',
          fields: [],
          tags: [{ text: '理财非存款', tone: 'warning' }],
          disclaimer: {
            id: 'wealth-risk-v1',
            text: '风险提示：wealth-risk-v1（必须向用户展示，理财非存款、投资有风险）',
          },
        },
      }),
    )
    const desc = node.querySelector('.ds-alert__desc').textContent
    expect(desc).toBe('理财非存款、投资有风险')
    expect(desc).not.toContain('必须向用户展示')
    expect(node.querySelector('.tool-card__disclaimer-id').textContent).toBe('wealth-risk-v1')
  })

  it('卡片徽标与字段色调都渲染（合规标签不能只留在数据里）', () => {
    const node = renderTool(
      tool({
        state: 'done',
        amountConfirmed: true,
        card: {
          kind: 'tool.knowledge_answer',
          template: 'knowledge',
          title: '知识问答',
          tags: [{ text: '知识校验', tone: 'brand' }],
          fields: [{ label: '理由码', value: 'KB-001', mono: true, tone: 'danger' }],
        },
      }),
    )
    expect(node.textContent).toContain('知识校验')
    expect(node.querySelector('.ds-tag--brand')).not.toBeNull()
    expect(node.querySelector('.field__value').className).toContain('field__value--danger')
  })

  it('副标题 / 备注 / 表格按契约渲染', () => {
    const node = renderTool(
      tool({
        state: 'done',
        amountConfirmed: true,
        card: {
          kind: 'tool.account_list',
          template: 'ledger',
          title: '账户列表',
          subtitle: '共 2 个账户',
          fields: [],
          tags: [],
          note: '金额单位为元',
          table: {
            headers: ['账户', '余额'],
            rows: [
              ['储蓄卡', '¥1,000.00'],
              ['信用卡', '¥0.00'],
            ],
          },
        },
      }),
    )
    expect(node.textContent).toContain('共 2 个账户')
    expect(node.textContent).toContain('金额单位为元')
    expect(node.querySelector('table.ds-table')).not.toBeNull()
    expect(node.querySelectorAll('tbody td')).toHaveLength(4)
  })

  it('正文用 pre 保留换行（模型给的多行结果不被压平）', () => {
    const node = renderTool(
      tool({
        card: { kind: 'k', template: 'generic', title: '结果', fields: [], tags: [], body: '第一行\n第二行' },
      }),
    )
    const body = node.querySelector('.tool-card__body')
    expect(body.tagName).toBe('PRE')
    expect(body.textContent).toContain('\n')
  })

  it('analysis 卡片正文默认折叠（计算过程长）', () => {
    const node = renderTool(
      tool({
        state: 'done',
        amountConfirmed: true,
        card: { kind: 'tool.analysis_calc', template: 'analysis', title: '受限计算', fields: [], tags: [], body: '1 + 1 = 2' },
      }),
    )
    const details = node.querySelector('details.tool-card__details')
    expect(details).not.toBeNull()
    expect(details.open).toBe(false)
    expect(details.querySelector('summary').textContent).toContain('查看计算过程')
    expect(details.querySelector('pre').textContent).toContain('1 + 1 = 2')
  })
})

describe('工具卡片 · 账单报告（结构化块替掉机器口径正文）', () => {
  it('字段 + 分类表 + 两行说明进卡，不再出现 pre 正文', () => {
    const node = renderTool(
      tool({
        state: 'done',
        amountConfirmed: true,
        name: 'bill_report',
        title: '账单报告',
        tier: 'green',
        card: {
          kind: 'tool.bill_report',
          template: 'ledger',
          title: '账单报告',
          fields: [
            { label: '账期', value: '2026-09 ~ 2026-10（季度）' },
            { label: '支出', value: '¥7,654.32', mono: true },
            { label: '异常', value: '1 条' },
          ],
          tags: [],
          table: { headers: ['分类', '金额', '占比'], rows: [['转账', '¥3,803.70', '49.69%']] },
          note: '收款人前 1：京东 ¥1,200.00（15.68%）\n异常：大额支出 ¥3,003.70',
        },
      }),
    )

    expect(node.querySelector('.tool-card__body')).toBeNull()
    expect(node.querySelectorAll('.tool-card__fields .field')).toHaveLength(3)
    expect(node.querySelector('table.ds-table')).not.toBeNull()
    expect(node.querySelector('tbody td').textContent).toBe('转账')
    // 说明里的换行是内容（收款人 / 异常各一行），不能被压成一行
    const note = node.querySelector('.tool-card__note')
    expect(note.textContent).toContain('\n')
    // 卡片里不该再有内部分类键
    expect(node.textContent).not.toContain('transfer')
  })
})

describe('工具卡片 · 状态兜底', () => {
  it('未知状态退回 pending，不产出 tool-card--undefined', () => {
    const node = renderTool(tool({ state: 'mystery' }))
    expect(node.className).toContain('tool-card--pending')
    expect(node.className).not.toContain('undefined')
    expect(node.dataset.state).toBe('mystery')
  })
})
