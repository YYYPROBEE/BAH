/**
 * 风险测评问卷实例（C-03 修复：把「模型直接给 5 个数字」换成「服务端发卷 → 用户作答」）。
 *
 * ## 为什么单独一个文件
 *
 * 题目与分值必须**只存在于代码里**：一旦进 prompt 或模型入参，模型就能自己凑一组合法答案，
 * 「用户确认」这件事就再也证明不了。所以本文件是问卷内容的唯一来源，
 * `MockBankCore` 只持有实例表（谁在什么时候领了哪张卷），不复制题目。
 *
 * ## 三条纪律
 *
 * 1. **题干与分值是不可变常量**（`RISK_QUESTIONS`）：模型既看不到也不需要看到，
 *    渠道拿到的问卷副本只能用于渲染；
 * 2. **分数带映射只有一份**（`model.ts` 的 `riskGradeOfScore`）：审批卡预告「批完会变成几级」
 *    与落档走同一个函数，不允许这里再抄一段 if-else；
 * 3. **校验顺序即安全边界**：存在 → 归属 → 过期 → 齐全 → 选项合法。归属先于过期，
 *    是为了让「别人的卷」与「不存在的卷」返回同一个错误码（防枚举：不能靠错误码探测
 *    某个问卷 ID 是否存在）。
 *
 * ## 一次性凭证
 *
 * 提交成功即从实例表移除（`assess` 内部 delete）。理由是它等价于一张签给本人的、
 * 只能核销一次的凭证：留着就能重复落档，重复落档就会让「用户确认」变成可重放的动作。
 * 审批被拒时工具根本没执行，卷仍在，用户可重试——这条边界由管线保证，不是本文件的假设。
 *
 * ## 重测冷却（R-2）
 *
 * 一次性凭证挡的是「同一张卷重放」，挡不住「重新取一张卷再测一遍」——后者每次都是
 * 新的合法凭证，连续重测就能把等级刷到满意为止（先答激进看结果，不满意再答保守）。
 * 所以本文件另记一颗**用户级**的 `lastAssessedAt`：落档成功即写，下一次 `assess`
 * 在冷却窗口内直接拒绝，且**不核销这张卷**（冷却过去后同一张卷仍然可用，
 * 只要它没超过问卷 TTL）。冷却时长由装配方注入（`cooldownMs`），核心库缺省 0
 * = 不启用；部署面的保守缺省是 `bank:tools.riskCooldownDays`（1 天）。
 *
 * 这是一条**节流**，不是等级保护的唯一闸：真正的闸仍是审批卡逐题回显 + 一次性票据。
 * 冷却只让"反复刷"变慢，不让它有新的可乘之机。
 */

import { BahError } from '@bah/util'
import type { Branded } from '@bah/util'

import type { RiskGrade, UserId } from './model.ts'
import { riskGradeOfScore } from './model.ts'

/** 问卷实例 ID（服务端铸造；品牌类型与账户/票据 ID 同构）。 */
export type RiskQuestionnaireId = Branded<'risk-questionnaire-id'>

/** 选项键（封闭三值；渠道只回传键，不回传分值）。 */
export type RiskOptionKey = 'conservative' | 'middle' | 'aggressive'

/** 全部合法选项键（门禁与校验共用，顺序即渲染顺序）。 */
export const RISK_OPTION_KEYS: readonly RiskOptionKey[] = ['conservative', 'middle', 'aggressive']

/** 一个选项：键 + 用户可读文本 + 分值。 */
export interface RiskQuestionOption {
  readonly key: RiskOptionKey
  readonly text: string
  /** 分值（1 / 3 / 5）。**只有服务端常量表能决定它**。 */
  readonly score: number
}

/** 一道题。 */
export interface RiskQuestion {
  /** 题号（1..5，与用户看到的顺序一致）。 */
  readonly index: number
  readonly title: string
  readonly options: readonly RiskQuestionOption[]
}

/** 下发出去的问卷实例。 */
export interface RiskQuestionnaire {
  readonly id: RiskQuestionnaireId
  /** 卷主：只有本人能提交（跨用户一律按「不存在」拒绝）。 */
  readonly userId: UserId
  /** 题目版本（改题干/分值必须改版本，审计才追得回"当时问的是什么"）。 */
  readonly version: string
  readonly issuedAt: number
  /** 失效时刻（epoch ms）；过了就 `risk-questionnaire-expired`。 */
  readonly expiresAt: number
  readonly questions: readonly RiskQuestion[]
}

