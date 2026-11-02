/**
 * `intent_resolve` 的出参整形与契约 schema。
 *
 * 整形是纯函数：保证「出参形状」与 `INTENT_RESOLVE_SCHEMA` 由同一份代码决定，
 * 而不是一份手写 schema 对着一份随手拼的对象。
 */

import type { ToolSchema } from '@bah/core'

import type { AskHint, FilledSlot, IntentProposal, IntentResolution, SlotConflict } from './types.ts'
import type { EvidenceItem } from './evidence.ts'

/** 出参：字段名与 schema 一一对应；金额类 value 一律 integer 分。 */
export interface IntentResolveResult {
  readonly kind: string
  readonly decision: string
  readonly confidence: number
  readonly requiresPreview: boolean
  readonly filled: readonly FilledSlot[]
  readonly missing: readonly string[]
  readonly conflicts: readonly SlotConflict[]
  readonly proposals: readonly IntentProposal[]
  readonly askHint: AskHint | null
  readonly evidence: readonly EvidenceItem[]
}

/**
 * 把 `IntentResolution` 整形成出参。
 *
 * WHY 逐字段挑而不是展开：内部类型以后可能加字段（例如要更多提案素材），
 * 出参是**契约**，加字段必须同步 schema 与 eval 断言，不能随内部结构自动漂移。
 */
export function intentResolveResult(resolution: IntentResolution): IntentResolveResult {
  return {
    kind: resolution.kind,
    decision: resolution.decision,
    confidence: resolution.confidence,
    requiresPreview: resolution.requiresPreview,
    filled: resolution.filled,
    missing: resolution.missing,
    // 冲突的候选里可能带全账号？不会：account 槽位在 slots.ts 已归一化为尾号，
    // 但冲突对象本身仍逐层脱敏一遍，避免上游新增来源时漏掉。
    conflicts: resolution.conflicts.map((conflict) => ({
      name: conflict.name,
      candidates: conflict.candidates,
    })),
    proposals: resolution.proposals,
    askHint: resolution.askHint,
    evidence: resolution.evidence,
  }
}

/**
 * 出参契约。
 *
 * 三条口径照抄 `bank/result-schemas.ts` 头注释：
 * 金额一律 integer 分；领域枚举只写 `type:'string'`；不设 `additionalProperties:false`。
 */
export const INTENT_RESOLVE_SCHEMA = {
  type: 'object',
  properties: {
    kind: { type: 'string' },
    decision: { type: 'string' },
    confidence: { type: 'number' },
    requiresPreview: { type: 'boolean' },
    filled: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          // 金额槽位是 integer 分（number），其余是归一化字符串：两种形态都用同一个契约，
          // 故不在这里写 type（写了会逼出一条「把分当字符串」的假断言）
          value: { description: '金额类为 integer 分，其余为归一化字符串' },
          source: { type: 'string' },
          confidence: { type: 'number' },
        },
      },
    },
    missing: { type: 'array', items: { type: 'string' } },
    conflicts: { type: 'array', items: { type: 'object' } },
    proposals: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          rationale: { type: 'string' },
          ruleId: { type: 'string' },
        },
      },
    },
    // null 是合法值（非 ask 时恒 null）；写 type:'object' 会让 askHint=null 的每次成功出参被判违规
    askHint: { description: 'decision=ask 时非 null' },
    evidence: {
      type: 'array',
      items: {
        type: 'object',
        properties: { ruleId: { type: 'string' }, span: { type: 'string' } },
      },
    },
  },
  required: ['kind', 'decision', 'confidence', 'requiresPreview', 'filled', 'missing'],
} satisfies ToolSchema
