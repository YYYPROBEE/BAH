/**
 * 意图平面的静态词表（03 单 §3.2 的规则线索）。
 *
 * 为什么集中在这里而不是散在 resolve.ts：词表是「可解释规则」的全部输入，
 * 每条词表项都必须能追到一个 ruleId 与至少一条用例（§3.2 规则表）。
 * 词表进模块常量而不是插件配置：它们是产品口径（中话语料），不是部署项；
 * 部署项（路径/端口/阈值）才归 `verify-no-hardcoded-config` 管。
 */

/** 动作动词：命中后才可能判 explicit。 */
export const ACTION_VERBS: readonly string[] = [
  '转',
  '转账',
  '汇款',
  '打款',
  '打钱',
  '还',
  '还上',
  '还清',
  '查',
  '查询',
  '看',
  '买',
  '购买',
  '赎回',
  '申购',
  '取消',
  '挂失',
  '冻结',
  '解冻',
  '对比',
  '试算',
  '改',
]

/** 查询类动词：单独一组，用于「查一下上次的转账记录」这类**对象是查询目标**的句子消歧。 */
export const QUERY_VERBS: readonly string[] = ['查', '查询', '看', '看看', '多少', '余额', '记录', '流水']

/** 意图域关键词。≥2 个域同时命中 ⇒ R-AMB-1（除非查询动词独占）。 */
export const DOMAIN_KEYWORDS: Readonly<Record<string, readonly string[]>> = {
  transfer: ['转账', '转给', '汇款', '打款', '打钱'],
  repay: ['信用卡', '还款', '还上', '还清', '还'],
  invest: ['理财', '基金', '产品', '收益'],
  bills: ['账单', '消费', '支出', '流水'],
}

/** 历史指代词：R-VAGUE-1 的线索。 */
export const HISTORY_DEICTIC: readonly string[] = [
  '上次',
  '上回',
  '之前',
  '那个',
  '这笔',
  '那笔',
  '老样子',
  '再来一次',
  '刚才',
]

/** 含混词：R-VAGUE-2 的线索。 */
export const VAGUE_WORDS: readonly string[] = ['随便', '差不多', '有点', '一些', '想弄', '搞一下', '弄一下']

/** 代词：R-VAGUE-3 的线索（作收款人且会话层无先行词 ⇒ 追问）。 */
export const PRONOUNS: readonly string[] = ['他', '她', '它', '他们', '她们', '它们']

/** 场景线索词（R-IMP-1）：只有「零动作动词」时才判 implicit。 */
export const SCENE_HINTS: readonly string[] = [
  '生日',
  '发工资',
  '年终奖',
  '孩子上学',
  '退休',
  '买车',
  '旅游',
  '结婚',
  '装修',
]

/** 咨询式问句（R-IMP-2）：没有明确产品指令，只表达「想听听建议」。 */
export const CONSULT_PATTERNS: readonly RegExp[] = [
  /怎么理财/,
  /钱放哪/,
  /划算吗/,
  /该不该买/,
  /怎么配置/,
  /值不值/,
]

/** 纯数值句（R-ELL-2）。 */
export const NUMERIC_ONLY = /^\d+(?:\.\d{1,2})?$/

/**
 * 跨场景指代词的权重表（R-XS-1 / `crossSceneConfidence`）。
 *
 * 评分 = 命中权重之和，clamp 到 [0,100]，再 /100 得 confidence。
 * WHY 权重而不是「命中即 1.0」：跨场景借用必须能表达「不太确定」——
 * 「把那边的事接着办」= 指代(30) + 延续(15) + 泛动作(14) = 59 < 60 ⇒ 拒借并反问。
 * 权重是产品口径，改动须同步 `docs/` 与单测里的钉死值。
 */
export const CROSS_SCENE_WEIGHTS: Readonly<Record<string, number>> = {
  那边: 30,
  另一个: 30,
  别的: 25,
  接着: 15,
  继续: 15,
  办: 14,
}

/** 跨场景目标场景的线索（决定 askHint 里「您是想在 X 场景继续吗」）。 */
export const TARGET_SCENE_HINTS: readonly (readonly [string, RegExp])[] = [
  ['transfer', /转账|汇款|打款|转/],
  ['bills', /账单|缴费|还款/],
  ['investment', /理财|基金|产品/],
  ['card', /挂失|卡/],
  ['subscription', /订阅|续费|扣款/],
]

/** 场景词 → 提案素材（R-IMP-1）。只写工具名：执行编排归 04 单。 */
export interface SceneProductSeed {
  readonly title: string
  readonly actions: readonly string[]
}

export const SCENE_PRODUCTS: Readonly<Record<string, SceneProductSeed>> = {
  生日: { title: '为爱人生日准备一笔心意金？', actions: ['transfer_preview'] },
  发工资: { title: '工资到账了，要不要先看看稳健理财？', actions: ['wealth_list', 'wealth_compare'] },
  年终奖: { title: '年终奖到账，要不要做个理财对比？', actions: ['wealth_list', 'wealth_compare'] },
  孩子上学: { title: '为孩子上学准备一笔专款？', actions: ['transfer_preview', 'wealth_list'] },
  退休: { title: '退休规划可以从稳健产品看起，要不要对比一下？', actions: ['wealth_list', 'wealth_compare'] },
  买车: { title: '买车预算可以先看看短期稳健产品？', actions: ['wealth_list'] },
  旅游: { title: '旅游预算要不要先做一笔专款？', actions: ['transfer_preview', 'wealth_list'] },
  结婚: { title: '结婚开销大，要不要先做一笔预算安排？', actions: ['transfer_preview'] },
  装修: { title: '装修预算要不要先看短期产品？', actions: ['wealth_list'] },
}

/** 咨询式问句的提案（R-IMP-2，与场景词无关）。 */
export const CONSULT_PRODUCT: SceneProductSeed = {
  title: '要不要先看看理财产品并做个对比？',
  actions: ['wealth_list', 'wealth_compare'],
}

/** 追问话术模板（askHint.question）。按槽位的**目的**写，不写死产品名。 */
export const ASK_QUESTIONS: Readonly<Record<string, string>> = {
  payee: '要转给谁？可以选一个，也可以直接说姓名。',
  amountCents: '要转多少？',
  account: '用哪个账户？',
  timeRange: '看哪个时间段？',
  product: '想看哪款产品？',
  category: '看哪一类？',
  targetScene: '您想继续哪个场景的事？',
}

/** 场景的中文名（问句与材料里用中文；场景键本身是机器码）。 */
export const SCENE_LABELS: Readonly<Record<string, string>> = {
  transfer: '转账',
  bills: '账单',
  investment: '理财',
  card: '银行卡',
  subscription: '订阅扣款',
  cross_scene: '跨场景',
}

/**
 * 「无动作动词就不判 explicit」的场景白名单（当前只有卡片场景）。
 *
 * WHY 是**白名单**而不是全局规则：订阅场景的合法请求**本来就无动词**
 * （「我有哪些订阅」「网盘会员是季付吗」——20 条语料见 `intent/subscription.test.ts`），
 * 一旦全局化，这些句子会被整片判成 implicit ⇒ 订阅场景回归。
 * 卡场景不同：它的 required 为空集，一句陈述（「钱包被偷了」）若判 explicit 就会直接 proceed。
 */
export const IMPLICIT_BARE_STATEMENT_SCENES: readonly string[] = ['card']

/** 跨场景拒借时的建议反问（R-XS-1）。`{target}` 由调用方替换成中文场景名。 */
export const CROSS_SCENE_ASK = '您是想在「{target}」那边继续吗？我不确定，先跟您确认一下。'
