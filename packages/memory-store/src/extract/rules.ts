/**
 * 规则抽取（设计文档 §4.2）：P1–P4，**禁 LLM**。
 *
 * 为什么不用模型抽：记忆写入是"用户说了什么就记什么"的合规动作，抽取结果要能被
 * 逐条回溯到一句原文、一条正则。模型抽出来的东西没法在对外说明现场解释"为什么记了这条"，
 * 也没法证明"没记那条"。
 *
 * 代价（必须承认）：召回率低——同样的意思换个说法就抽不到。这是刻意的：
 * 漏记可以靠用户重说，错记要靠擦除和道歉。
 */

import type {
  ExtractionResult,
  IngestInput,
  MemoryCandidate,
  VaultCandidate,
} from '../types.ts'

/* ────────────────────────────── P1 偏好绑定 ────────────────────────────── */

/**
 * `以后(给<payee>)?(转账|汇款)(都|一律|就)?(用|走|从)(尾号)?<last4>的?卡`
 *
 * 两处**偏离文档 §4.2 原文**（都是文档正则的实际缺陷，已登记在批次汇报里）：
 *   1. 文档写 `(?:转|汇)款?`，只能匹配「转 / 汇 / 汇款」，**匹配不了「转账」**——
 *      而文档 §4.1 的示例句正是「以后转账都用尾号8888的卡」。改为 `(?:转|汇)(?:账|款)?`。
 *   2. payee 组排除数字：否则「以后给房东转账用尾号8888」会把尾号吃进收款人名。
 */
const P1_PREFERRED_CARD =
  /以后(?:给(?<payee>[^\d,，。\s]{1,12}))?(?:转|汇)(?:账|款)?(?:都|一律|就)?(?:用|走|从)(?:尾号)?(?<!\d)(?<digits>\d{16,19}|\d{4})(?!\d)的?卡/

/* ────────────────────────────── P2 实体别名 ────────────────────────────── */

/**
 * `<alias>(是|就是|=)(尾号)?<last4>(的卡|的储蓄卡)?`
 *
 * **偏离文档 §4.2 原文**：文档要求结尾必须出现「卡/储蓄卡」，但同文档 §4.1 的示例句
 * 「工资卡是尾号6666」结尾并没有「卡」字——按文档正则这条示例根本抽不出来。
 * 这里把尾缀改为可选（`的卡` 本身已在前面的 alias 里出现过）。
 *
 * 尾 4 位带数字边界（`(?<!\d)…(?!\d)`）：否则 16 位完整卡号会被截出**前** 4 位当尾号。
 * 完整卡号的正解在 `extractCandidates` 顶部统一处理（取后 4 位）。
 */
const P2_CARD_ALIAS =
  /(?:我的)?(?<alias>[^\d,，。\s]{1,12})(?:是|就是|=)(?:尾号)?(?<!\d)(?<digits>\d{16,19}|\d{4})(?!\d)(?:的?(?:卡|储蓄卡))?/

/* ────────────────────────────── P3 状态陈述 ────────────────────────────── */

/** `我(的)?(尾号<last4>的)?卡(丢|挂失|注销)了?` —— STATEFUL，需指代解析。 */
const P3_CARD_STATE = /我(?:的)?(?:尾号(?<last4>\d{4})的?)?卡(?<verb>丢|挂失|注销)了?/

/** `(取消|退订)(这个)?(订阅|自动扣费)` */
const P3_SUBSCRIPTION_STATE = /(?:取消|退订)(?:这个)?(?:订阅|自动扣费)/

/** 状态词映射：用户口语 → 记忆域状态词。 */
const CARD_STATE_WORDS: Readonly<Record<string, string>> = {
  丢: 'lost',
  挂失: 'frozen_by_user',
  注销: 'cancelled',
}

/* ────────────────────────────── P4 程序性指令 ────────────────────────────── */

/** 安全动作类：只入金库，**永不**直接改变系统行为。 */
const P4_SAFE_ACTION =
  /以后(?:转账|汇款)(?:之前|前)?(?:都)?(?:先)?(?:给我)?(?:看|确认|发)(?:下)?(?:费率|汇率|手续费)/

const RULE_CONFIDENCE = 0.9

/**
 * 完整卡号（16–19 位连续数字）。
 *
 * 放在抽取入口统一处理，而不是丢给 G3 兜底：同一条消息里若有完整卡号，P1/P2 的
 * 「尾 4 位」组会因为数字边界而匹配不上，此时**唯一正确的尾号就是卡号后 4 位**。
 * 让 G3 事后脱敏救不了已经被截错的前 4 位。
 */
const FULL_CARD_NUMBER = /\b\d{16,19}\b/

/**
 * 会话实体键的合法形状：`card:8888` / `subscription:netflix`。
 *
 * `recentEntities` 由调用方传入（会话状态），属于**半可信输入**：它决定了 P3 的状态陈述
 * 会记到哪张卡上。只做 `startsWith('card:')` 判断的话，一个畸形键会被原样写进 `subject`
 * 并长期留在库里——不影响 SQL 安全（全程参数化），但会污染血统、让后续核验找不到实体。
 */
