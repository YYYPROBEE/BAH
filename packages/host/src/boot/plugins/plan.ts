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

import { BANK_TOOL_NAME_SET, yuanToCents } from '@bah/bank'
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
  type Plan,
  type PlanAbortReason,
  type PlanApi,
  type PlanEventType,
  type PlanInvoker,
  type PlanNode,
  type PlanResumeOptions,
  type PlanRunSnapshot,
  type PlanRunSummary,
  type PreExecuteInput,
  type ToolDefinition,
  type ToolRegistry,
} from '@bah/runtime'
import { BahError, canonicalJson, sha256Hex } from '@bah/util'

import type { HaltHandle } from '@bah/safety'

import type { HostPlugin, ValidatedRow } from '../../plugin-manager/index.ts'
import { RUN_SERVICE } from '../boot.ts'
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
        run(plan: Plan, options?: { readonly dryRun?: boolean }): Promise<PlanRunSummary> {
          const dryRun = options?.dryRun ?? settings.dryRunDefault

          const halted = haltedSummary(plan, dryRun)
          if (halted !== undefined) return Promise.resolve(halted)

          return withRunSlot(plan.planId, (signal) =>
            engine.run(plan, {
              dryRun,
              signal,
              // 发起方一律取会话：`PlanApi.run` 不接受这个参数（方案 §5「额外一条」）
              initiator: ctx.get(SESSION_SERVICE).sessionId,
            }),
          )
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

      /**
       * B1：模型可见的规划入口。
       *
       * 两个工具都**只接受银行工具目录内的节点**；`plan_execute` 还要过一次人工审批
       * （黄级 ask），它内部调用的 `PlanApi.run()` 会让每个节点**再各走一次** ToolPipeline。
       * 也就是说：模型能提出 DAG，但不能绕过任何一层审批 / Sentry / 审计 / 沙箱。
       */
      if (settings.modelTools) {
        const modelPlanLimit = Math.min(settings.maxNodes, settings.modelMaxNodes)

        const planOrThrow = (raw: unknown, callId: string): Plan => {
          const parsed = parseModelPlan(raw, `plan-${callId}`, modelPlanLimit)
          const issues =
            parsed.plan === undefined
              ? parsed.issues
              : [...parsed.issues, ...engine.validate(parsed.plan)]
          if (parsed.plan === undefined || issues.length > 0) {
            const first = issues[0]
            throw new BahError(
              'plan-invalid',
              `模型提交的计划校验失败（${String(issues.length)} 项）：${first?.message ?? '未知问题'}`,
              { issues },
            )
          }
          return parsed.plan
        }

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

        ctx.effect(registry().register(propose))
        ctx.effect(registry().register(execute))

        /**
         * `plan_execute` 的人工批准（黄级 ask）。
         *
         * 不把 `plan_execute` 定成红级：红级会再叠加一次强验证挑战，而真正动钱的是节点，
         * 节点自己会各走一次完整审批。这一层的职责是"用户确认这张图"，不是"再验一次身份"。
         * 先 `await next()` 再包 ask：下游（bank 治理 / sentry）的 deny 永远优先。
         */
        ctx.effect(
          ctx.events.on('tools/pre-execute', async (payload: PreExecuteInput, next) => {
            const downstream = await next(payload)
            if (payload.call.name !== PLAN_EXECUTE_TOOL) return downstream
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
