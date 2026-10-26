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

import { defineService } from '@bah/core'
import { HALT_SERVICE } from '@bah/safety'
import {
  SESSION_SERVICE,
  TOOLS_SERVICE,
  PLAN_INCIDENT_CODE,
  PlanEngine,
  ToolGuard,
  ToolPipeline,
  planDigest,
  type Plan,
  type PlanAbortReason,
  type PlanApi,
  type PlanEventType,
  type PlanInvoker,
  type PlanResumeOptions,
  type PlanRunSnapshot,
  type PlanRunSummary,
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

    return {
      enabled: readBoolean(config, 'enabled', WHERE, true),
      maxNodes: readPositiveInteger(config, 'maxNodes', WHERE) ?? 32,
      maxEdges: readPositiveInteger(config, 'maxEdges', WHERE) ?? 128,
      planTimeoutMs,
      dryRunDefault: readBoolean(config, 'dryRunDefault', WHERE, false),
      ticketTtlMs,
      maxNodeAttempts,
    }
  },
}
