/**
 * 意图解析纯函数 + 可解释规则引擎（03 单 §3.2/§3.3）。
 *
 * 规则求值顺序固定（R-XS → R-AMB → R-IMP → R-VAGUE → R-ELL → R-EXP 默认）：
 * WHY 显式动词优先——「爱人生日快到了，直接给张三转520」必须判 explicit 而不是 implicit，
 * 否则隐含意图规则会劫持一切含场景词的句子。
 *
 * 本文件零 IO、零时钟、零随机：同 (input, ctx) ⇒ 位级同输出（门禁 verify-intent-determinism I1 锁死）。
 */

import { assertNever } from '@bah/util'

import { buildEvidence } from './evidence.ts'
import {
  ACTION_VERBS,
  ASK_QUESTIONS,
  CONSULT_PATTERNS,
  CONSULT_PRODUCT,
  CROSS_SCENE_ASK,
  DOMAIN_KEYWORDS,
  HISTORY_DEICTIC,
  NUMERIC_ONLY,
  PRONOUNS,
  QUERY_VERBS,
  SCENE_HINTS,
  SCENE_LABELS,
  SCENE_PRODUCTS,
  VAGUE_WORDS,
} from './lexicon.ts'
import { memorySlots } from './recall.ts'
import {
  FUND_SLOT_NAMES,
  detectConflicts,
  findMissing,
  mergeByPriority,
  normalizeUtteranceSlots,
} from './slots.ts'

import type { EvidenceItem } from './evidence.ts'
import type { RecallSnapshot } from './recall.ts'
import type {
  AskHint,
  FilledSlot,
  IntentDecision,
  IntentKind,
  IntentProposal,
  IntentResolution,
  SlotConflict,
  SlotName,
  SlotTable,
} from './types.ts'

export interface ResolveInput {
  readonly utterance: string
  readonly slots: SlotTable
  /**
   * 由调用方注入：工具的 execute 先调 recall 完成 IO，再把结果喂给纯函数。
   * WHY 注入而非函数内检索：resolveIntent 必须零 IO，才能被门禁锁死。
   */
  readonly recall: RecallSnapshot | null
  /** 省略句判定需要「上一轮在办什么事」。 */
  readonly lastTurnKind: IntentKind | null
}

export interface ResolveContext {
  /** 当前场景（memory-store 的 Scene 六值或 unknown）。 */
  readonly scene: string
  /** 「今天/最近」等相对时间的解析基准。WHY 注入：纯函数不得读时钟。格式 'YYYY-MM-DD'。 */
  readonly today: string
}

/** 域歧义（R-AMB-1）时给用户看的解释：候选是「这句话可能指哪件事」，不是槽位值。 */
const DOMAIN_LABELS: Readonly<Record<string, string>> = {
  transfer: '转账给收款人',
  repay: '信用卡还款',
  invest: '理财产品',
  bills: '账单/流水',
}

/** 意图判定的中间结论（规则命中 + 证据 + 可选的域解释候选）。 */
interface Classification {
  readonly kind: IntentKind
  readonly evidence: readonly EvidenceItem[]
  readonly domainCandidates?: readonly FilledSlot[]
  /** 必须丢弃的记忆来源槽位：未经用户确认的实体指代不落地（R-VAGUE-3）。 */
  readonly dropMemorySlots?: readonly SlotName[]
}

/** 槽位在出参里的稳定顺序：回放与快照逐字比对时不能靠 Map 插入序。 */
const SLOT_ORDER: readonly SlotName[] = [
  'payee',
  'account',
  'amountCents',
  'timeRange',
  'category',
  'product',
  'targetScene',
]

function slotRank(name: SlotName): number {
  const index = SLOT_ORDER.indexOf(name)
  return index === -1 ? SLOT_ORDER.length : index
}

/** 命中任一关键词（`includes` 而不是正则：词表里没有元字符，转义反而增加不确定性）。 */
function hitsAny(text: string, words: readonly string[]): readonly string[] {
  return words.filter((word) => text.includes(word))
}

/** 命中的意图域（≥2 个 ⇒ R-AMB-1）。 */
function matchedDomains(text: string): readonly string[] {
  const domains: string[] = []
  for (const [domain, words] of Object.entries(DOMAIN_KEYWORDS)) {
    if (hitsAny(text, words).length > 0) domains.push(domain)
  }
  return domains
}

