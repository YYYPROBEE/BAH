/**
 * S 族 · 补偿（8）。
 *
 * 失败注入方式：替换 `SAGA_BRIDGE_RECIPES.transfer_create` 的编排步（场景级，跑完复原），
 * 仍然走真实的 `bank:saga` 协调器 + 补偿通道 + 审计链；不 mock 管线。
 *
 * 终态口径（W12）：补偿成功 → `saga/comp-result(outcome='ok')`；补偿失败 → `saga/dlq-escalated`；
 * 部分成功 → ok + err 同时出现（**不是** DLQ）。
 */

import { outcomeStep, toolCallStep } from '@bah/llm/mock'

import { scenario } from '../helpers.ts'
import type { EvalScenario, SagaStepFixture } from '../../scenario/types.ts'

function sagaSteps(amount: number) {
  return [
    toolCallStep('eval-saga', 'transfer_create', { amount, payee: { name: '王建国' } }),
    outcomeStep({
      tool: 'transfer_create',
      ok: '已受理，编排记录见上方工具卡。',
      failed: '未执行：{reason}',
    }),
  ]
}

function compRecipe(amount: number): readonly SagaStepFixture[] {
  const args = { amount, payee: { name: '王建国' } }
  return [
    { stepId: 'preview', toolName: 'transfer_preview', sideEffectClass: 'NONE', deps: [], args },
    { stepId: 'pay', toolName: 'transfer_create', sideEffectClass: 'EXTERNAL_UNDOABLE', deps: ['preview'], args },
    { stepId: 'post', toolName: 'eval_post_check', sideEffectClass: 'NONE', deps: ['pay'], args: {} },
  ]
}

function dlqRecipe(): readonly SagaStepFixture[] {
  return [
    {
      stepId: 'side',
      toolName: 'eval_side_effect',
      sideEffectClass: 'EXTERNAL_UNDOABLE',
      deps: [],
      args: {},
    },
    { stepId: 'boom', toolName: 'eval_fail', sideEffectClass: 'NONE', deps: ['side'], args: {} },
  ]
}

function partialRecipe(amount: number): readonly SagaStepFixture[] {
  const args = { amount, payee: { name: '王建国' } }
  return [
    {
      stepId: 'pay',
      toolName: 'transfer_create',
      sideEffectClass: 'EXTERNAL_UNDOABLE',
      deps: [],
      args,
    },
    {
      stepId: 'side',
      toolName: 'eval_side_effect',
      sideEffectClass: 'EXTERNAL_UNDOABLE',
      deps: ['pay'],
      args: {},
    },
    { stepId: 'boom', toolName: 'eval_fail', sideEffectClass: 'NONE', deps: ['side'], args: {} },
  ]
}

export const S_SCENARIOS: readonly EvalScenario[] = [
  scenario({
    id: 'S-01',
    family: 'S',
    title: '扣款后校验失败 → reverse(txnId) → COMPENSATED',
    turns: ['给王建国转 800 元'],
    expect: [
      { kind: 'event', type: 'saga/comp-issued' },
      { kind: 'event', type: 'saga/comp-result', where: { outcome: 'ok' } },
      { kind: 'no-event', type: 'saga/dlq-escalated' },
      { kind: 'event', type: 'transfer/created' },
    ],
    metric: 'task-success',
    action: { kind: 'saga', steps: sagaSteps(800), recipe: compRecipe(800) },
  }),
  scenario({
    id: 'S-02',
    family: 'S',
    title: '小额（100 元）同样走冲正回读',
    turns: ['给王建国转 100 元'],
    expect: [
      { kind: 'event', type: 'saga/comp-result', where: { outcome: 'ok' } },
      { kind: 'no-event', type: 'saga/dlq-escalated' },
    ],
    metric: 'task-success',
    action: { kind: 'saga', steps: sagaSteps(100), recipe: compRecipe(100) },
  }),
  scenario({
    id: 'S-03',
    family: 'S',
    title: '副作用无补偿模板 → COMPENSATION_DLQ（不是 INCIDENT）',
    turns: ['给王建国转 50 元'],
    expect: [
      { kind: 'event', type: 'saga/dlq-escalated' },
      { kind: 'no-event', type: 'transfer/created' },
    ],
    metric: 'task-success',
    action: { kind: 'saga', steps: sagaSteps(50), recipe: dlqRecipe() },
  }),
  scenario({
    id: 'S-04',
    family: 'S',
    title: '后置校验失败 + 无模板副作用 → DLQ',
    turns: ['给王建国转 20 元'],
    expect: [{ kind: 'event', type: 'saga/dlq-escalated' }],
    metric: 'task-success',
    action: { kind: 'saga', steps: sagaSteps(20), recipe: dlqRecipe() },
  }),
  scenario({
    id: 'S-05',
    family: 'S',
    title: '失败发生在副作用之前 → 不发起补偿',
    turns: ['给王建国转 10 元'],
    expect: [
      { kind: 'event', type: 'tool/result', where: { name: 'transfer_create', isError: true } },
      { kind: 'no-event', type: 'saga/comp-issued' },
    ],
    metric: 'task-success',
    action: {
      kind: 'saga',
      steps: sagaSteps(10),
      recipe: [
        { stepId: 'boom', toolName: 'eval_fail', sideEffectClass: 'NONE', deps: [], args: {} },
      ],
    },
  }),
  scenario({
    id: 'S-06',
    family: 'S',
    title: '正常转账（无失败）→ 不产生补偿事件',
    turns: ['给王建国转 1 元'],
    expect: [
      { kind: 'event', type: 'transfer/created' },
      { kind: 'no-event', type: 'saga/comp-issued' },
      { kind: 'no-event', type: 'saga/dlq-escalated' },
    ],
    metric: 'task-success',
    action: { kind: 'saga', steps: sagaSteps(1) },
  }),
  scenario({
    id: 'S-07',
    family: 'S',
    title: '999 元扣款后失败 → 冲正成功（补偿不受金额边界影响）',
    turns: ['给王建国转 999 元'],
    expect: [
      { kind: 'event', type: 'saga/comp-result', where: { outcome: 'ok' } },
      { kind: 'no-event', type: 'saga/dlq-escalated' },
    ],
    metric: 'task-success',
    action: { kind: 'saga', steps: sagaSteps(999), recipe: compRecipe(999) },
  }),
  scenario({
    id: 'S-08',
    family: 'S',
    title: '一笔冲正成功 + 一笔无模板副作用 → 已补偿部分，但整体进 DLQ',
    turns: ['给王建国转 300 元'],
    expect: [
      { kind: 'event', type: 'saga/comp-result', where: { outcome: 'ok' } },
      { kind: 'event', type: 'saga/dlq-escalated' },
    ],
    metric: 'task-success',
    action: { kind: 'saga', steps: sagaSteps(300), recipe: partialRecipe(300) },
  }),
]
