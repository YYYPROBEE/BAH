/**
 * 离线演示的**意图路由**（不是磁带）。
 *
 * ## 为什么需要它
 *
 * `provider: mock` 的固定脚本有一个致命的演示缺陷：它**不读 `call.messages`**，
 * 只按调用次序出队。于是"给王建国转 800 元"和"帮我查下余额"拿到的是同一段回复，
 * 审阅者问任何剧本外的问题，回答都是那句话。这比不演示更糟——它当着人面撒谎。
 *
 * 路由不是模型，它只做三件确定性的事：
 * 1. 从**最后一条用户消息**里判断意图（余额 / 转账 / 理财 / 订阅 / 账单 / 卡片 / 生日 / 意图平面）；
 * 2. 需要槽位的意图从原话里抽金额、收款人、卡号等，抽不全就**追问**，不编默认值；
 * 3. 按意图规划这一轮要走的步骤（如转账：预览 → 执行 → 收尾）。
 *
 * 它的边界要写清楚：**它不是自然语言理解**。认不出来的问题一律追问，
 * 不做"猜一个最像的意图"——猜错比不问更伤人。
 *
 * ## 与意图平面的分工（03 单，对外说明必被问）
 *
 * - 本文件决定「**调哪个工具**」：仍是确定性正则/关键词路由；
 * - `intent_resolve` 决定「**槽位怎么补、要不要追问、能不能借历史**」：可解释规则 + 纯函数。
 *
 * 所以 `implicit`/`recall`/`crossScene`/`slotGap` 四条路由只是把「该发射意图工具的话语形态」
 * 认出来，语义判定一律发生在工具内。**不得**为演示效果往本文件塞槽位解析逻辑——
 * 那是意图平面的职责，塞进来就是造第二个真相源。
 */

import { assertNever } from '@bah/util'

import type { LlmMessage, LlmRequest } from '../llm/types.ts'
import { isPlatformContext, lastUserText, lastUserTurnIndex } from '../llm/turns.ts'
import {
  outcomeStep,
  reflectStep,
  textStep,
  toolCallStep,
  type MockStep,
} from '../mock/script.ts'

/** 转出给本模块的使用者（判定逻辑在 `../llm/turns.ts`，路由只是消费者）。 */
export { lastUserText }

/** 一次转账请求（金额单位：元）。 */
export interface TransferIntent {
  readonly amount: number
  readonly payeeName: string
  readonly remark?: string
  /**
   * 未来执行时刻的**原话片段**（`明天` / `下周一 09:00` / `下个月 8 号`）。
   *
   * 有值 ⇒ 这一轮走 `transfer_schedule`（授权窗口 + 到点唤醒），**不是**立即转账。
   * 没有它，"明天给王建国转 200" 会被当成"现在转 200"——语义与时点同时错，
   * 而用户只要照习惯点了审批卡，钱就当场划走了。
   */
  readonly when?: string
}

/** 意图平面的四条路由（03 单 §7.3）。 */
export type IntentRoute = 'implicit' | 'recall' | 'crossScene' | 'slotGap'

/** 路由结论。 */
export type DemoIntent =
  | { readonly kind: 'balance' }
  | { readonly kind: 'transfer'; readonly request: TransferIntent }
  | {
      /**
       * 理财意图（04 单）：只覆盖演示语法（「有什么理财产品」/「买 4 号，1000 元」）。
       * 产品 ID 用编号规则 `w-<n>` 推导——路由里没有产品名、风险等级、价格。
       */
      readonly kind: 'wealth'
      readonly action: 'list'
    }
  | {
      readonly kind: 'wealth'
      readonly action: 'purchase'
      readonly productNo: number
      readonly amount: number
    }
  | { readonly kind: 'wealth'; readonly action: 'positions' }
  | { readonly kind: 'wealth'; readonly action: 'redeem'; readonly holdingId: string }
  | {
      /** 场景 1：AA 拆分收款（只认「A、B、C AA 300」这种演示语法）。 */
      readonly kind: 'aa'
      readonly totalYuan: number
      readonly participants: readonly string[]
    }
  | {
    /**
     * 场景 1 子能力：AA 模拟代收（demo 口径，ADR-0011）。
     *
     * 只认「张三已经付了 / 李四给我了」这类**完成态**说法。组号不在这里解析：
     * 离线剧本的 args 是静态字面量，引用不到上一轮工具结果，所以演示约定是
     * 「先建组、再报某一位已付」，组号固定为本次会话的第一个组（见 `DEMO_AA_GROUP_ID`）。
     */
    readonly kind: 'aa-collect'
    readonly participant: string
  }
  | {
      /**
       * 场景 1 子能力：AA 参与人明确拒绝（ADR-0017）。
       *
       * 只认「王建国不参加 / 说不去了」这类**拒绝态**说法。组号与 collect 同一约定
       * （本会话第一个组），因为离线剧本引用不到上一轮工具结果。
       */
      readonly kind: 'aa-decline'
      readonly participant: string
    }
  | {
      /**
       * 场景 1 子能力：查组状态（05 单 §6）。
       *
       * 组号与 collect 同一约定（本会话第一个组）；工具正文已带 paid/declined/pending，
       * 收尾直接复述，不在路由里再拼一份状态表。
       */
      readonly kind: 'aa-status'
    }
  | {
      /** 场景 5：订阅 / 代扣（离线演示只认演示语料，不做 NLU）。 */
      readonly kind: 'subscription'
      readonly action: 'list'
    }
  | {
      readonly kind: 'subscription'
      readonly action: 'cancel'
      readonly subscriptionId: string
      readonly mode: 'now' | 'at-next-cycle'
      readonly confirmContract: boolean
    }
  | {
      readonly kind: 'subscription'
      readonly action: 'authorize'
      readonly merchant: string
    }
  | {
      readonly kind: 'subscription'
      readonly action: 'watch'
      readonly subscriptionId: string
      readonly watch: 'remind' | 'idle'
      readonly aheadDays?: number
    }
  | { readonly kind: 'clarify'; readonly question: string }
  | {
      /**
       * 账单分析（02 单演示路由）：period 是**相对口径**（本月 / 近三个月 / 近一年），
       * 历史账期由锚点表达：`monthOffset`（-1 = 上个月）、`monthOfYear`（9 = 9 月）、
       * `year`（2025 = 该自然年）。三者互斥，换算在工具层用注入钟完成——
       * 路由本身没有时钟，算日期就会在回放里错。
       */
      readonly kind: 'bill'
      readonly action: 'analyze'
      readonly period: 'month' | 'quarter' | 'year'
      readonly groupBy: 'category' | 'payee' | 'merchant'
      readonly monthOffset?: number
      readonly monthOfYear?: number
      readonly year?: string
    }
  | {
      /** 账单报告（02 单）：同一口径 + 同一组账期锚点，输出摘要或明细。 */
      readonly kind: 'bill'
      readonly action: 'report'
      readonly period: 'month' | 'quarter' | 'year'
      readonly format: 'summary' | 'detail'
      readonly monthOffset?: number
      readonly monthOfYear?: number
      readonly year?: string
    }
  | {
      /**
       * 卡片管理（04 单演示路由）：卡号只认演示夹具的两张卡（尾号 1234 / 5678）；
       * 没给卡号就追问，绝不默认操作某一张。
       */
      readonly kind: 'card'
      readonly action: 'list'
    }
  | {
      readonly kind: 'card'
      readonly action: 'freeze' | 'unfreeze' | 'reportLost'
      readonly cardId: 'c-1' | 'c-2' | 'c-3'
      readonly reason?: string
    }
  | {
      /**
       * 办卡：借记（缺省）或信用。信用卡必须带授信额度（ADR-0015）——
       * 额度未知的信用卡在工具面根本开不出来，路由不替模型猜一个。
       */
      readonly kind: 'card'
      readonly action: 'apply'
      readonly cardKind?: 'credit'
      readonly creditLimitYuan?: number
    }
  | {
      readonly kind: 'card'
      readonly action: 'setLimit'
      readonly cardId: 'c-1' | 'c-2' | 'c-3'
      readonly dailyLimitYuan?: number
      readonly monthlyLimitYuan?: number
      /** 授信额度（元；仅信用卡）。与日/月限额是两种额度，不混投。 */
      readonly creditLimitYuan?: number
    }
  | {
      readonly kind: 'card'
      readonly action: 'restrict'
      readonly cardId: 'c-1' | 'c-2' | 'c-3'
      readonly mode: 'set' | 'clear'
      readonly restrictionKind: 'online' | 'overseas' | 'category'
      /** `category` 时的品类键（只在 mock 卡消费通道上生效）。 */
      readonly restrictionValue?: string
    }
  | {
      /**
       * 生日案例（04 单）：两幕脚本。propose = 提案（意图 → 目标账本 → DAG），
       * execute = 用户确认后执行同一张 DAG。**仍然不是 NLU**：
       * 它只认"生日"与"确认执行"两种话语形态，认不出的一律追问。
       */
      readonly kind: 'birthday'
      readonly phase: 'propose' | 'execute'
      readonly utterance: string
    }
  | {
      /**
       * 资金锁定（earmark）：把活期划到本人锁定账户，或反向释放。
       *
       * 与 `transfer` 分开：锁定不是付钱给谁，金额不该占转账日限额，也不该升成红档。
       */
      readonly kind: 'fundLock'
      readonly action: 'lock' | 'release' | 'status'
      readonly amountYuan?: number
    }
  | {
      /**
       * 交易密码（01 单 / ADR-0014）：只发起交办与查状态。
       *
       * 路由**永远不携带密码**：它只决定"要不要请服务端签一张交办票据"。
       * 明文只能在安全页 `apps/web/password.html` 的表单里提交——那条路径不经过模型。
       */
      readonly kind: 'password'
      readonly action: 'request' | 'status'
    }
  | {
      /**
       * 记住生日（04 单手工验收）：把用户明说的生日写进事实库。
       *
       * 只认演示语料「记住<称谓>生日 M 月 D 日」；抽不出称谓或日期就追问。
       * 年份是占位值（扫描只看月/日），存成 2000 是为了让 2 月 29 日合法。
       */
      readonly kind: 'factRemember'
      readonly person: string
      readonly relation: 'self' | 'spouse' | 'parent' | 'child' | 'other'
      readonly date: string
    }
  | {
      /**
       * 商户订购（场景 6 的单点能力，2026-11-01 开放）：先搜后订，绝不编 offerId。
       *
       * 只认 flower / cake 两个品类——商户目录只有这两类，别的品类认不出就追问，
       * 编一个匹配不上任何商品的品类等于让下单必然失败。
       */
      readonly kind: 'merchant'
      readonly action: 'search' | 'order'
      readonly category: 'flower' | 'cake'
      readonly budgetYuan?: number
    }
  | {
      /**
       * 风险测评（C-03）：`questions` = 取服务端问卷；`submit` = 提交用户逐题作答。
       *
       * 路由**不生成答案**：`submit` 的答案只能来自用户那条消息（Web 问卷卡或 IM 的
       * 「1/2/3」），路由只做"把用户说的键原样搬运"这一件事。
       */
      readonly kind: 'risk'
      readonly action: 'questions'
    }
  | {
      readonly kind: 'risk'
      readonly action: 'submit'
      readonly questionnaireId: string
      readonly answers: readonly { readonly index: number; readonly key: string }[]
    }
  | {
      /** 交给意图平面：router 只决定"要问意图工具"，不判定槽位语义。 */
      readonly kind: 'intent'
      readonly route: IntentRoute
      readonly utterance: string
      readonly scene: string
      /** slotGap 时带上追问目标与问法（供 prompt_ask 的入参）。 */
      readonly ask?: { readonly slot: string; readonly question: string; readonly candidates: readonly string[] }
    }