/** 复现标记：单独出现「上次/那个」不够，必须有「再来一次/照旧/接着」这类重办语义。 */
const RECALL_MARKERS = /再来|再转|再来一次|照旧|老样子|接着|继续/

/** 修改动词：它们天然依赖上一轮的槽位（「改成800」），是省略式的强信号。 */
const REVISION_VERBS = /改成|改为|换成|调整为/

/**
 * 实体消歧：用户只说了名字，而记忆里同一个名字对多条记录（「张伟（同事）/张伟（房东）」）。
 *
 * WHY 不能只靠 `detectConflicts`：合并阶段 utterance 覆盖 memory，payee 只剩一个值；
 * 「一个名字对多个实体」是**跨来源**的歧义，必须在合并之后单独算。
 */
function entityConflicts(
  utterancePayee: FilledSlot | undefined,
  recall: RecallSnapshot | null,
): readonly SlotConflict[] {
  if (utterancePayee === undefined || recall === null) return []
  const name = String(utterancePayee.value)
  const matches = recall.memories.filter((memory) =>
    memory.fields.some((field) => field.name === 'payee' && String(field.value).includes(name)),
  )
  if (matches.length < 2) return []
  const candidates: FilledSlot[] = []
  for (const memory of matches) {
    const field = memory.fields.find((item) => item.name === 'payee')
    if (field === undefined) continue
    if (candidates.some((candidate) => candidate.value === field.value)) continue
    candidates.push({ name: 'payee', value: field.value, source: 'memory', confidence: memory.confidence })
  }
  return candidates.length > 1 ? [{ name: 'payee', candidates }] : []
}

/** 合并冲突与实体消歧（同槽位只保留一条冲突记录，候选合并去重）。 */
function combineConflicts(
  conflicts: readonly SlotConflict[],
  entity: readonly SlotConflict[],
): readonly SlotConflict[] {
  if (entity.length === 0) return conflicts
  const byName = new Map<SlotName, FilledSlot[]>()
  for (const conflict of [...conflicts, ...entity]) {
    const list = byName.get(conflict.name) ?? []
    for (const candidate of conflict.candidates) {
      if (!list.some((item) => item.value === candidate.value)) list.push(candidate)
    }
    byName.set(conflict.name, list)
  }
  const combined: SlotConflict[] = []
  for (const [name, candidates] of byName) combined.push({ name, candidates })
  return combined.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
}