/** 一条作答（题号 + 选项键）。 */
export interface RiskAnswer {
  readonly index: number
  readonly key: RiskOptionKey
}

/** 问卷版本（题干或分值一变就必须改；`read/risk-questions` 与 `risk/assessed` 都记它）。 */
export const RISK_QUESTIONNAIRE_VERSION = 'risk-q/v1'

/**
 * 问卷有效期（15 分钟）。
 *
 * 与票据 TTL 分开：票据管「这一次批准」，问卷管「这一轮作答」。太长会让"过期"这条
 * 安全分支永远测不到，太短会让用户在第 5 题超时——15 分钟够答完 5 题，又短到能演示过期。
 */
export const RISK_QUESTIONNAIRE_TTL_MS = 15 * 60_000

/** 题数（5 题；测试与 schema 共用，避免两处各写一个 5）。 */
export const RISK_QUESTION_COUNT = 5

/**
 * 服务端常量表：5 题 × 3 选项，分值 1 / 3 / 5。
 *
 * 题干口径：只问「经验 / 期限 / 亏损承受 / 收入稳定性 / 目标」，
 * 不涉及具体产品、不索取金额——这是适当性问卷，不是营销问卷。
 */
export const RISK_QUESTIONS: readonly RiskQuestion[] = [
  {
    index: 1,
    title: '您的投资经验有多久？',
    options: [
      { key: 'conservative', text: '没有投资经验', score: 1 },
      { key: 'middle', text: '1–3 年', score: 3 },
      { key: 'aggressive', text: '3 年以上', score: 5 },
    ],
  },
  {
    index: 2,
    title: '这笔钱大概多久不用？',
    options: [
      { key: 'conservative', text: '1 年内可能要用', score: 1 },
      { key: 'middle', text: '1–3 年不用', score: 3 },
      { key: 'aggressive', text: '3 年以上不用', score: 5 },
    ],
  },
  {
    index: 3,
    title: '您能接受的最大亏损是？',
    options: [
      { key: 'conservative', text: '不能接受亏损', score: 1 },
      { key: 'middle', text: '10% 以内', score: 3 },
      { key: 'aggressive', text: '30% 以上也能接受', score: 5 },
    ],
  },
  {
    index: 4,
    title: '您的收入稳定性如何？',
    options: [
      { key: 'conservative', text: '不稳定', score: 1 },
      { key: 'middle', text: '一般', score: 3 },
      { key: 'aggressive', text: '稳定且有结余', score: 5 },
    ],
  },
  {
    index: 5,
    title: '您这次投资的主要目标是？',
    options: [
      { key: 'conservative', text: '保住本金', score: 1 },
      { key: 'middle', text: '稳健增值', score: 3 },
      { key: 'aggressive', text: '追求高收益', score: 5 },
    ],
  },
]

/** 一份问卷实例 + 是否已被核销（内部使用；对外只暴露 `RiskQuestionnaire`）。 */
interface StoredQuestionnaire {
  readonly questionnaire: RiskQuestionnaire
}

/**
 * 落档请求（`MockBankCore.assessRisk` 的入参形状）。
 *
 * `key` 故意放开成 `string`：调用方（模型参数 / 渠道）拿到的是字符串，
 * 收窄发生在 `assess` 内的选项比对里——在这里要求 `RiskOptionKey` 只会把
 * "非法键"变成类型错误，而它本该是一条结构化的 `risk-questionnaire-option-invalid`。
 */
export interface RiskAssessRequest {
  readonly userId: UserId
  readonly questionnaireId: string
  readonly answers: readonly { readonly index: number; readonly key: string }[]
}

/** 落档结果（`RiskAssessment` 的字段来源）。 */
export interface RiskAssessOutcome {
  readonly questionnaireId: RiskQuestionnaireId
  readonly version: string
  readonly answers: readonly RiskAnswer[]
  readonly score: number
  readonly from: RiskGrade
  readonly to: RiskGrade
  readonly at: number
}

/** 问卷实例库的装配参数（时钟与主体读写全部注入，便于单测与回放）。 */
export interface RiskQuestionnaireBookOptions {
  readonly now: () => number
  /** 读当前等级；未知名返回 `undefined`（调用方负责报 `user-unknown`）。 */
  readonly readRiskGrade: (userId: UserId) => RiskGrade | undefined
  /** 写回等级（只由 `assess` 调用）。 */
  readonly writeRiskGrade: (userId: UserId, grade: RiskGrade) => void
  /**
   * 重测冷却（毫秒）。缺省 0 = 核心库不启用。
   *
   * 保守缺省在部署面（`bank:tools.riskCooldownDays` = 1 天）：核心库是"可装配的机器"，
   * 给它一个隐式的一天会让所有直接构造的测试与回放都无端变慢/变红。
   */
  readonly cooldownMs?: number
}