/** 查余额的说法（宁可窄一点：认不出来就追问，不要误判成转账）。 */
const BALANCE_PATTERNS: readonly RegExp[] = [
  /余额/,
  /还有(多少|几)(钱|块)/,
  /(账户|卡里|卡上).{0,6}(有|剩)/,
  /可用额度/,
  /我有多少钱/,
]

/** 账单意图的粗筛（02 单）：只认「账单 / 收支 / 钱花哪 / 消费分析 / 流水分析」。 */
const BILL_PATTERNS: readonly RegExp[] = [
  /账单/,
  /收支/,
  /钱花哪/,
  /消费分析/,
  /流水分析/,
  // 自然话术（2026-11-01 补）："2025 年花了多少""上个月花了多少"。
  // 只认带"多少"或"年份+消费动词"的形态，避免"我花了 200 买咖啡"被当成账单分析。
  /(?:花|消费|支出)了多少/,
  /\d{4}\s*年.{0,6}(?:花|消费|支出)/,
]

/** 卡片管理的粗筛（04 单）：动作词或明确的卡片状态问法；单纯"银行卡"不劫持转账。 */
const CARD_PATTERNS: readonly RegExp[] = [
  /挂失/,
  /冻结/,
  /解冻/,
  /额度|提额|限额/,
  /交易限制|线上支付|境外支付/,
  /办.*卡|申请.*卡|虚拟卡|新卡/,
  /(银行卡|卡片).{0,8}(状态|有哪些|几张|尾号)/,
  /尾号.{0,4}(银行卡|卡片|卡)/,
  /尾号\s*\d{4}/,
]

/** 理财意图的粗筛（04 单）：只认「理财 / 基金 / 产品收益风险 / 买 N 号」。 */
const WEALTH_PATTERNS: readonly RegExp[] = [/理财/, /基金/, /产品.{0,6}(收益|风险)/, /买\s*\d+\s*号/]

/** 「看看有哪些」的话语形态：命中且没有购买动作时规划 `wealth_list`。 */
const WEALTH_LIST_PATTERNS: readonly RegExp[] = [/有什么|看看|推荐|哪些|在售/]

/** 当前演示产品数（编号 `w-1`–`w-5`）；超出不猜，走追问。 */
const WEALTH_PRODUCT_MAX = 5

/** 风险测评的粗筛（C-03）：只认「测评 / 风险问卷 / 我的风险等级」这几种说法。 */
const RISK_PATTERNS: readonly RegExp[] = [/测评/, /风险问卷/, /风险等级/, /risk\s*等级/i, /承受能力/]

/**
 * 问卷提交话术（Web 问卷卡 / IM 作答统一格式）。
 *
 * 形如：`风险测评作答 rq-1 1=conservative 2=middle 3=aggressive 4=middle 5=conservative`
 *
 * 为什么要一条"人能读"的消息而不是隐藏字段：它是**用户消息**，会原样落进
 * `user/message`；回放时能逐字看到"用户交了什么"。隐藏字段会让这条证据消失。
 */
const RISK_SUBMIT_PATTERN = /^风险测评作答\s+(\S+)\s+([\s\S]+)$/

/** 一条作答的词法：`<题号>=<选项键>`。 */
const RISK_ANSWER_PATTERN = /(\d+)\s*=\s*([a-z]+)/g

/** 解析「风险测评作答 …」这条用户消息（认不出就返回 `undefined`，交给后续路由）。 */
export function parseRiskSubmit(
  text: string,
): { readonly questionnaireId: string; readonly answers: readonly { index: number; key: string }[] } | undefined {
  const match = RISK_SUBMIT_PATTERN.exec(text.trim())
  if (match === null) return undefined
  const questionnaireId = match[1]
  if (questionnaireId === undefined || questionnaireId.length === 0) return undefined
  const answers: { index: number; key: string }[] = []
  for (const found of (match[2] ?? '').matchAll(RISK_ANSWER_PATTERN)) {
    const index = Number(found[1])
    const key = found[2]
    if (!Number.isInteger(index) || key === undefined) continue
    answers.push({ index, key })
  }
  if (answers.length === 0) return undefined
  return { questionnaireId, answers }
}

/** 订阅/代扣的粗筛（场景 5）。 */
const SUBSCRIPTION_PATTERNS: readonly RegExp[] = [
  /订阅/,
  /代扣/,
  /自动续费/,
  /会员/,
  /续费/,
  /月费/,
  /扣款/,
  /扣了/,
  /每月.{0,4}扣/,
  /合约/,
  /不用了/,
  /到期.{0,4}提醒/,
  /到期即断/,
]

/** 关协议（硬断供）：影响该商户全部订阅。 */
const SUB_AUTHORIZE_PATTERNS: readonly RegExp[] = [
  /关闭.*(代扣|协议)/,
  /关掉.*(代扣|协议)/,
  /彻底.*(停|关)/,
  /停掉.*(这家|代扣|协议)/,
]

/** 退订某个订阅。 */
const SUB_CANCEL_PATTERNS: readonly RegExp[] = [
  /退订/,
  /取消.*(订阅|会员|续费)/,
  /停止.*(订阅|会员)/,
]

/** 提醒 / 标注。 */
const SUB_WATCH_PATTERNS: readonly RegExp[] = [/提醒/, /不用了/, /标注/]

/** 到期即断 / 合约确认话语。 */
const AT_NEXT_CYCLE_PATTERNS: readonly RegExp[] = [/到期即断/, /下期.*停/, /到期.*停/, /下个?月.*停/]
const CONFIRM_PATTERNS: readonly RegExp[] = [/确认/, /同意/]

/**
 * 演示数据里的订阅商户 → ID（与 `forge` 的 recurring 档同源）。
 *
 * 路由不是 NLU：它只认这几家演示商户；认不出就追问，不猜。
 */
const DEMO_SUBSCRIPTIONS: readonly (readonly [string, string, string])[] = [
  ['视频会员', 's-video', '视频会员'],
  ['云音乐', 's-music', '云音乐'],
  ['云存储', 's-storage', '云存储'],
  ['某某健身', 's-gym', '某某健身'],
  ['健身房', 's-gym', '某某健身'],
  ['新闻会员', 's-news', '新闻会员'],
  ['网盘', 's-netdisk', '网盘超级会员'],
  ['阅读', 's-reading', '阅读包月'],
  ['软件', 's-software', 'xx软件订阅'],
]

/** 转账意图的粗筛（真正的判定在 `parseTransfer`：抽不出金额/收款人就转追问）。 */
const TRANSFER_PATTERNS: readonly RegExp[] = [/转\s*[\d一二三四五六七八九十百千万]/, /转账/, /打款/, /汇款/, /^转给/]

/** AA 收款（场景 1 补齐）：只认「A、B、C AA 300」这种演示语法。 */
const AA_PATTERNS: readonly RegExp[] = [/\bAA\b/i, /分摊|各付|一起.{0,6}分/]

/**
 * AA 模拟代收（场景 1 子能力）的演示语料：只认**完成态**。
 *
 * 不认「转给我 800」这种未完成说法——那是转账，不能让它被当成"钱已到账"。
 * 名字限 2–3 字（演示语料足够），后面必须紧跟「付了/给我了/到账」这类完成标记。
 */
const AA_COLLECT_PATTERNS: readonly RegExp[] = [
  /([\u4e00-\u9fa5]{2,3})(?:已经|已)?(?:把.{0,6})?(?:付了|给了|转给我了|给我了|打给我了|付给我了)/,
  /([\u4e00-\u9fa5]{2,3})(?:的|那笔|这笔)?(?:钱)?(?:已经)?(?:到账)/,
]

/**
 * AA 拒绝态：`王建国不参加` / `李四说不去了`（ADR-0017）。
 *
 * 必须带"不/拒"这类否定标记，且名字紧跟其后——"王建国还没付"不是拒绝，
 * 不能从"还没付"推出"拒绝"，那样会替参与人表态。
 */
const AA_DECLINE_PATTERNS: readonly RegExp[] = [
  // 名字用非贪婪：否则「李四说不去了」会把"说"吃进名字，变成"李四说"。
  /([\u4e00-\u9fa5]{2,3}?)(?:说|表示)?(?:不参加|不参与|不去了|不来了|不付了|拒绝)/,
]

/**
 * AA 查组状态的演示语料。
 *
 * 只认"查/看 + 状态/进度"这类问句；「张三已经付了」仍走 collect——
 * "谁付了"是状态，"张三付了"是动作，不混。
 */
const AA_STATUS_PATTERNS: readonly RegExp[] = [
  /AA.{0,8}(?:状态|进度|情况|谁(?:还)?没付|谁付了|收到多少)/i,
  /组状态|收款进度/,
]

/**
 * 演示约定的 AA 组号：`mock.ts` 的 `createAa` 用 `aa-new-{seq}`，本会话第一个组恒为它。
 *
 * 为什么写死：剧本的 `toolCallStep` 只收静态 args，没有"引用上一次工具结果"的能力
 * （plan DAG 有 `${node.<id>.<path>}`，mock 脚本没有）。换成真实模型时不需要它——
 * 模型能从上一轮的工具结果里读到 `groupId`。
 */
export const DEMO_AA_GROUP_ID = 'aa-new-1'

/** 中文数字（只覆盖演示会用到的小额；不做完整转换）。 */
const CN_DIGITS: Readonly<Record<string, number>> = {
  零: 0,
  一: 1,
  二: 2,
  两: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9,
}

/** 隐含意图的场景陈述（尚未提及任何动作）。 */
const IMPLICIT_PATTERNS: readonly RegExp[] = [/生日|发工资|年终奖|孩子上学|退休/]

/** 生日案例的确认话语（04 单第二幕）。 */
const BIRTHDAY_CONFIRM_PATTERNS: readonly RegExp[] = [
  /确认执行/,
  /按计划执行/,
  /开始执行.*计划/,
]