/** 分类：只读输入，产出 kind + 证据。`filled` 已剔除冲突槽位。 */
function classify(
  utterance: string,
  filled: readonly FilledSlot[],
  utteranceSlots: readonly FilledSlot[],
  conflicts: readonly SlotConflict[],
  input: ResolveInput,
  ctx: ResolveContext,
): Classification {
  const evidence: EvidenceItem[] = []
  const add = (ruleId: string, span: string, slot?: SlotName, slotSource?: FilledSlot['source']): void => {
    evidence.push(buildEvidence(ruleId, span, slot, slotSource))
  }

  const hasVerb = hitsAny(utterance, ACTION_VERBS).length > 0
  const queryOnly =
    hitsAny(utterance, QUERY_VERBS).length > 0 &&
    !/转账|汇款|打款|打钱|还款/.test(utterance)
  const deictic = hitsAny(utterance, HISTORY_DEICTIC)
  const marker = RECALL_MARKERS.test(utterance)
  const anaphorOnly = /那个|这笔|那笔/.test(utterance) && !queryOnly
  const wantsRecall = deictic.length > 0 && (marker || anaphorOnly)
  const hasHistory = input.recall !== null && input.recall.memories.length > 0
  const domains = matchedDomains(utterance)
  const sessionActive = Object.keys(input.slots.session).length > 0
  const required = findMissing('explicit', ctx.scene, filled, conflicts)
  // 「本轮说了名字/金额」必须看原话抽取，不能看 filled：filled 里有会话层继承值，
  // 用它判断会把「就转给他」当成「说了收款人」，R-ELL-1 永不触发
  const hasNamedPayee = utteranceSlots.some((slot) => slot.name === 'payee')
  const hasNamedAmount = utteranceSlots.some((slot) => slot.name === 'amountCents')

  // R-XS-1：跨场景引用优先于一切 kind 判定。
  // WHY 连 kind 一起定成 vague：指向「别处的事」本身就是模糊指代，
  // 若放任它落进 elliptical（短句 + 会话层有槽位），会把上一轮的转账参数当成它的槽位。
  const crossGate = input.recall?.crossScene ?? null
  if (crossGate !== null && !crossGate.allowed) {
    add('R-XS-1', utterance, 'targetScene', 'session')
    return { kind: 'vague', evidence }
  }

  // R-AMB-2：单槽位多候选（记忆里的两个「张伟」）⇒ 歧义，禁止默认值填充
  if (conflicts.length > 0) {
    const first = conflicts[0]
    if (first !== undefined) add('R-AMB-2', utterance, first.name, first.candidates[0]?.source)
    return { kind: 'ambiguous', evidence }
  }

  // R-AMB-1：≥2 个意图域同时命中且查询动词不能消歧（「把转账卡的钱还上」）
  if (domains.length >= 2 && !queryOnly) {
    add('R-AMB-1', utterance)
    const domainCandidates = domains
      .map((domain) => DOMAIN_LABELS[domain])
      .filter((label): label is string => label !== undefined)
      .map((label) => ({ name: 'targetScene' as const, value: label, source: 'session' as const, confidence: 0.5 }))
    return { kind: 'ambiguous', evidence, domainCandidates }
  }

  // R-IMP-1/2：场景陈述或咨询问句，且**去掉场景词后零动作动词**。
  // WHY 先剥场景词：「买车」「孩子上学」里的动词是场景词的一部分，不是资金动作；
  // 直接看 hasVerb 会把它们判成 explicit，隐含意图就永远出不来（§9 偏差 5）。
  const stripped = SCENE_HINTS.reduce((text, hint) => text.split(hint).join(''), utterance)
  const sceneVerb = hitsAny(stripped, ACTION_VERBS).length > 0
  if (!sceneVerb) {
    const sceneHint = hitsAny(utterance, SCENE_HINTS)
    if (sceneHint.length > 0) {
      add('R-IMP-1', utterance)
      return { kind: 'implicit', evidence }
    }
    const consult = CONSULT_PATTERNS.find((pattern) => pattern.test(utterance))
    if (consult !== undefined) {
      add('R-IMP-2', utterance)
      return { kind: 'implicit', evidence }
    }
  }

  // R-VAGUE-1：历史指代 + 复现语义。有历史 ⇒ 取记忆值；无历史 ⇒ 仍判 vague（复现绝不瞎猜）
  if (wantsRecall) {
    add('R-VAGUE-1', utterance, 'payee', hasHistory ? 'memory' : 'utterance')
    return { kind: 'vague', evidence }
  }

  // R-VAGUE-3：代词作收款人且会话层无先行词（「转500给他」）
  const pronoun = hitsAny(utterance, PRONOUNS)
  if (pronoun.length > 0 && !hasNamedPayee && input.slots.session.payee === undefined) {
    add('R-VAGUE-3', utterance, 'payee')
    // 「他」没有先行词时，记忆里的收款人只是**候选**而不是已确认的值：
    // 让 payee 留在 missing 里，askHint 才能把它作为可选项抛给用户确认
    return { kind: 'vague', evidence, dropMemorySlots: ['payee'] }
  }

  // R-ELL-2：纯数值句覆盖金额（优先于 R-ELL-1：它不依赖句长）
  if (NUMERIC_ONLY.test(utterance) && input.lastTurnKind !== null && sessionActive) {
    add('R-ELL-2', utterance, 'amountCents', 'utterance')
    return { kind: 'elliptical', evidence }
  }

  // R-VAGUE-2：含混词 + 关键槽位缺失（「随便转点钱」）
  const vagueWord = hitsAny(utterance, VAGUE_WORDS)
  if (vagueWord.length > 0 && required.length > 0) {
    add('R-VAGUE-2', utterance, required[0])
    return { kind: 'vague', evidence }
  }

  // R-ELL-1：短句省略，且上一轮确有在办的事可继承（「就转给他」「改成800」）。
  // 判据是「没有完整的新指令」而不是「句长 ≤6 且无动词」：后者会把「就转给他」排除在外
  // （它含动词「转」），与 TC-INT-05 不可同时成立（§9 偏差 4）。
  const revision = REVISION_VERBS.test(utterance)
  const noNewEntity = !hasNamedPayee && !hasNamedAmount
  if (
    (revision || (utterance.length <= 8 && noNewEntity)) &&
    !queryOnly &&
    input.lastTurnKind !== null &&
    sessionActive
  ) {
    add('R-ELL-1', utterance, required[0])
    return { kind: 'elliptical', evidence }
  }

  // R-EXP-1：直白动作 + 槽位齐备（基线）
  if (hasVerb && required.length === 0) add('R-EXP-1', utterance)
  return { kind: 'explicit', evidence }
}

