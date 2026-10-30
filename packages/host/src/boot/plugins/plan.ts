/**
 * `plan:dag`：把「外部传入的一张工具调用 DAG」接到**七段工具管线**上。
 *
 * ## 它是什么 / 不是什么
 *
 * 是一个**编排原语**，不是规划器：plan 由宿主/脚本/上层插件构造（工具锁定 14 个，
 * 模型看不见也调不动它）。它只做四件事——校验、拓扑排序、逐节点调度、落 8 个 durable 事件。
 *
 * 与 `bank:saga-bridge` 的分工（方案 §1.3，答辩必被问）：
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

import { BANK_IDENTITY, BANK_TOOL_NAME_SET, yuanToCents } from '@bah/bank'
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
  type ToolRegistry,
  type WindowCondition,
  type WindowVerdictInputs,
  type WorldSnapshot,
} from '@bah/runtime'
import { BahError, canonicalJson, errorCodeOf, sha256Hex } from '@bah/util'

import type { HaltHandle } from '@bah/safety'
import type { TicketAuthorization } from '@bah/core'

import type { HostPlugin, ValidatedRow } from '../../plugin-manager/index.ts'
import { RUN_SERVICE } from '../boot.ts'
import { BANK_BALANCE_PROBE } from './bank-tools.ts'
import { FACT_SERVICE, type FactStore } from './fact.ts'
import { MERCHANT_SERVICE, type MerchantFulfilment } from './merchant.ts'
import {
  bootError,
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
}

/** 单行校验使用银行侧的同一个默认值；最终生效 TTL 由 `validateComposition` 再核对。 */
const DEFAULT_TICKET_TTL_MS = DEFAULT_BANK_TOOLS.ticketTtlSeconds * 1_000

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
  /** 执行摘要（`executed` 时存在）。 */
  readonly summary?: {
    readonly status: string
    readonly succeeded: number
    readonly failed: number
    readonly blocked: number
    readonly durationMs: number
  }
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

/** 内容摘要（审计只认摘要，不认原文——金额与收款人不得进日志）。 */
function digestOf(payload: unknown): string {
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
          // 授权窗口代签：整次 run 的每个节点审批都会带上它（ADR-0006）
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
          const executed = executedInstanceKeys(session.events(), candidates)
          const entries: PlanWakeEntry[] = []
          const notified: PlanWakeReport['notified'][number][] = []

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
              const decision = deriveNotify(
                notifyHistory,
                { priority: 'alert', at: now, key },
                DEFAULT_NOTIFY_BUDGET,
              )
              notified.push({ key, send: decision.send, channel: decision.channel, reason: decision.reason })
              if (decision.send) notifyHistory.push({ priority: 'alert', at: now, key })
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
              continue
            }

            if (input.dryRun === true) {
              entries.push({ ...base, status: 'skipped', reason: 'dry-run', digest: verdict.digest })
              continue
            }

            try {
              const summary = await api.run(item.plan, {
                authorization: { kind: 'window', ref: item.windowId, digest: verdict.digest },
              })
              // 商户腿：银行腿成功后串行履约（不进 DAG；失败不静默）
              let merchantLeg: MerchantFulfilment | undefined
              if (item.merchant !== undefined) {
                let merchantService
                try {
                  merchantService = ctx.get(MERCHANT_SERVICE)
                } catch {
                  merchantService = undefined
                }
                merchantLeg =
                  merchantService === undefined
                    ? {
                        status: 'failed',
                        attempts: [
                          { offerId: item.merchant.offerId, ok: false, code: 'merchant-service-missing' },
                        ],
                      }
                    : merchantService.fulfil(String(session.sessionId), item.merchant.offerId, item.budgetCents)
              }
              entries.push({
                ...base,
                status: 'executed',
                digest: verdict.digest,
                inputs: verdict.inputs,
                ...(merchantLeg === undefined ? {} : { merchant: merchantLeg }),
                summary: {
                  status: summary.status,
                  succeeded: summary.succeeded,
                  failed: summary.failed,
                  blocked: summary.blocked,
                  durationMs: summary.durationMs,
                },
              })
              const merchantFailed = merchantLeg !== undefined && merchantLeg.status !== 'ok'
              const priority = summary.failed > 0 || summary.blocked > 0 || merchantFailed ? 'alert' : 'exec'
              const decision = deriveNotify(notifyHistory, { priority, at: now, key }, DEFAULT_NOTIFY_BUDGET)
              notified.push({ key, send: decision.send, channel: decision.channel, reason: decision.reason })
              if (decision.send) notifyHistory.push({ priority, at: now, key })
            } catch (error) {
              entries.push({
                ...base,
                status: 'failed',
                reason: errorCodeOf(error, 'wake-failed'),
                digest: verdict.digest,
              })
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
              description: '授权档（缺省 standard）；红级动作永不无人执行',
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

        const arm: ToolDefinition<Readonly<Record<string, unknown>>, ArmedPlan> = {
          name: PLAN_ARM_TOOL,
          description:
            '为一张计划签发"授权窗口"：用户只需确认一次整张图，到期由系统在条件快照成立时自动执行。' +
            '只在用户明确同意"到点自动办"时使用；条件快照必须来自用户确认过的事实（预算、余额门槛、事实版本）。' +
            '红级动作（挂失等）不允许放进宽档。',
          schema: armSchema,
          tier: { level: 'yellow' },
          sideEffect: 'write',
          execute: async (args, ictx) => {
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
            if (tier === 'wide') {
              const redNodes = plan.nodes.filter((node) => {
                const spec = registry().get(node.tool)
                return spec.tier.level === 'red'
              })
              if (redNodes.length > 0) {
                throw new BahError(
                  'plan-arm-invalid',
                  `宽档不允许包含红级动作：${redNodes.map((node) => node.tool).join(', ')}`,
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
              ...(args['expiresAt'] === undefined
                ? {}
                : { expiresAt: parseIsoTime(args['expiresAt'], 'expiresAt') }),
              plan,
              armedAt: clock(),
              state: 'armed',
              ...(args['merchantOfferId'] === undefined
                ? {}
                : { merchant: { offerId: String(args['merchantOfferId']) } }),
            }
            armedStore.arm(armed)
            return armed
          },
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

        ctx.effect(registry().register(propose))
        ctx.effect(registry().register(execute))

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
              payload.call.name === PLAN_DISARM_TOOL
            if (!asksUser) return downstream
            if (downstream.verdict.kind !== 'allow') return downstream
            return {
              ...downstream,
              verdict: {
                kind: 'ask' as const,
                ticket: {
                  fingerprint: sha256Hex(canonicalJson(payload.call.args)),
                  ttlMs: settings.ticketTtlMs,
                },
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
    }
  },
}