const ENTITY_KEY = /^(?:card|subscription):[A-Za-z0-9._-]{1,32}$/

/** 在会话近期实体里找最近的一个指定前缀的键（P3 指代解析）。 */
function latestEntity(recent: readonly string[] | undefined, prefix: string): string | undefined {
  if (recent === undefined) return undefined
  for (let index = recent.length - 1; index >= 0; index -= 1) {
    const key = recent[index]
    if (key === undefined) continue
    if (!key.startsWith(`${prefix}:`)) continue
    if (!ENTITY_KEY.test(key)) continue
    return key
  }
  return undefined
}

/**
 * 抽取入口。
 *
 * `speaker !== 'user'` 直接返回空：这是通道隔离的**第二道**防线（第一道在 pipeline）。
 * 两道都留不是冗余——将来若有人直接调 `extractCandidates`，工具输出也进不来。
 */
export function extractCandidates(input: IngestInput): ExtractionResult {
  const memories: MemoryCandidate[] = []
  const vaults: VaultCandidate[] = []
  const unresolved: { family: string; suggestion: string }[] = []
  if (input.speaker !== 'user') return { memories, vaults, unresolved }

  const text = input.text
  // 完整卡号优先：见 `FULL_CARD_NUMBER` 的注释。
  const fullCard = text.match(FULL_CARD_NUMBER)
  const fullCardLast4 = fullCard === null ? undefined : fullCard[0].slice(-4)

  /* P1 */
  const p1 = text.match(P1_PREFERRED_CARD)
  const p1Last4 = p1?.groups?.digits?.slice(-4) ?? fullCardLast4
  if (p1 !== null && p1Last4 !== undefined && p1Last4.length === 4) {
    const payee = p1.groups?.payee
    const hasPayee = payee !== undefined && payee.length > 0
    memories.push({
      subject: hasPayee ? `payee:${payee}` : 'user',
      predicate: hasPayee ? 'preferred_payee_card' : 'preferred_card_for',
      object: { card_last4: p1Last4 },
      scene: 'transfer',
      source: 'user_statement',
      pattern: 'P1',
      rawSpan: p1[0],
      confidence: RULE_CONFIDENCE,
    })
  }

  /* P2 */
  const p2 = text.match(P2_CARD_ALIAS)
  const p2Last4 = p2?.groups?.digits?.slice(-4) ?? fullCardLast4
  const p2Alias = p2?.groups?.alias
  if (p2 !== null && p2Last4 !== undefined && p2Alias !== undefined && p2Alias.length > 0) {
    memories.push({
      subject: `alias:${p2Alias}`,
      predicate: 'alias_of',
      object: { card_last4: p2Last4 },
      scene: 'card',
      source: 'user_statement',
      pattern: 'P2',
      rawSpan: p2[0],
      confidence: RULE_CONFIDENCE,
    })
  }

  /* P3 · 卡状态 */
  const p3Card = text.match(P3_CARD_STATE)
  if (p3Card !== null) {
    const verb = p3Card.groups?.verb ?? ''
    const status = CARD_STATE_WORDS[verb]
    const explicit = fullCardLast4 ?? p3Card.groups?.last4
    const subject =
      explicit !== undefined && explicit.length === 4
        ? `card:${explicit}`
        : latestEntity(input.recentEntities, 'card')
    if (status !== undefined && subject !== undefined) {
      memories.push({
        subject,
        predicate: 'card_state',
        object: { status },
        scene: 'card',
        source: 'user_statement',
        pattern: 'P3',
        rawSpan: p3Card[0],
        confidence: RULE_CONFIDENCE,
      })
    } else if (status !== undefined) {
      // 状态词认出来了、主体没认出来：不猜卡，交给调用方反问。
      unresolved.push({ family: 'card', suggestion: '您说的是哪张卡？请补充尾号后四位。' })
    }
  }

  /* P3 · 订阅状态 */
  const p3Sub = text.match(P3_SUBSCRIPTION_STATE)
  if (p3Sub !== null) {
    const subject = latestEntity(input.recentEntities, 'subscription')
    if (subject !== undefined) {
      memories.push({
        subject,
        predicate: 'subscription_state',
        object: { status: 'cancelled' },
        scene: 'subscription',
        source: 'user_statement',
        pattern: 'P3',
        rawSpan: p3Sub[0],
        confidence: RULE_CONFIDENCE,
      })
    } else {
      unresolved.push({ family: 'subscription', suggestion: '您指的是哪个订阅？请说出服务名称。' })
    }
  }

  /* P4 */
  const p4 = text.match(P4_SAFE_ACTION)
  if (p4 !== null) {
    vaults.push({
      triggerDesc: '转账执行前',
      actionDesc: '先向用户展示费率',
      rawSpan: p4[0],
      confidence: RULE_CONFIDENCE,
    })
  }

  return { memories, vaults, unresolved }
}