/** 决策：kind 决定基线，R-XS-1 与「vague 无历史」两个安全条件可以再收紧为 ask。 */
function decideFor(
  kind: IntentKind,
  missing: readonly SlotName[],
  conflicts: readonly SlotConflict[],
  input: ResolveInput,
): IntentDecision {
  const base = ((): IntentDecision => {
    switch (kind) {
      case 'implicit':
        return 'propose' // 恒定：隐含意图只出提案，绝不 proceed
      case 'ambiguous':
        return 'ask' // 恒定：歧义必须走 prompt_ask，禁止默认值填充
      case 'vague':
      case 'elliptical':
      case 'explicit':
        return conflicts.length > 0 || missing.length > 0 ? 'ask' : 'proceed'
      /* v8 ignore start —— IntentKind 五值穷尽：default 不可达 */
      default:
        return assertNever(kind)
      /* v8 ignore stop */
    }
  })()

  // R-XS-1：拒借后不得径直复现参数
  const crossGate = input.recall?.crossScene ?? null
  if (crossGate !== null && !crossGate.allowed) return 'ask'
  // 复现类意图在没有历史依据时不得 proceed（宁可追问，不做「猜上次」）
  if (kind === 'vague' && (input.recall === null || input.recall.memories.length === 0)) return 'ask' 
  return base
}

/** 分类阶段的 filled 预览（冲突已剔除，尚未应用 dropMemorySlots）。 */
function filledProbe(
  candidates: readonly FilledSlot[],
  conflicted: ReadonlySet<SlotName>,
): readonly FilledSlot[] {
  return candidates.filter((slot) => !conflicted.has(slot.name))
}

/** 构造追问素材。 */
function buildAskHint(
  kind: IntentKind,
  missing: readonly SlotName[],
  conflicts: readonly SlotConflict[],
  input: ResolveInput,
  domainCandidates: readonly FilledSlot[] | undefined,
): AskHint | null {
  if (kind === 'implicit') return null

  const crossGate = input.recall?.crossScene ?? null
  if (crossGate !== null && !crossGate.allowed) {
    return {
      slot: 'targetScene',
      question: CROSS_SCENE_ASK.replace('{target}', SCENE_LABELS[crossGate.target] ?? crossGate.target),
      candidates: [],
    }
  }

  const conflict = conflicts[0]
  const slot: SlotName = conflict?.name ?? missing[0] ?? (domainCandidates === undefined ? 'payee' : 'targetScene')
  const candidates =
    conflict?.candidates ??
    domainCandidates ??
    input.recall?.memories.flatMap((memory) =>
      memory.fields.filter((field) => field.name === slot).map((field) => ({
        name: field.name,
        value: field.value,
        source: 'memory' as const,
        confidence: memory.confidence,
      })),
    ) ??
    []
  return {
    slot,
    question: ASK_QUESTIONS[slot] ?? '能再说得具体一点吗？',
    candidates: candidates.slice(0, 3),
  }
}

/**
 * 构造提案素材（implicit 专用）。
 *
 * 导出供单测直接打兜底分支：classify 只在命中场景词/咨询问句时才返回 implicit，
 * 所以「两条都没命中」在正常路径上不可达——不可达分支要么删掉，要么被直接测到，
 * 不许用 ignore 注释留一个没人验证过的 `return []`。
 */
export function buildProposals(utterance: string): readonly IntentProposal[] {
  const sceneHint = hitsAny(utterance, SCENE_HINTS)[0]
  if (sceneHint !== undefined) {
    const seed = SCENE_PRODUCTS[sceneHint]
    if (seed !== undefined) {
      return [
        {
          title: seed.title,
          rationale: `识别到场景线索「${sceneHint}」且这句话没有动作指令（R-IMP-1）`,
          ruleId: 'R-IMP-1',
          candidateActions: seed.actions,
        },
      ]
    }
  }
  const consult = CONSULT_PATTERNS.find((pattern) => pattern.test(utterance))
  if (consult !== undefined) {
    return [
      {
        title: CONSULT_PRODUCT.title,
        rationale: '识别到咨询式问句且没有明确产品指令（R-IMP-2）',
        ruleId: 'R-IMP-2',
        candidateActions: CONSULT_PRODUCT.actions,
      },
    ]
  }
  return []
}

