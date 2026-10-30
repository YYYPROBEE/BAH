/**
 * 离线演示的**意图路由**（不是磁带）。
 *
 * ## 为什么需要它
 *
 * `provider: mock` 的固定脚本有一个致命的演示缺陷：它**不读 `call.messages`**，
 * 只按调用次序出队。于是"给王建国转 800 元"和"帮我查下余额"拿到的是同一段回复，
 * 评委问任何剧本外的问题，回答都是那句话。这比不演示更糟——它当着人面撒谎。
 *
 * 路由不是模型，它只做三件确定性的事：
 * 1. 从**最后一条用户消息**里判断意图（查余额 / 转账 / 其它）；
 * 2. 转账时从原话里抽金额与收款人，抽不全就**追问**，而不是编一个默认值；
 * 3. 按意图规划这一轮要走的步骤（预览 → 执行 → 收尾）。
 *
 * 它的边界要写清楚：**它不是自然语言理解**。认不出来的问题一律追问，
 * 不做"猜一个最像的意图"——猜错比不问更伤人。
 *
 * ## 与意图平面的分工（03 单，答辩必被问）
 *
 * - 本文件决定「**调哪个工具**」：仍是确定性正则/关键词路由；
 * - `intent_resolve` 决定「**槽位怎么补、要不要追问、能不能借历史**」：可解释规则 + 纯函数。
 *
 * 所以 `implicit`/`recall`/`crossScene`/`slotGap` 四条路由只是把「该发射意图工具的话语形态」
 * 认出来，语义判定一律发生在工具内。**不得**为演示效果往本文件塞槽位解析逻辑——
 * 那是意图平面的职责，塞进来就是造第二个真相源。
 */

import { assertNever } from '@bah/util'

import type { LlmRequest } from '../llm/types.ts'
import { lastUserText } from '../llm/turns.ts'
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
       * 生日案例（04 单）：两幕脚本。propose = 提案（意图 → 目标账本 → DAG），
       * execute = 用户确认后执行同一张 DAG。**仍然不是 NLU**：
       * 它只认"生日"与"确认执行"两种话语形态，认不出的一律追问。
       */
      readonly kind: 'birthday'
      readonly phase: 'propose' | 'execute'
      readonly utterance: string
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

/** 理财意图的粗筛（04 单）：只认「理财 / 基金 / 产品收益风险 / 买 N 号」。 */
const WEALTH_PATTERNS: readonly RegExp[] = [/理财/, /基金/, /产品.{0,6}(收益|风险)/, /买\s*\d+\s*号/]

/** 「看看有哪些」的话语形态：命中且没有购买动作时规划 `wealth_list`。 */
const WEALTH_LIST_PATTERNS: readonly RegExp[] = [/有什么|看看|推荐|哪些|在售/]

/** 当前演示产品数（编号 `w-1`–`w-5`）；超出不猜，走追问。 */
const WEALTH_PRODUCT_MAX = 5

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

  if (BALANCE_PATTERNS.some((pattern) => pattern.test(normalized))) {
    return { kind: 'balance' }
  }

  // 理财（04 单）：先于转账——「转 1 万买理财」的宾语是产品，不是收款人。
  if (WEALTH_PATTERNS.some((pattern) => pattern.test(normalized))) {
    return parseWealth(normalized)
  }

  // 订阅/代扣（场景 5）：先于转账——「退订视频会员」没有收款人。
  if (SUBSCRIPTION_PATTERNS.some((pattern) => pattern.test(normalized))) {
    return parseSubscription(normalized)
  }

  // 生日案例（04 单）：确认话术先判，再判场景陈述。两条都比转账更窄，先判窄的。
  if (BIRTHDAY_CONFIRM_PATTERNS.some((pattern) => pattern.test(normalized))) {
    return { kind: 'birthday', phase: 'execute', utterance: normalized }
  }

  const hasTransferCue = TRANSFER_PATTERNS.some((pattern) => pattern.test(normalized))

  // 只认"下个月…生日"这种带时间锚点的场景陈述：03 单的 `implicit` 路由继续兜住
  // 其它生日说法（"我爱人生日快到了"），不与它抢话语。
  if (!hasTransferCue && /下个?月.{0,12}生日|生日.{0,6}下个?月/.test(normalized)) {
    return { kind: 'birthday', phase: 'propose', utterance: normalized }
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
    return parsed
  }

  return {
    kind: 'clarify',
    question:
      '我现在只会三件事：① 查账户余额；② 给指定收款人转账（金额 + 姓名）；' +
      '③ 查/退订订阅与关闭代扣。你要办哪一件？',
  }
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

  const plain = /(\d[\d,]*(?:\.\d+)?)/.exec(text)
  if (plain?.[1] !== undefined) {
    const value = Number(plain[1].replace(/,/g, ''))
    // 明显是卡号/尾号的（≥7 位）不当金额
    if (Number.isFinite(value) && value > 0 && value < 1_000_000) return value
  }

  const cn = /([一二两三四五六七八九])\s*(?:元|块)/.exec(text)
  const digit = cn?.[1] === undefined ? undefined : CN_DIGITS[cn[1]]
  return digit === undefined ? undefined : digit
}

/**
 * 抽收款人姓名。
 *
 * 覆盖 `给<姓名>转` 与 `转给<姓名>` 两种说法；姓名取 1–8 个非标点字符。
 */
export function extractPayee(text: string): string | undefined {
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
    case 'clarify':
      return [textStep(intent.question)]
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
      textStep(
        '已生成计划：锁定预算 → 鲜花 → 蛋糕，共 6 步。' +
          '确认后每一笔转账仍需您单独批准；"生日前 2 天自动下单"是预演叙事，系统不会真正定时扣款。' +
          '要执行请回复「确认执行生日计划」。',
      ),
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

/** 从一次请求直接规划步骤（`MockLlmAdapter` 的 `plan` 入口）。 */
export function planFromRequest(request: LlmRequest): readonly MockStep[] {
  return planFor(classifyIntent(lastUserText(request.messages)))
}
