/**
 * 场景构造帮手（W13）：把重复的 profile / seed / 动作样板收敛到一处。
 *
 * 场景文件只写"这一条在证什么"；数据集的 seed 固定在 `EVAL_SEED`，
 * 组内所有场景共用（`validate.ts` 会拒绝组内 seed 不一致）。
 */

import { outcomeStep, reflectStep, textStep, toolCallStep } from '@bah/llm/mock'
import type { MockStep } from '@bah/llm/mock'

import type { ScenarioApproval, ScenarioExpectation, ScenarioFamily, ScenarioMetric } from '../scenario/spec.ts'
import type { EvalScenario, ScenarioAction } from '../scenario/types.ts'

/** 评测数据集 seed（demo 档；与快照的 7 不同，避免"同一个数被两处引用"的错觉）。 */
export const EVAL_SEED = 20261026

/** 造一个场景（默认 headless profile）。 */
export function scenario(options: {
  readonly id: string
  readonly family: ScenarioFamily
  readonly title: string
  readonly turns: readonly string[]
  readonly expect: readonly ScenarioExpectation[]
  readonly action: ScenarioAction
  readonly metric?: ScenarioMetric
  readonly approval?: ScenarioApproval
  readonly profile?: string
  readonly dataset?: string
}): EvalScenario {
  return {
    spec: {
      id: options.id,
      family: options.family,
      title: options.title,
      profile: options.profile ?? 'headless',
      ...(options.approval === undefined ? {} : { approval: options.approval }),
      seed: EVAL_SEED,
      dataset: options.dataset ?? 'demo',
      turns: options.turns,
      expect: options.expect,
      ...(options.metric === undefined ? {} : { metric: options.metric }),
    },
    action: options.action,
  }
}

/** 只读工具：调用 → 复述权威结果（不编数字）。 */
export function readSteps(tool: string, args: Readonly<Record<string, unknown>>, callId = 'eval-read'): readonly MockStep[] {
  return [
    toolCallStep(callId, tool, args),
    reflectStep({ tool, fallback: '工具没有返回结果。' }),
  ]
}

/** 写工具：调用 → 按成败二选一收尾。 */
export function writeSteps(
  tool: string,
  args: Readonly<Record<string, unknown>>,
  callId = 'eval-write',
): readonly MockStep[] {
  return [
    toolCallStep(callId, tool, args),
    outcomeStep({ tool, ok: '已受理。', failed: '未执行：{reason}' }),
  ]
}

/** 转账：试算（可选）→ 执行 → 按结局收尾。 */
export function transferSteps(options: {
  readonly amount: number
  readonly payee?: string
  readonly previewOnly?: boolean
  readonly when?: string
  readonly idempotencyKey?: string
  readonly remark?: string
}): readonly MockStep[] {
  const args: Record<string, unknown> = {
    amount: options.amount,
    payee: { name: options.payee ?? '王建国' },
    ...(options.remark === undefined ? {} : { remark: options.remark }),
    ...(options.when === undefined ? {} : { when: options.when }),
    ...(options.idempotencyKey === undefined ? {} : { idempotencyKey: options.idempotencyKey }),
  }
  if (options.previewOnly === true) {
    return [
      toolCallStep('eval-preview', 'transfer_preview', args),
      reflectStep({ tool: 'transfer_preview', fallback: '未返回试算结果。' }),
    ]
  }
  return [
    toolCallStep('eval-preview', 'transfer_preview', args),
    toolCallStep('eval-create', 'transfer_create', args),
    outcomeStep({
      tool: 'transfer_create',
      ok: '转账已受理，审批与核销记录见上方工具卡。',
      failed: '未执行：{reason}',
    }),
  ]
}

/** 知识工具：调用 → 中性收尾（不转述数字，交给 W05 核验门）。 */
export function knowledgeSteps(
  tool: 'knowledge_answer' | 'knowledge_query',
  question: string,
  callId = 'eval-knowledge',
): readonly MockStep[] {
  return [
    toolCallStep(callId, tool, { question }),
    textStep('已根据知识库返回结果完成答复。'),
  ]
}

/** 追问（不调工具；用于"参数不全"的场景）。 */
export function clarifySteps(question: string): readonly MockStep[] {
  return [textStep(question)]
}