/** 整数评分（0–100）：确定性、可解释、无浮点累加。 */
function scoreOf(kind: IntentKind, decision: IntentDecision, evidence: readonly EvidenceItem[], input: ResolveInput): number {
  const crossGate = input.recall?.crossScene ?? null
  if (crossGate !== null && !crossGate.allowed) return Math.round(crossGate.confidence * 100)
  switch (kind) {
    case 'ambiguous':
      return 40
    case 'implicit':
      return 60
    case 'vague':
      return evidence.some((item) => item.ruleId === 'R-VAGUE-1') && input.recall !== null && input.recall.memories.length > 0
        ? 75
        : 50
    case 'elliptical':
      return 70
    case 'explicit':
      return decision === 'proceed' ? 90 : 60
    /* v8 ignore start —— IntentKind 五值穷尽：default 不可达 */
    default:
      return assertNever(kind)
    /* v8 ignore stop */
  }
}

/**
 * 意图解析纯函数：同 (input, ctx) ⇒ 位级同输出。
 *
 * `ctx.scene` 决定必填槽位；`ctx.today` 是相对时间的唯一基准。
 */
export function resolveIntent(input: ResolveInput, ctx: ResolveContext): IntentResolution {
  const utterance = input.utterance.trim()
  const utteranceSlots = normalizeUtteranceSlots(utterance, ctx.today, ctx.scene).slots
  const memory = input.recall === null ? [] : memorySlots(input.recall)
  const candidates = mergeByPriority(input.slots, utteranceSlots, memory)
  const utterancePayee = utteranceSlots.find((slot) => slot.name === 'payee')
  const conflicts = combineConflicts(detectConflicts(candidates), entityConflicts(utterancePayee, input.recall))
  const conflicted = new Set(conflicts.map((conflict) => conflict.name))

  const classified = classify(utterance, filledProbe(candidates, conflicted), utteranceSlots, conflicts, input, ctx)
  const dropped = new Set(classified.dropMemorySlots ?? [])
  // 冲突槽位只进 conflicts 不进 filled：默认值填充是歧义场景里最贵的一种「聪明」
  // 继承规则（按 kind）：
  // - 只有省略句继承会话层：其它意图都是新话题，带上上一轮的任务参数只会误导；
  // - 歧义时不取记忆值：值本身可靠，但"这句话指哪件事"还没定，先塞参数等于替用户拍板；
  // - 隐含意图完全不填槽位：提案不执行，带上一轮的金额只会让材料失真。
  const inheritSession = classified.kind === 'elliptical'
  const merged = candidates
    .filter((slot) => !conflicted.has(slot.name))
    .filter((slot) => !(slot.source === 'memory' && dropped.has(slot.name)))
    .filter((slot) => inheritSession || slot.source !== 'session')
    .filter((slot) => classified.kind !== 'ambiguous' || slot.source !== 'memory')
    .sort((a, b) => slotRank(a.name) - slotRank(b.name))
  const filled = classified.kind === 'implicit' ? [] : merged
  const missing = findMissing(classified.kind, ctx.scene, filled, conflicts)
  const decision = decideFor(classified.kind, missing, conflicts, input)
  const askHint =
    decision === 'ask'
      ? buildAskHint(classified.kind, missing, conflicts, input, classified.domainCandidates)
      : null
  const proposals = classified.kind === 'implicit' ? buildProposals(utterance) : []

  const hasMemoryFund = filled.some(
    (slot) => slot.source === 'memory' && FUND_SLOT_NAMES.has(slot.name),
  )
  const requiresPreview = classified.kind === 'vague' || hasMemoryFund

  // 证据里的槽位来源必须与最终 filled 一致：模型据此解释「这个值哪来的」
  const evidence = classified.evidence.map((item) => {
    if (item.slot === undefined) return item
    const slot = filled.find((candidate) => candidate.name === item.slot)
    return slot === undefined ? item : buildEvidence(item.ruleId, item.span, slot.name, slot.source)
  })

  return {
    kind: classified.kind,
    evidence,
    filled,
    missing,
    conflicts,
    decision,
    confidence: scoreOf(classified.kind, decision, evidence, input) / 100,
    requiresPreview,
    proposals,
    askHint,
  }
}
