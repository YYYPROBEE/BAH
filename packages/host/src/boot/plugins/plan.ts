/**
 * `plan:dag`：把「外部传入的一张工具调用 DAG」接到**七段工具管线**上。
 *
 * ## 它是什么 / 不是什么
 *
 * 是一个**编排原语**，不是规划器：plan 由宿主/脚本/上层插件构造（工具锁定 14 个，
 * 模型看不见也调不动它）。它只做四件事——校验、拓扑排序、逐节点调度、落 8 个 durable 事件。
 *
 * 与 `bank:saga-bridge` 的分工（方案 §1.3，对外说明必被问）：
 * - saga 的图在**代码**里（`RECIPES` 硬编码两跳），回答"失败了怎么退"；
 * - plan 的图是**数据**，回答"先做什么后做什么"；
 * - saga 是"外层批一次、内层直调"，plan 是**每个节点各走一次 `tools/pre-execute`**。
 *
 * ## 为什么 invoker 必须走 `new ToolPipeline(...).execute()`
 *
 * 唯一合法的执行方式。抄 `saga-bridge.ts` 的 `executeTool`（直接 `definition.execute`）
 * 会绕过审批、Sentry、审计——而 plan 的每个节点是**不同工具、不同金额**，
 * "外层已经批过一次"在这里根本不成立（方案 §5 陷阱 1）。
 * 引擎签名里**没有** `ToolRegistry`，只有 `PlanInvoker` 这一个函数：想绕得先改签名，改签名会被 review 抓住。
 *
 * ## 三层超时/取消的取舍
 *
 * - `planTimeoutMs` 只覆盖**本 plan 的调度**：超时置 abort，已进入的节点跑完；
 * - 兜底的硬约束是 `planTimeoutMs < ticketTtlMs`（方案 §3.8）：票据 TTL 是 10 分钟、
 *   计划排队 30 秒还行，排 11 分钟就是拿过期票据扣款。v1 没有 lease（那是治理平面的活）；
 * - `ctx.dispose()` 时在跑的 plan 全部 abort（`reason: 'disposed'`）。
 *
 * **已知限制**（README 也写了）：plan 拿不到 turn 的 `AbortSignal`（`tools/execute` 的
 * 包裹层只拿到 `call`），所以 turn 被取消后，已进入的 plan 节点仍会跑完。
 */

import { BANK_CHALLENGE, BANK_COMPENSATION, BANK_IDENTITY, BANK_TOOL_NAME_SET, yuanToCents, type MerchantReservation } from '@bah/bank'
import { defineService } from '@bah/core'
import { HALT_SERVICE } from '@bah/safety'
import {
  SESSION_SERVICE,
  TOOLS_SERVICE,
  createGoalSetTool,
  createGoalStore,
  createTodoWriteTool,
  PLAN_INCIDENT_CODE,
  PLAN_NODE_ID_PATTERN,
  PlanEngine,
  ToolGuard,
  ToolPipeline,
  kahnSort,
  planDigest,
  checkWindow,
  decideWindowSign,
  WINDOW_AUTO_LEVEL,
  duePlans,
  executedInstanceKeys,
  idempotencyKey,
  occurrenceOf,
  replayArmedPlans,
  DEFAULT_NOTIFY_BUDGET,
  deriveNotify,
  PLAN_ARM_TOOL,
  PLAN_DISARM_TOOL,
  PLAN_WAKE_TOOL,
  type ArmedPlan,
  type AnySessionEvent,
  type NotifyHistoryItem,
  type Plan,
  type PlanAbortReason,
  type PlanApiRunOptions,
  type PlanApi,
  type PlanEventType,
  type PlanInvoker,
  type PlanNode,
  type PlanResumeOptions,
  type PlanRunSnapshot,
  type PlanRunSummary,
  type PreExecuteInput,
  type Recurrence,
  type ToolDefinition,
  type ToolExecContext,
  type ToolRegistry,
  type WindowCondition,
  type WindowVerdictInputs,
  type WorldSnapshot,
} from '@bah/runtime'
import { BahError, canonicalJson, errorCodeOf, sha256Hex } from '@bah/util'

import type { HaltHandle } from '@bah/safety'
import type { TicketAuthorization, TicketDetail } from '@bah/core'
import type { WindowSignGrant, WindowSignRequest } from '@bah/interaction'

import type { HostPlugin, ValidatedRow } from '../../plugin-manager/index.ts'
import { RUN_SERVICE } from '../boot.ts'
import { createWakeMarkStore, type WakeMarkStore } from '../wake-marks.ts'
import {
  BANK_BALANCE_PROBE,
  BANK_TRANSFER_PROBE,
  type TransferProbe,
  type TransferProbeUsage,
} from './bank-tools.ts'
import { FACT_SERVICE, type FactStore } from './fact.ts'
import { MERCHANT_SERVICE, type MerchantFulfilment, type MerchantService } from './merchant.ts'
import { WINDOW_SIGNER, type WindowSigner } from './plan-grant.ts'
import {
  detailsDigestOf,
  maskPhone,
  renderArmDetails,
  renderBirthdayDetails,
  renderScheduleDetails,
  type ArmFacts,
  type OfferFacts,
  type PlanLegFacts,
} from './plan-details.ts'
import {
  bootError,
  describeValue,
  readBoolean,
  readPositiveInteger,
  rejectUnknownKeys,
} from '../config.ts'
import { DEFAULT_BANK_TOOLS, type BankToolsSettings } from './bank-tools.ts'

/** `plan:dag` 的配置。 */
export interface PlanSettings {
  /** 总开关：`false` 时本插件只做配置校验，不提供 `bah:plan` 服务（等价于没装）。 */
  readonly enabled: boolean
  /** 节点数上限（防"一张图 200 个节点"把串行执行拖成不可解释的长事务）。 */
  readonly maxNodes: number
  /** 依赖边数上限。 */
  readonly maxEdges: number
  /** 单次 run 的调度预算（毫秒）；超时置 abort，已进入的节点跑完。 */
  readonly planTimeoutMs: number
  /** `PlanApi.run()` 不传 `dryRun` 时的缺省值。 */
  readonly dryRunDefault: boolean
  /**
   * 是否把 `plan_propose` / `plan_execute` 暴露给模型（B1）。
   *
   * 缺省关闭：默认 Web / headless profile 的工具面保持原样；只有显式打开的
   * profile（如 `profiles/plan`）才让模型看得见这两个工具。
   */
  readonly modelTools: boolean
  /**
   * 模型生成的计划节点上限（比 `maxNodes` 更紧）。
   *
   * 模型一次生成 32 个节点在演示里既不可审阅也不可控；8 是"能讲清一张图"的上限，
   * 超过就必须拆成多张计划。执行器本身仍允许 `maxNodes`。
   */
  readonly modelMaxNodes: number
  /**
   * 票据 TTL（毫秒）：**只用于越界判定**，不参与执行。
   *
   * 方案 §4.3 的 5 键之外的第 6 键。真源在 `bank:tools.ticketTtlSeconds`，但插件之间拿不到
   * 彼此的配置；与其在代码里写死一个会过期的常数让"预算 < TTL"的判定说谎，不如显式配置。
   */
  readonly ticketTtlMs: number
  /**
   * 同一节点允许的**失败次数上限**（含首次运行，按 `plan/node-result(status='failed')` 累计）。
   *
   * 口径是"失败几次"而不是"重试几次"：事件里区分不出"这次是首次还是第 4 次"。
   * 默认 3 = 1 次原始运行 + 2 次 `resume` 重试；再想重试只能换新 `planId`
   * （新计划 + 冲正，见 `docs/plan.md` §12.4）。
   */
  readonly maxNodeAttempts: number
  /**
   * 到期前提醒的提前量（毫秒；提示词 4-2）。
   *
   * 窗口还没到期、但已进入 `[dueAt - lead, dueAt)` 时，唤醒执行器发一条 `exec` 级提醒
   * （"即将执行，如需修改请重新授权"）。`0` = 关闭提醒。**只提醒，不执行**：
   * 到点后是否真的扣款仍由窗口复验 + 代签核验决定。
   */
  readonly dueSoonLeadMs: number
}

/** 单行校验使用银行侧的同一个默认值；最终生效 TTL 由 `validateComposition` 再核对。 */
const DEFAULT_TICKET_TTL_MS = DEFAULT_BANK_TOOLS.ticketTtlSeconds * 1_000

/**
 * 定时窗口在 `dueAt` 之后还允许补跑多久（ms）。
 *
 * 为什么要有宽限：到期那一刻进程可能没在跑（关机 / 重启），补跑是既有能力；
 * 但"补跑"必须有个尽头——过了宽限就不再自动扣款，让用户重新安排。
 * 它同时是**红级预授权的有效期上界**：`verifiedAt` 只在这段窗口内算数。
 */
const WINDOW_GRACE_MS = 24 * 60 * 60 * 1_000

/**
 * 到期前提醒的缺省提前量：24 小时（提示词 4-2）。
 *
 * 24h 是"还来得及改主意"的最小量级：更短会让用户在夜里收到提醒，更长会把
 * 提前几天的计划提前一周就吵。`0` = 关闭（配置项 `dueSoonLeadMs`）。
 */
const DEFAULT_DUE_SOON_LEAD_MS = 24 * 60 * 60 * 1_000

/**
 * 调度预算的缺省值。
 *
 * **不取 120_000**（方案 §4.3 骨架里的数）：那正好等于票据 TTL，
 * 会被下面的 "< TTL" 判定直接拒掉——默认值必须自己先站得住。
 */
const DEFAULT_PLAN_TIMEOUT_MS = 30_000

/**
 * 同一节点允许的失败次数。
 *
 * 3 = 1 次原始运行 + 2 次 `resume` 重试。取 3 而不是 5：银行侧"同一笔第三次要复核"是常见口径，
 * 而这里能做的只是"到点就停"，复核仍在审批面。
 */
const DEFAULT_MAX_NODE_ATTEMPTS = 3

const WHERE = 'plan:dag'

/** 模型可见的计划工具名（B1）。 */
export const PLAN_PROPOSE_TOOL = 'plan_propose'
export const PLAN_EXECUTE_TOOL = 'plan_execute'

/** 模型可见的计划工具（只读目录；评测/文档用它断言"模型看得到什么"）。 */
export const MODEL_PLAN_TOOL_NAMES: readonly string[] = [PLAN_PROPOSE_TOOL, PLAN_EXECUTE_TOOL]

/** 模型计划的节点数缺省上限（比 `maxNodes` 更紧，见 `PlanSettings.modelMaxNodes`）。 */
const DEFAULT_MODEL_MAX_NODES = 8

/** 一条模型计划的结构问题（与 `PlanIssue` 同形，但多一个"工具不在银行目录"的宿主级码）。 */
interface ModelPlanIssue {
  readonly code: string
  readonly message: string
  readonly nodeId?: string
  readonly tool?: string
}

/** 结构解析结果：有 `plan` 才继续跑 `validatePlan`。 */
interface ParsedModelPlan {
  readonly plan?: Plan
  readonly issues: readonly ModelPlanIssue[]
}

/** 普通对象（不是数组 / null）。 */
function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * 把模型给的 JSON 解析成 `Plan`（结构层），**同时执行 B1 的两条额外约束**：
 *
 * 1. 节点工具只能取 `BANK_TOOL_NAME_SET`（模型不能用 DAG 间接调用 `plan_execute` 自己，
 *    也不能借此触达非银行工具）；
 * 2. 节点数 ≤ `modelMaxNodes`（执行器上限仍是 `maxNodes`）。
 *
 * 为什么不在 `validatePlan` 里加这两条：那是纯引擎的规则，面对的是"任何调用方"；
 * 这两条是**模型入口**的策略，只有宿主知道 `BANK_TOOL_NAME_SET`。规则放对层，
 * 引擎的单测与快照就不会因为多一个业务约束而全部漂移。
 */
function parseModelPlan(args: unknown, fallbackPlanId: string, maxNodes: number): ParsedModelPlan {
  if (!isRecord(args)) {
    return { issues: [{ code: 'plan-args-invalid', message: 'plan 参数必须是对象' }] }
  }

  const rawNodes = args['nodes']
  if (!Array.isArray(rawNodes) || rawNodes.length === 0) {
    return { issues: [{ code: 'plan-empty', message: '计划至少要有一个节点（nodes 不能为空）' }] }
  }

  const issues: ModelPlanIssue[] = []
  if (rawNodes.length > maxNodes) {
    issues.push({
      code: 'plan-too-large',
      message: `模型计划最多 ${String(maxNodes)} 个节点，本次给了 ${String(rawNodes.length)} 个`,
    })
  }

  const nodes: PlanNode[] = []
  for (const [index, raw] of rawNodes.entries()) {
    if (!isRecord(raw)) {
      issues.push({ code: 'plan-args-invalid', message: `第 ${String(index + 1)} 个节点必须是对象` })
      continue
    }
    const id = raw['id']
    if (typeof id !== 'string' || !PLAN_NODE_ID_PATTERN.test(id)) {
      issues.push({
        code: 'plan-node-id',
        message: `第 ${String(index + 1)} 个节点的 id 必须是 [A-Za-z0-9_-]{1,64}`,
      })
      continue
    }
    const tool = raw['tool']
    if (typeof tool !== 'string' || tool.length === 0) {
      issues.push({ code: 'plan-tool-missing', message: `节点 ${id} 缺少 tool`, nodeId: id })
      continue
    }
    if (!BANK_TOOL_NAME_SET.has(tool)) {
      issues.push({
        code: 'plan-tool-not-allowed',
        message: `节点 ${id} 的工具 ${tool} 不在银行工具目录内（模型计划只允许 BANK_TOOL_NAME_SET）`,
        nodeId: id,
        tool,
      })
      continue
    }

    const argsRaw = raw['args'] ?? {}
    if (!isRecord(argsRaw)) {
      issues.push({ code: 'plan-args-invalid', message: `节点 ${id} 的 args 必须是对象`, nodeId: id })
      continue
    }
    const depsRaw = raw['deps'] ?? []
    if (!Array.isArray(depsRaw) || depsRaw.some((dep) => typeof dep !== 'string')) {
      issues.push({
        code: 'plan-dep-missing',
        message: `节点 ${id} 的 deps 必须是字符串数组`,
        nodeId: id,
      })
      continue
    }
    const optional = raw['optional']
    if (optional !== undefined && typeof optional !== 'boolean') {
      issues.push({ code: 'plan-args-invalid', message: `节点 ${id} 的 optional 必须是布尔`, nodeId: id })
      continue
    }
    const idempotencyKey = raw['idempotencyKey']
    if (idempotencyKey !== undefined && typeof idempotencyKey !== 'string') {
      issues.push({
        code: 'plan-args-invalid',
        message: `节点 ${id} 的 idempotencyKey 必须是字符串`,
        nodeId: id,
      })
      continue
    }

    nodes.push({
      id,
      tool,
      args: argsRaw,
      deps: depsRaw as readonly string[],
      ...(optional === undefined ? {} : { optional }),
      ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
    })
  }

  const planIdRaw = args['planId']
  if (planIdRaw !== undefined && (typeof planIdRaw !== 'string' || planIdRaw.trim().length === 0)) {
    issues.push({ code: 'plan-id-invalid', message: 'planId 必须是非空字符串' })
  }
  if (issues.length > 0) return { issues }

  const planId = typeof planIdRaw === 'string' ? planIdRaw.trim() : fallbackPlanId
  const metaRaw = args['meta']
  let meta: { title?: string } | undefined
  if (isRecord(metaRaw)) {
    const title = metaRaw['title']
    if (typeof title === 'string' && title.length > 0) meta = { title }
  }
  return {
    plan: { planId, nodes, ...(meta === undefined ? {} : { meta }) },
    issues,
  }
}

