/**
 * T 族 · 转账主链（16）。
 *
 * 顺序有意义：三条金额边界试算必须在任何扣款之前（日累计会改判升级），
 * 之后两笔真实转账把日累计推到 1000 元整，再证明第 1001 元被拦。
 * 期望值来自 `docs/bank-tools.md` 的日累计 1000 元口径，不来自某次运行结果。
 */

import { outcomeStep, textStep, toolCallStep } from '@bah/llm/mock'

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

  /**
   * 03 单：意图平面的四条。判据是「工具形态也能被审计与断言」，
   * 不是「函数单测过了」——这四条跑的是真实七段管线 + 真实契约校验。
   */
  scenario({
    id: 'T-13',
    family: 'T',
    title: '模糊复现：「上次那个转账再来一次」⇒ 意图解析 ⇒ 必经预演，确认前零扣款',
    turns: ['上次那个转账再来一次'],
    expect: [
      { kind: 'tool-sequence', tools: ['intent_resolve', 'transfer_preview'], mode: 'contains' },
      { kind: 'tool-result', tool: 'intent_resolve', path: 'kind', equals: 'vague' },
      { kind: 'tool-result', tool: 'intent_resolve', path: 'requiresPreview', equals: true },
      { kind: 'no-event', type: 'transfer/created' },
    ],
    metric: 'task-success',
    action: {
      kind: 'script',
      steps: [
        toolCallStep('c-intent', 'intent_resolve', { utterance: '上次那个转账再来一次', scene: 'transfer' }),
        toolCallStep('c-prev', 'transfer_preview', { amount: 800, payee: { name: '王建国' } }),
        textStep('已按上次的参数生成预演：向王建国转 800 元。确认后才发起。'),
      ],
    },
  }),
  scenario({
    id: 'T-14',
    family: 'T',
    title: '槽位缺失：「转500给他」⇒ 出选择题，不猜收款人、不调资金工具',
    turns: ['转500给他'],
    expect: [
      { kind: 'tool-sequence', tools: ['intent_resolve', 'prompt_ask'], mode: 'contains' },
      { kind: 'tool-result', tool: 'intent_resolve', path: 'decision', equals: 'ask' },
      { kind: 'tool-result', tool: 'prompt_ask', path: 'degraded', equals: false },
      { kind: 'no-event', type: 'tool/call', where: { name: 'transfer_preview' } },
      { kind: 'no-event', type: 'transfer/created' },
    ],
    metric: 'task-success',
    action: {
      kind: 'script',
      steps: [
        toolCallStep('c-intent', 'intent_resolve', { utterance: '转500给他', scene: 'transfer' }),
        toolCallStep('c-ask', 'prompt_ask', {
          question: '要转给谁？',
          slot: 'payee',
          candidates: [
            { label: '王建国', value: '王建国' },
            { label: '张伟', value: '张伟' },
          ],
        }),
        textStep('请选择收款人，或直接输入姓名。'),
      ],
    },
  }),
  scenario({
    id: 'T-15',
    family: 'T',
    title: '歧义收款人：两个「张伟」⇒ ambiguous ⇒ 候选 + 手动输入出口',
    turns: ['给张伟转200'],
    expect: [
      { kind: 'tool-result', tool: 'intent_resolve', path: 'kind', equals: 'ambiguous' },
      { kind: 'tool-sequence', tools: ['intent_resolve', 'prompt_ask'], mode: 'contains' },
      { kind: 'tool-result', tool: 'prompt_ask', path: 'allowFreeText', equals: true },
      { kind: 'no-event', type: 'transfer/created' },
    ],
    metric: 'task-success',
    action: {
      kind: 'script',
      steps: [
        toolCallStep('c-intent', 'intent_resolve', { utterance: '给张伟转200', scene: 'transfer' }),
        toolCallStep('c-ask', 'prompt_ask', {
          question: '找到两位张伟，转给哪位？',
          slot: 'payee',
          candidates: [
            { label: '张伟（同事）', value: '张伟（同事）' },
            { label: '张伟（房东）', value: '张伟（房东）' },
          ],
        }),
        textStep('请选择收款人。'),
      ],
    },
  }),
  scenario({
    id: 'T-16',
    family: 'T',
    title: '隐含意图：「我爱人生日快到了」⇒ 只出提案，绝不执行任何资金工具',
    turns: ['我爱人生日快到了'],
    expect: [
      { kind: 'tool-result', tool: 'intent_resolve', path: 'kind', equals: 'implicit' },
      { kind: 'tool-result', tool: 'intent_resolve', path: 'decision', equals: 'propose' },
      { kind: 'no-event', type: 'tool/call', where: { name: 'transfer_create' } },
      { kind: 'no-event', type: 'tool/call', where: { name: 'wealth_purchase' } },
      { kind: 'no-event', type: 'transfer/created' },
    ],
    metric: 'task-success',
    action: {
      kind: 'script',
      steps: [
        toolCallStep('c-intent', 'intent_resolve', { utterance: '我爱人生日快到了', scene: 'unknown' }),
        textStep('生日快到了，要不要先看看心意金方案？我只提建议，不会直接操作。'),
      ],
    },
  }),
]

