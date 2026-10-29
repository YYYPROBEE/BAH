/**
 * 意图平面类型契约（03 单 §3.1）。
 *
 * WHY 封闭联合：任何消费点必须以判别标签 switch 显式分支并以 `assertNever` 收尾，
 * 新增意图种类时编译器逼出所有遗漏点，杜绝「静默落入 default」。
 */

import type { EvidenceItem } from './evidence.ts'

/** 意图种类。`explicit` 是基线；其余四类是本平面要识别的「非直白意图」。 */
export type IntentKind =
  | 'explicit' // 直白：动作动词 + 对象 + 关键槽位齐备（「给张三转500元」）
  | 'vague' // 模糊：用指代/含混词指向历史或对象（「上次那个转账再来一次」）
  | 'elliptical' // 省略：省略主语/谓语，依赖上一轮槽位表（「就转给他」「改成800」）
  | 'implicit' // 隐含：只陈述场景/事实，未说动作（「我爱人生日快到了」）
  | 'ambiguous' // 歧义：≥2 个意图域同时命中，或单槽位存在多个候选

/** 槽位名。封闭集合。WHY 不给每个产品加新槽位名：防 SlotTable 键空间爆炸，产品差异进 value。 */
export type SlotName =
  | 'payee' // 收款人（归一化后仍可能是多候选 ⇒ 进 conflicts）
  | 'account' // 账户（证据与出参中只允许尾号形态，见 evidence.ts）
  | 'amountCents' // 金额。WHY 带 Cents 后缀：模型参数口径是「元」，核心与事件口径是「分」
  | 'timeRange' // 时间范围（归一化为 ISO 日期串区间）
  | 'category' // 交易分类（账单分析用）
  | 'product' // 理财产品标识
  | 'targetScene' // 跨场景引用目标

/** 槽位名的运行时白名单（配置校验用；与 `SlotName` 联合一一对应）。 */
export const SLOT_NAMES = [
  'payee',
  'account',
  'amountCents',
  'timeRange',
  'category',
  'product',
  'targetScene',
] as const satisfies readonly SlotName[]

/** 槽位值来源。审计必须能回答「这个值从哪来」，来源直接决定是否允许进入执行链。 */
export type SlotSource =
  | 'utterance' // 本轮用户原话抽取
  | 'session' // 会话层槽位表继承（上一轮已被用户确认过的值）
  | 'memory' // memory 检索复现（未经用户确认 ⇒ 强制 requiresPreview）
  | 'user-choice' // prompt_ask 选择题点选
  | 'tool' // 银行工具出参回填

export interface FilledSlot {
  readonly name: SlotName
  /** 金额槽位一律 integer 分；其余为归一化字符串。 */
  readonly value: string | number
  readonly source: SlotSource
  /**
   * 置信度 ∈ [0,1]，由整数评分/100 得出。
   * WHY 整数评分：浮点累加会破坏「同输入同输出」的位级可复现性。禁止任何随机来源。
   */
  readonly confidence: number
}

export interface SlotConflict {
  readonly name: SlotName
  /** ≥2 个不同来源/取值的候选。conflicts 非空 ⇒ kind 至少是 ambiguous。 */
  readonly candidates: readonly FilledSlot[]
}

/**
 * 两层槽位表。
 *
 * 生命周期：
 *  - turn 层：turn 开始构建，turn 结束即弃；接受 utterance / user-choice / tool 写入；
 *  - session 层：跨 turn 存活；turn 结束时仅把 source ∉ {'memory'} 的 turn 层槽位并入。
 *    WHY 排除 memory：检索复现值未经用户确认，并入会话层 = 跨 turn 污染。
 *
 * 覆盖规则：同名槽位 turn 层覆盖 session 层；turn 层内优先级
 * user-choice > utterance > tool > session > memory。
 * askCount：每槽位累计追问次数，防死循环（上限见 prompt/tool.ts，n=2）。
 */
export interface SlotTable {
  readonly turn: Readonly<Partial<Record<SlotName, FilledSlot>>>
  readonly session: Readonly<Partial<Record<SlotName, FilledSlot>>>
  readonly askCount: Readonly<Partial<Record<SlotName, number>>>
}

/** 空表：第一次判定时的初值（常量对象，避免每次新建带来的引用不等）。 */
export const EMPTY_SLOT_TABLE: SlotTable = Object.freeze({ turn: {}, session: {}, askCount: {} })

export type IntentDecision = 'proceed' | 'ask' | 'propose'

export interface IntentProposal {
  /** 提案一句话（「为爱人生日准备一笔心意金？」）。 */
  readonly title: string
  /** 为什么提这个案（引用 evidence 的 ruleId）。 */
  readonly rationale: string
  readonly ruleId: string
  /** 只写工具名，不写参数：执行编排归 04 单 plan_propose。 */
  readonly candidateActions: readonly string[]
}

export interface AskHint {
  /** 追问目标槽位。 */
  readonly slot: SlotName
  /** 建议问法（prompt_ask 可直接采用）。 */
  readonly question: string
  /** 可构造选择题的候选（可为空 ⇒ 开放式提问）。 */
  readonly candidates: readonly FilledSlot[]
}

export interface IntentResolution {
  readonly kind: IntentKind
  /** 不得含 PII 原文（证据构造点已脱敏）。 */
  readonly evidence: readonly EvidenceItem[]
  /** 冲突槽位不在其中（歧义值只进 conflicts，禁止默认值填充）。 */
  readonly filled: readonly FilledSlot[]
  readonly missing: readonly SlotName[]
  readonly conflicts: readonly SlotConflict[]
  readonly decision: IntentDecision
  readonly confidence: number
  /**
   * filled 中存在 source==='memory' 的资金类槽位，或 kind==='vague' ⇒ 恒为 true。
   * WHY 单独成字段而不是让调用方自己推断：E5 要求「复现必经预演」是可门禁、可 eval 断言的硬约束，
   * 不能依赖调用方记得去查 source。
   */
  readonly requiresPreview: boolean
  /** decision='propose' 时非空；否则恒 []。 */
  readonly proposals: readonly IntentProposal[]
  /** decision='ask' 时非 null；否则恒 null。 */
  readonly askHint: AskHint | null
}
