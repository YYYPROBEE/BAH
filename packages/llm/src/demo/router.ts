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
  | { readonly kind: 'clarify'; readonly question: string }
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

  const hasTransferCue = TRANSFER_PATTERNS.some((pattern) => pattern.test(normalized))

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
      '我现在只会两件事：① 查账户余额；② 给指定收款人转账（金额 + 姓名）。' +
      '你要办哪一件？',
  }
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
    case 'clarify':
      return [textStep(intent.question)]
    case 'intent':
      return planIntent(intent)
    default:
      // 封闭联合上的兜底：新增意图时忘了在这里规划，编译期就会红
      return assertNever(intent, 'demo-intent')
  }
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