/**
 * 问卷实例库（内存；与 `TicketStore` 同一定位：状态机的唯一属主）。
 *
 * 线程/会话无关：实例按 ID 存，归属靠 `questionnaire.userId` 判定。
 */
export class RiskQuestionnaireBook {
  private readonly items = new Map<string, StoredQuestionnaire>()
  /**
   * 用户 → 上次落档时刻（epoch ms）。**只记本人最近一次成功落档**。
   *
   * 失败（过期 / 不齐全 / 选项非法 / 冷却拒绝）都不写这张表：只有真的改过等级的那一次
   * 才启动冷却。否则一个手滑答错题的用户会被自己"没成功的提交"锁住一天。
   */
  private readonly lastAssessedAt = new Map<string, number>()
  private seq = 0
  private readonly options: RiskQuestionnaireBookOptions

  constructor(options: RiskQuestionnaireBookOptions) {
    this.options = options
  }

  /** 已签发且未核销的实例数（测试与可观测性用；正常业务不读它）。 */
  size(): number {
    return this.items.size
  }

  /**
   * 给用户发一张新卷。
   *
   * 同一用户可以同时持有多张（上一张没答完就重新发起）：它们各自带 ID 与到期时刻，
   * 提交时按 ID 判定，不存在「后发覆盖先发」的歧义。
   *
   * @throws `user-unknown` 卷主不存在（绝不发一张没有主体的卷）
   */
  issue(userId: UserId): RiskQuestionnaire {
    if (this.options.readRiskGrade(userId) === undefined) {
      throw new BahError('user-unknown', `bank: 用户不存在：${userId}`, { userId })
    }
    this.seq += 1
    const issuedAt = this.options.now()
    const questionnaire: RiskQuestionnaire = {
      id: `rq-${String(this.seq)}` as RiskQuestionnaireId,
      userId,
      version: RISK_QUESTIONNAIRE_VERSION,
      issuedAt,
      expiresAt: issuedAt + RISK_QUESTIONNAIRE_TTL_MS,
      // 深拷贝：调用方（渠道投影 / 测试）改数组不能污染常量表
      questions: RISK_QUESTIONS.map((question) => ({
        index: question.index,
        title: question.title,
        options: question.options.map((option) => ({ ...option })),
      })),
    }
    this.items.set(questionnaire.id, { questionnaire })
    return cloneQuestionnaire(questionnaire)
  }

  /**
   * 按 ID 取卷（只读副本；不存在返回 `undefined`）。
   *
   * **不做归属过滤**：归属判定发生在 `assess`。这里若按会话过滤，
   * 调用方就再也拿不到"这张卷不是你的"这个事实，审计上也看不见越权尝试。
   */
  get(questionnaireId: string): RiskQuestionnaire | undefined {
    const stored = this.items.get(questionnaireId)
    return stored === undefined ? undefined : cloneQuestionnaire(stored.questionnaire)
  }