/** `plan_propose` 的返回（给模型看的最小摘要）。 */
export interface PlanProposalResult {
  readonly planId: string
  readonly digest: string
  readonly total: number
  /** 拓扑序（同层按 id 字典序），让模型能讲清"先做什么后做什么"。 */
  readonly order: readonly string[]
}

/** `plan_execute` 的返回：摘要 + 节点终态（不含 args / 金额）。 */
export interface PlanExecutedResult {
  readonly planId: string
  readonly status: PlanRunSummary['status']
  readonly total: number
  readonly succeeded: number
  readonly failed: number
  readonly blocked: number
  readonly skipped: number
  readonly cancelled: number
  readonly durationMs: number
  readonly nodes: readonly {
    readonly nodeId: string
    readonly tool: string
    readonly state: string
    readonly code?: string
  }[]
}

/**
 * `bah:plan` 服务键。
 *
 * 命名与 `runtime:*` 族不一致是**有意的**（方案 §7.2 第 3 条已在 README 登记）：
 * `runtime:` 是基础面（会话/工具/管线），`bah:` 是业务编排面。
 * 若要统一改成 `runtime:plan`，必须与 `inject` 逐字一致，否则等待队列永远等不到。
 */
export const PLAN_SERVICE = defineService<PlanApi>('bah:plan')

/** 一次唤醒里单个计划的结局。 */
export interface PlanWakeEntry {
  readonly planId: string
  readonly windowId: string
  readonly occurrence: string
  readonly key: string
  readonly status: 'executed' | 'skipped' | 'downgraded' | 'failed'
  /** `skipped` 的理由（`already-ran` / `dry-run`）或 `failed` 的理由码。 */
  readonly reason?: string
  /** 窗口判决摘要（成立的与失守的都带；回放据此重算）。 */
  readonly digest?: string
  /**
   * 判决输入（`WindowVerdictInputs` 原样）。
   *
   * 只有 digest 不够："摘要对得上"证明不了"当时余额是多少"。把输入一起落进
   * `tool/result`，任何人事后都能用同一份快照重跑 `checkWindow`（门禁 I13）。
   */
  readonly inputs?: WindowVerdictInputs
  /** 失守码（`window-expired` / `condition-failed` / `plan-cancelled` / `window-clock-ahead`）。 */
  readonly code?: string
  /** 失守条件明细（`expected` / `actual`）。 */
  readonly failed?: readonly { readonly kind: string; readonly expected: string; readonly actual: string }[]
  /** 商户腿结果（计划带 `merchant` 且银行腿成功时存在）。 */
  readonly merchant?: MerchantFulfilment
  /**
   * 补偿记录（ADR-0013）：商户腿在扣款后失败时，对银行腿的冲正结果。
   * `reversed` 才代表"钱回来了"；其余两种都是如实报"没退成"。
   */
  readonly compensation?: PlanCompensation
  /** 执行摘要（`executed` 时存在）。 */
  readonly summary?: {
    readonly status: string
    readonly succeeded: number
    readonly failed: number
    readonly blocked: number
    readonly durationMs: number
  }
}

/** 补偿记录（ADR-0013）。`reversed` = 银行腿已冲正；其余两种如实报失败。 */
export interface PlanCompensation {
  readonly kind: 'reversed' | 'reversal-failed' | 'reversal-unavailable'
  readonly txnId?: string
  readonly reversalTxnId?: string
  readonly amountCents?: number
  readonly code?: string
}

/** 唤醒报告（工具出参 / CLI 输出 / 调度日志共用一份形状）。 */
export interface PlanWakeReport {
  readonly at: number
  readonly now: number
  readonly source: PlanWakeSource
  readonly ok: boolean
  readonly code?: string
  readonly entries: readonly PlanWakeEntry[]
  /**
   * 应用内播报建议（**不投递**：本版本没有 IM 通道）。
   * 计数来自进程内历史，非 durable——诚实边界写在这里。
   */
  readonly notified: readonly {
    readonly key: string
    readonly send: boolean
    readonly channel: string
    readonly reason: string
    /**
     * 可读回执（提示词 4-2）：三类失守各有一句话，其它情形省略。
     *
     * 文案由 `planNoticeText()` 从窗口自己的 durable 字段（标题 / 到期 / 有效期 / 失守明细）
     * 渲染，**不接受任何自由文本**——它是给用户看的原因，不是第二份事实源。
     */
    readonly text?: string
  }[]
}

/** 唤醒的触发来源（进报告，不进事件）。 */
export type PlanWakeSource = 'tool' | 'boot' | 'tick' | 'cli'

/** 唤醒执行器（调度器 / CLI / `plan_wake` 工具共用的唯一入口）。 */
export interface PlanWakeRunner {
  wake(input?: {
    readonly at?: number
    readonly planId?: string
    readonly dryRun?: boolean
    readonly source?: PlanWakeSource
  }): Promise<PlanWakeReport>
}

/** 服务键：`bah:plan-wake`（调度器与 CLI 都从它取）。 */
export const PLAN_WAKE_SERVICE = defineService<PlanWakeRunner>('bah:plan-wake')

/** 服务键：`bah:plan-armed`（只读视图；计划卡与 CLI `list` 用）。 */
export interface ArmedPlansView {
  readonly list: () => readonly ArmedPlan[]
}

export const PLAN_ARMED_SERVICE = defineService<ArmedPlansView>('bah:plan-armed')

/** 内容摘要（审计只认摘要，不认原文——金额与收款人不得进日志）。 */function digestOf(payload: unknown): string {
  try {
    return sha256Hex(canonicalJson(payload))
  } catch {
    // 渲染层给回来的内容理论上都 JSON 安全；真出意外也不能让"结果摘要"把节点判失败。
    // 不可达（`ContentBlock[]` 恒可 canonical 化），故整块不计入覆盖率。
    /* v8 ignore next 3 */
    return sha256Hex(String(payload))
  }
}

/**
 * `offerId` → 报价事实（**只读查价**）。
 *
 * 用 `MerchantService.offer()` 而不是 `search()`：`search` 会把 offer 写进
 * "本会话搜过"的引用闭包，等于顺手把一个没搜过的商户变成可下单（那是安全边界）。
 *
 * 武装时存下来的 `priceCents` / `merchantName` **优先**（ADR-0013）：那样明细摘要
 * 锚定用户当时看到的价格；唤醒时商户涨价由 `price-changed` 单独处理，
 * 不会被 `detailsMismatch` 提前说成"明细被改"。
 */
function offerFactsOf(
  service: MerchantService | undefined,
  merchant: { readonly offerId: string; readonly merchantName?: string; readonly priceCents?: number } | undefined,
): OfferFacts | undefined {
  if (merchant === undefined) return undefined
  if (merchant.priceCents !== undefined && merchant.merchantName !== undefined) {
    return {
      offerId: merchant.offerId,
      merchantName: merchant.merchantName,
      priceCents: merchant.priceCents,
    }
  }
  const offer = service?.offer(merchant.offerId)
  if (offer === undefined) return undefined
  return { offerId: offer.offerId, merchantName: offer.merchantName, priceCents: offer.priceCents }
}

/** 计划节点 → 明细里的"腿"（金额只认静态数字；动态 args 不猜）。 */
function legsOf(
  nodes: readonly {
    readonly id: string
    readonly tool: string
    readonly args: Readonly<Record<string, unknown>>
  }[],
): readonly PlanLegFacts[] {
  return nodes.map((node) => {
    const amount = node.args['amount']
    const payeeRaw = node.args['payee']
    const payeeName =
      typeof payeeRaw === 'object' &&
      payeeRaw !== null &&
      !Array.isArray(payeeRaw) &&
      typeof (payeeRaw as Readonly<Record<string, unknown>>)['name'] === 'string'
        ? String((payeeRaw as Readonly<Record<string, unknown>>)['name'])
        : undefined
    return {
      nodeId: node.id,
      tool: node.tool,
      ...(typeof amount === 'number' && Number.isFinite(amount) && amount > 0
        ? { amountCents: yuanToCents(amount) }
        : {}),
      ...(payeeName === undefined ? {} : { payee: payeeName }),
    }
  })
}

/** 武装后的窗口 → 明细事实（`detailsDigest` 的唯一输入；唤醒复验也用这一份）。 */
function armFactsOf(merchant: MerchantService | undefined, armed: ArmedPlan): ArmFacts {
  const offer = offerFactsOf(merchant, armed.merchant)
  return {
    title: armed.title,
    budgetCents: armed.budgetCents,
    dueAt: armed.dueAt,
    tier: armed.tier,
    conditions: armed.conditions,
    ...(offer === undefined ? {} : { offer }),
    legs: legsOf(armed.plan.nodes),
  }
}

/**
 * 唤醒复验：明细摘要对不上就返回重算值（`undefined` = 对得上 / 无摘要）。
 *
 * 无摘要（旧回放数据）不拦：那时审批卡本来就没有明细，
 * "没有背书"与"背书被改"是两件事，混为一谈会让升级变成全量停摆。
 */
function detailsMismatch(
  merchant: MerchantService | undefined,
  item: ArmedPlan,
): string | undefined {
  if (item.detailsDigest === undefined) return undefined
  const actual = detailsDigestOf(renderArmDetails(armFactsOf(merchant, item)))
  return actual === item.detailsDigest ? undefined : actual
}

/**
 * 计划里的转账总额（分）——"不擅自加价"的硬校验。
 *
 * 只累加**静态**金额（`transfer_create` 节点上的数字 `amount`）。动态 args
 * （`${node.<id>.<path>}`）在 v1 里算不出，会漏算——这条限制登记在已知风险里，
 * 不假装它能覆盖：宁可少算后如实说，也不要为了"看起来完整"编一个数。
 */
function staticSpendCents(plan: Plan): number {
  let total = 0
  for (const node of plan.nodes) {
    if (node.tool !== 'transfer_create') continue
    const amount = node.args['amount']
    if (typeof amount === 'number' && Number.isFinite(amount) && amount > 0) {
      total += yuanToCents(amount)
    }
  }
  return total
}

/**
 * 父预算守卫（纯函数；ADR-0013）。
 *
 * `used + leg > parentBudget` 即"父预算耗尽"。抽成纯函数是为了能单独穷举边界
 * （等号算通过、超 1 分算拒），不用先造一个"三腿预算之和小于父预算"的畸形窗口
 * ——在 `birthday_plan` 的算术下，三腿预算之和恒等于父预算，边界只能靠单测钉。
 */
export function parentBudgetAllows(
  parentBudgetCents: number,
  usedCents: number,
  legCents: number,
): boolean {
  return usedCents + legCents <= parentBudgetCents
}

/**
 * 同一父计划下**已成功腿**的累计金额（分；从 `plan/completed` 事件派生）。
 *
 * 不另建账本：`plan/completed` 本来就是"这次 run 的终态"；只认 `status='succeeded'`
 * 且落在本窗口武装之后的 run。父预算耗尽时后续腿会被跳过（`budget-exhausted`）。
 */
function parentSpentCents(
  events: readonly AnySessionEvent[],
  legs: readonly ArmedPlan[],
  parentPlanId: string,
): number {
  let total = 0
  for (const leg of legs) {
    if (leg.parentPlanId !== parentPlanId) continue
    const succeeded = events.some((event) => {
      if (String(event.type) !== 'plan/completed') return false
      const data = event.data as Readonly<Record<string, unknown>>
      return (
        data['planId'] === leg.planId &&
        data['status'] === 'succeeded' &&
        typeof data['at'] === 'number' &&
        data['at'] >= leg.armedAt
      )
    })
    if (succeeded) total += staticSpendCents(leg.plan)
  }
  return total
}

/**
 * 本次 run 新落的银行转账流水号（冲正用的幂等键）。
 *
 * 只认 `transfer/created` 领域事件（`result.txnId` 是结构化字段），
 * 不解析 `tool/result` 的展示文案——文案改一个标点就会让补偿失效。
 */
function lastTransferTxnId(
  events: readonly AnySessionEvent[],
  fromIndex: number,
): string | undefined {
  for (let index = events.length - 1; index >= fromIndex; index -= 1) {
    const event = events[index]
    if (event === undefined || String(event.type) !== 'transfer/created') continue
    const data = event.data as Readonly<Record<string, unknown>>
    const result = data['result']
    if (typeof result !== 'object' || result === null) continue
    const txnId = (result as Readonly<Record<string, unknown>>)['txnId']
    if (typeof txnId === 'string' && txnId.length > 0) return txnId
  }
  return undefined
}

/**
 * 唤醒失守 → 给用户的可读回执（提示词 4-2）。
 *
 * 三类各一句话，输入只来自窗口的 durable 事实（title / dueAt / expiresAt / failed 明细），
 * 不拼任何自由文本。认不出的码返回 `undefined`（不编"已转人工"这类没发生的事）。
 */
export function planNoticeText(input: {
  readonly code: string | undefined
  readonly title: string
  readonly dueAt: number
  readonly expiresAt?: number
  readonly failed?: readonly {
    readonly kind: string
    readonly expected: string
    readonly actual: string
  }[]
}): string | undefined {
  const title = input.title.trim()
  switch (input.code) {
    case 'window-expired': {
      const until = new Date(input.expiresAt ?? input.dueAt).toISOString()
      return `计划《${title}》已过期未执行（有效期至 ${until}），未扣款`
    }
    case 'details-changed':
      return `计划《${title}》的明细与批准时不一致（摘要变化），已转人工确认，未扣款`
    case 'condition-failed': {
      const first = input.failed?.[0]
      const why =
        first === undefined
          ? '条件已变化'
          : `${first.kind} 期望 ${first.expected}，实际 ${first.actual}`
      return `计划《${title}》的条件不满足（${why}），本次未执行`
    }
    default:
      return undefined
  }
}

/**
 * 定时转账「当日额度」的取数（提示词 4-1）：探针缺席 / 身份缺席 / 探针抛错都返回 `undefined`。
 *
 * 为什么单独抽出来：这条降级链是审批卡"两行整条省略"的唯一入口，
 * 必须能在不装配银行插件的前提下单测——否则只能靠端到端碰运气。
 */
export async function transferUsageOf(
  probe: TransferProbe | undefined,
  userId: string | undefined,
  amountYuan: number,
  payeeName: string,
): Promise<TransferProbeUsage | undefined> {
  if (probe === undefined || userId === undefined) return undefined
  try {
    return await probe.preview(userId, amountYuan, payeeName)
  } catch {
    // 探针自己炸了也只丢这两行，**不连累**金额/收款人/时刻（展示面不许抢戏）
    return undefined
  }
}

/** 解析 ISO 时刻（`plan_arm` 的 `dueAt` / `expiresAt`）。 */
function parseIsoTime(value: unknown, field: string): number {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new BahError('plan-arm-invalid', `授权窗口的 ${field} 必须是 ISO 时间字符串`, { field })
  }
  const parsed = Date.parse(value)
  if (!Number.isFinite(parsed)) {
    throw new BahError('plan-arm-invalid', `授权窗口的 ${field} 不是合法时间：${value}`, { field })
  }
  return parsed
}

/** 生日计划的元金额：未给用缺省，给了必须是正数。 */
function readPositiveYuan(value: unknown, fallback: number, field: string): number {
  if (value === undefined) return fallback
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new BahError('birthday-plan-invalid', `${field} 必须是正数（元）`, { value })
  }
  return value
}

/**
 * 生日计划「锁定预算」那笔的收款人：本人锁定账户。
 *
 * 演示环境的账户尾号由 forge 造数写死（`6222 0202 0000 9012`，账户类型 `locked`），
 * 所以这里是一个**单点常量**：明细文案与计划节点共用同一份事实，不在两处各写一遍。
 * 接真实核心后应改成从账户列表读（`listAccounts`），不要继续写死。
 */
const LOCK_ACCOUNT_PAYEE = '锁定账户(9012)'

/**
 * 生日计划的自然日期解析（只认演示语料：下个月N号 / N月N号 / ISO 日期）。
 *
 * 返回生日当天 UTC 00:00 与"生日前 2 天 09:00"的到期时刻；不读系统时钟。
 */
