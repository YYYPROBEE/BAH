/**
 * G1 结构门（施工文档 §5 第 3 步）。
 *
 * 只判两件事：SPO 齐不齐、谓词在不在词表。**不判对错**——"用户说错了"不是结构问题，
 * 记忆层不负责纠正人，只负责记下"他说过"。
 */

import { KNOWN_PREDICATES } from '../words.ts'

import type { GateResult, MemoryCandidate } from '../types.ts'

/**
 * @returns `PASS` 或 `EXTRACT_SPO_INCOMPLETE` / `GATE_PREDICATE_UNKNOWN`
 */
export function checkStructure(candidate: MemoryCandidate): GateResult {
  if (candidate.subject.length === 0 || candidate.predicate.length === 0) {
    return { code: 'EXTRACT_SPO_INCOMPLETE', reason: 'subject/predicate 为空' }
  }
  if (candidate.object === undefined || candidate.object === null) {
    return { code: 'EXTRACT_SPO_INCOMPLETE', reason: 'object 为空' }
  }
  if (!KNOWN_PREDICATES.has(candidate.predicate)) {
    return {
      code: 'GATE_PREDICATE_UNKNOWN',
      reason: `谓词「${candidate.predicate}」不在受控词表（6 条）内`,
    }
  }
  return { code: 'PASS' }
}
