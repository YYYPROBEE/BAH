/**
 * 装配（本轮为最小版）：行 → `RetrievedMemory`。
 *
 * M3 会在这里补影子核验（工具值覆盖记忆值）与 `<memory>` 标签包裹；本文件先把
 * **渲染规则**定死：文本由 `words.ts` 的模板决定，不从 object 自由生成——同一谓词
 * 在任何会话里都必须长出同一句话，否则用户会怀疑"它是不是每次都在编"。
 */

import { renderMemoryText, STATEFUL_PREDICATES } from '../words.ts'

import type { MemoryUnitRow } from '../store/index.ts'
import type { RetrievedMemory, Scene } from '../types.ts'

/** `subject` 形如 `card:8888` / `alias:工资卡` / `payee:房东` / `user`。 */
function subjectValue(subject: string, prefix: string): string | undefined {
  const head = `${prefix}:`
  return subject.startsWith(head) ? subject.slice(head.length) : undefined
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

/** 按谓词的模板渲染（模板缺值处留空，不抛错）。 */
export function renderRowText(row: MemoryUnitRow): string {
  const object = (row.object ?? {}) as Record<string, unknown>
  const values: Record<string, string> = {
    card_last4: asString(object.card_last4) ?? subjectValue(row.subject, 'card') ?? '',
    status: asString(object.status) ?? '',
    payee: subjectValue(row.subject, 'payee') ?? '',
    alias: subjectValue(row.subject, 'alias') ?? '',
    subscription: subjectValue(row.subject, 'subscription') ?? '',
    note: asString(object.note) ?? asString(object.rawSpan) ?? '',
  }
  return renderMemoryText(row.predicate, values)
}

/** 来源场景 = `sceneTags[0]`（写入时保证首位是产生该记忆的场景，见 pipeline）。 */
export function sourceSceneOf(row: MemoryUnitRow): Scene {
  return row.sceneTags[0] ?? 'cross_scene'
}

/**
 * 行 → 装配项。
 *
 * **STATEFUL 的 fail-closed 在这里落地**：`card_state` / `subscription_state` 的记录值来自
 * 用户陈述（"我的卡丢了"），而卡到底能不能用只有银行系统说了算。M3 的影子核验会用工具值
 * 覆盖它；但在核验**尚未发生**时（`lastVerifiedAt` 为空），本函数**不得**输出确定性文案。
 *
 * 为什么这条不能等到 M3 再补：本轮 `shadow` 一律是 `n_a`，而 `n_a` 的语义是"不需要核验"。
 * 一个 STATEFUL 谓词挂上 `n_a`，等于告诉上层"这条状态可以直接用"——模型会照着它给建议，
 * 用户会照着它去转账。宁可输出一句难听但诚实的话（"上次记录…请以银行系统为准"），
 * 也不能让一句未核验的状态看起来像事实。
 */
export function toRetrieved(row: MemoryUnitRow): RetrievedMemory {
  const stateful = STATEFUL_PREDICATES.has(row.predicate)
  const verified = row.lastVerifiedAt !== null

  if (stateful && !verified) {
    // 只给**身份**，不给**状态**。
    //
    // 第一版写成 `上次记录：${renderRowText(row)}（…）`，把「当前状态：lost」原样复述了一遍——
    // 换了个包装，模型照样能照抄。STATEFUL 的记录值只能当"路由线索"（这是哪张卡），
    // 不能当"事实"（这卡还能不能用）。
    const object = (row.object ?? {}) as Record<string, unknown>
    const target =
      row.predicate === 'card_state'
        ? `尾号 ${asString(object.card_last4) ?? subjectValue(row.subject, 'card') ?? '未知'} 的卡`
        : `订阅 ${subjectValue(row.subject, 'subscription') ?? '未知'}`
    return {
      unitId: row.unitId,
      sceneTag: sourceSceneOf(row),
      sourceScene: sourceSceneOf(row),
      confidence: row.confidence,
      asOf: row.validFrom,
      // `stale` 不是"数据旧了"，而是"这份状态没被权威源确认过"。
      shadow: 'stale',
      renderedText: `上次记录：您在 ${row.validFrom} 提到过${target}的状态变化；尚未与银行系统核验，请以银行系统为准。`,
    }
  }

  return {
    unitId: row.unitId,
    sceneTag: sourceSceneOf(row),
    sourceScene: sourceSceneOf(row),
    confidence: row.confidence,
    asOf: row.lastVerifiedAt ?? row.validFrom,
    shadow: stateful ? 'verified' : 'n_a',
    renderedText: renderRowText(row),
    ...(row.lastVerifiedAt === null ? {} : { lastVerifiedAt: row.lastVerifiedAt }),
  }
}