function parseBirthdayDate(  value: unknown,
  now: number,
): { readonly birthdayAt: number; readonly dueAt: number } {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new BahError('birthday-plan-invalid', 'birthday_plan.birthday 必须是非空字符串', {})
  }
  const text = value.trim()
  const base = new Date(now)
  const year = base.getUTCFullYear()
  const month = base.getUTCMonth()
  const day = base.getUTCDate()

  const daysInMonth = (y: number, m: number): number => new Date(Date.UTC(y, m + 1, 0)).getUTCDate()

  let birthdayAt: number
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(text)
  const monthName = /(\d{1,2})\s*月\s*(\d{1,2})\s*[号日]/.exec(text)
  const nextMonth = /下个?月\s*(\d{1,2})\s*[号日]/.exec(text)
  const bareDay = /(\d{1,2})\s*[号日]/.exec(text)

  if (iso !== null) {
    const y = Number(iso[1])
    const m = Number(iso[2]) - 1
    const d = Number(iso[3])
    if (m < 0 || m > 11 || d < 1 || d > daysInMonth(y, m)) {
      throw new BahError('birthday-plan-invalid', `生日日期非法：${text}`, { birthday: text })
    }
    birthdayAt = Date.UTC(y, m, d)
  } else if (monthName !== null) {
    const m = Number(monthName[1]) - 1
    const d = Number(monthName[2])
    if (m < 0 || m > 11 || d < 1 || d > daysInMonth(year, m)) {
      throw new BahError('birthday-plan-invalid', `生日日期非法：${text}`, { birthday: text })
    }
    birthdayAt = Date.UTC(year, m, d)
    if (birthdayAt <= now) birthdayAt = Date.UTC(year + 1, m, d)
  } else if (nextMonth !== null) {
    const d = Number(nextMonth[1])
    const m = month + 1
    const y = year + Math.floor(m / 12)
    const normalizedMonth = m % 12
    if (d < 1 || d > daysInMonth(y, normalizedMonth)) {
      throw new BahError('birthday-plan-invalid', `生日日期非法：${text}`, { birthday: text })
    }
    birthdayAt = Date.UTC(y, normalizedMonth, d)
  } else if (bareDay !== null) {
    const d = Number(bareDay[1])
    const m = d > day ? month : month + 1
    const y = year + Math.floor(m / 12)
    const normalizedMonth = m % 12
    if (d < 1 || d > daysInMonth(y, normalizedMonth)) {
      throw new BahError('birthday-plan-invalid', `生日日期非法：${text}`, { birthday: text })
    }
    birthdayAt = Date.UTC(y, normalizedMonth, d)
  } else {
    throw new BahError(
      'birthday-plan-invalid',
      `生日日期只认 ISO / N月N号 / 下个月N号：${text}`,
      { birthday: text },
    )
  }

  const dueAt = birthdayAt - 2 * 86_400_000 + 9 * 3_600_000
  if (dueAt <= now) {
    throw new BahError('birthday-plan-invalid', '生日前 2 天已经过去，不能再排自动计划', {
      birthdayAt,
      dueAt,
      now,
    })
  }
  return { birthdayAt, dueAt }
}

/**
 * 定时转账的自然时间解析（只认演示会用到的时间词）。
 *
 * 只做 UTC 日历运算，不读系统时钟：`now` 由宿主注入，回放/测试可完全复现。
 * 认不出就 fail-loud，绝不猜一个"明天"。
 */
function parseScheduleWhen(value: unknown, now: number): number {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new BahError('transfer-schedule-invalid', '定时转账的 when 必须是非空字符串', {})
  }
  const text = value.trim()
  const iso = Date.parse(text)
  if (Number.isFinite(iso)) {
    if (iso <= now) {
      throw new BahError('transfer-schedule-invalid', '定时转账时间必须晚于当前时刻', {
        dueAt: iso,
        now,
      })
    }
    return iso
  }

  const base = new Date(now)
  const atTime = (dayOffset: number, hour = 9, minute = 0): number =>
    Date.UTC(
      base.getUTCFullYear(),
      base.getUTCMonth(),
      base.getUTCDate() + dayOffset,
      hour,
      minute,
    )

  const day = /^(今天|明天|后天)\s*(?:(\d{1,2})[:：](\d{2}))?$/.exec(text)
  if (day !== null) {
    const offset = day[1] === '今天' ? 0 : day[1] === '明天' ? 1 : 2
    const hour = day[2] === undefined ? 9 : Number(day[2])
    const minute = day[3] === undefined ? 0 : Number(day[3])
    if (hour > 23 || minute > 59) {
      throw new BahError('transfer-schedule-invalid', `定时转账时间非法：${text}`, { when: text })
    }
    const dueAt = atTime(offset, hour, minute)
    if (dueAt <= now) {
      throw new BahError('transfer-schedule-invalid', '定时转账时间必须晚于当前时刻', {
        dueAt,
        now,
      })
    }
    return dueAt
  }

  const week = /^下周([一二三四五六日天])\s*(?:(\d{1,2})[:：](\d{2}))?$/.exec(text)
  if (week !== null) {
    const weekday = '一二三四五六日'.indexOf(week[1]!)
    const target = weekday === -1 ? 6 : weekday
    const current = (base.getUTCDay() + 6) % 7
    const offset = 7 - current + target
    const hour = week[2] === undefined ? 9 : Number(week[2])
    const minute = week[3] === undefined ? 0 : Number(week[3])
    if (hour > 23 || minute > 59) {
      throw new BahError('transfer-schedule-invalid', `定时转账时间非法：${text}`, { when: text })
    }
    return atTime(offset, hour, minute)
  }

  /**
   * `下个月 8 号` / `3 月 8 号`（可带 HH:mm）。
   *
   * WHY 补这两种：生日/纪念日是**按月份日期**说的，`明天/下周X` 覆盖不到；
   * 缺了它们，模型只能把"下个月 8 号转 200"降级成"现在转"——语义与资金时点都会错。
   * 日期非法（如 2 月 30 号）或已过一律 fail-loud，不悄悄顺延。
   */
  const nextMonthDay = /^下个月\s*(\d{1,2})\s*[号日]\s*(?:(\d{1,2})[:：](\d{2}))?$/.exec(text)
  if (nextMonthDay !== null) {
    const day = Number(nextMonthDay[1])
    const hour = nextMonthDay[2] === undefined ? 9 : Number(nextMonthDay[2])
    const minute = nextMonthDay[3] === undefined ? 0 : Number(nextMonthDay[3])
    if (day < 1 || day > 31 || hour > 23 || minute > 59) {
      throw new BahError('transfer-schedule-invalid', `定时转账时间非法：${text}`, { when: text })
    }
    const dueAt = Date.UTC(base.getUTCFullYear(), base.getUTCMonth() + 1, day, hour, minute)
    // 溢出检测：2 月 30 号会被 Date 归一化成 3 月 2 号，必须拒绝而不是悄悄改期。
    if (new Date(dueAt).getUTCDate() !== day) {
      throw new BahError('transfer-schedule-invalid', `定时转账日期不存在：${text}`, { when: text })
    }
    if (dueAt <= now) {
      throw new BahError('transfer-schedule-invalid', '定时转账时间必须晚于当前时刻', {
        dueAt,
        now,
      })
    }
    return dueAt
  }

  const monthDay = /^(\d{1,2})\s*月\s*(\d{1,2})\s*[号日]\s*(?:(\d{1,2})[:：](\d{2}))?$/.exec(text)
  if (monthDay !== null) {
    const month = Number(monthDay[1])
    const day = Number(monthDay[2])
    const hour = monthDay[3] === undefined ? 9 : Number(monthDay[3])
    const minute = monthDay[4] === undefined ? 0 : Number(monthDay[4])
    if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59) {
      throw new BahError('transfer-schedule-invalid', `定时转账时间非法：${text}`, { when: text })
    }
    const dueAt = Date.UTC(base.getUTCFullYear(), month - 1, day, hour, minute)
    if (new Date(dueAt).getUTCDate() !== day || new Date(dueAt).getUTCMonth() !== month - 1) {
      throw new BahError('transfer-schedule-invalid', `定时转账日期不存在：${text}`, { when: text })
    }
    if (dueAt <= now) {
      throw new BahError('transfer-schedule-invalid', '定时转账时间必须晚于当前时刻', {
        dueAt,
        now,
      })
    }
    return dueAt
  }

  throw new BahError(
    'transfer-schedule-invalid',
    `定时转账只认 ISO、今天/明天/后天、下周X、下个月N号、M月D号（可带 HH:mm）：${text}`,
    { when: text },
  )
}

/** 授权档（封闭联合；模型传别的值即拒）。 */
function parseTier(value: unknown): 'strict' | 'standard' | 'wide' {
  if (value === undefined) return 'standard'
  if (value === 'strict' || value === 'standard' || value === 'wide') return value
  throw new BahError('plan-arm-invalid', `授权档必须是 strict / standard / wide：${String(value)}`, {})
}

/** 预算（模型传元，落账一律分）。 */
function parseBudgetYuan(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new BahError('plan-arm-invalid', '授权窗口预算必须是正数（元）', {})
  }
  return yuanToCents(value)
}

/** 周期规则：`once` 用 `dueAt`，其余要求 `at: 'HH:mm'`。 */
function parseRecurrence(raw: unknown, dueAt: number): Recurrence {
  if (raw === undefined) return { every: 'once', dueAt }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new BahError('plan-arm-invalid', 'recurrence 必须是对象', {})
  }
  const record = raw as Readonly<Record<string, unknown>>
  const every = record['every']
  if (every === 'once') return { every: 'once', dueAt }
  const at = record['at']
  if (typeof at !== 'string') {
    throw new BahError('plan-arm-invalid', '周期计划必须给 at（HH:mm）', {})
  }
  switch (every) {
    case 'daily':
      return { every: 'daily', at }
    case 'monthly': {
      const day = record['day']
      if (typeof day !== 'number' || day < 1 || day > 31) {
        throw new BahError('plan-arm-invalid', 'monthly 计划必须给 day（1–31）', {})
      }
      return { every: 'monthly', day, at }
    }
    case 'yearly': {
      const month = record['month']
      const day = record['day']
      if (typeof month !== 'number' || month < 1 || month > 12) {
        throw new BahError('plan-arm-invalid', 'yearly 计划必须给 month（1–12）', {})
      }
      if (typeof day !== 'number' || day < 1 || day > 31) {
        throw new BahError('plan-arm-invalid', 'yearly 计划必须给 day（1–31）', {})
      }
      return { every: 'yearly', month, day, at }
    }
    default:
      throw new BahError('plan-arm-invalid', `未知的周期规则：${String(every)}`, {})
  }
}

/** 条件列表（逐条收窄；未知种类即拒）。 */
function parseConditions(raw: unknown): readonly WindowCondition[] {
  if (raw === undefined) return []
  if (!Array.isArray(raw)) {
    throw new BahError('plan-arm-invalid', 'conditions 必须是数组', {})
  }
  const conditions: WindowCondition[] = []
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw new BahError('plan-arm-invalid', 'conditions 的每一项必须是对象', {})
    }
    const record = entry as Readonly<Record<string, unknown>>
    switch (record['kind']) {
      case 'balance-at-least': {
        const cents = record['cents']
        if (typeof cents !== 'number' || !Number.isInteger(cents) || cents < 0) {
          throw new BahError('plan-arm-invalid', 'balance-at-least 需要整数 cents', {})
        }
        conditions.push({ kind: 'balance-at-least', cents })
        break
      }
      case 'fact-unchanged': {
        const factId = record['factId']
        const version = record['version']
        if (typeof factId !== 'string' || typeof version !== 'number') {
          throw new BahError('plan-arm-invalid', 'fact-unchanged 需要 factId 与 version', {})
        }
        conditions.push({ kind: 'fact-unchanged', factId, version })
        break
      }
      case 'plan-not-cancelled': {
        const planId = record['planId']
        if (typeof planId !== 'string') {
          throw new BahError('plan-arm-invalid', 'plan-not-cancelled 需要 planId', {})
        }
        conditions.push({ kind: 'plan-not-cancelled', planId })
        break
      }
      case 'amount-within': {
        const cents = record['cents']
        if (typeof cents !== 'number' || !Number.isInteger(cents) || cents < 0) {
          throw new BahError('plan-arm-invalid', 'amount-within 需要整数 cents', {})
        }
        conditions.push({ kind: 'amount-within', cents })
        break
      }
      case 'address-unchanged': {
        const addressId = record['addressId']
        const version = record['version']
        if (typeof addressId !== 'string' || typeof version !== 'number') {
          throw new BahError('plan-arm-invalid', 'address-unchanged 需要 addressId 与 version', {})
        }
        conditions.push({ kind: 'address-unchanged', addressId, version })
        break
      }
      default:
        throw new BahError('plan-arm-invalid', `未知的条件种类：${String(record['kind'])}`, {})
    }
  }
  return conditions
}

