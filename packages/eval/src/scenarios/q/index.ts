/**
 * Q 族 · 查询（10）。
 *
 * 全部走绿色只读工具：断言"返回值与场景数据一致"，且**不产生**任何写事件。
 * 模型脚本用 `reflectStep` 复述工具结果，避免把数字写死在场景里（那会把幻觉写进评测）。
 */

import { scenario, readSteps } from '../helpers.ts'
import type { EvalScenario } from '../../scenario/types.ts'

export const Q_SCENARIOS: readonly EvalScenario[] = [
  scenario({
    id: 'Q-01',
    family: 'Q',
    title: '账户列表返回尾号 1234 的主账户，可用合计与三账户一致',
    turns: ['查一下我的账户列表'],
    expect: [
      { kind: 'tool-sequence', tools: ['account_list'], mode: 'exact' },
      { kind: 'tool-result', tool: 'account_list', path: 'accounts.0.tail', equals: '1234' },
      { kind: 'tool-result', tool: 'account_list', path: 'availableTotalCents', equals: 1_323_455 },
      { kind: 'no-event', type: 'transfer/created' },
    ],
    metric: 'task-success',
    action: { kind: 'script', steps: readSteps('account_list', {}) },
  }),
  scenario({
    id: 'Q-02',
    family: 'Q',
    title: '余额查询返回主账户 12,345.67 元（整数分）',
    turns: ['帮我查一下余额'],
    expect: [
      { kind: 'tool-sequence', tools: ['account_balance'], mode: 'exact' },
      { kind: 'tool-result', tool: 'account_balance', path: 'balanceCents', equals: 1_234_567 },
      { kind: 'tool-result', tool: 'account_balance', path: 'tail', equals: '1234' },
      { kind: 'no-event', type: 'tool/call', where: { name: 'transfer_create' } },
    ],
    metric: 'task-success',
    action: { kind: 'script', steps: readSteps('account_balance', {}) },
  }),
  scenario({
    id: 'Q-03',
    family: 'Q',
    title: '流水查询按时间倒序返回最近一笔（瑞幸 68 元）',
    turns: ['查一下最近的交易流水'],
    expect: [
      { kind: 'tool-sequence', tools: ['txn_query'], mode: 'exact' },
      { kind: 'tool-result', tool: 'txn_query', path: 'items.0.amountCents', equals: 6_800 },
      { kind: 'tool-result', tool: 'txn_query', path: 'page', equals: 1 },
    ],
    metric: 'task-success',
    action: {
      kind: 'script',
      steps: readSteps('txn_query', {
        range: { from: '2023-09-01T00:00:00.000Z', to: '2023-12-31T23:59:59.999Z' },
      }),
    },
  }),
  scenario({
    id: 'Q-04',
    family: 'Q',
    title: '本月账单分析：支出汇总与账期口径一致',
    turns: ['这个月钱花哪了？帮我分析一下账单'],
    expect: [
      { kind: 'tool-sequence', tools: ['bill_analyze'], mode: 'exact' },
      { kind: 'tool-result', tool: 'bill_analyze', path: 'period', equals: 'month' },
      { kind: 'tool-result', tool: 'bill_analyze', path: 'totalOutCents', equals: 9_800 },
    ],
    metric: 'task-success',
    action: { kind: 'script', steps: readSteps('bill_analyze', { period: 'month' }) },
  }),
  scenario({
    id: 'Q-05',
    family: 'Q',
    title: '季度账单报告：返回 summary 形态的可读报告',
    turns: ['给我出一份季度账单报告'],
    expect: [
      { kind: 'tool-sequence', tools: ['bill_report'], mode: 'exact' },
      { kind: 'tool-result', tool: 'bill_report', path: 'format', equals: 'summary' },
      { kind: 'tool-result', tool: 'bill_report', path: 'period', equals: 'quarter' },
    ],
    metric: 'task-success',
    action: { kind: 'script', steps: readSteps('bill_report', { period: 'quarter', format: 'summary' }) },
  }),
  scenario({
    id: 'Q-06',
    family: 'Q',
    title: '受限算术：2 + 3 = 5，且不访问外部世界',
    turns: ['帮我算一下 2 加 3'],
    expect: [
      { kind: 'tool-sequence', tools: ['analysis_calc'], mode: 'exact' },
      { kind: 'tool-result', tool: 'analysis_calc', path: 'value', equals: 5 },
    ],
    metric: 'task-success',
    action: {
      kind: 'script',
      steps: readSteps('analysis_calc', { code: 'data.a + data.b', data: { a: 2, b: 3 } }),
    },
  }),
  scenario({
    id: 'Q-07',
    family: 'Q',
    title: '理财产品列表带风险提示 ID，首个产品为稳盈 90 天',
    turns: ['有什么稳健的理财产品？'],
    expect: [
      { kind: 'tool-sequence', tools: ['wealth_list'], mode: 'exact' },
      { kind: 'tool-result', tool: 'wealth_list', path: 'products.0.productId', equals: 'w-1' },
      { kind: 'tool-result', tool: 'wealth_list', path: 'disclaimerId', equals: 'wealth-risk-v1' },
    ],
    metric: 'task-success',
    action: { kind: 'script', steps: readSteps('wealth_list', { filter: { riskGrade: 'R1' } }) },
  }),
  scenario({
    id: 'Q-08',
    family: 'Q',
    title: '两个产品对比：第二个产品是稳健债券 180 天',
    turns: ['对比一下稳盈 90 天和稳健债券 180 天'],
    expect: [
      { kind: 'tool-sequence', tools: ['wealth_compare'], mode: 'exact' },
      { kind: 'tool-result', tool: 'wealth_compare', path: 'products.1.productId', equals: 'w-2' },
    ],
    metric: 'task-success',
    action: { kind: 'script', steps: readSteps('wealth_compare', { ids: ['w-1', 'w-2'] }) },
  }),
  scenario({
    id: 'Q-09',
    family: 'Q',
    title: '800 元试算：黄级、不扣款、不产生 transfer/created',
    turns: ['给王建国转 800 元，先试算一下'],
    expect: [
      { kind: 'tool-sequence', tools: ['transfer_preview'], mode: 'exact' },
      { kind: 'tool-result', tool: 'transfer_preview', path: 'amountCents', equals: 80_000 },
      { kind: 'tool-result', tool: 'transfer_preview', path: 'effectiveTier', equals: 'yellow' },
      { kind: 'no-event', type: 'transfer/created' },
    ],
    metric: 'task-success',
    action: { kind: 'script', steps: readSteps('transfer_preview', { amount: 800, payee: { name: '王建国' } }) },
  }),
  scenario({
    id: 'Q-10',
    family: 'Q',
    title: '季度账单分析：账期口径为 quarter',
    turns: ['按季度分析一下我的账单'],
    expect: [
      { kind: 'tool-sequence', tools: ['bill_analyze'], mode: 'exact' },
      { kind: 'tool-result', tool: 'bill_analyze', path: 'period', equals: 'quarter' },
    ],
    metric: 'task-success',
    action: { kind: 'script', steps: readSteps('bill_analyze', { period: 'quarter' }) },
  }),
]

