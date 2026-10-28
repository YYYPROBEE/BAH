/**
 * T 族 · 转账主链（12）。
 *
 * 顺序有意义：三条金额边界试算必须在任何扣款之前（日累计会改判升级），
 * 之后两笔真实转账把日累计推到 1000 元整，再证明第 1001 元被拦。
 * 期望值来自 `docs/bank-tools.md` 的日累计 1000 元口径，不来自某次运行结果。
 */

import { outcomeStep, toolCallStep } from '@bah/llm/mock'

import { scenario, clarifySteps, transferSteps } from '../helpers.ts'
import type { EvalScenario } from '../../scenario/types.ts'

const PAYEE = { name: '王建国' }

export const T_SCENARIOS: readonly EvalScenario[] = [
  scenario({
    id: 'T-01',
    family: 'T',
    title: '999 元试算：黄级、剩余额度 1 元',
    turns: ['给王建国转 999 元，先试算'],
    expect: [
      { kind: 'tool-sequence', tools: ['transfer_preview'], mode: 'exact' },
      { kind: 'tool-result', tool: 'transfer_preview', path: 'effectiveTier', equals: 'yellow' },
      { kind: 'tool-result', tool: 'transfer_preview', path: 'remainingCents', equals: 100_000 },
      { kind: 'no-event', type: 'transfer/created' },
    ],
    metric: 'task-success',
    action: { kind: 'script', steps: transferSteps({ amount: 999, previewOnly: true }) },
  }),
  scenario({
    id: 'T-02',
    family: 'T',
    title: '1000 元整（日累计上限）试算：边界含于上限，仍为黄级',
    turns: ['给王建国转 1000 元，先试算'],
    expect: [
      { kind: 'tool-sequence', tools: ['transfer_preview'], mode: 'exact' },
      { kind: 'tool-result', tool: 'transfer_preview', path: 'effectiveTier', equals: 'yellow' },
      { kind: 'no-event', type: 'transfer/created' },
    ],
    metric: 'task-success',
    action: { kind: 'script', steps: transferSteps({ amount: 1000, previewOnly: true }) },
  }),
  scenario({
    id: 'T-03',
    family: 'T',
    title: '1001 元：超日累计 → 升级红级 + 强验证（headless 批准后执行）',
    turns: ['给王建国转 1001 元'],
    expect: [
      { kind: 'tool-result', tool: 'transfer_preview', path: 'effectiveTier', equals: 'red' },
      { kind: 'event', type: 'approval/asked', where: { challenge: 'sms' } },
      { kind: 'event', type: 'transfer/created' },
    ],
    metric: 'task-success',
    action: { kind: 'script', steps: transferSteps({ amount: 1001 }) },
  }),
  scenario({
    id: 'T-04',
    family: 'T',
    title: '转账 800 元主链：试算 → 审批 → 扣款，余额减 800',
    turns: ['给王建国转 800 元房租'],
    expect: [
      { kind: 'tool-sequence', tools: ['transfer_preview', 'transfer_create'], mode: 'exact' },
      { kind: 'tool-result', tool: 'transfer_create', path: 'amountCents', equals: 80_000 },
      { kind: 'tool-result', tool: 'transfer_create', path: 'balanceCents', equals: 1_054_467 },
      { kind: 'event', type: 'approval/decided', where: { decision: 'allowed-once' } },
    ],
    metric: 'task-success',
    action: { kind: 'script', steps: transferSteps({ amount: 800, remark: '房租' }) },
  }),
  scenario({
    id: 'T-05',
    family: 'T',
    title: '转账 200 元：日累计恰好到 1000 元，仍放行',
    turns: ['再给王建国转 200 元'],
    expect: [
      { kind: 'tool-sequence', tools: ['transfer_preview', 'transfer_create'], mode: 'exact' },
      { kind: 'tool-result', tool: 'transfer_create', path: 'amountCents', equals: 20_000 },
      { kind: 'tool-result', tool: 'transfer_create', path: 'dailyUsedCents', equals: 200_100 },
    ],
    metric: 'task-success',
    action: { kind: 'script', steps: transferSteps({ amount: 200 }) },
  }),
  scenario({
    id: 'T-06',
    family: 'T',
    title: '日累计已满后再转 50 元：升级红级 + 强验证（批准后执行）',
    turns: ['再给王建国转 50 元'],
    expect: [
      { kind: 'event', type: 'approval/asked', where: { challenge: 'sms' } },
      { kind: 'event', type: 'transfer/created' },
    ],
    metric: 'task-success',
    action: { kind: 'script', steps: transferSteps({ amount: 50 }) },
  }),
  scenario({
    id: 'T-07',
    family: 'T',
    title: '余额不足的试算：拒绝（insufficient-balance）',
    turns: ['给王建国转 99999 元'],
    expect: [
      { kind: 'tool-denied', tool: 'transfer_create', code: 'insufficient-balance' },
      { kind: 'no-event', type: 'transfer/created' },
    ],
    metric: 'task-success',
    action: { kind: 'script', steps: transferSteps({ amount: 99_999 }) },
  }),
  scenario({
    id: 'T-08',
    family: 'T',
    title: '金额 0 元：参数非法，拒绝（tool-args-invalid）',
    turns: ['给王建国转 0 元'],
    expect: [
      { kind: 'tool-denied', tool: 'transfer_preview', code: 'tool-args-invalid' },
      { kind: 'no-event', type: 'transfer/created' },
    ],
    metric: 'task-success',
    action: { kind: 'script', steps: transferSteps({ amount: 0, previewOnly: true }) },
  }),
  scenario({
    id: 'T-09',
    family: 'T',
    title: '缺收款人：不猜、不调工具，先追问',
    turns: ['我要转 100 元'],
    expect: [
      { kind: 'no-event', type: 'tool/call' },
    ],
    metric: 'task-success',
    action: { kind: 'script', steps: clarifySteps('要转给谁？请给出收款人姓名。') },
  }),
  scenario({
    id: 'T-10',
    family: 'T',
    title: '缺金额：不补默认值，先追问',
    turns: ['给王建国转点钱'],
    expect: [
      { kind: 'no-event', type: 'tool/call' },
    ],
    metric: 'task-success',
    action: { kind: 'script', steps: clarifySteps('给王建国转多少？请给出金额。') },
  }),
  scenario({
    id: 'T-11',
    family: 'T',
    title: '只试算不执行：不产生 transfer/created',
    turns: ['王建国要借 100 元，先算算'],
    expect: [
      { kind: 'tool-sequence', tools: ['transfer_preview'], mode: 'exact' },
      { kind: 'tool-result', tool: 'transfer_preview', path: 'amountCents', equals: 10_000 },
      { kind: 'no-event', type: 'transfer/created' },
    ],
    metric: 'task-success',
    action: { kind: 'script', steps: transferSteps({ amount: 100, previewOnly: true }) },
  }),
  scenario({
    id: 'T-12',
    family: 'T',
    title: '定时到过去：拒绝（when-in-past），不产生扣款',
    turns: ['给王建国转 100 元，执行时间写 2020 年'],
    expect: [
      { kind: 'tool-denied', tool: 'transfer_create', code: 'when-in-past' },
      { kind: 'no-event', type: 'transfer/created' },
    ],
    metric: 'task-success',
    action: {
      kind: 'script',
      steps: [
        toolCallStep('eval-create', 'transfer_create', {
          amount: 100,
          payee: PAYEE,
          when: '2020-01-01T00:00:00.000Z',
        }),
        outcomeStep({ tool: 'transfer_create', ok: '已受理。', failed: '未执行：{reason}' }),
      ],
    },
  }),
]
