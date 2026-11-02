/**
 * 候选构造纯函数。
 *
 * 去重 → 确定性排序 → 截断 → 恒追加手动输入。排序与输入序无关：
 * 候选来自记忆检索/账户列表，其顺序随数据状态漂移；不重排则「同输入同输出」
 * 在 eval 快照上不可复现。
 */

import { BahError } from '@bah/util'

import type { CandidateInput, PromptChoice } from './types.ts'

/** 门禁 I4 在源码里查这个字面量；改它 = 改产品口径，须过 。 */
export const MAX_CANDIDATES = 3

/** 「手动输入」出口：恒为最后一项。 */
export const MANUAL_CHOICE: PromptChoice = Object.freeze({
  label: '手动输入',
  value: '__manual__',
  kind: 'manual',
})

/** label 上限（中文按字符计）：移动端一屏拇指可达，超过就折行成两行按钮。 */
export const MAX_LABEL_LENGTH = 20

/** 控制字符 + 尖括号：前端用 textContent 渲染，这里再挡一次「标签注入」。 */
const FORBIDDEN_LABEL = /[\u0000-\u001f\u007f<>]/

/**
 * 校验 label。
 *
 * WHY fail-loud 而不是截断：截断会把两个不同候选显示成同一个名字，
 * 用户点了一个、系统收到另一个 —— 这是比报错更坏的静默错误。
 */
export function validateLabel(label: string): void {
  if (label.length === 0) throw new BahError('prompt-choice-invalid', '候选 label 为空')
  if ([...label].length > MAX_LABEL_LENGTH) {
    throw new BahError('prompt-choice-invalid', `候选 label 超过 ${String(MAX_LABEL_LENGTH)} 字`, {
      length: [...label].length,
    })
  }
  if (FORBIDDEN_LABEL.test(label)) {
    throw new BahError('prompt-choice-invalid', '候选 label 含控制字符或尖括号')
  }
}

/** 确定性排序：按 value 码点升序，同 value 按 label 码点升序。 */
function compareChoice(a: PromptChoice, b: PromptChoice): number {
  if (a.value !== b.value) return a.value < b.value ? -1 : 1
  return a.label < b.label ? -1 : a.label > b.label ? 1 : 0
}

/**
 * 构造选择题的候选项。
 *
 * @throws `BahError('prompt-no-candidates')` 上游没给任何候选——这是 bug，不是
 * 「悄悄改成开放式提问」的理由；调用方（prompt_ask）捕获后降级并如实标记 `degraded`。
 */
export function buildChoices(raw: readonly CandidateInput[]): readonly PromptChoice[] {
  const seen = new Map<string, PromptChoice>()
  for (const item of raw) {
    validateLabel(item.label)
    if (!seen.has(item.value)) {
      seen.set(item.value, { label: item.label, value: item.value, kind: 'candidate' })
    }
  }
  if (seen.size === 0) {
    throw new BahError('prompt-no-candidates', '候选为空，拒绝构造选择题')
  }
  const sorted = [...seen.values()].sort(compareChoice)
  return [...sorted.slice(0, MAX_CANDIDATES), MANUAL_CHOICE]
}