export const planPlugin: HostPlugin<PlanSettings> = {
  id: 'plan:dag',

  plugin: {
    name: 'plan:dag',
    apply(ctx, settings) {
      if (!settings.enabled) return

      // 懒解析（同 saga-bridge）：apply 期硬取会把"行顺序"变成隐性契约
      const registry = (): ToolRegistry => ctx.get(TOOLS_SERVICE)

      /**
       * 时钟一律取 `bah:run` 的注入钟，**不用 `Date.now()`**。
       *
       * 两个理由：① 与主循环同一时间轴，`tool/call` 与 `plan/node-started` 的 `at` 才可比；
       * ② 快照回放要"逐字节相等"，任何一处漏用真实时钟都会让它变成不可复现的断言。
       */
      const clock = (): number => ctx.get(RUN_SERVICE).now()

      /** 每 run 一个 guard：同 plan 内同名同参的 deny 单调生效，跨 plan 不串味。 */
      const runGuards = new Map<string, ToolGuard>()
      // 必须清：长跑进程里每个 plan 泄漏一个 Map，一天下来就是内存增长
      ctx.effect(() => {
        runGuards.clear()
      })

      // 领域事件走 `appendDomain`：plan 是可选项，旧 reader 跳过它不影响对话重建
      const emit = (type: PlanEventType, data: unknown): void => {
        ctx.get(SESSION_SERVICE).appendDomain(type, data)
      }

      /**
       * 引擎对宿主的唯一依赖。
       *
       * 只读 `result.isError`，**绝不 try/catch 判失败**：`ToolPipeline.execute()` 内部已把
       * 抛错归一化成 `isError`，它不抛。用 try/catch 判失败的代码永远走不到那条分支。
       */
      const invoker: PlanInvoker = async (node, ictx) => {
        const guard = runGuards.get(ictx.planId)
        /* v8 ignore start —— 不可达：guard 由 `api.run()` 在调用引擎前装配，
           绕过它直接调引擎没有公开入口。保留 fail-loud 而不是 `as ToolGuard`：
           真有人绕过去时，宁可炸也不能让节点在没有单调 guard 的管线上跑。 */
        if (guard === undefined) {
          throw new BahError('plan-guard-missing', `plan ${ictx.planId} 没有装配 guard`, {
            planId: ictx.planId,
          })
        }
        /* v8 ignore stop */
        const session = ctx.get(SESSION_SERVICE)
        const run = ctx.get(RUN_SERVICE)
        const pipeline = new ToolPipeline({
          ctx,
          registry: registry(),
          session,
          guard,
          sessionId: session.sessionId,
          now: run.now,
          signal: ictx.signal,
          // 授权窗口代签：整次 run 的每个节点审批都会带上它（ADR-0008）
          ...(runAuthorization.get(ictx.planId) === undefined
            ? {}
            : { authorization: runAuthorization.get(ictx.planId) }),
          // 验收面（快照回放）注入确定性票号；生产不传，仍走随机 UUID
          ...(run.mintTicketId === undefined ? {} : { mintTicketId: run.mintTicketId }),
        })
        const execution = await pipeline.execute({
          callId: ictx.callId,
          name: node.tool,
          args: node.args,
        })
        const result = execution.result
        return {
          isError: result.isError,
          ...(result.code === undefined ? {} : { code: result.code }),
          summary: digestOf(result.content),
          // 动态 args 的取值源：**结构化原值**（`result.content` 是渲染投影，按字段取不到东西）
          ...(result.isError ? {} : { output: execution.value }),
          // 审批等待：管线用注入钟测好的数，引擎原样落 `plan/node-waiting`
          ...(execution.approvalWaitedMs === undefined
            ? {}
            : { waitedMs: execution.approvalWaitedMs }),
          // 外部不可用 → 引擎落 `incident`。闭集只有这一个码，**超时不许进来**：
          //   超时可能发生在扣款之后，而 `incident` 在 resume 里是自动重跑的（= 二次扣款后门）。
          ...(result.code === PLAN_INCIDENT_CODE ? { incident: true } : {}),
        }
      }

      // 声明顺序：engine 引用 invoker，必须在 invoker 之后（否则 TDZ）
      const engine = new PlanEngine({
        invoker,
        emit,
        now: clock,
        maxNodes: settings.maxNodes,
        maxEdges: settings.maxEdges,
        hasTool: (name) => registry().has(name),
        // 持久化决策是回调：dry-run 不进"已完成的 run 表"（引擎不知道 dryRun 是什么）
        shouldPersist: (state: PlanRunSnapshot) => state.dryRun !== true,
        // 续跑的唯一输入：会话事件（引擎不做跨进程持久化，也不猜"上次跑到哪"）
        history: () => ctx.get(SESSION_SERVICE).events(),
        maxNodeAttempts: settings.maxNodeAttempts,
      })

      // 下线时在跑的 plan 全部 abort（reason: 'disposed'）
      ctx.effect(() => engine.dispose())

      /** 模型入口的节点上限（`plan_arm` 与 `plan_execute` 共用同一条上限）。 */
      const modelPlanLimit = Math.min(settings.maxNodes, settings.modelMaxNodes)

      /** 把工具入参解析成合法 `Plan`（结构解析 + 引擎校验），失败即抛。 */
      const planFromArgs = (raw: unknown, callId: string): Plan => {
        const parsed = parseModelPlan(raw, `plan-${callId}`, modelPlanLimit)
        const issues =
          parsed.plan === undefined ? parsed.issues : [...parsed.issues, ...engine.validate(parsed.plan)]
        if (parsed.plan === undefined || issues.length > 0) {
          const first = issues[0]
          throw new BahError(
            'plan-invalid',
            `计划校验失败（${String(issues.length)} 项）：${first?.message ?? '未知问题'}`,
            { issues },
          )
        }
        return parsed.plan
      }

      /**
       * HALT 面（W07 §2.2）：惰性取，plan 可以在没有 `safety:sentry` 的装配里存在。
       */
      const haltOf = (): HaltHandle | undefined => {
        try {
          return ctx.get(HALT_SERVICE)
        } catch {
          return undefined
        }
      }

      /**
       * HALT 拦截（**宿主层**，不进入引擎）：ADR-0002 §4.2 定稿口径。
       *
       * - 引擎零改动（R-4 / TC-W07-09 diff=0）：它不 import safety，也不认识 `halted`；
       * - 不落任何 `plan/created` / `plan/resumed` / `plan/node-*`：计划根本没有开始调度，
       *   伪造 node-started 会让审计误以为节点跑过（宪法 §7.3）；
       * - 两个事件用 `appendDomain`（plan 域的既有纪律），`at` 取注入钟。
       *
       * ★ `run` 与 `resume` **共用**这一个函数：只包 `run` 的话，停机期间可以用 `resume`
       *   把计划续起来——这才是 HALT 面真正的洞（`resume` 不经过 `plan/created`，
       *   所以它连"HALT 只拦新建"这种辩解都不成立）。
       *
       * @returns `undefined` = 没停机，照常执行；否则是"计划没开始"的 aborted 回执
       */
      const haltedSummary = (plan: Plan, dryRun: boolean): PlanRunSummary | undefined => {
        const safety = haltOf()
        if (safety?.halted !== true) return undefined
        const at = clock()
        const total = plan.nodes.length
        emit('plan/completed', {
          planId: plan.planId,
          status: 'aborted',
          total,
          succeeded: 0,
          failed: 0,
          blocked: 0,
          skipped: 0,
          cancelled: total,
          durationMs: 0,
          at,
        })
        emit('plan/aborted', { planId: plan.planId, reason: 'halted', at })
        return {
          planId: plan.planId,
          digest: planDigest(plan),
          dryRun,
          status: 'aborted',
          total,
          succeeded: 0,
          failed: 0,
          blocked: 0,
          skipped: 0,
          cancelled: total,
          durationMs: 0,
        }
      }

      /**
       * 进引擎前的三件装配：单调 guard、调度预算定时器、`finally` 清理。
       *
       * `resume` 必须和 `run` 一样走这一道：少了它，续跑既没有 deny 的单调性
       * （同 plan 内同名同参的 deny 要一直生效），也没有 `planTimeoutMs` 上限——
       * 而 `planTimeoutMs < ticketTtlMs` 是 v1 唯一能防"拿过期票据扣款"的闸。
       *
       * ★ `finally` 里**只还回自己装的那把 guard**：单写者拒绝（`plan-already-running`）
       * 发生在引擎内部，那时新 guard 已经装上去了；无脑 delete 会把**正在跑**的那次 run
       * 的 guard 一起删掉，它的下一个节点就会撞 `plan-guard-missing`。
       */
      const withRunSlot = (
        planId: string,
        body: (signal: AbortSignal) => Promise<PlanRunSummary>,
      ): Promise<PlanRunSummary> => {
        const previous = runGuards.get(planId)
        const guard = new ToolGuard()
        runGuards.set(planId, guard)
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort('timeout'), settings.planTimeoutMs)
        timer.unref?.()
        return body(controller.signal).finally(() => {
          clearTimeout(timer)
          if (runGuards.get(planId) !== guard) return
          if (previous === undefined) runGuards.delete(planId)
          else runGuards.set(planId, previous)
        })
      }

      const api: PlanApi = {
        run(plan: Plan, options?: PlanApiRunOptions): Promise<PlanRunSummary> {
          const dryRun = options?.dryRun ?? settings.dryRunDefault

          const halted = haltedSummary(plan, dryRun)
          if (halted !== undefined) return Promise.resolve(halted)

          // 授权来源只在本 run 的生命周期内生效；结束必须还原（同 plan 可被重新武装）
          const previousAuth = runAuthorization.get(plan.planId)
          if (options?.authorization === undefined) runAuthorization.delete(plan.planId)
          else runAuthorization.set(plan.planId, options.authorization)

          return withRunSlot(plan.planId, (signal) =>
            engine.run(plan, {
              dryRun,
              signal,
              // 发起方一律取会话：`PlanApi.run` 不接受这个参数（方案 §5「额外一条」）
              initiator: ctx.get(SESSION_SERVICE).sessionId,
            }),
          ).finally(() => {
            if (previousAuth === undefined) runAuthorization.delete(plan.planId)
            else runAuthorization.set(plan.planId, previousAuth)
          })
        },

        resume(plan: Plan, options?: PlanResumeOptions): Promise<PlanRunSummary> {
          // 续跑没有 dry-run 分支：dry-run 不留档（`shouldPersist` 拦掉了），也就没有"上次结果"
          const halted = haltedSummary(plan, false)
          if (halted !== undefined) return Promise.resolve(halted)

          return withRunSlot(plan.planId, (signal) =>
            engine.resume(plan, {
              signal,
              initiator: ctx.get(SESSION_SERVICE).sessionId,
              ...(options?.from === undefined ? {} : { from: options.from }),
            }),
          )
        },

        cancel: (planId: string, reason?: PlanAbortReason) => engine.cancel(planId, reason),
        snapshot: (planId: string) => engine.snapshot(planId),
      }

      ctx.effect(ctx.provide(PLAN_SERVICE, api))

      /*
       * 04 单：goal / todo 平面（D5 表指定的落点 = plan 插件同族）。
       *
       * 两个工具都零新事件键：落账只有管线自动落的 `tool/call` + `tool/result`。
       * goal 的会话级 store 在进程内；因为结果已落账，重启后可用
       * `replayGoalStore(sessionEvents)` 重建（诚实边界，见 docs/mobile.md）。
       *
       * `originTurn` 的来源：`ToolExecContext` 不带 turn（core 契约面冻结），
       * 所以由插件按 `turn/start` 维护一个当前轮次，注入给工具。
       */
      const session = ctx.get(SESSION_SERVICE)
      let currentTurn = 0
      for (const event of session.events()) {
        if (event.type === 'turn/start') currentTurn = Math.max(currentTurn, event.data.turn)
      }
      ctx.effect(
        ctx.events.on('session/event', ({ event }) => {
          if (event.type === 'turn/start') currentTurn = event.data.turn
        }),
      )
      let goalSeq = 0
      const goalStore = createGoalStore({
        now: clock,
        nextId: () => {
          goalSeq += 1
          return `g-${String(goalSeq)}`
        },
      })
      ctx.effect(
        registry().register(
          createGoalSetTool(goalStore, { turnOf: () => currentTurn, toCents: yuanToCents }),
        ),
      )
      ctx.effect(registry().register(createTodoWriteTool({ now: clock })))

      /* ──────────────────────────────────────────────────────────────────────
       * G1/G2：授权窗口 + 到期唤醒（R2/R3）。
       *
       * 三条纪律：
       * 1. 零新事件键：武装 / 撤销 / 唤醒都只落 `tool/call` + `tool/result`；
       * 2. `plan_wake` **不进模型可见面**（`exposure:'internal'`）：模型若能调它，
       *    就能对任意未到期计划发起唤醒；
       * 3. 执行期无 LLM：唤醒的调用链只有纯函数 + `PlanApi.run`。
       * ────────────────────────────────────────────────────────────────────── */
      const armedStore = replayArmedPlans(session.events())

      /**
       * 商户服务（未装配的 profile 里不存在）。
       *
       * 明细、`detailsDigest` 与商户腿都要能"服务缺席时降级"：读不到报价就整条省略，
       * 而不是编一个价——审批卡上的数字只有一个来源。
       */
      const merchantOf = (): MerchantService | undefined => {
        try {
          return ctx.get(MERCHANT_SERVICE)
        } catch {
          return undefined
        }
      }

      /**
       * 转账预检探针（提示词 4-1）：`transfer_schedule` 的「当日已用 / 剩余」取数口。
       *
       * 未装配 `bank:tools` 的 profile 里不存在——这时明细**整条省略**，不写占位符。
       */
      const transferProbeOf = (): TransferProbe | undefined => {
        try {
          return ctx.get(BANK_TRANSFER_PROBE)
        } catch {
          return undefined
        }
      }

      /** 当前会话绑定的银行用户（未绑定 / 没有 bank 插件时 `undefined`）。 */
      const bankUserIdOf = (): string | undefined => {
        try {
          return ctx.get(BANK_IDENTITY).resolve(session.sessionId)
        } catch {
          return undefined
        }
      }

      /** 本次 run 的授权来源（按 planId 暂存；引擎的 invoker 只能从这里取到）。 */
      const runAuthorization = new Map<string, TicketAuthorization>()

      const factStoreOf = (): FactStore | undefined => {
        try {
          return ctx.get(FACT_SERVICE)
        } catch {
          return undefined
        }
      }

      /** 复验世界：余额 / 事实版本 / 取消集合。取不到的项按"缺失"处理（fail-closed）。 */
      const snapshotFor = async (item: ArmedPlan): Promise<WorldSnapshot> => {
        const needsBalance = item.conditions.some(
          (condition) => condition.kind === 'balance-at-least' || condition.kind === 'amount-within',
        )
        let balanceCents = 0
        if (needsBalance) {
          const userId = ctx.get(BANK_IDENTITY).resolve(session.sessionId)
          if (userId !== undefined) {
            balanceCents = await ctx.get(BANK_BALANCE_PROBE).availableCents(userId)
          }
        }
        return {
          now: clock(),
          balanceCents,
          factVersions: factStoreOf()?.versions() ?? {},
          cancelledPlans: armedStore
            .list()
            .filter((plan) => plan.state === 'cancelled')
            .map((plan) => plan.planId),
          // v1 没有地址账本：带 `address-unchanged` 条件的计划会以"缺失"失守（fail-closed）
          addressVersions: {},
        }
      }

      /** 播报历史（进程内；非 durable——诚实边界写在 `PlanWakeReport.notified` 的注释里）。 */
      const notifyHistory: NotifyHistoryItem[] = []

      /**
       * "同一窗口的同一种通知已经送达"账本（进程内；提示词 4-2）。
       *
       * 键 = `windowId#<种类>`：同一个窗口的同一种失守只提醒一次，别的窗口/别的种类互不影响。
       * 不 durable 是刻意的：重启后用户会再收到一次同类提醒（可接受的打扰），
       * 而"重启后永远不提醒"才是真正危险的那一边。`deriveNotify` 的预算仍叠在它之上。
       */
      const noticeSent = new Set<string>()

      /**
       * 连续几次"唤醒跑完但失败/阻断"就把窗口撤掉（ADR-0010 的熔断口径）。
       *
       * 为什么用**既有**的 `plan_disarm` 而不是新造锁定机制：撤销是账本上的一次状态转移
       * （`armed → cancelled`），`duePlans` 从此不再扫到它，`plan_disarm` 工具与运维命令
       * 看到的是同一份事实。再想自动执行必须由用户重新武装（= 重新做一次预授权）。
       *
       * 计数按窗口实例累计、成功即清零；进程重启后归零（诚实边界：这是运行期护栏，
       * 不是 durable 的"失败次数账本"）。
       */
      const windowFailures = new Map<string, number>()
      const DISARM_AFTER_FAILED_WAKES = 2

      /**
       * 唤醒标记账本（ADR-0010）。
       *
       * 缺省用 `bah:run` 注入的那一份（CLI 与测试夹具各造一个）；注入缺失时自己造一个，
       * 行为等价（"没有外部注入"= 本进程自己管标记），只是装配面上看不见它。
       */
      const wakeMarks: WakeMarkStore = ctx.get(RUN_SERVICE).wakeMarks ?? createWakeMarkStore()

      /**
       * 窗口代签核验端口（ADR-0010 的判定面）。
       *
       * 判定顺序（**顺序即安全边界，不可重排**）：
       * 1. `authorization.kind` 必须是 `window`（人工票据走渠道，不在这里）；
       * 2. **唤醒标记必须在**：没有标记 ⇒ 这次 run 不是唤醒执行器开的 ⇒ 不放行。
       *    这条是防"伪造 authorization 字段"的关键——字段能被仿，标记不能：
       *    它只由本文件的 `wake()` 开，且带着 `windowId + planId + digest + 预算` 四元组；
       * 3. 窗口存在且仍在 `armed`、三份摘要（标记 / 票据 / 重新计算的 planDigest）一致；
       * 4. 窗口条件复验（`checkWindow`，与唤醒入口**同一份实现**，不另算一套）；
       * 5. 档位 × 级别 × 红级预授权 × 预算（纯函数 `decideWindowSign`）；
       * 6. 记账扣预算（`take`）——放在最后，前面任何一步失败都不消耗额度。
       *
       * 任何一步拿不到确定答案都返回 `ok:false`：应答者会**沉默**（票据留给渠道/超时），
       * 不是替用户拒绝。
       */
      const signer: WindowSigner = {
        async sign(request: WindowSignRequest): Promise<WindowSignGrant> {
          const authorization = request.authorization
          if (authorization.kind !== 'window') {
            return { ok: false, code: 'not-window', reason: '票据没有窗口授权' }
          }

          // ② 唤醒标记（防伪造）：字段可仿，标记不可
          const mark = wakeMarks.get(authorization.ref)
          if (mark === undefined) {
            return {
              ok: false,
              code: 'no-wake-mark',
              reason: `窗口 ${authorization.ref} 没有在途唤醒标记（不是唤醒执行器发起的 run）`,
            }
          }

          // ③ 窗口条目 + 三份摘要
          const armed = armedStore.get(authorization.ref)
          if (armed === undefined) {
            return { ok: false, code: 'window-unknown', reason: `授权窗口不存在：${authorization.ref}` }
          }
          if (armed.state !== 'armed') {
            return { ok: false, code: 'window-cancelled', reason: '授权窗口已撤销' }
          }
          if (mark.planId !== armed.planId || mark.digest !== authorization.digest) {
            return {
              ok: false,
              code: 'window-mismatch',
              reason: '票据与唤醒标记不属于同一个窗口/计划',
            }
          }
          if (armed.planDigest !== planDigest(armed.plan)) {
            // "武装的是 A，跑的是 B"：计划本体被改过，摘要对不上就不签
            return { ok: false, code: 'plan-digest-mismatch', reason: '当前计划内容与武装摘要不一致' }
          }

          // ④ 条件复验（同一份 checkWindow；失守即降级人工）
          const verdict = checkWindow(armed, await snapshotFor(armed), clock())
          if (!verdict.ok) {
            return { ok: false, code: verdict.code, reason: `窗口复验失守：${verdict.code}` }
          }

          // ⑤ 档位 × 级别 × 预授权 × 预算（纯函数）
          const nowAt = clock()
          const redVerified =
            armed.verifiedAt !== undefined &&
            armed.expiresAt !== undefined &&
            nowAt >= armed.verifiedAt &&
            nowAt <= armed.expiresAt
          const amountCents =
            request.amountYuan === undefined || !Number.isFinite(request.amountYuan)
              ? 0
              : yuanToCents(request.amountYuan)
          const decision = decideWindowSign({
            tier: armed.tier,
            level: request.level,
            redVerified,
            spentCents: mark.spentCents,
            amountCents,
            budgetCents: mark.budgetCents,
          })
          if (!decision.ok) return { ok: false, code: decision.code, reason: decision.reason }

          // ⑥ 记账（原子；失败 = 不放行）
          if (!mark.take(amountCents)) {
            return { ok: false, code: 'over-budget', reason: '本次 run 的代签额度已用尽' }
          }
          return { ok: true, windowId: armed.windowId }
        },
      }

      ctx.effect(ctx.provide(WINDOW_SIGNER, signer))

      const wake: PlanWakeRunner = {
        wake: async (input = {}) => {
          const at = input.at ?? clock()
          const now = clock()
          const source = input.source ?? 'tool'
          const scan = duePlans(armedStore.list(), at, now)
          if (!scan.ok) {
            return { at, now, source, ok: false, code: scan.code, entries: [], notified: [] }
          }
          const candidates =
            input.planId === undefined
              ? scan.due
              : scan.due.filter((item) => item.planId === input.planId)
          // 实例键按**全部**窗口算：候选之外还要用它给"到期前提醒"去重（提示词 4-2）
          const executed = executedInstanceKeys(session.events(), armedStore.list())
          const entries: PlanWakeEntry[] = []
          const notified: PlanWakeReport['notified'][number][] = []

          /**
           * 一条通知的**唯一出口**：先过"同窗口同种类只发一次"账本，再过 `deriveNotify` 预算
           * （静默时段 / 日上限 / 同档最小间隔）。没送达时不记账——提醒不能因为夜里被静默
           * 而永久丢失；下一次唤醒还会再试。
           */
          const noticeOf = (
            ledgerKey: string,
            priority: 'exec' | 'decision' | 'alert',
            key: string,
            text: string | undefined,
          ): void => {
            if (noticeSent.has(ledgerKey)) return
            const decision = deriveNotify(
              notifyHistory,
              { priority, at: now, key },
              DEFAULT_NOTIFY_BUDGET,
            )
            notified.push({
              key,
              send: decision.send,
              channel: decision.channel,
              reason: decision.reason,
              ...(text === undefined ? {} : { text }),
            })
            if (decision.send) {
              noticeSent.add(ledgerKey)
              notifyHistory.push({ priority, at: now, key })
            }
          }

          for (const item of candidates) {
            const occurrence = occurrenceOf(item.recurrence, item.dueAt)
            const key = idempotencyKey(item.planId, occurrence)
            const base = {
              planId: item.planId,
              windowId: item.windowId,
              occurrence,
              key,
            }
            if (executed.has(key)) {
              entries.push({ ...base, status: 'skipped', reason: 'already-ran' })
              continue
            }

            const verdict = checkWindow(item, await snapshotFor(item), at)
            if (!verdict.ok) {
              // 窗口失守：不执行、降级为人工确认（`downgrade:'ask'`）
              entries.push({
                ...base,
                status: 'downgraded',
                code: verdict.code,
                digest: verdict.digest,
                inputs: verdict.inputs,
                failed: verdict.failed,
              })
              noticeOf(
                `${item.windowId}#${verdict.code}`,
                'alert',
                key,
                planNoticeText({
                  code: verdict.code,
                  title: item.title,
                  dueAt: item.dueAt,
                  ...(item.expiresAt === undefined ? {} : { expiresAt: item.expiresAt }),
                  ...(verdict.failed === undefined ? {} : { failed: verdict.failed }),
                }),
              )
              continue
            }

            // G8：用户批准的是"那一行行具体的钱"。明细摘要对不上（商户涨价、条件被改写、
            // 档位被改）→ 不按旧授权放行，降级人工确认。放在条件复验**之后**、预算之前：
            // 条件失守本来就不该执行，它的码更具体（`window-expired` 比 `details-changed` 更该被看见）。
            const recomputed = detailsMismatch(merchantOf(), item)
            if (recomputed !== undefined) {
              entries.push({
                ...base,
                status: 'downgraded',
                code: 'details-changed',
                digest: verdict.digest,
                inputs: verdict.inputs,
                failed: [
                  {
                    kind: 'details-digest',
                    expected: item.detailsDigest ?? '',
                    actual: recomputed,
                  },
                ],
              })
              noticeOf(
                `${item.windowId}#details-changed`,
                'alert',
                key,
                planNoticeText({ code: 'details-changed', title: item.title, dueAt: item.dueAt }),
              )
              continue
            }

            // 预算硬校验：窗口通过了条件，也仍然要守住"不擅自加价"
            const spend = staticSpendCents(item.plan)
            if (spend > item.budgetCents) {
              entries.push({
                ...base,
                status: 'downgraded',
                code: 'condition-failed',
                digest: verdict.digest,
                inputs: verdict.inputs,
                failed: [
                  {
                    kind: 'amount-within',
                    expected: `<= ${String(item.budgetCents)}`,
                    actual: String(spend),
                  },
                ],
              })
              noticeOf(
                `${item.windowId}#condition-failed`,
                'alert',
                key,
                planNoticeText({
                  code: 'condition-failed',
                  title: item.title,
                  dueAt: item.dueAt,
                  failed: [
                    {
                      kind: 'amount-within',
                      expected: `<= ${String(item.budgetCents)}`,
                      actual: String(spend),
                    },
                  ],
                }),
              )
              continue
            }

            /**
             * 父预算账本（ADR-0013）：同一 `parentPlanId` 的已成功腿累计 + 本腿 > 父预算
             * ⇒ 本腿**跳过**（不扣款、不订商户）并发 alert。数据来自 `plan/completed`，
             * 不另建账本文件；只认武装之后成功的 run。
             */
            if (item.parentPlanId !== undefined && item.parentBudgetCents !== undefined) {
              const used = parentSpentCents(session.events(), armedStore.list(), item.parentPlanId)
              if (!parentBudgetAllows(item.parentBudgetCents, used, spend)) {
                entries.push({
                  ...base,
                  status: 'skipped',
                  reason: 'budget-exhausted',
                  digest: verdict.digest,
                })
                noticeOf(`${item.windowId}#budget-exhausted`, 'alert', key, undefined)
                continue
              }
            }

            /**
             * 档位预检（ADR-0010）：`strict` 档什么都不代签。
             *
             * 为什么在**进引擎之前**判：每个节点的票据都会走审批，而窗口应答者被禁止
             * 抢答（失败只沉默）。若放它进去，一张普通票据要等满 TTL 才被拒——
             * 用户看到的是"点了自动办，两分钟后才说没办"。这里直接降级，一次都不跑。
             */
            if (WINDOW_AUTO_LEVEL[item.tier].length === 0) {
              entries.push({
                ...base,
                status: 'downgraded',
                code: 'tier-not-allowed',
                digest: verdict.digest,
                inputs: verdict.inputs,
                failed: [{ kind: 'tier', expected: '至少 standard', actual: item.tier }],
              })
              noticeOf(`${item.windowId}#tier-not-allowed`, 'alert', key, undefined)
              continue
            }

            if (input.dryRun === true) {
              entries.push({ ...base, status: 'skipped', reason: 'dry-run', digest: verdict.digest })
              continue
            }

            const sessionKey = String(session.sessionId)
            const merchantService = item.merchant === undefined ? undefined : merchantOf()
            let reservation: MerchantReservation | undefined
            let merchantLeg: MerchantFulfilment | undefined
            let compensation: PlanCompensation | undefined

            /**
             * ★ 先订后付（ADR-0013）：商户腿在**扣款前**预占。
             *
             * 缺货 / 超时 / 没搜过 ⇒ 一分钱不扣，直接 failed（不再"先扣再发现买不到"）。
             * 价格复验与"用户批准价"比对：涨价不自动支付，释放预占并降级成 `price-changed`。
             */
            if (item.merchant !== undefined) {
              if (merchantService === undefined) {
                entries.push({
                  ...base,
                  status: 'failed',
                  reason: 'merchant-service-missing',
                  digest: verdict.digest,
                  merchant: {
                    status: 'failed',
                    attempts: [
                      { offerId: item.merchant.offerId, ok: false, code: 'merchant-service-missing' },
                    ],
                  },
                })
                noticeOf(`${item.windowId}#merchant-service-missing`, 'alert', key, undefined)
                continue
              }
              const reserved = merchantService.reserve(
                sessionKey,
                item.merchant.offerId,
                `${item.planId}#merchant`,
              )
              if (!reserved.ok) {
                const code = reserved.attempts[0]?.code ?? 'merchant-reserve-failed'
                entries.push({
                  ...base,
                  status: 'failed',
                  reason: code,
                  digest: verdict.digest,
                  merchant: { status: 'failed', attempts: reserved.attempts },
                })
                noticeOf(`${item.windowId}#${code}`, 'alert', key, undefined)
                continue
              }
              reservation = reserved.reservation
              const approved = item.merchant.priceCents
              if (approved !== undefined && reservation.totalCents !== approved) {
                merchantService.release(reservation)
                entries.push({
                  ...base,
                  status: 'skipped',
                  reason: 'price-changed',
                  digest: verdict.digest,
                  merchant: {
                    status: 'failed',
                    attempts: [{ offerId: item.merchant.offerId, ok: false, code: 'price-changed' }],
                    price: { approvedCents: approved, currentCents: reservation.totalCents },
                  },
                })
                noticeOf(`${item.windowId}#price-changed`, 'alert', key, undefined)
                continue
              }
              if (reservation.totalCents > item.budgetCents) {
                merchantService.release(reservation)
                entries.push({
                  ...base,
                  status: 'skipped',
                  reason: 'over-budget',
                  digest: verdict.digest,
                  merchant: {
                    status: 'failed',
                    attempts: [{ offerId: item.merchant.offerId, ok: false, code: 'over-budget' }],
                  },
                })
                noticeOf(`${item.windowId}#over-budget`, 'alert', key, undefined)
                continue
              }
            }

            try {
              /**
               * ★ 唤醒标记（ADR-0010）：这是"这次 run 由唤醒执行器发起"的唯一证据。
               *
               * 只在这里 `open()`，`finally` 里立刻撤销——所以它天然是**一次性**的：
               * run 结束后同一个 `authorization` 字段再也换不来代签。
               * 标记里带 `windowId + planId + digest + 预算`，窗口代签核验端口按
               * `authorization.ref` 取它，四元组对不上就不签。
               */
              const release = wakeMarks.open({
                windowId: item.windowId,
                planId: item.planId,
                digest: verdict.digest,
                budgetCents: item.budgetCents,
                ...(item.verifiedAt === undefined ? {} : { verifiedAt: item.verifiedAt }),
                ...(item.expiresAt === undefined ? {} : { expiresAt: item.expiresAt }),
              })
              const eventsBefore = session.events().length
              let summary: PlanRunSummary
              try {
                summary = await api.run(item.plan, {
                  authorization: { kind: 'window', ref: item.windowId, digest: verdict.digest },
                })
              } finally {
                release()
              }
              /**
               * 商户腿（ADR-0013）：预占已在上方完成。
               * 银行腿成功 → 提交；提交失败 → **冲正银行腿**（钱不能白扣）。
               * 银行腿失败 → 释放预占，不提交、不冲正（本来就没扣钱）。
               */
              if (reservation !== undefined && merchantService !== undefined) {
                if (summary.status !== 'succeeded') {
                  merchantService.release(reservation)
                } else {
                  let committed
                  try {
                    committed = merchantService.commit(reservation)
                  } catch (error) {
                    // commit 自己炸了也算"没成交"：不能因此跳过冲正
                    committed = {
                      ok: false as const,
                      attempts: [
                        {
                          offerId: reservation.offerId,
                          ok: false,
                          code: errorCodeOf(error, 'merchant-commit-failed'),
                        },
                      ],
                    }
                  }
                  if (committed.ok) {
                    merchantLeg = { status: 'ok', attempts: committed.attempts, order: committed.order }
                  } else {
                    merchantLeg = { status: 'failed', attempts: committed.attempts }
                    const txnId = lastTransferTxnId(session.events(), eventsBefore)
                    if (txnId === undefined) {
                      compensation = { kind: 'reversal-failed', code: 'txn-unknown' }
                    } else {
                      let port
                      try {
                        port = ctx.get(BANK_COMPENSATION)
                      } catch (error) {
                        port = undefined
                        compensation = {
                          kind: 'reversal-unavailable',
                          txnId,
                          code: errorCodeOf(error, 'compensation-unavailable'),
                        }
                      }
                      if (port !== undefined) {
                        try {
                          const reversed = await port.reverse(txnId)
                          compensation = {
                            kind: 'reversed',
                            txnId,
                            reversalTxnId: String(reversed.reversalTxnId),
                            amountCents: reversed.amountCents,
                          }
                        } catch (error) {
                          compensation = {
                            kind: 'reversal-failed',
                            txnId,
                            code: errorCodeOf(error, 'reversal-failed'),
                          }
                        }
                      }
                    }
                  }
                }
              }
              entries.push({
                ...base,
                status: 'executed',
                digest: verdict.digest,
                inputs: verdict.inputs,
                ...(merchantLeg === undefined ? {} : { merchant: merchantLeg }),
                ...(compensation === undefined ? {} : { compensation }),
                summary: {
                  status: summary.status,
                  succeeded: summary.succeeded,
                  failed: summary.failed,
                  blocked: summary.blocked,
                  durationMs: summary.durationMs,
                },
              })
              const merchantFailed =
                (merchantLeg !== undefined && merchantLeg.status !== 'ok') || compensation !== undefined
              const priority = summary.failed > 0 || summary.blocked > 0 || merchantFailed ? 'alert' : 'exec'
              // 熔断（ADR-0010）：连续 N 次跑失败 → 走既有 `plan_disarm` 把窗口撤掉
              const badRun = summary.failed > 0 || summary.blocked > 0 || summary.status !== 'succeeded'
              if (badRun) {
                const count = (windowFailures.get(item.windowId) ?? 0) + 1
                windowFailures.set(item.windowId, count)
                if (count >= DISARM_AFTER_FAILED_WAKES) {
                  // 与 `plan_disarm` 工具、`bah plan disarm` 用的是同一个状态转移
                  armedStore.disarm(item.windowId)
                  windowFailures.delete(item.windowId)
                }
              } else {
                windowFailures.delete(item.windowId)
              }
              // 播报账本按**实例**分键（周期计划的每个 occurrence 各播一次）
              noticeOf(`${item.windowId}#executed#${occurrence}`, priority, key, undefined)
            } catch (error) {
              // 异常路径也要把预占释放掉（没成交的单不该一直占着）
              if (reservation !== undefined) merchantService?.release(reservation)
              entries.push({
                ...base,
                status: 'failed',
                reason: errorCodeOf(error, 'wake-failed'),
                digest: verdict.digest,
              })
            }
          }
          /**
           * 过期未执行（提示词 4-2 / C-06）：`duePlans` 只扫"还没过有效期"的窗口，
           * 过了宽限的窗口**永远不会被它扫到**——那正是"错过唤醒对用户静默"的根。
           *
           * 这里单独扫一遍给出终态回执：`failed(window-expired)`，**不执行、不补扣**。
           * 每次唤醒都会如实报告（它确实还挂着）；但提醒本身按窗口只发一次（`noticeSent`）。
           */
          for (const item of armedStore.list()) {
            if (item.state !== 'armed') continue
            if (item.expiresAt === undefined || at <= item.expiresAt) continue
            if (input.planId !== undefined && item.planId !== input.planId) continue
            const occurrence = occurrenceOf(item.recurrence, item.dueAt)
            const key = idempotencyKey(item.planId, occurrence)
            if (executed.has(key)) continue
            entries.push({
              planId: item.planId,
              windowId: item.windowId,
              occurrence,
              key,
              status: 'failed',
              reason: 'window-expired',
              code: 'window-expired',
              failed: [
                {
                  kind: 'window-expired',
                  expected: `<= ${String(item.expiresAt)}`,
                  actual: String(at),
                },
              ],
            })
            if (input.dryRun !== true) {
              noticeOf(
                `${item.windowId}#window-expired`,
                'alert',
                key,
                planNoticeText({
                  code: 'window-expired',
                  title: item.title,
                  dueAt: item.dueAt,
                  expiresAt: item.expiresAt,
                }),
              )
            }
          }

          /**
           * 到期前提醒（提示词 4-2）：还没到期、但已进入提前量窗口的实例，发一条 `exec` 级提醒。
           *
           * 三条边界：
           * 1. **只提醒，不执行**——到点后是否扣款仍由窗口复验 + 代签核验决定；
           * 2. `dueSoonLeadMs = 0` 关闭；`dryRun` 不产生通知（"只判定"不该打扰用户）；
           * 3. 已过期 / 本实例已跑过 / 不是 `armed` 的窗口都不提醒。
           */
          if (input.dryRun !== true && settings.dueSoonLeadMs > 0) {
            for (const item of armedStore.list()) {
              if (item.state !== 'armed') continue
              if (input.planId !== undefined && item.planId !== input.planId) continue
              if (item.dueAt <= at || item.dueAt - at > settings.dueSoonLeadMs) continue
              if (item.expiresAt !== undefined && at > item.expiresAt) continue
              const occurrence = occurrenceOf(item.recurrence, item.dueAt)
              const key = idempotencyKey(item.planId, occurrence)
              if (executed.has(key)) continue
              noticeOf(
                `${item.windowId}#due-soon#${occurrence}`,
                'exec',
                `${key}#due-soon`,
                `计划《${item.title}》将在 ${new Date(item.dueAt).toISOString()}（UTC）到期执行；如需修改请重新授权。`,
              )
            }
          }

          return { at, now, source, ok: true, entries, notified }
        },
      }

      ctx.effect(ctx.provide(PLAN_WAKE_SERVICE, wake))
      ctx.effect(ctx.provide(PLAN_ARMED_SERVICE, { list: () => armedStore.list() }))

      /**
       * B1：模型可见的规划入口。
       *
       * 两个工具都**只接受银行工具目录内的节点**；`plan_execute` 还要过一次人工审批
       * （黄级 ask），它内部调用的 `PlanApi.run()` 会让每个节点**再各走一次** ToolPipeline。
       * 也就是说：模型能提出 DAG，但不能绕过任何一层审批 / Sentry / 审计 / 沙箱。
       */
      if (settings.modelTools) {
        const planOrThrow = (raw: unknown, callId: string): Plan => planFromArgs(raw, callId)

        const planSchema = {
          type: 'object',
          description: '一张工具调用 DAG；节点工具只能取银行工具目录',
          properties: {
            planId: {
              type: 'string',
              description: '计划 ID（同一会话内建议唯一；缺省用本次工具调用 ID）',
            },
            nodes: {
              type: 'array',
              description: `节点数组（最多 ${String(modelPlanLimit)} 个）`,
              items: {
                type: 'object',
                properties: {
                  id: { type: 'string', description: '节点 ID：[A-Za-z0-9_-]{1,64}，计划内唯一' },
                  tool: { type: 'string', description: '银行工具名（必须已注册）' },
                  args: { type: 'object', description: '工具入参（可整串用 ${node.<id>.<path>} 取上游字段）' },
                  deps: { type: 'array', items: { type: 'string' }, description: '依赖的节点 ID' },
                  optional: { type: 'boolean', description: '上游失败时跳过而不是阻断（缺省 false）' },
                },
                required: ['id', 'tool'],
              },
            },
            meta: {
              type: 'object',
              properties: { title: { type: 'string', description: '计划标题（只做展示，不进 digest）' } },
            },
          },
          required: ['nodes'],
        } as const

        const propose: ToolDefinition<Readonly<Record<string, unknown>>, PlanProposalResult> = {
          name: PLAN_PROPOSE_TOOL,
          description:
            '把复杂任务拆成受约束的工具调用 DAG，并做一次完整校验（只校验，不执行、不扣款）。' +
            '只在用户明确要求“分几步/先做什么再做什么/帮我规划”时用；单个查询或转账直接调对应工具，不要包装。' +
            '节点工具只能取银行工具目录；校验通过后再用 plan_execute 执行。',
          schema: planSchema,
          tier: { level: 'green' },
          sideEffect: 'none',
          execute: async (args, ictx) => {
            const plan = planOrThrow(args, ictx.callId)
            return {
              planId: plan.planId,
              digest: planDigest(plan),
              total: plan.nodes.length,
              order: kahnSort(plan.nodes).order,
            }
          },
          projectContent: (result) => [
            {
              type: 'text',
              text:
                `计划 ${result.planId} 校验通过：${String(result.total)} 个节点，` +
                `执行序 ${result.order.join(' → ')}。摘要 ${result.digest}。` +
                '尚未执行——要执行请调用 plan_execute（执行时仍需人工批准）。',
            },
          ],
        }

        const execute: ToolDefinition<Readonly<Record<string, unknown>>, PlanExecutedResult> = {
          name: PLAN_EXECUTE_TOOL,
          description:
            '执行一张已通过 plan_propose 校验的计划（DAG）。只在用户明确确认“按这个计划执行”后用；' +
            '执行本身要一次人工批准，每个写节点还会各自触发审批；不要用它包装单个普通调用。',
          schema: planSchema,
          tier: { level: 'yellow' },
          sideEffect: 'write',
          execute: async (args, ictx) => {
            const plan = planOrThrow(args, ictx.callId)
            const summary = await api.run(plan)
            const snapshot = api.snapshot(plan.planId)
            return {
              planId: summary.planId,
              status: summary.status,
              total: summary.total,
              succeeded: summary.succeeded,
              failed: summary.failed,
              blocked: summary.blocked,
              skipped: summary.skipped,
              cancelled: summary.cancelled,
              durationMs: summary.durationMs,
              nodes: (snapshot?.nodes ?? []).map((node) => ({
                nodeId: node.nodeId,
                tool: node.tool,
                state: node.state,
                ...(node.code === undefined ? {} : { code: node.code }),
              })),
            }
          },
          projectContent: (result) => [
            {
              type: 'text',
              text:
                `计划 ${result.planId} ${result.status}：` +
                `成功 ${String(result.succeeded)} / 失败 ${String(result.failed)} / ` +
                `阻断 ${String(result.blocked)} / 跳过 ${String(result.skipped)} / ` +
                `取消 ${String(result.cancelled)}（共 ${String(result.total)} 个节点）。`,
            },
          ],
        }

        /**
         * `plan_arm`：签发授权窗口（G1）。
         *
         * 用户确认的是"**在条件快照成立的前提下**执行"，不是"未来任何情况都执行"。
         * 把整张 DAG + 预算上限 + 条件快照一起哈希进 digest；唤醒时必须复验。
         */
        const armSchema = {
          type: 'object',
          description: '为一张工具调用 DAG 签发授权窗口（黄级，需要人工确认整张图）',
          properties: {
            planId: { type: 'string', description: '计划 ID（缺省用本次调用 ID）' },
            title: { type: 'string', description: '计划标题（展示用）' },
            nodes: {
              type: 'array',
              description: `节点数组（最多 ${String(modelPlanLimit)} 个）`,
              items: {
                type: 'object',
                properties: {
                  id: { type: 'string', description: '节点 ID：[A-Za-z0-9_-]{1,64}' },
                  tool: { type: 'string', description: '银行工具名（必须已注册）' },
                  args: { type: 'object', description: '工具入参（可用 ${node.<id>.<path>} 取上游字段）' },
                  deps: { type: 'array', items: { type: 'string' }, description: '依赖的节点 ID' },
                  optional: { type: 'boolean', description: '上游失败时跳过而不是阻断' },
                },
                required: ['id', 'tool'],
              },
            },
            tier: {
              type: 'string',
              enum: ['strict', 'standard', 'wide'],
              description:
                '授权档（缺省 standard）：strict 一律人工；standard 只代签绿/黄；' +
                'wide 可代签红级，但必须在这次审批里完成强验证且给 expiresAt',
            },
            budgetYuan: { type: 'number', description: '预算上限（元）' },
            merchantOfferId: {
              type: 'string',
              description: '商户腿（可选）：merchant_search 返回的 offerId；只允许本会话搜过的商品',
            },
            dueAt: { type: 'string', description: '到期时刻（ISO 8601，如 2026-10-22T10:00:00+08:00）' },
            expiresAt: { type: 'string', description: '窗口过期时刻（ISO 8601；可选）' },
            recurrence: {
              type: 'object',
              description: '周期（可选；缺省一次性）',
              properties: {
                every: { type: 'string', enum: ['once', 'daily', 'monthly', 'yearly'] },
                at: { type: 'string', description: 'HH:mm（daily/monthly/yearly 必填）' },
                day: { type: 'number', description: '每月/每年第几天' },
                month: { type: 'number', description: '每年第几月' },
              },
              required: ['every'],
            },
            conditions: {
              type: 'array',
              description: '条件快照（唤醒时逐条复验；失守即降级人工）',
              items: {
                type: 'object',
                properties: {
                  kind: {
                    type: 'string',
                    enum: [
                      'balance-at-least',
                      'fact-unchanged',
                      'plan-not-cancelled',
                      'amount-within',
                      'address-unchanged',
                    ],
                  },
                  cents: { type: 'number' },
                  factId: { type: 'string' },
                  planId: { type: 'string' },
                  addressId: { type: 'string' },
                  version: { type: 'number' },
                },
                required: ['kind'],
              },
            },
          },
          required: ['title', 'nodes', 'budgetYuan', 'dueAt'],
        } as const

        /**
         * 红级一次性预授权凭据（ADR-0010）。
         *
         * 来源只有一处：**本次调用自己的红级挑战已经通过**。
         * 审计证据链是 `approval/challenge-issued(callId) → verify/*(成功) → approval/challenge-issued.passed`
         * ——没有任何"系统自己给自己盖章"的路径。
         */
        interface WindowPreauth {
          readonly verifiedAt: number
          readonly challenge: {
            readonly channel: 'face' | 'sms' | 'ushield'
            readonly challengeId: string
          }
        }

        /**
         * 取"这次调用做完强验证"的凭据（没有就 `undefined`）。
         *
         * 为什么要扫会话事件而不是读一个内存变量：
         * 挑战的签发点是 `interaction:approval`，它只通过 `approval/challenge-issued`
         * 落账；宿主这边没有第二个真相源。`passed()` 由银行侧 `VerifyService` 作答，
         * 二者合起来就是"这一次人脸/短信真的过了"。
         *
         * **只认本 callId**：别人的挑战不能拿来给这张窗口背书。
         */
        const preauthOf = (callId: string): WindowPreauth | undefined => {
          let challenges
          try {
            challenges = ctx.get(BANK_CHALLENGE)
          } catch {
            return undefined
          }
          const events = ctx.get(SESSION_SERVICE).events()
          for (let index = events.length - 1; index >= 0; index -= 1) {
            const event = events[index]
            if (event === undefined || String(event.type) !== 'approval/challenge-issued') continue
            const data = event.data as Readonly<Record<string, unknown>>
            if (data['callId'] !== callId) continue
            const challengeId = data['challengeId']
            const channel = data['channel']
            if (typeof challengeId !== 'string') return undefined
            if (channel !== 'face' && channel !== 'sms' && channel !== 'ushield') return undefined
            if (!challenges.passed(challengeId)) return undefined
            // 预授权时刻取"现在"（注入钟）：挑战通过之后就武装，两者相隔毫秒级；
            // 之所以不取 verify 事件的时刻，是因为 `verify/*` 的载荷不带 challengeId 映射。
            return { verifiedAt: clock(), challenge: { channel, challengeId } }
          }
          return undefined
        }

        /** 计划里是否含红级工具（读注册表，不读配置——配置改不动工具声明）。 */
        const hasRedNode = (plan: Plan): boolean =>
          plan.nodes.some((node) => {
            try {
              return registry().get(node.tool).tier.level === 'red'
            } catch {
              return false
            }
          })

        /**
         * 这一次 ask 是否要升级成"红级 + 强验证"（ADR-0010）。
         *
         * - `plan_arm`：宽档，或计划里含红级工具——宽档的意义就是"允许代签红级"，
         *   所以授权那一刻必须做过一次强验证，否则宽档等于免验证；
         * - `transfer_schedule` / `birthday_plan`：它们武装的是**宽档**窗口
         *   （收款人常常未登记 ⇒ 到期时 `transfer_create` 会升到红级）；
         * - `plan_execute` / `plan_disarm`：维持黄级（前者不动钱、后者只撤销）。
         */
        const needsRedPreauth = (
          name: string,
          args: Readonly<Record<string, unknown>>,
        ): boolean => {
          if (name === 'transfer_schedule' || name === 'birthday_plan') return true
          if (name !== PLAN_ARM_TOOL) return false
          try {
            const tier = parseTier(args['tier'])
            if (tier === 'wide') return true
            const plan = planFromArgs(
              {
                ...(args['planId'] === undefined ? {} : { planId: args['planId'] }),
                nodes: args['nodes'],
                meta: { title: String(args['title'] ?? '') },
              },
              'approval-args',
            )
            return hasRedNode(plan)
          } catch {
            // 参数非法：让工具体抛 `plan-arm-invalid`，这里不抢答（也不升级成红级）
            return false
          }
        }

        /**
         * 武装一张窗口（`plan_arm` 与两个"定时"工具共用的唯一实现）。
         *
         * @param preauth 红级预授权凭据；`tier:'wide'` 或含红级节点时**必须有**，
         *   否则抛 `plan-arm-unverified`。`plan_arm` 自己从本次调用的挑战取，
         *   `transfer_schedule` / `birthday_plan` 把**父审批**的凭据传下来
         *   （用户批准的是"这张计划"，子窗口是它的三笔钱）。
         */
        /**
         * 父计划与腿别（`birthday_plan` 专用；**不走模型入参**，避免模型自封父计划）。
         * `merchant` 是武装时刻的报价事实（ADR-0013），用于涨价复验。
         */
        interface ArmExtras {
          readonly parentPlanId?: string
          readonly legKind?: 'lock' | 'flower' | 'cake'
          readonly parentBudgetCents?: number
          readonly merchant?: {
            readonly merchantName?: string
            readonly priceCents?: number
          }
        }

        const armPlan = (
          args: Readonly<Record<string, unknown>>,
          ictx: ToolExecContext,
          preauth: WindowPreauth | undefined,
          extras: ArmExtras = {},
        ): ArmedPlan => {
          const plan = planFromArgs(
            {
              ...(args['planId'] === undefined ? {} : { planId: args['planId'] }),
              nodes: args['nodes'],
              meta: { title: String(args['title'] ?? '') },
            },
            ictx.callId,
          )
          const dueAt = parseIsoTime(args['dueAt'], 'dueAt')
          const tier = parseTier(args['tier'])
          const expiresAt =
            args['expiresAt'] === undefined ? undefined : parseIsoTime(args['expiresAt'], 'expiresAt')

          // ★ 宽档 = 允许代签红级 ⇒ 必须同时具备"有效期"与"预授权"。
          //   两条都不给默认值：没有有效期的宽档是"永久免验证"，没有预授权的宽档是"免验证"。
          if (tier === 'wide' || hasRedNode(plan)) {
            if (expiresAt === undefined || expiresAt < dueAt) {
              throw new BahError(
                'plan-arm-invalid',
                '宽档（或含红级动作）的授权窗口必须给 expiresAt，且不得早于 dueAt',
                { planId: plan.planId },
              )
            }
            if (preauth === undefined) {
              throw new BahError(
                'plan-arm-unverified',
                '宽档（或含红级动作）的授权窗口必须在武装时完成一次强验证（人脸/短信）',
                { planId: plan.planId },
              )
            }
          }

          const armed: ArmedPlan = {
            planId: plan.planId,
            windowId: `w-${ictx.callId}`,
            planDigest: planDigest(plan),
            title: plan.meta?.title ?? plan.planId,
            tier,
            conditions: parseConditions(args['conditions']),
            budgetCents: parseBudgetYuan(args['budgetYuan']),
            dueAt,
            recurrence: parseRecurrence(args['recurrence'], dueAt),
            ...(expiresAt === undefined ? {} : { expiresAt }),
            plan,
            armedAt: clock(),
            state: 'armed',
            ...(preauth === undefined
              ? {}
              : { verifiedAt: preauth.verifiedAt, challenge: preauth.challenge }),
            ...(args['merchantOfferId'] === undefined
              ? {}
              : {
                  merchant: {
                    offerId: String(args['merchantOfferId']),
                    ...(extras.merchant?.merchantName === undefined
                      ? {}
                      : { merchantName: extras.merchant.merchantName }),
                    ...(extras.merchant?.priceCents === undefined
                      ? {}
                      : { priceCents: extras.merchant.priceCents }),
                  },
                }),
            ...(extras.parentPlanId === undefined ? {} : { parentPlanId: extras.parentPlanId }),
            ...(extras.legKind === undefined ? {} : { legKind: extras.legKind }),
            ...(extras.parentBudgetCents === undefined
              ? {}
              : { parentBudgetCents: extras.parentBudgetCents }),
          }
          // G8：把"用户当时看到的明细"哈希进窗口。唤醒时重算，对不上就降级人工
          // （见 `detailsMismatch`）——授权的是那一行行具体的钱，不是一个工具名。
          const withDigest: ArmedPlan = {
            ...armed,
            detailsDigest: detailsDigestOf(renderArmDetails(armFactsOf(merchantOf(), armed))),
          }
          armedStore.arm(withDigest)
          return withDigest
        }

        const arm: ToolDefinition<Readonly<Record<string, unknown>>, ArmedPlan> = {
          name: PLAN_ARM_TOOL,
          description:
            '为一张计划签发"授权窗口"：用户只需确认一次整张图，到期由系统在条件快照成立时自动执行。' +
            '只在用户明确同意"到点自动办"时使用；条件快照必须来自用户确认过的事实（预算、余额门槛、事实版本）。' +
            '宽档（tier=wide）允许代签红级动作，但必须在这次审批里完成强验证，并给出 expiresAt。',
          schema: armSchema,
          tier: { level: 'yellow' },
          sideEffect: 'write',
          execute: async (args, ictx) => armPlan(args, ictx, preauthOf(ictx.callId)),
          // 不写 projectContent：出参必须是 **结构化 JSON**（ArmedPlan），
          // `replayArmedPlans` 与计划卡都按 JSON 读；投影成一句人话会让两者同时断粮。
        }

        const disarm: ToolDefinition<Readonly<Record<string, unknown>>, { readonly windowId: string; readonly planId: string; readonly state: string }> = {
          name: PLAN_DISARM_TOOL,
          description: '撤销一个授权窗口（不可逆；未执行则不再执行）。需要人工审批并逐字输入确认词。',
          schema: {
            type: 'object',
            properties: { windowId: { type: 'string', description: '要撤销的窗口 id' } },
            required: ['windowId'],
          },
          tier: { level: 'yellow' },
          sideEffect: 'write',
          execute: async (args) => {
            const windowId = typeof args['windowId'] === 'string' ? args['windowId'] : ''
            if (windowId.length === 0) {
              throw new BahError('plan-arm-invalid', 'plan_disarm: windowId 必填', {})
            }
            const cancelled = armedStore.disarm(windowId)
            return { windowId: cancelled.windowId, planId: cancelled.planId, state: cancelled.state }
          },
        }

        ctx.effect(registry().register(arm))
        ctx.effect(registry().register(disarm))

        /**
         * `transfer_schedule`：把「明天/下周X 给谁转多少」翻译成一张
         * `plan_arm` 授权窗口（节点 = transfer_create）。到期由既有
         * `plan_wake` 执行，不另造调度器。
         */
        const scheduleTransfer: ToolDefinition<
          Readonly<Record<string, unknown>>,
          {
            readonly scheduleId: string
            readonly planId: string
            readonly dueAt: number
            readonly amount: number
            readonly payeeName: string
            readonly title: string
          }
        > = {
          name: 'transfer_schedule',
          description:
            '定时转账（黄档写操作）：用户指定未来时间（今天/明天/后天/下周X，可带 HH:mm）给某人转多少钱时用。' +
            '到期由授权窗口自动发起转账审批；只做一次，不负责周期扣款。不要用它立即转账（用 transfer_create）。',
          schema: {
            type: 'object',
            properties: {
              amount: { type: 'number', description: '转账金额（元，> 0）' },
              payee: {
                type: 'object',
                properties: {
                  name: { type: 'string', description: '收款人姓名（必填）' },
                  phone: { type: 'string', description: '手机号（可选）' },
                },
                required: ['name'],
              },
              when: {
                type: 'string',
                description: '执行时间：ISO 8601 或 今天/明天/后天/下周X（可带 HH:mm）',
              },
              remark: { type: 'string', description: '附言（可选）' },
            },
            required: ['amount', 'payee', 'when'],
          },
          tier: { level: 'yellow' },
          sideEffect: 'write',
          execute: async (args, ictx) => {
            const amount = args['amount']
            if (typeof amount !== 'number' || !Number.isFinite(amount) || amount <= 0) {
              throw new BahError('transfer-schedule-invalid', 'transfer_schedule.amount 必须是正数', {
                amount,
              })
            }
            const payeeRaw = args['payee']
            if (typeof payeeRaw !== 'object' || payeeRaw === null || Array.isArray(payeeRaw)) {
              throw new BahError('transfer-schedule-invalid', 'transfer_schedule.payee 必须是对象', {})
            }
            const payeeRecord = payeeRaw as Readonly<Record<string, unknown>>
            const payeeName = typeof payeeRecord['name'] === 'string' ? payeeRecord['name'].trim() : ''
            if (payeeName.length === 0) {
              throw new BahError('transfer-schedule-invalid', 'transfer_schedule.payee.name 必填', {})
            }
            const phone =
              typeof payeeRecord['phone'] === 'string' && payeeRecord['phone'].trim().length > 0
                ? payeeRecord['phone'].trim()
                : undefined
            const dueAt = parseScheduleWhen(args['when'], clock())
            const remark = typeof args['remark'] === 'string' ? args['remark'] : undefined
            /**
             * ★ 宽档 + 预授权（ADR-0010）：到期时收款人常常是"未登记"
             * （`binding='new'` ⇒ 治理面把它升到红级），标准档根本签不了它。
             * 所以定时转账在**用户确认的那一刻**做一次强验证（本次审批已升级为红级），
             * 凭据随窗口落账；到期由窗口代签，失败一律回人工。
             */
            const armed = armPlan(
              {
                title: `定时转账：${payeeName} ${String(amount)} 元`,
                nodes: [
                  {
                    id: 'pay',
                    tool: 'transfer_create',
                    args: {
                      amount,
                      payee: { name: payeeName, ...(phone === undefined ? {} : { phone }) },
                      ...(remark === undefined ? {} : { remark }),
                    },
                  },
                ],
                budgetYuan: amount,
                dueAt: new Date(dueAt).toISOString(),
                expiresAt: new Date(dueAt + WINDOW_GRACE_MS).toISOString(),
                tier: 'wide',
              },
              ictx,
              preauthOf(ictx.callId),
            )
            return {
              scheduleId: armed.windowId,
              planId: armed.planId,
              dueAt: armed.dueAt,
              amount,
              payeeName,
              title: armed.title,
            }
          },
          projectContent: (result) => [
            {
              type: 'text',
              text:
                `已设置定时转账：${new Date(result.dueAt).toISOString()} 向 ${result.payeeName} 转 ¥${result.amount.toFixed(2)}。` +
                `到期由授权窗口代签（宽档，凭据 = 本次审批里完成的那次强验证）；` +
                `余额/收款人条件失守时立即降级回人工，不会自动扣款。`,
            },
          ],
        }

        ctx.effect(registry().register(scheduleTransfer))

        /**
         * `birthday_plan`：官方场景 6 的定时版。
         *
         * 官方示例是「检测生日 → 当月锁定 1000 → 生日前 2 天订鲜花/蛋糕」。
         * 这里把它拆成三张授权窗口（锁预算 / 鲜花 / 蛋糕），到期由 `plan_wake`
         * 执行；鲜花/蛋糕走既有 `merchantOfferId` 商户腿（搜过才可下单、缺货换店、
         * 不擅自加价），资金腿仍是 `transfer_create`。**不把商户腿塞进 DAG**：
         * 计划节点的工具白名单只认银行工具，这是既有安全边界。
         */
        const birthdayPlan: ToolDefinition<
          Readonly<Record<string, unknown>>,
          {
            readonly birthdayAt: number
            readonly dueAt: number
            readonly totalYuan: number
            readonly schedules: readonly {
              readonly kind: 'lock' | 'flower' | 'cake'
              readonly scheduleId: string
              readonly planId: string
              readonly amountYuan: number
              readonly merchant?: string
            }[]
          }
        > = {
          name: 'birthday_plan',
          description:
            '为生日创建定时计划（黄档写操作）：锁定预算 + 生日前 2 天订鲜花/蛋糕。用户说“下个月 N 号生日，提前两天自动办”时用；' +
            '只排一次，不负责真实商户 API 的送达/退款。不要用它立即执行（立即演示用 plan_propose/plan_execute）。',
          schema: {
            type: 'object',
            properties: {
              birthday: {
                type: 'string',
                description: '生日日期：ISO（YYYY-MM-DD）/ N月N号 / 下个月N号',
              },
              lockYuan: { type: 'number', description: '锁定预算（元；缺省 1000）' },
              flowerYuan: { type: 'number', description: '鲜花预算（元；缺省 200）' },
              cakeYuan: { type: 'number', description: '蛋糕预算（元；缺省 200）' },
            },
            required: ['birthday'],
          },
          tier: { level: 'yellow' },
          sideEffect: 'write',
          execute: async (args, ictx) => {
            const lockYuan = readPositiveYuan(args['lockYuan'], 1000, 'birthday_plan.lockYuan')
            const flowerYuan = readPositiveYuan(args['flowerYuan'], 200, 'birthday_plan.flowerYuan')
            const cakeYuan = readPositiveYuan(args['cakeYuan'], 200, 'birthday_plan.cakeYuan')
            const { birthdayAt, dueAt } = parseBirthdayDate(args['birthday'], clock())
            const dueIso = new Date(dueAt).toISOString()
            const sessionKey = String(ctx.get(RUN_SERVICE).sessionId)

            let merchant: MerchantService | undefined
            try {
              merchant = ctx.get(MERCHANT_SERVICE)
            } catch {
              merchant = undefined
            }
            const flowerOffers =
              merchant === undefined
                ? []
                : merchant.search(
                    { category: 'flower', budgetCents: yuanToCents(flowerYuan) },
                    sessionKey,
                  )
            const cakeOffers =
              merchant === undefined
                ? []
                : merchant.search(
                    { category: 'cake', budgetCents: yuanToCents(cakeYuan) },
                    sessionKey,
                  )
            const flowerOffer = flowerOffers[0]
            const cakeOffer = cakeOffers[0]

            const flowerAmountCents = flowerOffer?.priceCents ?? yuanToCents(flowerYuan)
            const cakeAmountCents = cakeOffer?.priceCents ?? yuanToCents(cakeYuan)
            const totalCents = yuanToCents(lockYuan) + flowerAmountCents + cakeAmountCents
            const conditions = [{ kind: 'balance-at-least' as const, cents: totalCents }]
            /**
             * ★ 三张子窗口共用**父审批**的强验证凭据（ADR-0010）。
             *
             * 用户批准的是"这张生日计划"，三笔钱是它的明细；再让他做三次人脸没有意义。
             * 所以父调用（`birthday_plan`）在 `needsRedPreauth` 里被升级成红级 + 挑战，
             * 这里把那一份凭据原样传给三个子窗口。
             *
             * 档位必须是宽档：锁定账户/商户名都不是登记收款人（`binding='new'`），
             * 到期时 `transfer_create` 会被升到红级，标准档签不了。
             */
            const inherited = preauthOf(ictx.callId)

            /**
             * 父计划 id（ADR-0013）：三张子窗口共用 `callId-birthday` 前缀。
             * 唤醒时按这个 id 归集"已成功腿"的累计金额，父预算耗尽就跳过后续腿。
             */
            const parentPlanId = `${ictx.callId}-birthday`
            const parentBudgetCents = totalCents

            const armOne = (
              kind: 'lock' | 'flower' | 'cake',
              title: string,
              amountYuan: number,
              payee: string,
              budgetYuan: number,
              merchantOfferId: string | undefined,
              merchant?: { readonly merchantName: string; readonly priceCents: number },
            ): { scheduleId: string; planId: string } => {
              const armed = armPlan(
                {
                  title,
                  nodes: [
                    {
                      id: 'pay',
                      tool: 'transfer_create',
                      args: {
                        amount: amountYuan,
                        payee: { name: payee },
                        remark: kind === 'lock' ? '生日预算锁定' : `生日${kind === 'flower' ? '鲜花' : '蛋糕'}预订款`,
                      },
                    },
                  ],
                  budgetYuan,
                  dueAt: dueIso,
                  expiresAt: new Date(dueAt + WINDOW_GRACE_MS).toISOString(),
                  tier: 'wide',
                  conditions,
                  ...(merchantOfferId === undefined ? {} : { merchantOfferId }),
                },
                { ...ictx, callId: `${ictx.callId}-${kind}` },
                inherited,
                {
                  parentPlanId,
                  legKind: kind,
                  parentBudgetCents,
                  ...(merchant === undefined
                    ? {}
                    : {
                        merchant: {
                          merchantName: merchant.merchantName,
                          priceCents: merchant.priceCents,
                        },
                      }),
                },
              )
              return { scheduleId: armed.windowId, planId: armed.planId }
            }

            const lock = armOne(
              'lock',
              '生日计划：锁定预算',
              lockYuan,
              LOCK_ACCOUNT_PAYEE,
              lockYuan,
              undefined,
            )
            const flower = armOne(
              'flower',
              '生日计划：鲜花',
              flowerAmountCents / 100,
              flowerOffer?.merchantName ?? '馨香花艺',
              flowerAmountCents / 100,
              flowerOffer?.offerId,
              flowerOffer === undefined
                ? undefined
                : { merchantName: flowerOffer.merchantName, priceCents: flowerOffer.priceCents },
            )
            const cake = armOne(
              'cake',
              '生日计划：蛋糕',
              cakeAmountCents / 100,
              cakeOffer?.merchantName ?? '甜心蛋糕坊',
              cakeAmountCents / 100,
              cakeOffer?.offerId,
              cakeOffer === undefined
                ? undefined
                : { merchantName: cakeOffer.merchantName, priceCents: cakeOffer.priceCents },
            )
            return {
              birthdayAt,
              dueAt,
              totalYuan: totalCents / 100,
              schedules: [
                { kind: 'lock' as const, ...lock, amountYuan: lockYuan },
                {
                  kind: 'flower' as const,
                  ...flower,
                  amountYuan: flowerAmountCents / 100,
                  ...(flowerOffer === undefined ? {} : { merchant: flowerOffer.merchantName }),
                },
                {
                  kind: 'cake' as const,
                  ...cake,
                  amountYuan: cakeAmountCents / 100,
                  ...(cakeOffer === undefined ? {} : { merchant: cakeOffer.merchantName }),
                },
              ],
            }
          },
          projectContent: (result) => [
            {
              type: 'text',
              text:
                `已设置生日计划：生日 ${new Date(result.birthdayAt).toISOString().slice(0, 10)}，` +
                `生日前 2 天（${new Date(result.dueAt).toISOString()}）执行；总预算 ¥${result.totalYuan.toFixed(2)}。` +
                `\n${result.schedules
                  .map(
                    (item) =>
                      `- ${item.kind}：¥${item.amountYuan.toFixed(2)}${item.merchant === undefined ? '' : `（${item.merchant}）`}`,
                  )
                  .join('\n')}` +
                `\n到期由授权窗口代签（宽档，预授权凭据 = 本次审批里完成的那次强验证，` +
                `有效期至 ${new Date(result.dueAt + WINDOW_GRACE_MS).toISOString()}）；` +
                `余额/条件只要有一条失守就立即降级回人工确认，不会扣款。` +
                `商户腿是 mock 商户域，不是真实商户 API。`,
            },
          ],
        }

        ctx.effect(registry().register(birthdayPlan))

        ctx.effect(registry().register(propose))
        ctx.effect(registry().register(execute))

        /* ──────────────────────────────────────────────────────────────────────
         * G8：签票时就把每一笔钱说清楚（审批明细）。
         *
         * 三个宿主侧工具（`plan_arm` / `transfer_schedule` / `birthday_plan`）的明细
         * **不走 deps.core**（宿主不知道余额），走的是**计划本体**：
         * `ArmedPlan` 的 title / dueAt / budgetCents / tier / conditions /
         * merchant.offerId / plan.nodes。
         *
         * 两条纪律：
         * 1. 价格只认商户报价（`offer.priceCents`），不拿入参 `flowerYuan` / `cakeYuan` 当报价——
         *    用户付的是报价，两者可能不同；
         * 2. 读不到就整条省略（不写"待确认"占位符），且明细构造失败不许把审批变成错误。
         * ────────────────────────────────────────────────────────────────────── */

        /**
         * ask 时刻的明细（**只从入参的确定性字段**重建）。
         *
         * 返回 `undefined` = 这个工具/这次入参没有明细（例如 `plan_execute` 的图在
         * `nodes` 里、但那是执行面不是金额面）；解析抛错也返回 `undefined`——
         * 真正的错误由工具体用同一个解析器抛出，明细不该抢在它前面报错。
         */
        const approvalDetailsFor = async (
          name: string,
          args: Readonly<Record<string, unknown>>,
        ): Promise<readonly TicketDetail[] | undefined> => {
          try {
            if (name === PLAN_ARM_TOOL) {
              const plan = planFromArgs(
                {
                  ...(args['planId'] === undefined ? {} : { planId: args['planId'] }),
                  nodes: args['nodes'],
                  meta: { title: String(args['title'] ?? '') },
                },
                'approval-details',
              )
              const offer = offerFactsOf(
                merchantOf(),
                typeof args['merchantOfferId'] === 'string'
                  ? { offerId: args['merchantOfferId'] }
                  : undefined,
              )
              return renderArmDetails({
                title: plan.meta?.title ?? plan.planId,
                budgetCents: parseBudgetYuan(args['budgetYuan']),
                dueAt: parseIsoTime(args['dueAt'], 'dueAt'),
                tier: parseTier(args['tier']),
                conditions: parseConditions(args['conditions']),
                ...(offer === undefined ? {} : { offer }),
                legs: legsOf(plan.nodes),
              })
            }

            if (name === 'transfer_schedule') {
              const amount = args['amount']
              if (typeof amount !== 'number' || !Number.isFinite(amount) || amount <= 0) {
                return undefined
              }
              const payeeRaw = args['payee']
              if (typeof payeeRaw !== 'object' || payeeRaw === null || Array.isArray(payeeRaw)) {
                return undefined
              }
              const payee = payeeRaw as Readonly<Record<string, unknown>>
              const payeeName = typeof payee['name'] === 'string' ? payee['name'].trim() : ''
              if (payeeName.length === 0) return undefined
              const phone =
                typeof payee['phone'] === 'string' && payee['phone'].trim().length > 0
                  ? payee['phone'].trim()
                  : undefined
              /**
               * 当日已用 / 剩余（提示词 4-1）：懒取探针 + 现读试算。
               *
               * 拿不到（无身份 / 无 `bank:tools` / 核心拒绝）就传 `undefined`，
               * `renderScheduleDetails` 会把这两行整条省略——不写 0、不拿可用余额冒充。
               */
              const probe = transferProbeOf()
              const userId = bankUserIdOf()
              const usage = await transferUsageOf(probe, userId, amount, payeeName)
              return renderScheduleDetails({
                amountCents: yuanToCents(amount),
                payeeName,
                ...(phone === undefined ? {} : { payeePhoneMasked: maskPhone(phone) }),
                dueAt: parseScheduleWhen(args['when'], clock()),
                ...(usage === undefined ? {} : { usage }),
              })
            }

            if (name === 'birthday_plan') {
              const lockYuan = readPositiveYuan(args['lockYuan'], 1000, 'birthday_plan.lockYuan')
              const flowerYuan = readPositiveYuan(args['flowerYuan'], 200, 'birthday_plan.flowerYuan')
              const cakeYuan = readPositiveYuan(args['cakeYuan'], 200, 'birthday_plan.cakeYuan')
              const { birthdayAt, dueAt } = parseBirthdayDate(args['birthday'], clock())
              // 与 `execute` 同一套搜索条件：报价来自商户域，不是入参
              const sessionKey = String(ctx.get(RUN_SERVICE).sessionId)
              const merchant = merchantOf()
              const flowerOffer = merchant?.search(
                { category: 'flower', budgetCents: yuanToCents(flowerYuan) },
                sessionKey,
              )[0]
              const cakeOffer = merchant?.search(
                { category: 'cake', budgetCents: yuanToCents(cakeYuan) },
                sessionKey,
              )[0]
              const flowerCents = flowerOffer?.priceCents ?? yuanToCents(flowerYuan)
              const cakeCents = cakeOffer?.priceCents ?? yuanToCents(cakeYuan)
              const totalCents = yuanToCents(lockYuan) + flowerCents + cakeCents
              return renderBirthdayDetails({
                birthdayAt,
                dueAt,
                lockCents: yuanToCents(lockYuan),
                ...(flowerOffer === undefined
                  ? { flowerBudgetCents: yuanToCents(flowerYuan) }
                  : {
                      flower: {
                        offerId: flowerOffer.offerId,
                        merchantName: flowerOffer.merchantName,
                        priceCents: flowerOffer.priceCents,
                      },
                    }),
                ...(cakeOffer === undefined
                  ? { cakeBudgetCents: yuanToCents(cakeYuan) }
                  : {
                      cake: {
                        offerId: cakeOffer.offerId,
                        merchantName: cakeOffer.merchantName,
                        priceCents: cakeOffer.priceCents,
                      },
                    }),
                totalCents,
                conditions: [{ kind: 'balance-at-least' as const, cents: totalCents }],
                // 与 `armOne` 实际武装的档位一致（宽档）：卡上写的档位必须等于落账的档位
                tier: 'wide',
                lockPayee: LOCK_ACCOUNT_PAYEE,
              })
            }

            // 其它 ask 工具（plan_execute / plan_disarm）没有"逐笔金额"面：
            // plan_execute 的每个节点在下面各走一次自己的审批（那里才有金额明细）。
            return undefined
          } catch {
            return undefined
          }
        }

        /**
         * 计划域三个写工具的人工批准（黄级 ask）。
         *
         * 不把 `plan_execute` 定成红级：红级会再叠加一次强验证挑战，而真正动钱的是节点，
         * 节点自己会各走一次完整审批。这一层的职责是"用户确认这张图"，不是"再验一次身份"。
         * 先 `await next()` 再包 ask：下游（bank 治理 / sentry）的 deny 永远优先。
         */
        ctx.effect(
          ctx.events.on('tools/pre-execute', async (payload: PreExecuteInput, next) => {
            // 先交还控制权：下游（bank 治理 / sentry）的 deny 永远优先
            const downstream = await next(payload)
            const asksUser =
              payload.call.name === PLAN_EXECUTE_TOOL ||
              payload.call.name === PLAN_ARM_TOOL ||
              payload.call.name === PLAN_DISARM_TOOL ||
              payload.call.name === 'transfer_schedule' ||
              payload.call.name === 'birthday_plan'
            if (!asksUser) return downstream
            if (downstream.verdict.kind !== 'allow') return downstream
            // G8：签票时就把明细交出去（用户批准的是"每一笔钱"，不是一个工具名）。
            // 明细构造失败不能让一次审批变成错误：它是展示面，读不到就整条省略。
            const details = await approvalDetailsFor(payload.call.name, payload.call.args)
            // ADR-0010：宽档 / 含红级动作 / 两个定时工具 → 这一次审批升级为**红级 + 强验证**。
            // 用户在这里做的那一次人脸（或短信）就是"到期可以无人值守"的凭据；
            // 升级只影响挑战与票据，不影响档位判定（档位仍由 `args.tier` 决定）。
            const redPreauth = needsRedPreauth(payload.call.name, payload.call.args)
            return {
              ...downstream,
              verdict: {
                kind: 'ask' as const,
                ticket: {
                  fingerprint: sha256Hex(canonicalJson(payload.call.args)),
                  ttlMs: settings.ticketTtlMs,
                  ...(details === undefined ? {} : { details }),
                },
                ...(redPreauth ? { challenge: DEFAULT_BANK_TOOLS.redChallenge } : {}),
              },
            }
          }),
        )
      }

      /**
       * `plan_wake`：扫到期计划并执行。
       *
       * **`exposure:'internal'`**：不进模型可见 schema。模型若能调它，就能对任意未到期
       * 计划发起唤醒——"主动"变成"模型想什么时候花就什么时候花"。真正的触发者是
       * 调度器（boot 补跑 + `saga/tick`）与 CLI。
       */
      const wakeTool: ToolDefinition<
        { readonly at?: string; readonly planId?: string; readonly dryRun?: boolean },
        PlanWakeReport
      > = {
        name: PLAN_WAKE_TOOL,
        description: '扫描到期计划并执行（内部工具；不暴露给模型）。',
        schema: {
          type: 'object',
          properties: {
            at: { type: 'string', description: '判定时刻（ISO 8601；缺省 = 现在）' },
            planId: { type: 'string', description: '只唤醒指定计划' },
            dryRun: { type: 'boolean', description: '只判定不执行' },
          },
        },
        tier: { level: 'yellow' },
        sideEffect: 'write',
        exposure: 'internal',
        execute: async (args) =>
          wake.wake({
            ...(args.at === undefined ? {} : { at: parseIsoTime(args.at, 'at') }),
            ...(args.planId === undefined ? {} : { planId: args.planId }),
            ...(args.dryRun === undefined ? {} : { dryRun: args.dryRun }),
            source: 'tool',
          }),
      }
      ctx.effect(registry().register(wakeTool))
    },
  },

  validate(config) {
    rejectUnknownKeys(
      config,
      [
        'enabled',
        'maxNodes',
        'maxEdges',
        'planTimeoutMs',
        'dryRunDefault',
        'ticketTtlMs',
        'maxNodeAttempts',
        'modelTools',
        'modelMaxNodes',
        'dueSoonLeadMs',
      ],
      WHERE,
    )

    const planTimeoutMs = readPositiveInteger(config, 'planTimeoutMs', WHERE) ?? DEFAULT_PLAN_TIMEOUT_MS
    const ticketTtlMs = readPositiveInteger(config, 'ticketTtlMs', WHERE) ?? DEFAULT_TICKET_TTL_MS
    const maxNodeAttempts =
      readPositiveInteger(config, 'maxNodeAttempts', WHERE) ?? DEFAULT_MAX_NODE_ATTEMPTS

    // fail-loud：这条判定是 v1 唯一能防"排队排过票据有效期还去核销"的闸
    if (planTimeoutMs >= ticketTtlMs) {
      throw bootError(
        'invalid-config',
        `${WHERE}.planTimeoutMs(${String(planTimeoutMs)}ms) 必须小于票据 TTL(${String(ticketTtlMs)}ms)：` +
          '超过票据有效期的审批会被拿去扣款，而 v1 没有 lease 可以拦住它',
        { where: WHERE, planTimeoutMs, ticketTtlMs },
      )
    }

    const maxNodes = readPositiveInteger(config, 'maxNodes', WHERE) ?? 32
    const modelMaxNodes =
      readPositiveInteger(config, 'modelMaxNodes', WHERE) ?? DEFAULT_MODEL_MAX_NODES
    if (modelMaxNodes > maxNodes) {
      throw bootError(
        'invalid-config',
        `${WHERE}.modelMaxNodes(${String(modelMaxNodes)}) 不能大于 maxNodes(${String(maxNodes)})：` +
          '模型入口不比执行器更宽',
        { where: WHERE, modelMaxNodes, maxNodes },
      )
    }

    /**
     * 提前量允许 **0**（= 关闭提醒），所以不能用 `readPositiveInteger`（它拒 0）。
     * 负值 / 小数一律 fail-loud：负数会被当成"永不提醒"的另一种写法，语义比写错更糟。
     */
    const rawDueSoon = config['dueSoonLeadMs']
    let dueSoonLeadMs = DEFAULT_DUE_SOON_LEAD_MS
    if (rawDueSoon !== undefined) {
      if (typeof rawDueSoon !== 'number' || !Number.isInteger(rawDueSoon) || rawDueSoon < 0) {
        throw bootError(
          'invalid-config',
          `${WHERE}.dueSoonLeadMs 必须是非负整数毫秒（0 = 关闭到期前提醒，收到 ${describeValue(rawDueSoon)}）`,
          { where: WHERE, key: 'dueSoonLeadMs' },
        )
      }
      dueSoonLeadMs = rawDueSoon
    }

    return {
      enabled: readBoolean(config, 'enabled', WHERE, true),
      maxNodes,
      maxEdges: readPositiveInteger(config, 'maxEdges', WHERE) ?? 128,
      planTimeoutMs,
      dryRunDefault: readBoolean(config, 'dryRunDefault', WHERE, false),
      ticketTtlMs,
      maxNodeAttempts,
      modelTools: readBoolean(config, 'modelTools', WHERE, false),
      modelMaxNodes,
      dueSoonLeadMs,
    }
  },
}