/**
 * 04 单：主动提醒里那句"回复「给爱人订生日计划」"必须能被路由接住。
 *
 * 只认"生日 + 计划/安排/预定"这种**明确要办生日**的说法；普通的"我爱人生日快到了"
 * 仍走 `implicit`，不与它抢话语。带转账线索时让转账分支优先（那是另一件事）。
 */
const BIRTHDAY_PLAN_PATTERNS: readonly RegExp[] = [
  /生日计划/,
  /(?:订|安排|准备|办).{0,8}生日/,
  /生日.{0,8}(?:计划|安排|准备)/,
]

/** 资金锁定（场景 6 原文："当月锁定 1000 元活期"）。"冻结"归卡片域，这里不抢。 */
const FUND_LOCK_PATTERNS: readonly RegExp[] = [/锁定|锁住|锁了/]

/** 解析资金锁定意图：释放/查询优先，其余按锁定。缺金额就追问，不默认一个数。 */
export function parseFundLock(text: string): DemoIntent {
  const action: 'lock' | 'release' | 'status' = /(?:解除|释放|取消)锁定|解锁资金/.test(text)
    ? 'release'
    : /锁了多少钱|锁定金额|锁定多少/.test(text)
      ? 'status'
      : 'lock'
  const amountYuan = extractAmount(text)
  if (action !== 'status' && amountYuan === undefined) {
    return { kind: 'clarify', question: '要锁定/释放多少钱？请给出金额（例如：锁定 1000 元）。' }
  }
  return {
    kind: 'fundLock',
    action,
    ...(amountYuan === undefined ? {} : { amountYuan }),
  }
}

/**
 * 交易密码（01 单 / ADR-0014）。
 *
 * 只认"交易密码 / 支付密码"这类**明确指交易凭据**的说法，外加"改/重置…密码"的动词形态。
 * 「登录密码」被显式排除：那是 `auth/` 的另一套凭据，走登录页，不归本工具。
 */
const PASSWORD_PATTERNS: readonly RegExp[] = [
  /交易密码/,
  /支付密码/,
  /(?:修改|更改|变更|重置|改).{0,4}密码/,
  /密码.{0,6}(?:修改|更改|变更|重置)/,
]

/** 「改登录密码」不是本工具能办的事：明确引导，不静默当成交易密码。 */
const LOGIN_PASSWORD_PATTERN = /登录密码|登录口令/

/**
 * 解析交易密码意图。
 *
 * 只有两种形态：`request`（发起交办）与 `status`（看状态）。
 * **不解析、也不接收任何密码内容**——用户在这条消息里打了密码，路由也不会把它带进 args。
 */
export function parsePassword(text: string): DemoIntent {
  if (LOGIN_PASSWORD_PATTERN.test(text)) {
    return {
      kind: 'clarify',
      question: '登录密码请用登录页修改；这里的改密指的是**交易密码**（对外支付用的那一个）。',
    }
  }
  const status =
    /还能试|还能输|错了几次|剩余次数|锁定|被锁|上次.*(?:改|变)|什么?时候(?:改|变)/.test(text)
  return { kind: 'password', action: status ? 'status' : 'request' }
}

/**
 * 记住生日（04 单手工验收）：只认"记住/记一下 + 生日 + M 月 D 日"。
 *
 * 放在 BIRTHDAY_PLAN / implicit 之前：否则「记住我爱人生日 3 月 8 日」会被当成
 * 生日场景陈述，落到意图平面而不是 `fact_remember`，事实库永远写不进去。
 */
const FACT_REMEMBER_PATTERN = /(?:记住|记一下|帮我记|帮我记住)/
/** 生日日期的演示语法（M 月 D 日）；年份由路由补占位值。 */
const BIRTHDAY_DATE_PATTERN = /(\d{1,2})\s*月\s*(\d{1,2})\s*[日号]/

/** 称谓 → 事实库的 `person`/`relation`（先匹配更具体的配偶，再匹配"我"）。 */
const FACT_PERSON_SPECS = [
  { pattern: /爱人|老婆|老公|妻子|丈夫/, person: '爱人', relation: 'spouse' },
  { pattern: /妈妈|母亲/, person: '母亲', relation: 'parent' },
  { pattern: /爸爸|父亲/, person: '父亲', relation: 'parent' },
  { pattern: /孩子|儿子|女儿/, person: '孩子', relation: 'child' },
  { pattern: /我(?:自己)?的?生日|我生日/, person: '我', relation: 'self' },
] as const