  /**
   * 提交作答并落档。
   *
   * 校核顺序（不可重排，见文件头）：
   * 1. 存在 → 2. 归属 → 3. 重测冷却 → 4. 未过期 → 5. 五题齐全 → 6. 选项属于该题
   *
   * 冷却排在归属之后、过期之前的两条理由：
   * - **归属之后**：别人的卷仍走 `risk-questionnaire-unknown`，冷却码不会成为"这张卷存在"
   *   的新侧信道（冷却只依赖 `req.userId`，与问卷 ID 无关，但错误码先后顺序保持不变更省解释）；
   * - **过期之前**：过期卷无论如何都用不了，先说过期比先说冷却更贴近用户的实际处境。
   *
   * 全通过才改主体等级；任何一步失败都不写库、不消耗问卷（用户可改正后重试）。
   *
   * @throws `risk-questionnaire-unknown` / `risk-retest-cooldown` / `-expired` / `-incomplete` / `-option-invalid`
   */
  assess(req: RiskAssessRequest): RiskAssessOutcome {
    const stored = this.items.get(req.questionnaireId)
    if (stored === undefined) {
      throw new BahError(
        'risk-questionnaire-unknown',
        'bank: 问卷不存在或已使用，请重新获取风险问卷',
        { questionnaireId: req.questionnaireId },
      )
    }
    const questionnaire = stored.questionnaire
    // 跨用户与"不存在"同码：错误码不能成为探测他人问卷的侧信道
    if (questionnaire.userId !== req.userId) {
      throw new BahError(
        'risk-questionnaire-unknown',
        'bank: 问卷不存在或不属于当前用户，请重新获取风险问卷',
        { questionnaireId: req.questionnaireId },
      )
    }
    const at = this.options.now()
    const cooldownMs = this.options.cooldownMs ?? 0
    const last = this.lastAssessedAt.get(String(req.userId))
    if (cooldownMs > 0 && last !== undefined && at - last < cooldownMs) {
      throw new BahError('risk-retest-cooldown', 'bank: 距上次风险测评不足一个冷却周期，请稍后重试', {
        lastAssessedAt: last,
        at,
        cooldownMs,
        remainingMs: cooldownMs - (at - last),
      })
    }
    if (at > questionnaire.expiresAt) {
      throw new BahError('risk-questionnaire-expired', 'bank: 问卷已过期，请重新获取风险问卷', {
        questionnaireId: questionnaire.id,
        expiresAt: questionnaire.expiresAt,
        at,
      })
    }

    const byIndex = assertComplete(questionnaire, req.answers)
    const score = [...byIndex.values()].reduce((sum, option) => sum + option.score, 0)
    const from = this.options.readRiskGrade(req.userId)
    if (from === undefined) {
      throw new BahError('user-unknown', `bank: 用户不存在：${req.userId}`, { userId: req.userId })
    }
    const to = riskGradeOfScore(score)
    this.options.writeRiskGrade(req.userId, to)
    // 冷却从**落档成功**起算：这一刻才是"等级真的变了"
    this.lastAssessedAt.set(String(req.userId), at)
    // 一次性凭证：落档成功即核销（重放会得到 `risk-questionnaire-unknown`）
    this.items.delete(questionnaire.id)
    return {
      questionnaireId: questionnaire.id,
      version: questionnaire.version,
      // 用选项表里的键重建（`key` 的类型因此是 `RiskOptionKey`，不需要断言）：
      // 用户传什么字符串，落进审计的只能是问卷里真实存在的那个键。
      answers: [...byIndex.entries()]
        .sort((left, right) => left[0] - right[0])
        .map(([index, option]) => ({ index, key: option.key })),
      score,
      from,
      to,
      at,
    }
  }
}

/**
 * 齐全性 + 选项合法性校验，返回 题号 → 选项（供求和）。
 *
 * 齐全的定义：每个题号 1..5 **恰好出现一次**。多答、漏答、重复答都算不齐全——
 * 允许重复会让「5 条」变成可以拿同一题刷分。
 */
function assertComplete(
  questionnaire: RiskQuestionnaire,
  answers: readonly { readonly index: number; readonly key: string }[],
): Map<number, RiskQuestionOption> {
  const expected = questionnaire.questions.length
  if (answers.length !== expected) {
    throw new BahError('risk-questionnaire-incomplete', 'bank: 必须回答全部 5 题', {
      expected,
      count: answers.length,
    })
  }
  const byIndex = new Map<number, RiskQuestionOption>()
  for (const answer of answers) {
    const question = questionnaire.questions.find((item) => item.index === answer.index)
    if (question === undefined) {
      throw new BahError('risk-questionnaire-incomplete', 'bank: 题号超出问卷范围', {
        index: answer.index,
      })
    }
    if (byIndex.has(answer.index)) {
      throw new BahError('risk-questionnaire-incomplete', 'bank: 同一题被重复作答', {
        index: answer.index,
      })
    }
    const option = question.options.find((item) => item.key === answer.key)
    if (option === undefined) {
      throw new BahError('risk-questionnaire-option-invalid', 'bank: 选项不属于该题', {
        index: answer.index,
        key: answer.key,
      })
    }
    byIndex.set(answer.index, option)
  }
  if (byIndex.size !== expected) {
    throw new BahError('risk-questionnaire-incomplete', 'bank: 必须回答全部 5 题', {
      expected,
      count: byIndex.size,
    })
  }
  return byIndex
}

/** 深拷贝（渠道/测试拿到的是快照，改不动实例表里的对象）。 */
function cloneQuestionnaire(questionnaire: RiskQuestionnaire): RiskQuestionnaire {
  return {
    ...questionnaire,
    questions: questionnaire.questions.map((question) => ({
      index: question.index,
      title: question.title,
      options: question.options.map((option) => ({ ...option })),
    })),
  }
}