/** `M 月 D 日` → `YYYY-MM-DD`；日期不存在（2 月 30 日）返回 `undefined`。 */
function birthdayDateOf(text: string): string | undefined {
  const match = BIRTHDAY_DATE_PATTERN.exec(text)
  if (match === null) return undefined
  const month = Number(match[1])
  const day = Number(match[2])
  // 2000 是闰年：占位年份让 2 月 29 日也能通过日历校验（扫描只取月/日）
  const at = Date.UTC(2000, month - 1, day)
  const probe = new Date(at)
  if (probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day) return undefined
  return `2000-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

/** 解析"记住某人的生日"：日期先算（更硬），称谓抽不出就追问，不编人名。 */
export function parseFactRemember(text: string): DemoIntent {
  const date = birthdayDateOf(text)
  if (date === undefined) {
    return {
      kind: 'clarify',
      question: '这是哪一天？请说「记住爱人生日 3 月 8 日」这样的日期。',
    }
  }
  const spec = FACT_PERSON_SPECS.find((item) => item.pattern.test(text))
  if (spec !== undefined) {
    return { kind: 'factRemember', person: spec.person, relation: spec.relation, date }
  }
  const captured = /(?:记住|记一下|帮我记)\s*([\u4e00-\u9fa5]{2,4})\s*的?生日/.exec(text)?.[1]
  if (captured !== undefined) {
    return { kind: 'factRemember', person: captured.replace(/^我/, ''), relation: 'other', date }
  }
  return {
    kind: 'clarify',
    question: '这是谁的生日？请说「记住爱人生日 3 月 8 日」这样的说法。',
  }
}

/** 商户订购（场景 6 单点能力）：只认鲜花 / 蛋糕两类。 */
const MERCHANT_PATTERNS: readonly RegExp[] = [
  /(?:订|买|下单).{0,12}(?:花|蛋糕)/,
  /花束|鲜花|蛋糕|一束花/,
]

/**
 * 解析商户订购意图：先搜后订。
 *
 * 「就订 / 直接订 / 下单」才算 order，其余一律先 search——没看到报价就下单，
 * 等于替用户接受了一个他没见过的价格。
 */
export function parseMerchant(text: string): DemoIntent {
  const category: 'flower' | 'cake' = /蛋糕/.test(text) ? 'cake' : 'flower'
  const budgetYuan = extractAmount(text)
  const order = /就订|直接订|下单|买下|订了/.test(text)
  return {
    kind: 'merchant',
    action: order ? 'order' : 'search',
    category,
    ...(budgetYuan === undefined ? {} : { budgetYuan }),
  }
}

/** 模糊复现：历史指代 + 重办语义。 */
const RECALL_PATTERNS: readonly RegExp[] = [/(上次|上回|之前|那个).{0,8}(再来|再转|接着|继续)/]

/** 跨场景引用：指代到「别处」的事。 */
const CROSS_SCENE_PATTERNS: readonly RegExp[] = [/(那边|另一个|别的).{0,4}(事|场景)/]

/** slotGap 的演示候选：与演示夹具同源（改一处必须改 demo:intent 的 demoMemory）。 */
const DEMO_PAYEE_CHOICES = ['王建国', '张伟'] as const

/**
 * 判断意图。
 *
 * 顺序是先余额后转账：一句"我余额够不够转 800"两类特征都有，
 * 但用户真正想知道的是余额——先答能答的，再追问要不要转。
 *
 * 03 单新增的四条路由排在转账粗筛**之前**：隐含/模糊形态比转账更窄，先判窄的。
 */
export function classifyIntent(text: string): DemoIntent {
  const normalized = text.trim()
  if (normalized === '') {
    return { kind: 'clarify', question: '我没听清，你要办什么？（查余额，还是给谁转多少钱？）' }
  }

  // 问卷提交必须最先判：它是最窄的形态（整条消息就是一次作答），
  // 放到后面会被"测评"分支抢走，于是用户答完 5 题反而又拿到一张新卷。
  const riskSubmit = parseRiskSubmit(normalized)
  if (riskSubmit !== undefined) {
    return { kind: 'risk', action: 'submit', ...riskSubmit }
  }

  if (BALANCE_PATTERNS.some((pattern) => pattern.test(normalized))) {
    return { kind: 'balance' }
  }

  // 交易密码（01 单 / ADR-0014）：放在最前面一片——「改交易密码」里既没有金额也没有收款人，
  // 落到后面任一支都会被答成别的意思（尤其不能被「限额/额度」的卡片分支抢走）。
  if (PASSWORD_PATTERNS.some((pattern) => pattern.test(normalized))) {
    return parsePassword(normalized)
  }

  // 记住生日（04 单）：先于 BIRTHDAY_PLAN / implicit——否则会被当成生日场景陈述，
  // 事实库永远写不进去，后面的主动提醒也就没有数据源。
  if (FACT_REMEMBER_PATTERN.test(normalized) && /生日/.test(normalized)) {
    return parseFactRemember(normalized)
  }

  // 账单（02 单）与卡片（04 单）：都先于转账——「挂失银行卡」没有收款人。
  if (BILL_PATTERNS.some((pattern) => pattern.test(normalized))) {
    return parseBill(normalized)
  }
  if (CARD_PATTERNS.some((pattern) => pattern.test(normalized))) {
    return parseCard(normalized)
  }

  // 资金锁定（场景 6）：与卡片"冻结"区分——这里动的是账户余额，不是卡状态。
  if (FUND_LOCK_PATTERNS.some((pattern) => pattern.test(normalized))) {
    return parseFundLock(normalized)
  }

  // 理财（04 单）：先于转账——「转 1 万买理财」的宾语是产品，不是收款人。
  if (WEALTH_PATTERNS.some((pattern) => pattern.test(normalized))) {
    return parseWealth(normalized)
  }

  // 风险测评（C-03）：先于订阅——「风险等级」里没有扣款语义。
  // 放在理财之后：「理财产品风险等级」的宾语是产品，那个问题该由 wealth_list 答。
  if (RISK_PATTERNS.some((pattern) => pattern.test(normalized))) {
    return { kind: 'risk', action: 'questions' }
  }

  // 订阅/代扣（场景 5）：先于转账——「退订视频会员」没有收款人。
  if (SUBSCRIPTION_PATTERNS.some((pattern) => pattern.test(normalized))) {
    return parseSubscription(normalized)
  }

  // AA 查组状态（05 单）：先于 collect/建组——「查一下AA状态」没有金额，
  // 落到建组分支会被追问总额，等于把"查看"答成"新建"。
  if (AA_STATUS_PATTERNS.some((pattern) => pattern.test(normalized))) {
    return { kind: 'aa-status' }
  }

  // AA 模拟代收（场景 1 子能力）：先于 AA 建组与转账——「张三已经付了」既没有金额、
  // 也没有「AA」字样，落到下面任一支都会被答成别的意思。
  const aaCollect = parseAaCollect(normalized)
  if (aaCollect !== undefined) {
    return aaCollect
  }

  // AA 拒绝（ADR-0017）：先于建组/转账——「王建国不参加」没有金额，落到后面会被答成别的。
  const aaDecline = parseAaDecline(normalized)
  if (aaDecline !== undefined) {
    return aaDecline
  }

  // AA 收款（场景 1）：先于转账——AA 是收款请求，不是单笔付款。
  if (AA_PATTERNS.some((pattern) => pattern.test(normalized))) {
    return parseAa(normalized)
  }

  // 生日案例（04 单）：确认话术先判，再判场景陈述。两条都比转账更窄，先判窄的。
  if (BIRTHDAY_CONFIRM_PATTERNS.some((pattern) => pattern.test(normalized))) {
    return { kind: 'birthday', phase: 'execute', utterance: normalized }
  }

  const hasTransferCue = TRANSFER_PATTERNS.some((pattern) => pattern.test(normalized))

  // 只认"下个月…生日"这种带时间锚点的场景陈述，以及 04 单提醒文案里的
  // "给爱人订生日计划"；03 单的 `implicit` 路由继续兜住其它生日说法
  // （"我爱人生日快到了"），不与它抢话语。
  if (
    !hasTransferCue &&
    (/下个?月.{0,12}生日|生日.{0,6}下个?月/.test(normalized) ||
      BIRTHDAY_PLAN_PATTERNS.some((pattern) => pattern.test(normalized)))
  ) {
    return { kind: 'birthday', phase: 'propose', utterance: normalized }
  }

  // 商户订购（场景 6）：比"生日"陈述更窄（带品类词就是要买东西），先判它再判 implicit。
  if (!hasTransferCue && MERCHANT_PATTERNS.some((pattern) => pattern.test(normalized))) {
    return parseMerchant(normalized)
  }

  // 隐含意图：场景陈述且**没有任何转账线索**（有动作时显式指令优先）
  if (!hasTransferCue && IMPLICIT_PATTERNS.some((pattern) => pattern.test(normalized))) {
    return { kind: 'intent', route: 'implicit', utterance: normalized, scene: 'unknown' }
  }

  if (RECALL_PATTERNS.some((pattern) => pattern.test(normalized))) {
    return { kind: 'intent', route: 'recall', utterance: normalized, scene: 'transfer' }
  }

  if (CROSS_SCENE_PATTERNS.some((pattern) => pattern.test(normalized))) {
    return { kind: 'intent', route: 'crossScene', utterance: normalized, scene: 'cross_scene' }
  }

  if (hasTransferCue) {
    const parsed = parseTransfer(normalized)
    // 要素不全 ⇒ 改道意图平面：追问从纯文案升级为结构化选择题（对外口径不变）
    if (parsed.kind === 'clarify') {
      const amount = extractAmount(normalized)
      const payeeName = extractPayee(normalized)
      // 只有「金额已给、缺收款人」才静态发选择题：这是 intent_resolve 也会点名 payee 的唯一形态。
      // 其余缺参（缺金额 / 两样都缺）只发 intent_resolve + 文案——router 不知道 askHint 指向哪个槽位，
      // 硬发选择题就会与意图工具的判定打架（演示里那是最难解释的一种自相矛盾）。
      const ask =
        payeeName === undefined && amount !== undefined
          ? { slot: 'payee', question: parsed.question, candidates: [...DEMO_PAYEE_CHOICES] }
          : undefined
      return {
        kind: 'intent',
        route: 'slotGap',
        utterance: normalized,
        scene: 'transfer',
        ...(ask === undefined ? {} : { ask }),
      }
    }
    if (parsed.kind !== 'transfer') return parsed
    /**
     * 含时点的转账：能落到 `transfer_schedule` 就走定时，落不到就**追问**。
     *
     * 铁律：任何情况下都不许把"明天转"降级成"现在转"——那会当场划走本不该动的钱。
     * 这也是"先判窄、再判宽"的延续：时点比金额更硬，格式不认就不猜。
     */
    const schedule = extractScheduleWhen(normalized)
    if (schedule !== undefined) {
      if (schedule.when === undefined) {
        return {
          kind: 'clarify',
          question: '这笔要什么时候转？请给具体时间（例如：明天 15:00、下个月 8 号、2026-11-20）。',
        }
      }
      if (schedule.needsTime) {
        return {
          kind: 'clarify',
          question: `「${schedule.when}」还要具体到几点：请补一个时刻（例如：${schedule.when} 15:00）。`,
        }
      }
      return { kind: 'transfer', request: { ...parsed.request, when: schedule.when } }
    }
    return parsed
  }

  return {
    kind: 'clarify',
    question:
      '我现在能办：① 查账户余额；② 给指定收款人转账（金额 + 姓名）；' +
      '③ 理财查询/购买；④ 订阅查询/退订；⑤ 账单分析、卡片冻结/解冻/挂失；⑥ 风险测评（服务端问卷）。你要办哪一件？',
  }
}

/**
 * 账单意图（02 单）：只支持工具声明的三种口径。
 *
 * 「上个月」这类指定月份不在工具能力里：**追问**而不是按本月算——
 * 口径错了，用户会拿一份错误的月度分析去做决定。
 */
export function parseBill(text: string): DemoIntent {
  const period: 'month' | 'quarter' | 'year' = /季度|三个月/.test(text)
    ? 'quarter'
    : /年度|一年|十二个月|12\s*个月/.test(text)
      ? 'year'
      : 'month'
  const anchor = billAnchorOf(text)
  // 点名了年份就是年度口径（"2025 年花了多少"），不让 period 词把它压回单月。
  const effective: 'month' | 'quarter' | 'year' = anchor.year === undefined ? period : 'year'

  if (/报告|明细|出一份|发给我/.test(text)) {
    return {
      kind: 'bill',
      action: 'report',
      period: effective,
      format: /明细|每一笔|每笔/.test(text) ? 'detail' : 'summary',
      ...anchor,
    }
  }

  const groupBy: 'category' | 'payee' | 'merchant' = /商户|品类/.test(text)
    ? 'merchant'
    : /收款人|对方/.test(text)
      ? 'payee'
      : 'category'
  return { kind: 'bill', action: 'analyze', period: effective, groupBy, ...anchor }
}

/**
 * 账期锚点：把"上个月 / 9 月 / 2025 年 / 去年"翻成**结构化参数**。
 *
 * 只产出相对量或字面量，绝不在这里算日期——路由是确定性脚本，没有注入钟；
 * 真日期由工具层用 `bah:run` 的时钟换算（`resolveBillAnchor`）。
 */
function billAnchorOf(
  text: string,
): { readonly monthOffset?: number; readonly monthOfYear?: number; readonly year?: string } {
  if (/上上个月/.test(text)) return { monthOffset: -2 }
  if (/上个月|上月/.test(text)) return { monthOffset: -1 }
  const year = /(\d{4})\s*年/.exec(text)
  if (year?.[1] !== undefined) return { year: year[1] }
  // 「去年」= 相对 12 个月：配 period=year 就是去年全年，配 month 就是去年同月。
  if (/去年/.test(text)) return { monthOffset: -12 }
  const month = /(\d{1,2})\s*月(?!个)/.exec(text)
  if (month?.[1] !== undefined) {
    const value = Number(month[1])
    if (value >= 1 && value <= 12) return { monthOfYear: value }
  }
  return {}
}

/**
 * 卡片意图（04 单）：卡号只认演示夹具的三张卡（尾号 1234 → c-1，5678 → c-2，
 * 信用额度卡 2468 → c-3；ADR-0015 把第三张加进来）。
 *
 * 没给卡号就追问；不默认冻/挂任何一张卡。冻结/解冻/挂失都是真实副作用，
 * 猜错卡等于让用户另一张卡不能用。
 */
/**
 * 卡片品类限制的口语词 → `MerchantCategory` 键。
 *
 * 只认这几类（与 `packages/bank/src/core/merchant.ts` 的封闭表对齐）；认不出的品类
 * 不进 `category` 分支——宁可当成"线上支付"也不编一个匹配不上任何消费的键。
 */
const CARD_CATEGORY_WORDS: readonly (readonly [RegExp, string])[] = [
  [/餐饮/, 'dining'],
  [/咖啡/, 'coffee'],
  [/生鲜|买菜|超市/, 'grocery'],
  [/通勤|地铁|公交|打车/, 'transit'],
  [/购物|商城/, 'shopping'],
  [/数码|订阅/, 'digital'],
]

/** 信用产品的话语形态（ADR-0015）：只说"信用卡/信用额度/授信额度"才算，不猜。 */
const CARD_CREDIT_PATTERN = /信用卡|信用额度|授信额度/

/**
 * 解析卡片意图：卡号只认演示夹具的三张卡；没给卡号就追问，不默认操作任何一张卡。
 */
export function parseCard(text: string): DemoIntent {
  /**
   * 卡号解析顺序：先认**信用卡**（尾号 2468 或"信用"二字），再认虚拟/实体。
   *
   * "虚拟信用卡"同时含"虚拟"与"信用"——它指的就是 c-3（信用产品可以是虚拟卡），
   * 所以信用优先级高于介质词，否则用户会被指到 c-2 那张借记卡上。
   */
  const cardId: 'c-1' | 'c-2' | 'c-3' | undefined = /2468|信用/.test(text)
    ? 'c-3'
    : /5678|虚拟/.test(text)
      ? 'c-2'
      : /1234|实体/.test(text)
        ? 'c-1'
        : undefined

  /**
   * 办信用卡（ADR-0015）：必须排在"额度"分支**之前**。
   *
   * 否则"办一张 5000 额度的信用卡"会被当成调额——而调额需要卡号，于是变成
   * "要调整哪张卡的额度？"：用户想开卡，却被追问调额。这是 02 单修的演示断链。
   * 形态刻意收窄（有信用词 + 有办卡动词 + 无挂失/冻结），不劫持既有的办借记卡话术。
   */
  if (CARD_CREDIT_PATTERN.test(text) && /办|申请|开|来一张|整一张/.test(text) && !/挂失|冻结|解冻|停用|注销/.test(text)) {
    const amount = extractAmount(
      text.replace(/信用卡|信用额度|授信额度|额度|尾号|卡号/g, ' '),
    )
    if (amount === undefined) {
      return { kind: 'clarify', question: '要办多少额度的信用卡？（例：办一张 5000 额度的信用卡）' }
    }
    return { kind: 'card', action: 'apply', cardKind: 'credit', creditLimitYuan: amount }
  }

  if (/额度|提额|限额/.test(text)) {
    if (cardId === undefined) {
      return {
        kind: 'clarify',
        question: '要调整哪张卡的额度？演示卡：尾号 1234（实体卡）/ 尾号 5678（虚拟卡）/ 尾号 2468（信用额度卡）。',
      }
    }
    const cleaned = text.replace(/(尾号|卡号)?\s*(1234|5678|2468)/g, ' ')
    const amount = extractAmount(cleaned)
    if (amount === undefined) {
      return { kind: 'clarify', question: '要把额度调到多少元？' }
    }
    /**
     * 两种"额度"不混投：信用卡话语 → `creditLimitYuan`（授信额度），
     * 其余 → `dailyLimitYuan`（交易日限额，与改动前逐字一致）。
     */
    return CARD_CREDIT_PATTERN.test(text)
      ? { kind: 'card', action: 'setLimit', cardId, creditLimitYuan: amount }
      : { kind: 'card', action: 'setLimit', cardId, dailyLimitYuan: amount }
  }

  if (
    /交易限制|线上支付|境外支付|品类限制|关.*(支付|交易|消费)|恢复.*(支付|交易|消费)|打开.*(支付|交易|消费)/.test(
      text,
    )
  ) {
    if (cardId === undefined) {
      return {
        kind: 'clarify',
        question: '要设置哪张卡的交易限制？演示卡：尾号 1234（实体卡）/ 尾号 5678（虚拟卡）。',
      }
    }
    const mode: 'set' | 'clear' = /解除|恢复|打开|取消.*限制/.test(text) ? 'clear' : 'set'
    const category = CARD_CATEGORY_WORDS.find(([pattern]) => pattern.test(text))
    if (category !== undefined) {
      return {
        kind: 'card',
        action: 'restrict',
        cardId,
        mode,
        restrictionKind: 'category',
        restrictionValue: category[1],
      }
    }
    const restrictionKind: 'online' | 'overseas' = /境外/.test(text) ? 'overseas' : 'online'
    return { kind: 'card', action: 'restrict', cardId, mode, restrictionKind }
  }

  if (/办.*卡|申请.*卡|开.*卡|虚拟卡|新卡/.test(text) && !/挂失|冻结|解冻|停用/.test(text)) {
    return { kind: 'card', action: 'apply' }
  }

  if (!/挂失|冻结|解冻|停用/.test(text)) {
    return { kind: 'card', action: 'list' }
  }
  const action = /挂失/.test(text)
    ? 'reportLost'
    : /解冻/.test(text)
      ? 'unfreeze'
      : 'freeze'
  if (cardId === undefined) {
    return {
      kind: 'clarify',
      question: '要操作哪张卡？演示卡：尾号 1234（实体卡）/ 尾号 5678（虚拟卡）。',
    }
  }
  const reason = /盗刷/.test(text)
    ? '疑似盗刷'
    : /找不到|丢了|不见/.test(text)
      ? '卡片暂时找不到'
      : undefined
  return {
    kind: 'card',
    action,
    cardId,
    ...(reason === undefined ? {} : { reason }),
  }
}

/**
 * AA 模拟代收：从「张三已经付了」「李四给我了」里取人名。
 *
 * 认不出就返回 `undefined`（由后面的分支接手），**不猜名字**——替用户编一个参与人，
 * 后面会变成一条张冠李戴的入账记录。
 */
export function parseAaCollect(text: string): DemoIntent | undefined {
  for (const pattern of AA_COLLECT_PATTERNS) {
    const participant = pattern.exec(text)?.[1]?.trim()
    if (participant !== undefined && participant.length > 0) {
      return { kind: 'aa-collect', participant }
    }
  }
  return undefined
}

/**
 * AA 拒绝：从「王建国不参加」「李四说不去了」里取人名。
 *
 * 与 `parseAaCollect` 同一条纪律：认不出就返回 `undefined`，不猜名字——
 * 替一位参与人宣布拒绝，和替他入账一样是张冠李戴。
 */
export function parseAaDecline(text: string): DemoIntent | undefined {
  for (const pattern of AA_DECLINE_PATTERNS) {
    const participant = pattern.exec(text)?.[1]?.trim()
    if (participant !== undefined && participant.length > 0) {
      return { kind: 'aa-decline', participant }
    }
  }
  return undefined
}

/**
 * AA 收款（场景 1 补齐）：只认「张三、李四、王五 AA 300」这种演示语法。
 * 参与人必须显式给出；认不出就追问，不替用户编三个名字。
 */
export function parseAa(text: string): DemoIntent {
  const totalYuan = extractAmount(text)
  if (totalYuan === undefined) {
    return { kind: 'clarify', question: 'AA 一共多少钱？请给出总额（例如：张三、李四、王五 AA 300）。' }
  }
  // 名字允许 2–4 字，另把单字"我"列为合法参与人：「我、张伟、王建国」里的组织者
  // 也是这一组的成员（演示口径）。不能直接放开 1 字——「块，三个人」会被解析成名单。
  const name = '(?:我|[\\u4e00-\\u9fa5]{2,4})'
  const group = new RegExp(`(${name}(?:[、,，和]${name})+)`).exec(text)?.[1]
  if (group === undefined) {
    return { kind: 'clarify', question: 'AA 有哪几个人？请给出参与人姓名（用、或和分隔）。' }
  }
  const participants = group
    .split(/[、,，和]/)
    .map((name) => name.trim())
    .filter((name) => name.length > 0)
  // 构造不可达：上面的名单正则要求至少两段姓名（`(?:[、,，和]name)+`），单人说法在 `group === undefined` 那一步就已经追问了。留这道守卫是为了放宽正则时不静默放行。
  /* v8 ignore next 4 */
  if (participants.length < 2) {
    return { kind: 'clarify', question: 'AA 至少需要两个参与人。' }
  }
  return { kind: 'aa', totalYuan, participants }
}

/** 命中的演示订阅商户（返回展示名与订阅 ID）；认不出返回 undefined。 */
export function findSubscription(text: string): { readonly merchant: string; readonly id: string } | undefined {
  for (const [keyword, id, merchant] of DEMO_SUBSCRIPTIONS) {
    if (text.includes(keyword)) return { merchant, id }
  }
  return undefined
}

/** 从「提前三天」「提前 5 天」抽提醒提前量（1..7；抽不出用 3）。 */
export function extractAheadDays(text: string): number | undefined {
  const match = /提前\s*(\d+|[一二三四五六七])\s*天/.exec(text)
  const raw = match?.[1]
  if (raw === undefined) return undefined
  const value = Number(raw) || CN_DIGITS[raw]
  return value !== undefined && value >= 1 && value <= 7 ? value : undefined
}

/**
 * 订阅意图（场景 5）。
 *
 * 顺序：关协议（影响面最大）→ 退订 → 提醒/标注 → 其余按「查订阅」处理。
 * 认不出商户就追问；「确认到期即断」是演示脚本的第二幕，按视频会员处理（与 P9 台词同源）。
 */
export function parseSubscription(text: string): DemoIntent {
  const found = findSubscription(text)

  if (SUB_AUTHORIZE_PATTERNS.some((pattern) => pattern.test(text))) {
    if (found === undefined) {
      return {
        kind: 'clarify',
        question: '要关闭哪家商户的代扣协议？（演示商户：视频会员 / 云音乐 / 云存储 / 某某健身 / 新闻会员 / 网盘 / 阅读 / 软件）',
      }
    }
    return { kind: 'subscription', action: 'authorize', merchant: found.merchant }
  }

  const atNextCycle = AT_NEXT_CYCLE_PATTERNS.some((pattern) => pattern.test(text))
  if (SUB_CANCEL_PATTERNS.some((pattern) => pattern.test(text)) || atNextCycle) {
    const target = found ?? (atNextCycle ? findSubscription('视频会员') : undefined)
    if (target === undefined) {
      return {
        kind: 'clarify',
        question: '要退订哪一个订阅？（演示商户：视频会员 / 云音乐 / 云存储 / 某某健身 / 新闻会员 / 网盘 / 阅读 / 软件）',
      }
    }
    return {
      kind: 'subscription',
      action: 'cancel',
      subscriptionId: target.id,
      mode: atNextCycle ? 'at-next-cycle' : 'now',
      confirmContract: atNextCycle || CONFIRM_PATTERNS.some((pattern) => pattern.test(text)),
    }
  }

  if (SUB_WATCH_PATTERNS.some((pattern) => pattern.test(text))) {
    if (found === undefined) {
      return { kind: 'clarify', question: '要给哪个订阅设提醒或做标注？' }
    }
    if (/不用了|标注/.test(text)) {
      return { kind: 'subscription', action: 'watch', subscriptionId: found.id, watch: 'idle' }
    }
    const aheadDays = extractAheadDays(text)
    return {
      kind: 'subscription',
      action: 'watch',
      subscriptionId: found.id,
      watch: 'remind',
      ...(aheadDays === undefined ? {} : { aheadDays }),
    }
  }

  return { kind: 'subscription', action: 'list' }
}

/**
 * 从原话里抽转账要素；缺一件就追问缺的那件。
 *
 * 抽不全时**不补默认值**：默认收款人或默认金额一旦猜错，转出去的是真钱。
 */
export function parseTransfer(text: string): DemoIntent {
  const amount = extractAmount(text)
  const payeeName = extractPayee(text)

  if (amount === undefined && payeeName === undefined) {
    return { kind: 'clarify', question: '要转给谁、转多少？说得具体一点我就去办（例如：给王建国转 800 元）。' }
  }
  if (payeeName === undefined) {
    return { kind: 'clarify', question: '要转给谁？请给出收款人姓名。' }
  }
  if (amount === undefined) {
    return { kind: 'clarify', question: `给${payeeName}转多少？请给出金额。` }
  }
  return { kind: 'transfer', request: { amount, payeeName } }
}

/**
 * 理财要素（04 单）：编号 + 金额。
 *
 * 缺一件就追问缺的那件；编号只接受 1–`WEALTH_PRODUCT_MAX`，超出不猜。
 * 「买 4 号」没有金额时**不默认一个金额**——金额猜错，扣的是真钱。
 */
export function parseWealth(text: string): DemoIntent {
  if (/持仓|收益|买了什么|持有/.test(text)) {
    return { kind: 'wealth', action: 'positions' }
  }
  if (/赎回|卖出|卖掉/.test(text)) {
    // 演示夹具只有 h-1 一笔持仓；真实模型应从 wealth_positions 取 ID。
    return { kind: 'wealth', action: 'redeem', holdingId: 'h-1' }
  }
  const productNo = extractProductNo(text)
  const amount = extractWealthAmount(text)
  const buying = /买|购|申购/.test(text)

  if (!buying && WEALTH_LIST_PATTERNS.some((pattern) => pattern.test(text))) {
    return { kind: 'wealth', action: 'list' }
  }
  if (buying) {
    if (productNo === undefined) {
      return { kind: 'clarify', question: '要买几号产品、多少钱？（例如：买 4 号，1000 元）' }
    }
    if (amount === undefined) {
      return {
        kind: 'clarify',
        question: `买 ${String(productNo)} 号多少元？（例如：买 4 号，1000 元）`,
      }
    }
    return { kind: 'wealth', action: 'purchase', productNo, amount }
  }
  // 只提到理财 / 基金，既没有买也没有列表词：按「看看」处理（列表是安全的只读动作）。
  return { kind: 'wealth', action: 'list' }
}

/** 产品编号：`4 号` → 4；只接受 1–5（当前演示产品数），其余当"没给"。 */
export function extractProductNo(text: string): number | undefined {
  const match = /(\d+)\s*号/.exec(text)
  if (match?.[1] === undefined) return undefined
  const value = Number(match[1])
  return Number.isInteger(value) && value >= 1 && value <= WEALTH_PRODUCT_MAX ? value : undefined
}

/** 理财金额：先认「万」（`买 4 号 1 万元` → 10000），再退回 `extractAmount`。 */
export function extractWealthAmount(text: string): number | undefined {
  const wan = /(\d+(?:\.\d+)?)\s*万/.exec(text)
  if (wan?.[1] !== undefined) {
    const value = Number(wan[1]) * 10_000
    return Number.isFinite(value) && value > 0 ? value : undefined
  }
  // 先把产品编号剥掉：`买 4 号 1000`（没有「元」）不能把 4 号当金额。
  return extractAmount(text.replace(/(\d+)\s*号/, ' '))
}

/**
 * 抽金额（元）。
 *
 * 优先取**带"元/块"后缀**的数字，避免把"尾号 3333"这类编号当金额；
 * 没有再退回第一个阿拉伯数字。中文数字只支持 1–9 的单字（演示够用）。
 */
export function extractAmount(text: string): number | undefined {
  const withUnit = /(\d[\d,]*(?:\.\d+)?)\s*(?:元|块|rmb|RMB)/.exec(text)
  if (withUnit?.[1] !== undefined) {
    const value = Number(withUnit[1].replace(/,/g, ''))
    return Number.isFinite(value) && value > 0 ? value : undefined
  }

  const plain = /(\d[\d,]*(?:\.\d+)?)/g
  for (let match = plain.exec(text); match !== null; match = plain.exec(text)) {
    const digits = match[1]
    if (digits === undefined) continue
    // 明显是卡号/尾号/手机号的（≥7 位）不当金额，继续往后找。
    if (digits.replace(/[,.]/g, '').length >= 7) continue
    // 日期/时刻/序数上的数字不是金额（「每月 1 号转 3500」取 3500，不取 1）。
    const after = text.slice(match.index + match[0].length)
    if (/^\s*(?:号|日|月|年|时|点|分|天|周|星期|个月|[-/.]\s*\d)/.test(after)) continue
    if (/(?:第|周|星期|[-/.])\s*$/.test(text.slice(0, match.index))) continue
    const value = Number(digits.replace(/,/g, ''))
    if (Number.isFinite(value) && value > 0 && value < 1_000_000) return value
  }

  const cn = /([一二两三四五六七八九])\s*(?:元|块)/.exec(text)
  const digit = cn?.[1] === undefined ? undefined : CN_DIGITS[cn[1]]
  return digit === undefined ? undefined : digit
}

/** 未来时刻短语（与宿主 `parseScheduleWhen` 支持的格式一一对应，改一边必须改另一边）。 */
const SCHEDULE_PATTERNS: readonly RegExp[] = [
  /下周[一二三四五六日天]\s*(?:\d{1,2}[:：]\d{2})?/,
  /(?:今天|明天|后天)\s*(?:\d{1,2}[:：]\d{2})?/,
  /下个月\s*\d{1,2}\s*[号日]\s*(?:\d{1,2}[:：]\d{2})?/,
  /\d{1,2}\s*月\s*\d{1,2}\s*[号日]\s*(?:\d{1,2}[:：]\d{2})?/,
]

/** 宽泛的时间线索：命中即"这话含时点"，能不能解析另说。 */
const SCHEDULE_HINTS: readonly RegExp[] = [
  /今天|明天|后天|下周|下个月|下下个?月/,
  /\d{1,2}\s*月|这个月|本月|每月/,
  /\d{1,2}\s*[号日]/,
  /上午|下午|中午|晚上|早上|凌晨/,
  /\d{1,2}\s*[点時时]/,
]

/**
 * 抽"未来执行时刻"的原话片段。**只抽取，不换算**。
 *
 * 三种返回：
 * - `{ when }`：白名单格式（明天 / 下周一 09:00 / 下个月 8 号 / 3 月 8 号），直接交给 `transfer_schedule`；
 * - `{ needsTime: true }`：原话含时点线索但格式不可解析（"明天下午三点"、"这个月 20 号"、"每月 1 号"）
 *   ⇒ **必须追问**，既不能猜成某个时刻，更不能当成"现在转"；
 * - `undefined`：这句话没有时点，按立即转账处理。
 *
 * WHY 不在这里算日期：router 是确定性脚本，没有注入钟；算出来的"明天"在回放里就是错的。
 */
export function extractScheduleWhen(
  text: string,
): { readonly when?: string; readonly needsTime: boolean } | undefined {
  for (const pattern of SCHEDULE_PATTERNS) {
    const match = pattern.exec(text)
    if (match === null) continue
    const when = match[0].replace(/：/g, ':').trim()
    // 「明天下午三点」：日期命中了，但后面紧跟中文时刻 ⇒ 仍要追问具体 HH:mm。
    const tail = text.slice(match.index + match[0].length, match.index + match[0].length + 6)
    const needsTime = /^\s*(?:上午|下午|中午|晚上|早上|凌晨)/.test(tail)
    return { when, needsTime }
  }
  if (SCHEDULE_HINTS.some((pattern) => pattern.test(text))) return { needsTime: true }
  return undefined
}

/**
 * 抽收款人姓名。
 *
 * 覆盖 `给<姓名>转` 与 `转给<姓名>` 两种说法；姓名取 1–8 个非标点字符。
 */
export function extractPayee(text: string): string | undefined {
  // 手机号优先：姓名模式上限 8 字符，11 位号码匹配不到。
  const phonePatterns: readonly RegExp[] = [
    /给\s*(1\d{10})\s*(?:转|汇款|打款|打钱)/,
    /转给\s*(1\d{10})/,
    /(?:收款人|对方)[:：]?\s*(1\d{10})/,
  ]
  for (const pattern of phonePatterns) {
    const phone = pattern.exec(text)?.[1]?.trim()
    if (phone !== undefined && /^1\d{10}$/.test(phone)) return phone
  }
  const patterns: readonly RegExp[] = [
    /给\s*([^\s，。！？,、]{1,8}?)\s*(?:转|汇款|打款|打钱)/,
    /转给\s*([^\s，。！？,、]{1,8})/,
    /(?:收款人|对方)[:：]?\s*([^\s，。！？,、]{1,8})/,
  ]
  for (const pattern of patterns) {
    const name = pattern.exec(text)?.[1]?.trim()
    if (name !== undefined && name.length > 0 && !/^\d+$/.test(name)) return name
  }
  return undefined
}

/**
 * 意图 → 这一轮的步骤序列。
 *
 * 转账是**三步**，不是一步：先 `transfer_preview`（算额度、出门槛、不扣钱），
 * 再 `transfer_create`（真扣款、进审批），最后按结局收尾。
 * 演示跳过预览直接扣款，等于把"先算后办"这个安全设计从画面上抹掉。
 */
export function planFor(intent: DemoIntent): readonly MockStep[] {
  switch (intent.kind) {
    case 'balance':
      return [
        toolCallStep('call-balance', 'account_balance', {}),
        reflectStep({
          tool: 'account_balance',
          fallback: '余额查询没有返回结果，请稍后重试。',
        }),
      ]
    case 'transfer': {
      const args = {
        amount: intent.request.amount,
        payee: { name: intent.request.payeeName },
        ...(intent.request.remark === undefined ? {} : { remark: intent.request.remark }),
      }
      /**
       * 定时转账：只发 `transfer_schedule`，**不再补** `transfer_create`。
       *
       * 该工具把「哪天给谁转多少」翻译成一张授权窗口（到期由 `plan_wake` 代签）。
       * 若这里同时发 create，用户在审批卡上点一次就构成"提前扣款"——正是要修的那个缺陷。
       */
      if (intent.request.when !== undefined) {
        return [
          toolCallStep('call-schedule', 'transfer_schedule', {
            ...args,
            when: intent.request.when,
          }),
          outcomeStep({
            tool: 'transfer_schedule',
            ok: `已建立定时转账（${intent.request.when}）：到期由授权窗口代签，现在不会扣款；要取消请在计划卡上撤销窗口。`,
            failed: '未建立定时转账：{reason}',
          }),
        ]
      }
      return [
        toolCallStep('call-preview', 'transfer_preview', args),
        toolCallStep('call-create', 'transfer_create', args),
        outcomeStep({
          tool: 'transfer_create',
          ok: `已为你在模拟环境完成 ${String(intent.request.amount)} 元转账，审批与核销记录见上方工具卡。`,
          failed: '未执行：{reason}',
        }),
      ]
    }
    case 'wealth': {
      if (intent.action === 'list') {
        return [
          toolCallStep('call-wealth-list', 'wealth_list', {}),
          reflectStep({
            tool: 'wealth_list',
            fallback: '理财产品暂时取不到，请稍后再试。',
          }),
        ]
      }
      if (intent.action === 'positions') {
        return [
          toolCallStep('call-wealth-positions', 'wealth_positions', {}),
          reflectStep({ tool: 'wealth_positions', fallback: '持仓暂时取不到，请稍后再试。' }),
        ]
      }
      if (intent.action === 'redeem') {
        return [
          toolCallStep('call-wealth-redeem', 'wealth_redeem', { holdingId: intent.holdingId }),
          outcomeStep({
            tool: 'wealth_redeem',
            ok: '赎回已受理，审批与核验记录见上方工具卡。',
            failed: '未执行：{reason}',
          }),
        ]
      }
      return [
        toolCallStep('call-wealth-buy', 'wealth_purchase', {
          productId: `w-${String(intent.productNo)}`,
          amount: intent.amount,
        }),
        outcomeStep({
          tool: 'wealth_purchase',
          ok: '已受理，审批与核验记录见上方工具卡。',
          failed: '未执行：{reason}',
        }),
      ]
    }
    case 'risk': {
      if (intent.action === 'questions') {
        return [
          toolCallStep('call-risk-questions', 'risk_assess', { action: 'questions' }),
          reflectStep({ tool: 'risk_assess', fallback: '风险问卷暂时取不到，请稍后再试。' }),
        ]
      }
      return [
        toolCallStep('call-risk-submit', 'risk_assess', {
          action: 'submit',
          questionnaireId: intent.questionnaireId,
          answers: intent.answers,
        }),
        outcomeStep({
          tool: 'risk_assess',
          ok: '风险测评已提交，审批与确认记录见上方工具卡。',
          failed: '未提交：{reason}',
        }),
      ]
    }
    case 'subscription': {
      if (intent.action === 'list') {
        return [
          toolCallStep('call-sub-list', 'sub_list', {}),
          reflectStep({ tool: 'sub_list', fallback: '订阅清单暂时取不到，请稍后再试。' }),
        ]
      }
      if (intent.action === 'cancel') {
        return [
          toolCallStep('call-sub-cancel', 'sub_cancel', {
            subscriptionId: intent.subscriptionId,
            mode: intent.mode,
            ...(intent.confirmContract ? { confirmContract: true } : {}),
          }),
          outcomeStep({
            tool: 'sub_cancel',
            ok: '退订已受理，审批与核验记录见上方工具卡。',
            failed: '未执行：{reason}',
          }),
        ]
      }
      if (intent.action === 'authorize') {
        return [
          toolCallStep('call-sub-authorize', 'sub_authorize', { merchant: intent.merchant }),
          outcomeStep({
            tool: 'sub_authorize',
            ok: '代扣协议已关闭，受影响订阅见上方工具卡。',
            failed: '未执行：{reason}',
          }),
        ]
      }
      return [
        toolCallStep('call-sub-watch', 'sub_watch', {
          subscriptionId: intent.subscriptionId,
          watch: intent.watch,
          ...(intent.aheadDays === undefined ? {} : { aheadDays: intent.aheadDays }),
        }),
        outcomeStep({
          tool: 'sub_watch',
          ok: '提醒/标注已更新。',
          failed: '未执行：{reason}',
        }),
      ]
    }
    case 'bill': {
      // 账期锚点原样透传：路由只翻译不换算，真日期由工具层用注入钟算。
      const anchor = {
        ...(intent.monthOffset === undefined ? {} : { monthOffset: intent.monthOffset }),
        ...(intent.monthOfYear === undefined ? {} : { monthOfYear: intent.monthOfYear }),
        ...(intent.year === undefined ? {} : { year: intent.year }),
      }
      if (intent.action === 'analyze') {
        return [
          toolCallStep('call-bill', 'bill_analyze', {
            period: intent.period,
            groupBy: intent.groupBy,
            ...anchor,
          }),
          reflectStep({
            tool: 'bill_analyze',
            fallback: '账单分析暂时取不到，请稍后再试。',
          }),
        ]
      }
      return [
        toolCallStep('call-bill-report', 'bill_report', {
          period: intent.period,
          format: intent.format,
          ...anchor,
        }),
        reflectStep({
          tool: 'bill_report',
          fallback: '账单报告暂时取不到，请稍后再试。',
        }),
      ]
    }
    case 'card': {
      if (intent.action === 'list') {
        return [
          toolCallStep('call-card-list', 'account_list', {}),
          reflectStep({ tool: 'account_list', fallback: '卡片清单暂时取不到，请稍后再试。' }),
        ]
      }
      if (intent.action === 'apply') {
        return [
          toolCallStep('call-card-apply', 'card_apply', {
            ...(intent.cardKind === undefined ? {} : { kind: intent.cardKind }),
            ...(intent.creditLimitYuan === undefined
              ? {}
              : { creditLimitYuan: intent.creditLimitYuan }),
          }),
          outcomeStep({
            tool: 'card_apply',
            ok: '新卡申请已受理，审批与核验记录见上方工具卡。',
            failed: '未执行：{reason}',
          }),
        ]
      }
      if (intent.action === 'setLimit') {
        return [
          toolCallStep('call-card-limit', 'card_limit_set', {
            cardId: intent.cardId,
            ...(intent.dailyLimitYuan === undefined
              ? {}
              : { dailyLimitYuan: intent.dailyLimitYuan }),
            ...(intent.monthlyLimitYuan === undefined
              ? {}
              : { monthlyLimitYuan: intent.monthlyLimitYuan }),
            ...(intent.creditLimitYuan === undefined
              ? {}
              : { creditLimitYuan: intent.creditLimitYuan }),
          }),
          outcomeStep({
            tool: 'card_limit_set',
            ok: '卡额度调整已受理，审批与核验记录见上方工具卡。',
            failed: '未执行：{reason}',
          }),
        ]
      }
      if (intent.action === 'restrict') {
        return [
          toolCallStep('call-card-restrict', 'card_restriction', {
            cardId: intent.cardId,
            mode: intent.mode,
            kind: intent.restrictionKind,
            ...(intent.restrictionValue === undefined ? {} : { value: intent.restrictionValue }),
          }),
          outcomeStep({
            tool: 'card_restriction',
            ok: '交易限制已更新，审批与核验记录见上方工具卡。',
            failed: '未执行：{reason}',
          }),
        ]
      }
      const tool =
        intent.action === 'reportLost'
          ? 'card_report_lost'
          : intent.action === 'unfreeze'
            ? 'card_unfreeze'
            : 'card_freeze'
      const args =
        intent.action === 'freeze'
          ? { cardId: intent.cardId, ...(intent.reason === undefined ? {} : { reason: intent.reason }) }
          : { cardId: intent.cardId }
      const ok =
        intent.action === 'reportLost'
          ? '挂失已受理，卡片即刻不可用；补发流程请以银行通知为准。'
          : '卡片状态已更新，审批与核验记录见上方工具卡。'
      return [
        toolCallStep(`call-card-${intent.action}`, tool, args),
        outcomeStep({ tool, ok, failed: '未执行：{reason}' }),
      ]
    }
    case 'aa-collect': {
      // 组号写死为本次会话的第一个 AA 组（见 `DEMO_AA_GROUP_ID`）。名字必须在组里，
      // 不在就是 `aa-participant-unknown`——那条失败路径同样可演示，而且比"假装到账"诚实。
      return [
        toolCallStep('call-aa-collect', 'aa_create', {
          action: 'collect',
          groupId: DEMO_AA_GROUP_ID,
          participant: intent.participant,
        }),
        outcomeStep({
          tool: 'aa_create',
          ok: `${intent.participant} 的份额已入账，收款进度见上方工具卡。`,
          failed: '未执行：{reason}',
        }),
      ]
    }
    case 'aa-decline': {
      // 与 collect 同一个组号约定：本次会话的第一个组。
      return [
        toolCallStep('call-aa-decline', 'aa_create', {
          action: 'decline',
          groupId: DEMO_AA_GROUP_ID,
          participant: intent.participant,
        }),
        outcomeStep({
          tool: 'aa_create',
          ok: `已记录 ${intent.participant} 不参加，收款进度见上方工具卡。`,
          failed: '未执行：{reason}',
        }),
      ]
    }
    case 'aa-status':
      return [
        toolCallStep('call-aa-status', 'aa_create', {
          action: 'status',
          groupId: DEMO_AA_GROUP_ID,
        }),
        // 复述工具正文：paid/declined/pending 与金额都在结果里，路由不再抄一份状态表
        reflectStep({
          tool: 'aa_create',
          fallback: '没有查到 AA 组状态（可能还没建组，或本会话的第一个组已被清空）。',
        }),
      ]
    case 'aa': {
      return [
        toolCallStep('call-aa', 'aa_create', {
          title: 'AA 收款',
          totalYuan: intent.totalYuan,
          participants: intent.participants.map((name) => ({ name })),
        }),
        outcomeStep({
          tool: 'aa_create',
          ok: 'AA 收款请求已创建，每人待收金额见上方工具卡。',
          failed: '未执行：{reason}',
        }),
      ]
    }
    case 'clarify':
      return [textStep(intent.question)]
    case 'fundLock': {
      return [
        toolCallStep('call-fund-lock', 'fund_lock', {
          action: intent.action,
          ...(intent.amountYuan === undefined ? {} : { amountYuan: intent.amountYuan }),
        }),
        outcomeStep({
          tool: 'fund_lock',
          ok:
            intent.action === 'status'
              ? '已查到当前锁定金额与可用余额，明细见上方工具卡。'
              : intent.action === 'lock'
                ? '资金已锁定：可用余额下降、总资产不变，随时可解除。'
                : '已解除锁定：资金回到活期可用余额。',
          failed: '未完成：{reason}',
        }),
      ]
    }
    case 'password': {
      // 只发 `{ action }`：工具 schema 里没有别的字段，这里也就不可能有密码。
      // 成功话术引用工具正文：交接页地址与票据号只能来自工具结果，写死一份就会漂移。
      return [
        toolCallStep('call-password-change', 'password_change', { action: intent.action }),
        outcomeStep({
          tool: 'password_change',
          okFromResult: true,
          ok:
            intent.action === 'request'
              ? '已发起交易密码修改，安全页地址与票据见上方工具卡。'
              : '已查到交易密码状态，最近改密时刻与剩余尝试次数见上方工具卡。',
          failed: '未完成：{reason}',
        }),
      ]
    }
    case 'merchant': {
      const args = {
        category: intent.category,
        ...(intent.budgetYuan === undefined ? {} : { budgetYuan: intent.budgetYuan }),
      }
      if (intent.action === 'search') {
        return [
          toolCallStep('call-merchant-search', 'merchant_search', args),
          reflectStep({
            tool: 'merchant_search',
            fallback: '商户目录暂时取不到，请稍后再试。',
          }),
        ]
      }
      return [
        toolCallStep('call-merchant-order', 'merchant_order', args),
        outcomeStep({
          tool: 'merchant_order',
          ok: '已下单：履约与扣款记录见上方工具卡（超预算会换店或失败，不会擅自加价）。',
          failed: '未下单：{reason}',
        }),
      ]
    }
    case 'factRemember': {
      const display = `${intent.date.slice(5, 7)} 月 ${intent.date.slice(8, 10)} 日`
      return [
        toolCallStep('call-fact-remember', 'fact_remember', {
          person: intent.person,
          relation: intent.relation,
          kind: 'birthday',
          date: intent.date,
          confirmed: true,
        }),
        outcomeStep({
          tool: 'fact_remember',
          ok: `已记住：${intent.person}的生日是 ${display}，临近时我会主动提醒你。`,
          failed: '没记住：{reason}',
        }),
      ]
    }
    case 'birthday':
      return planBirthday(intent)
    case 'intent':
      return planIntent(intent)
    default:
      // 封闭联合上的兜底：新增意图时忘了在这里规划，编译期就会红
      return assertNever(intent, 'demo-intent')
  }
}

/** 生日案例的 DAG（6 节点 5 边）；提案与执行两幕共用同一份定义。 */
const BIRTHDAY_NODES = [
  { id: 'a1', tool: 'transfer_preview', args: { amount: 300, payee: { name: '锁定账户(9012)' } }, deps: [] },
  {
    id: 'a2',
    tool: 'transfer_create',
    args: { amount: 300, payee: { name: '锁定账户(9012)', memo: '生日预算锁定' } },
    deps: ['a1'],
  },
  { id: 'b1', tool: 'transfer_preview', args: { amount: 200, payee: { name: '馨香花艺' } }, deps: ['a2'] },
  { id: 'c1', tool: 'transfer_preview', args: { amount: 100, payee: { name: '甜心蛋糕坊' } }, deps: ['a2'] },
  {
    id: 'b2',
    tool: 'transfer_create',
    args: { amount: 200, payee: { name: '馨香花艺', memo: '生日鲜花预订款' } },
    deps: ['b1'],
  },
  {
    id: 'c2',
    tool: 'transfer_create',
    args: { amount: 100, payee: { name: '甜心蛋糕坊', memo: '生日蛋糕预订款' } },
    deps: ['c1'],
  },
] as const

const BIRTHDAY_PLAN = {
  planId: 'birthday-plan',
  meta: { title: '生日准备：锁定预算 → 鲜花 → 蛋糕' },
  nodes: BIRTHDAY_NODES,
} as const

/**
 * 生日案例两幕（04 单 §4）的脚本。
 *
 * 第一幕：意图（implicit）→ `goal_set` 记意图账 → `plan_propose` 出 DAG（**只校验不执行**）。
 * 第二幕：用户确认后 `plan_execute` —— 计划本身黄级审批一次，每个写节点**再各走一次**审批。
 * 时间语义是预演（不做真定时）：文案里写明"生日前 2 天"只是提案声明，没有定时器。
 */
function planBirthday(intent: Extract<DemoIntent, { kind: 'birthday' }>): readonly MockStep[] {
  if (intent.phase === 'propose') {
    return [
      toolCallStep('call-intent', 'intent_resolve', { utterance: intent.utterance, scene: 'unknown' }),
      toolCallStep('call-goal', 'goal_set', {
        statement: '为配偶生日做准备：锁定预算 300 元，预订鲜花 200 元、蛋糕 100 元',
        budget: { amount: 600, currency: 'CNY' },
        constraints: ['只用活期余额', '生日前 2 天预订（预演，不自动下单）'],
      }),
      toolCallStep('call-plan', 'plan_propose', BIRTHDAY_PLAN),
      /**
       * 文案必须挂在 `tool/result` 上，不能是无条件 `textStep`。
       *
       * WHY：`plan_propose` 在没装计划插件的 profile 里会 `tool-missing`，
       * 旧写法仍然输出"已生成计划"——当着审阅者面编造了一个不存在的计划。
       * 现在工具没跑通就只会说"没生成"。
       */
      outcomeStep({
        tool: 'plan_propose',
        ok:
          '已生成计划草案（6 步，尚未执行）：锁定预算 → 鲜花 → 蛋糕。' +
          '每一笔转账仍要您单独批准；"生日前 2 天自动下单"属于授权窗口能力，本草案不含定时。' +
          '要执行请回复「确认执行生日计划」。',
        failed: '计划没有生成：{reason}。我不会在工具未执行时假装成功。',
      }),
    ]
  }
  return [
    toolCallStep('call-exec', 'plan_execute', BIRTHDAY_PLAN),
    outcomeStep({
      tool: 'plan_execute',
      ok: '计划已执行完成：每一笔转账都各自经过了审批与票据核销，明细见上方工具卡。',
      failed: '计划未全部完成：{reason}。已发生的操作不会自动撤销，请核对清单。',
    }),
  ]
}

/**
 * 意图平面的四条路由 → 步骤。
 *
 * 每一条都是「先调 `intent_resolve`」：router 只负责认出话语形态，判定在工具里。
 * 复现路径的 `transfer_preview` 参数来自演示夹具（与 `demoMemory` 同源）——
 * 真实模型会从 `intent_resolve` 的 filled 里取，演示脚本只能写死。
 */
function planIntent(intent: Extract<DemoIntent, { kind: 'intent' }>): readonly MockStep[] {
  const resolve = toolCallStep('call-intent', 'intent_resolve', {
    utterance: intent.utterance,
    scene: intent.scene,
  })
  switch (intent.route) {
    case 'implicit':
      return [
        resolve,
        textStep('这件事我只提建议，不会直接操作。要不要先看看心意金或稳健理财方案？（执行编排在 04 单落地后接 plan_propose）'),
      ]
    case 'recall':
      return [
        resolve,
        toolCallStep('call-preview', 'transfer_preview', { amount: 800, payee: { name: '王建国' } }),
        textStep('已按上次的参数生成预演：向王建国转 800 元。确认后才发起。'),
      ]
    case 'crossScene':
      return [
        resolve,
        textStep('您是想继续上次的转账，还是账单那边的事？我不确定，先问一下。'),
      ]
    case 'slotGap':
      if (intent.ask === undefined) return [resolve, textStep('请说得具体一点：是要给谁转账，还是还信用卡？')]
      return [
        resolve,
        toolCallStep('call-ask', 'prompt_ask', {
          question: intent.ask.question,
          slot: intent.ask.slot,
          candidates: intent.ask.candidates.map((label) => ({ label, value: label })),
        }),
        textStep('请选择一下，或者直接输入。'),
      ]
    /* v8 ignore start —— IntentRoute 四值穷尽：default 不可达 */
    default:
      return assertNever(intent.route, 'demo-intent-route')
    /* v8 ignore stop */
  }
}

/** `prompt_ask` 结果里的候选（宿主把工具结果投影成一条 JSON 文本消息）。 */
interface PromptAskChoices {
  readonly choices: readonly { readonly label: string; readonly value: string; readonly kind: string }[]
}

function promptAskChoices(message: LlmMessage): PromptAskChoices | undefined {
  const block = message.content.find((item) => item.kind === 'text')
  if (block === undefined || block.kind !== 'text') return undefined
  let payload: unknown
  try {
    payload = JSON.parse(block.text)
  } catch {
    return undefined
  }
  if (payload === null || typeof payload !== 'object') return undefined
  const choices = (payload as { choices?: unknown }).choices
  if (!Array.isArray(choices)) return undefined
  const parsed: { label: string; value: string; kind: string }[] = []
  for (const item of choices) {
    if (item === null || typeof item !== 'object') return undefined
    const { label, value, kind } = item as Record<string, unknown>
    if (typeof label !== 'string' || typeof value !== 'string' || typeof kind !== 'string') return undefined
    parsed.push({ label, value, kind })
  }
  return { choices: parsed }
}

/** `prompt_ask` 的调用参数里问的是哪个槽位（工具结果本身不带槽位）。 */
function promptAskSlot(messages: readonly LlmMessage[], callId: string | undefined): string | undefined {
  if (callId === undefined) return undefined
  for (const message of messages) {
    if (message.role !== 'assistant') continue
    for (const block of message.content) {
      if (block.kind !== 'tool-call' || block.id !== callId) continue
      const args = block.args
      if (args === null || typeof args !== 'object') return undefined
      const slot = (args as { slot?: unknown }).slot
      return typeof slot === 'string' ? slot : undefined
    }
  }
  return undefined
}

/** 当前用户消息之前最近一条真实用户原话（跳过平台注入的上下文段）。 */
function userTextBefore(messages: readonly LlmMessage[], index: number): string | undefined {
  for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
    const message = messages[cursor]
    if (message?.role !== 'user' || isPlatformContext(message)) continue
    const texts: string[] = []
    for (const block of message.content) {
      if (block.kind === 'text') texts.push(block.text)
    }
    return texts.join('\n').trim()
  }
  return undefined
}

/**
 * 追问卡点选后的续接：离线 router 没有真实模型那层上下文合并，必须把答案接回上一轮。
 *
 * 只认「紧挨着 `prompt_ask`、且命中候选值」的回复——手输的自由文本不在此列，
 * 免得把「算了」这类短句当成收款人。命中后金额取上一条用户原话；
 * 上一条没有金额就接着问金额，而不是退回能力清单。
 */
function answerToPendingAsk(messages: readonly LlmMessage[]): DemoIntent | undefined {
  const currentIndex = lastUserTurnIndex(messages)
  if (currentIndex < 0) return undefined
  const answer = lastUserText(messages)
  if (answer.length === 0) return undefined

  let askIndex = -1
  for (let index = currentIndex - 1; index >= 0; index -= 1) {
    const message = messages[index]!
    if (message.role === 'tool' && message.name === 'prompt_ask') {
      askIndex = index
      break
    }
  }
  if (askIndex < 0) return undefined

  // 追问之后用户又说过别的话 ⇒ 这条候选早已过期，不能把旧问题当现行上下文。
  for (let index = askIndex + 1; index < currentIndex; index += 1) {
    const message = messages[index]!
    if (message.role === 'user' && !isPlatformContext(message)) return undefined
  }

  const ask = messages[askIndex]!
  const parsed = promptAskChoices(ask)
  if (parsed === undefined) return undefined
  const matched = parsed.choices.some(
    (choice) => choice.kind === 'candidate' && (choice.label === answer || choice.value === answer),
  )
  if (!matched) return undefined
  if (promptAskSlot(messages, ask.toolCallId) !== 'payee') return undefined

  const previous = userTextBefore(messages, currentIndex)
  const amount = previous === undefined ? undefined : extractAmount(previous)
  if (amount === undefined) return parseTransfer(`给${answer}转`)
  return { kind: 'transfer', request: { amount, payeeName: answer } }
}

/**
 * 给本轮的 tool callId 加唯一前缀。
 *
 * 会话投影按 `callId` 配对 assistant/tool 消息；跨轮复用同一个 `callId` 会让旧消息
 * 抢占新消息的承载位，本轮 assistant 被吞掉后步号永远停在 0（表现为同一步空转到步数上限）。
 *
 * @param steps 本轮规划
 * @param prefix 调用前缀（同一轮内稳定）
 */
function prefixCallIds(steps: readonly MockStep[], prefix: string): readonly MockStep[] {
  if (prefix === '') return steps
  return steps.map((step) => ({
    ...step,
    ...(step.content === undefined
      ? {}
      : {
          content: step.content.map((block) =>
            block.kind === 'tool-call' ? { ...block, id: `${prefix}:${block.id}` } : block,
          ),
        }),
  }))
}

/** 从一次请求直接规划步骤（`MockLlmAdapter` 的 `plan` 入口）。 */
export function planFromRequest(request: LlmRequest, callPrefix = ''): readonly MockStep[] {
  const intent = answerToPendingAsk(request.messages) ?? classifyIntent(lastUserText(request.messages))
  return prefixCallIds(planFor(intent), callPrefix)
}
