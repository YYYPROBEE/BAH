/**
 * `plan:dag` 编排引擎（方案 §3.4 / §3.9 / §4.2）。
 *
 * 状态驱动 + 拓扑串行 + 一次性失败闭包。**不认识的**：任何宿主包、任何 I/O、任何时钟
 * （时钟由 `now()` 注入，`Date.now()` 在本目录被门禁禁止——恢复路径的对齐靠它）。
 *
 * 续跑（W10）**只从会话事件重放**：`history()` 由宿主注入 `session.events()`，
 * 引擎自己不做任何持久化，也不猜"上次应该跑到哪"。
 *
 * 三条容易写错的地方，都在下面用 `★` 标出：
 * 1. `blocked` 与 `skipped` **也要入队**（否则只传一层，孙节点永远 `pending`，
 *    `total` 不等于各状态之和）；
 * 2. `skipped` 算依赖满足，所以它**不继续传播**（optional 的意义就在这）；
 * 3. `blocked > 0` 必须判定为 `failed`（否则一个全被 block 的计划会报成功）。
 */

import { BahError, canonicalJson, errorCodeOf, reasonOf, sha256Hex } from '@bah/util'

import { transition } from './machine.ts'
import { collectTemplateRefs, resolveTemplateArgs } from './template.ts'
import { kahnSort } from './topo.ts'
import {
  PLAN_ARGS_UNRESOLVED_CODE,
  PLAN_INCIDENT_CODE,
  PLAN_RESUME_ERRORS,
  TERMINAL_STATES,
  nodeStateFromResult,
} from './types.ts'
import { validatePlan } from './validate.ts'

import type { PlanEventData, PlanEventRecord, PlanEventType } from './events.ts'
import type {
  Plan,
  PlanAbortReason,
  PlanInvoker,
  PlanIssue,
  PlanNode,
  PlanNodeOutcome,
  PlanNodeSnapshot,
  PlanNodeState,
  PlanResumeRunOptions,
  PlanRunOptions,
  PlanRunSnapshot,
  PlanRunStatus,
  PlanRunSummary,
} from './types.ts'

/** 引擎依赖（全部显式注入：单测替换时钟与 invoker，不必起宿主）。 */
export interface PlanEngineOptions {
  /** 唯一宿主依赖：一次节点执行。 */
  readonly invoker: PlanInvoker
  /** 事件出口（宿主接 `session.appendDomain`）。 */
  readonly emit: (type: PlanEventType, data: unknown) => void
  /** 时钟注入（**禁止**内部 `Date.now()`）。 */
  readonly now: () => number
  /** 节点数上限（配置面）。 */
  readonly maxNodes: number
  /** 边数上限（配置面）。 */
  readonly maxEdges: number
  /** 工具已注册判定（宿主注入 `(n) => registry.has(n)`）。 */
  readonly hasTool: (name: string) => boolean
  /**
   * 持久化决策（形态抄 Mastra 的 `shouldPersistSnapshot`）：**决策是回调，不是 `if (env)`**。
   *
   * 引擎不知道 `dryRun` 是什么；宿主传 `(state) => state.dryRun !== true`，
   * dry-run 因此不进"已完成的 run 表"，也就不会被 `snapshot()` 当成真实执行留档。
   * 缺省恒 `true`。
   */
  readonly shouldPersist?: (state: PlanRunSnapshot) => boolean
  /**
   * 会话事件只读视图（`resume` 重放用；`run` 不读）。
   *
   * **必填，不给"缺省空数组"**：缺省会让"忘了接"与"真的没有历史"都表现成
   * `plan-replay-incomplete`，而后者是安全行为、前者是装配 bug——两者必须在
   * 编译期就分开（同 `trace.sink` 的取舍）。
   */
  readonly history: () => readonly PlanEventRecord[]
  /**
   * 同一节点允许的**失败次数上限**（含首次运行；按 `plan/node-result(status='failed')` 累计）。
   *
   * **必填**：给个 `Infinity` 缺省等于"保护默认关闭"，而这种默认在银行场景里是最坏的一种。
   *
   * 口径刻意是"失败 N 次"而不是"重试 N 次"：`node-result` 里区分不出"这次失败是首次还是第 4 次"，
   * 硬要算重试次数就得再引入一个状态，而那个状态会和事件窗口裁剪打架（裁剪后计数就不可信）。
   */
  readonly maxNodeAttempts: number
}

/** 一次 run 的引擎内存态（不落盘）。 */
interface RunRecord {
  readonly planId: string
  readonly digest: string
  readonly dryRun: boolean
  readonly nodes: ReadonlyMap<string, PlanNode>
  readonly dependents: ReadonlyMap<string, readonly PlanNode[]>
  readonly ordinal: ReadonlyMap<string, number>
  readonly order: readonly string[]
  readonly controller: AbortController
  readonly startedAt: number
  readonly states: Map<string, PlanNodeState>
  /**
   * 节点 → 本进程内已派发次数（跨窗口基线来自 `PlanReplay.starts`）。
   *
   * 只服务于 `callId` 的第 3 段：`resume(from: X)` 重跑 X 时必须换一个 callId，
   * 否则票据 ID（按 callId 派生）会与首次执行撞号。
   */
  readonly attempts: Map<string, number>
  /**
   * 节点 id → 工具返回值（**只在内存**，进不了任何事件）。
   *
   * 动态 args 的唯一数据源。之所以只能放内存：output 里有金额与收款人，
   * 落 append-only 日志就等于把业务原文写进审计。代价是**跨不了 resume 窗口**
   * （见 `resume()` 的 `plan-resume-args-unresolved` 判定）。
   */
  readonly outputs: Map<string, unknown>
  readonly codes: Map<string, string>
  readonly durations: Map<string, number>
  status: PlanRunStatus
  currentNode?: string
  abortedAtNode?: string
  abortReason?: PlanAbortReason
  finishedAt?: number
}

/** 计数面（`plan/completed` 的载荷与返回值同源）。 */
interface RunCounts {
  readonly total: number
  readonly succeeded: number
  readonly failed: number
  readonly blocked: number
  readonly skipped: number
  readonly cancelled: number
}

/**
 * 一次执行的**进入方式**。
 *
 * `run` 与 `resume` 的区别只有两处：落哪个起点事件、初始节点状态从哪来。
 * 调度循环、失败传播、收尾计数**只有一份**——复制一份循环，两条路径迟早会走岔。
 */
type Entry =
  | { readonly kind: 'run' }
  | {
      readonly kind: 'resume'
      /** 重放 + 过滤后的初始状态（没出现在表里的节点 = `pending`）。 */
      readonly seed: ReadonlyMap<string, PlanNodeState>
      /** 因上次已 `succeeded` 而跳过的节点数。 */
      readonly skipped: number
      /** 本次显式授权重跑的节点。 */
      readonly resumedFrom: readonly string[]
      /** 重放得到的每节点 `plan/node-started` 历史次数（callId 的 attempt 基线）。 */
      readonly attempts: ReadonlyMap<string, number>
    }

/** 引擎（无状态之外的一切都在实例上：`inflight` 是进程内单写者）。 */
export class PlanEngine {
  private readonly invoker: PlanInvoker
  private readonly sink: (type: PlanEventType, data: unknown) => void
  private readonly now: () => number
  private readonly maxNodes: number
  private readonly maxEdges: number
  private readonly hasTool: (name: string) => boolean
  private readonly shouldPersist: (state: PlanRunSnapshot) => boolean
  private readonly history: () => readonly PlanEventRecord[]
  private readonly maxNodeAttempts: number

  /** 在跑的 run（`planId` → 记录）：**单写者**，没有它 Web 双请求会让同一 plan 双扣款。 */
  private readonly active = new Map<string, RunRecord>()

  /** 已完成的 run 快照（dry-run 由 `shouldPersist` 拦在门外）。 */
  private readonly finished = new Map<string, PlanRunSnapshot>()

  private disposed = false

  constructor(options: PlanEngineOptions) {
    this.invoker = options.invoker
    this.sink = options.emit
    this.now = options.now
    this.maxNodes = options.maxNodes
    this.maxEdges = options.maxEdges
    this.hasTool = options.hasTool
    this.shouldPersist = options.shouldPersist ?? (() => true)
    this.history = options.history
    this.maxNodeAttempts = options.maxNodeAttempts
  }

  /**
   * 校验一张计划（不执行）。
   *
   * 单独暴露给宿主做"预检接口"用：校验与执行**共用同一份规则**，不允许宿主自己再写一遍。
   */
  validate(plan: Plan): PlanIssue[] {
    return validatePlan(plan, {
      maxNodes: this.maxNodes,
      maxEdges: this.maxEdges,
      hasTool: this.hasTool,
    })
  }

  /**
   * 执行一张计划（串行、拓扑序、一次性失败闭包）。
   *
   * @throws `BahError('plan-disposed')` 引擎已 dispose
   * @throws `BahError('plan-already-running')` 同一 `planId` 已在跑（单写者）
   * @throws `BahError('plan-invalid')` 校验未通过（`detail.issues` 是全量清单）
   */
  async run(plan: Plan, options: PlanRunOptions): Promise<PlanRunSummary> {
    this.guard(plan)
    return this.execute(plan, options, { kind: 'run' })
  }

  /**
   * 从上次运行结果接着跑（**只从会话事件重放**，没有跨进程持久化）。
   *
   * 三条过滤规则（顺序即优先级）：
   * 1. `succeeded` → 跳过：**永不重跑**（重跑 = 二次扣款；`from` 也改不了这一条）；
   * 2. `failed` → 不自动重试，只有 `options.from` 点名才重置为 `pending`；
   * 3. `blocked` / `skipped` / `cancelled` / 悬空 `running` / **`incident`** → 重置为 `pending` 重新调度。
   *
   * 第 3 条为什么把这些都重置：它们**一次都没执行成功**（`skipped` 的定义就是"调度过没执行"），
   * 且上次的结论依赖当时的上游/外部状态——上游这次可能已经被修好了，依赖方也可能恢复了。
   * 留着不动会让审计说"这个节点被上游卡住"，而那个上游其实已经成功。
   *
   * ★ `incident` 落在第 3 条（W11）：它与 `failed` 的**唯一区别**就是这条——
   * "外部不可用"不是"这个节点不行"，人工修好外部条件后 `resume` 应当自动重跑，
   * 不需要像 `failed` 那样逐个点名。
   *
   * @throws `BahError('plan-identity-mismatch')` 计划被改过（digest 对不上）
   * @throws `BahError('plan-replay-incomplete')` 事件窗口不完整（没有 plan/created / 没收尾 / 缺中间结果）
   * @throws `BahError('plan-resume-target-missing')` `from` 指向不存在的节点
   * @throws `BahError('plan-resume-retry-exhausted')` 该节点失败次数已达 `maxNodeAttempts`
   * @throws `BahError('plan-disposed')` / `BahError('plan-already-running')` / `BahError('plan-invalid')` 同 `run()`
   */
  async resume(plan: Plan, options: PlanResumeRunOptions): Promise<PlanRunSummary> {
    this.guard(plan)

    const known = new Set(plan.nodes.map((node) => node.id))
    const from = options.from ?? []
    const missing = from.filter((nodeId) => !known.has(nodeId))
    if (missing.length > 0) {
      throw new BahError(
        PLAN_RESUME_ERRORS.targetMissing,
        `plan ${plan.planId} 的 resume 指名了计划里不存在的节点：${missing.join(', ')}`,
        { planId: plan.planId, from: missing },
      )
    }

    const digest = planDigest(plan)
    const replay = replayPlan(this.history(), plan.planId)

    // 连 plan/created 都没有：要么窗口被裁剪，要么这张计划从没在本会话跑过（那是 run 的事）
    if (!replay.sawCreated) {
      throw new BahError(
        PLAN_RESUME_ERRORS.replayIncomplete,
        `plan ${plan.planId} 没有可续跑的 plan/created：窗口被裁剪或计划从未在本会话执行`,
        { planId: plan.planId },
      )
    }
    if (replay.digest !== digest) {
      throw new BahError(
        PLAN_RESUME_ERRORS.identityMismatch,
        `plan ${plan.planId} 身份不一致（记录 ${String(replay.digest)} ≠ 本次 ${digest}）：` +
          'resume 只续同一份计划，改过 args 就是另一张计划',
        { planId: plan.planId, recorded: replay.digest, actual: digest },
      )
    }
    if (!replay.closed) {
      throw new BahError(
        PLAN_RESUME_ERRORS.replayIncomplete,
        `plan ${plan.planId} 的上次运行没有收尾事件（plan/completed / plan/aborted）：` +
          '窗口被裁剪或进程中断，重放不完整',
        { planId: plan.planId },
      )
    }
    const terminals = countTerminals(replay.states)
    if (replay.expectedTerminals !== undefined && terminals < replay.expectedTerminals) {
      throw new BahError(
        PLAN_RESUME_ERRORS.replayIncomplete,
        `plan ${plan.planId} 的事件窗口缺了中间结果：` +
          `重放到 ${String(terminals)} 个终态，plan/completed 声明 ${String(replay.expectedTerminals)} 个`,
        { planId: plan.planId, replayed: terminals, expected: replay.expectedTerminals },
      )
    }

    /**
     * 重试上限：只对**真的会被重试**的节点判（`failed` / 悬空 `running` 且在 `from` 里）。
     *
     * 为什么放在完整性判据**之后**：计数是从重放里数出来的，窗口不完整时那个数本身就不可信——
     * 先报"日志坏了"比先报"重试超限"更接近真相（后者会让运维去改计划，而问题在日志）。
     *
     * 为什么 `succeeded` 不在判定范围：它根本不会被重跑，点名也只是空操作；
     * 对一个空操作报"重试超限"是纯噪音。
     */
    const retriable = (nodeId: string): boolean => {
      const state = replay.states.get(nodeId)
      return state === 'failed' || state === 'running'
    }
    const exhausted = from
      .filter((nodeId) => retriable(nodeId) && (replay.failures.get(nodeId) ?? 0) >= this.maxNodeAttempts)
      .map((nodeId) => ({ nodeId, failures: replay.failures.get(nodeId) ?? 0 }))
    if (exhausted.length > 0) {
      throw new BahError(
        PLAN_RESUME_ERRORS.retryExhausted,
        `plan ${plan.planId} 的节点失败次数已达上限 ${String(this.maxNodeAttempts)}：` +
          exhausted.map((item) => `${item.nodeId}(${String(item.failures)} 次)`).join('、') +
          '——反复重试要换新的 planId（新计划 + 冲正），不许在同一个 planId 上无限续',
        { planId: plan.planId, maxNodeAttempts: this.maxNodeAttempts, exhausted },
      )
    }

    const retry = new Set(from)
    const seed = new Map<string, PlanNodeState>()
    let skipped = 0
    for (const [nodeId, state] of replay.states) {
      // 计划里已不存在的节点不参与（digest 相等时不该出现，防御而已）
      if (!known.has(nodeId)) continue
      if (state === 'succeeded') {
        seed.set(nodeId, 'succeeded')
        skipped += 1
        continue
      }
      // `running` = 上次进程中断在节点内部，结果未知：按 failed 处理（不许自动重跑）
      if (state === 'failed' || state === 'running') {
        seed.set(nodeId, retry.has(nodeId) ? 'pending' : 'failed')
        continue
      }
      // `blocked` / `skipped` / `cancelled` / `incident` 都落到这里：一次都没成功，重排
      seed.set(nodeId, 'pending')
    }
    // ★ 把 seed **补全**到"计划里的每个节点都有值"：重放没提到过的节点（上次被 cancel、
    //   或从没跑到）在 `createRun()` 里等价于 pending，这里也是。补全的理由不是好看——
    //   下面那个"动态 args 会不会解析得出来"的判定必须与 `createRun()` 对"会不会执行"
    //   给同一个答案，否则判定面与执行面各说一套（第二真相源）。
    for (const node of plan.nodes) {
      if (!seed.has(node.id)) seed.set(node.id, 'pending')
    }

    /**
     * 动态 args × 续跑（W11）：**待执行的节点**引用了本次会被跳过的上游 → 直接拒绝。
     *
     * 为什么只能拒：`output` 只在内存里（不进事件），被跳过的上游没有 output 可解析；
     * 而"连带重跑上游"= 二次扣款（W10 不变量），"把 output 落事件"= 金额与收款人进日志。
     * 第四种做法（跑到那个节点才 failed）在串行计划里等于"已经转出一笔才发现参数废了"。
     *
     * 为什么在 seed 之后判、且只看 `pending`：引用方自己若已 `succeeded`（本次不跑）、
     * 或它是 `failed` 且未被 `from` 点名（也不跑），模板根本不会被解析——一刀切会误拒。
     *
     * **保守方向**：引用方若本就注定被上游 `failed` 拖成 `blocked`，这里仍会拒。
     * 这是刻意的——宁可少一条恢复路径，也不引入第二套"它到底会不会执行"的推演模型
     * （那套模型一旦与 `propagate()` 分叉，就是第二个真相源）。
     */
    const unresolvedRefs: { readonly nodeId: string; readonly ref: string }[] = []
    for (const node of plan.nodes) {
      if (seed.get(node.id) !== 'pending') continue
      for (const ref of collectTemplateRefs(node.args)) {
        if (seed.get(ref.nodeId) === 'succeeded') {
          unresolvedRefs.push({ nodeId: node.id, ref: ref.raw })
        }
      }
    }
    if (unresolvedRefs.length > 0) {
      throw new BahError(
        PLAN_RESUME_ERRORS.argsUnresolved,
        `plan ${plan.planId} 的续跑会让动态 args 解析不出来：` +
          unresolvedRefs.map((item) => `${item.nodeId} 引用 ${item.ref}`).join('、') +
          '——上游已 succeeded、本次会被跳过，它的 output 只在内存里（不进事件）。' +
          '要重做请换新的 planId（新计划 + 冲正），不要在同一张计划上续',
        { planId: plan.planId, unresolved: unresolvedRefs },
      )
    }

    return this.execute(
      plan,
      {
        ...(options.signal === undefined ? {} : { signal: options.signal }),
        initiator: options.initiator,
      },
      { kind: 'resume', seed, skipped, resumedFrom: from, attempts: replay.starts },
    )
  }

  /**
   * 入口守卫：已下线 / 同 `planId` 在跑 / 计划本身不合法。
   *
   * **顺序是契约**：`plan-already-running` 必须早于重放，否则 TC-W10-06 会报成
   * "窗口未收尾"——那是把"正在跑"误诊成"日志坏了"。
   */
  private guard(plan: Plan): void {
    if (this.disposed) {
      throw new BahError('plan-disposed', 'plan 引擎已 dispose，不能再执行计划', {
        planId: plan.planId,
      })
    }
    if (this.active.has(plan.planId)) {
      throw new BahError(
        'plan-already-running',
        `plan ${plan.planId} 正在执行（单写者：同一 plan 不允许并发或重入）`,
        { planId: plan.planId },
      )
    }

    const issues = this.validate(plan)
    if (issues.length > 0) {
      throw new BahError(
        'plan-invalid',
        `plan ${plan.planId} 校验失败（${String(issues.length)} 项）：${issues[0]?.message ?? ''}`,
        { planId: plan.planId, issues },
      )
    }
  }

  /** `run` / `resume` 共用的执行体（差别只有起点事件与初始状态）。 */
  private async execute(
    plan: Plan,
    options: PlanRunOptions,
    entry: Entry,
  ): Promise<PlanRunSummary> {
    const run = this.createRun(
      plan,
      options,
      entry.kind === 'resume' ? entry.seed : undefined,
      entry.kind === 'resume' ? entry.attempts : undefined,
    )
    this.active.set(plan.planId, run)

    const external = options.signal
    const onExternalAbort = (): void => {
      // 宿主只为一个原因 abort 外部信号：超时（`planTimeoutMs`）
      this.requestAbort(run, 'timeout')
    }
    if (external !== undefined) {
      // 已经在 abort 状态的信号不会再触发事件（事件早已派发完），必须显式补一次
      if (external.aborted) onExternalAbort()
      else external.addEventListener('abort', onExternalAbort, { once: true })
    }

    try {
      if (entry.kind === 'run') {
        this.emitEvent('plan/created', {
          planId: run.planId,
          nodes: plan.nodes.length,
          edges: edgesOf(plan.nodes),
          dryRun: run.dryRun,
          digest: run.digest,
          initiator: options.initiator,
          at: this.now(),
        })
      } else {
        // 续跑不重发 plan/created：那不是"新建了一张计划"，重发会让审计数出两张
        this.emitEvent('plan/resumed', {
          planId: run.planId,
          digest: run.digest,
          skipped: entry.skipped,
          resumedFrom: entry.resumedFrom,
          at: this.now(),
        })
      }

      for (const nodeId of run.order) {
        // ★ 每个节点**执行前**检查取消：取消后不再调度任何新节点
        if (run.controller.signal.aborted) {
          this.cancelRemaining(run)
          break
        }
        if (run.states.get(nodeId) !== 'pending') continue // 已被传播成 blocked / skipped / cancelled
        const node = run.nodes.get(nodeId)
        if (node === undefined) continue
        // 防御：正常路径由 propagate 保证；走到这里说明传播漏了，仍然不能放行
        if (!this.depsSatisfied(run, node)) {
          if (this.blockOrSkip(run, node) === 'blocked') this.propagate(run, node.id)
          continue
        }
        await this.dispatch(run, node)
      }

      return this.finish(run)
    } finally {
      if (external !== undefined) external.removeEventListener('abort', onExternalAbort)
      this.active.delete(run.planId)
    }
  }

  /**
   * 置取消信号。
   *
   * **已进入的节点跑完**（不伪造半途中断，与 `saga-bridge` 同一取舍）：
   * 取消只在"下一个节点是否开始"这个决策点上生效。
   *
   * @returns 是否命中在跑的 run（false = 没有这个 plan 或已结束）
   */
  cancel(planId: string, reason: PlanAbortReason = 'cancelled'): boolean {
    const run = this.active.get(planId)
    if (run === undefined) return false
    this.requestAbort(run, reason)
    return true
  }

  /** 运行中或已完成的快照。 */
  snapshot(planId: string): PlanRunSnapshot | undefined {
    const run = this.active.get(planId)
    if (run !== undefined) return this.snapshotOf(run)
    return this.finished.get(planId)
  }

  /** 引擎下线：在跑的 run 全部 abort（`reason: 'disposed'`），此后 `run()` 直接抛。 */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    for (const run of this.active.values()) this.requestAbort(run, 'disposed')
  }

  /* ── 内部：装配与推进 ─────────────────────────────────────────────── */

  private createRun(
    plan: Plan,
    options: PlanRunOptions,
    seed?: ReadonlyMap<string, PlanNodeState>,
    attempts?: ReadonlyMap<string, number>,
  ): RunRecord {
    const { order } = kahnSort(plan.nodes)
    const nodes = new Map<string, PlanNode>()
    const dependents = new Map<string, PlanNode[]>()
    const ordinal = new Map<string, number>()
    const states = new Map<string, PlanNodeState>()

    for (const node of plan.nodes) {
      nodes.set(node.id, node)
      dependents.set(node.id, [])
      // seed 只来自重放（resume），是**上次已经发生的事实**，不走 `transition()`
      states.set(node.id, seed?.get(node.id) ?? 'pending')
    }
    for (const node of plan.nodes) {
      for (const dep of new Set(node.deps)) {
        if (dep === node.id) continue
        dependents.get(dep)?.push(node)
      }
    }
    // 依赖遍历顺序固定（字典序），否则同一张图的失败传播顺序依赖构造顺序
    for (const list of dependents.values()) list.sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0))
    order.forEach((id, index) => ordinal.set(id, index + 1))

    return {
      planId: plan.planId,
      digest: planDigest(plan),
      dryRun: options.dryRun ?? false,
      nodes,
      dependents,
      ordinal,
      order,
      controller: new AbortController(),
      startedAt: this.now(),
      states,
      // attempt 基线：首次运行是空表（每个节点从 1 开始），续跑带上次的重放计数
      attempts: new Map<string, number>(attempts ?? []),
      outputs: new Map<string, unknown>(),
      codes: new Map<string, string>(),
      durations: new Map<string, number>(),
      status: 'running',
    }
  }

  /** 调度一个节点：ready → running → 执行 → 终态。 */
  private async dispatch(run: RunRecord, node: PlanNode): Promise<void> {
    if (run.dryRun) {
      // ★ dry-run 在 invoker **之前**短路：走管线就会签票据、落 tool/call、触发 approval/asked，
      //   审计里出现"预览了一次转账"的假记录（方案 §0.3 硬约束 3）。
      //
      // 状态走 `pending → skipped`（不经过 ready/running）：dry-run 里没有任何节点"开始执行"过，
      // 落 `plan/node-started` 就是在编造一个没发生的事实。`skipped` 在方案 §3.5 里的定义
      // 恰好是"调度过、没执行"，`plan/node-result` 的 `code: 'plan-dry-run'` 说明原因。
      this.settle(run, node.id, 'skipped', 'plan-dry-run', 0)
      this.emitEvent('plan/node-result', {
        planId: run.planId,
        nodeId: node.id,
        status: 'skipped',
        code: 'plan-dry-run',
        durationMs: 0,
        at: this.now(),
      })
      return
    }

    const ordinal = run.ordinal.get(node.id) ?? 0

    this.move(run, node.id, 'ready')
    this.move(run, node.id, 'running')
    run.currentNode = node.id

    // ★ 入参替换在 `plan/node-started` **之前**：解析不出来 = 这个节点根本没被派发，
    //   落一条 started 就是在编造"它开始执行了"（与 dry-run 不落 node-started 同一取舍）。
    //   `outputs` 只存在于本次 run 的内存里，所以 resume 跳过的上游在这里必然取不到值
    //   —— 那种情况在 `resume()` 入口就被拒了（`plan-resume-args-unresolved`），不会走到这。
    const resolution = resolveTemplateArgs(node.args, run.outputs)
    if (!resolution.ok) {
      run.currentNode = undefined
      this.settle(run, node.id, 'failed', PLAN_ARGS_UNRESOLVED_CODE, 0)
      this.emitEvent('plan/node-result', {
        planId: run.planId,
        nodeId: node.id,
        status: 'failed',
        code: PLAN_ARGS_UNRESOLVED_CODE,
        durationMs: 0,
        at: this.now(),
      })
      this.propagate(run, node.id)
      return
    }
    const effective: PlanNode = resolution.args === node.args ? node : { ...node, args: resolution.args }

    // ★ attempt 只在**真正派发**时才递增：上面的 args 解析失败分支没有落 `plan/node-started`，
    //   在那里递增会让 callId 跳号（`PlanReplay.starts` 从 node-started 数，数不出那个号）。
    //   递增的必要性是票据层面的：票据 ID 按 callId 派生，`resume(from: X)` 重跑 X 若沿用
    //   `#1`，第二次执行就会复用第一张票据的账本行。
    const attempt = (run.attempts.get(node.id) ?? 0) + 1
    run.attempts.set(node.id, attempt)
    const callId = `${run.planId}#${node.id}#${String(attempt)}`

    this.emitEvent('plan/node-started', {
      planId: run.planId,
      nodeId: node.id,
      tool: node.tool,
      ordinal,
      callId,
      at: this.now(),
    })

    const startedAt = this.now()
    let outcome: PlanNodeOutcome
    try {
      outcome = await this.invoker(effective, {
        planId: run.planId,
        nodeId: node.id,
        callId,
        ordinal,
        signal: run.controller.signal,
      })
    } catch (error) {
      // 契约上 invoker 不抛（ToolPipeline 内部已归一化）；真抛了也不能把整个 plan 拖死
      outcome = {
        isError: true,
        code: errorCodeOf(error, 'plan-invoker-failed'),
        summary: reasonOf(error),
      }
    }
    const durationMs = this.now() - startedAt
    run.currentNode = undefined

    // 审批等待（W11）：宿主测的、注入钟上的事后值；先于 node-result（时间线是"等完 → 出结果"）。
    // `Number.isFinite` 兜住 NaN/Infinity：事件载荷里出现 NaN 会让 JSONL 回放不可解析。
    if (outcome.waitedMs !== undefined) {
      this.emitEvent('plan/node-waiting', {
        planId: run.planId,
        nodeId: node.id,
        waitedMs:
          Number.isFinite(outcome.waitedMs) && outcome.waitedMs > 0 ? Math.trunc(outcome.waitedMs) : 0,
        at: this.now(),
      })
    }

    if (outcome.isError) {
      // `incident`：宿主声明"外部不可用、需人工介入"。载荷仍是三值里的 `failed`（W02 冻结），
      // 区分靠 code；而 code **由引擎写**——工具返回任意字符串都伪造不出这个状态。
      const incident = outcome.incident === true
      const code = incident ? PLAN_INCIDENT_CODE : (outcome.code ?? 'tool-failed')
      this.settle(run, node.id, incident ? 'incident' : 'failed', code, durationMs)
      this.emitEvent('plan/node-result', {
        planId: run.planId,
        nodeId: node.id,
        status: 'failed',
        code,
        durationMs,
        at: this.now(),
      })
      this.propagate(run, node.id)
      return
    }

    // 成功后立刻留 output：下游的 `${node.<id>.<path>}` 只能从这里取
    run.outputs.set(node.id, outcome.output)
    this.settle(run, node.id, 'succeeded', undefined, durationMs)
    this.emitEvent('plan/node-result', {
      planId: run.planId,
      nodeId: node.id,
      status: 'succeeded',
      digest: outcome.summary,
      durationMs,
      at: this.now(),
    })
  }

  /**
   * 一次性失败闭包（不逐轮）：宽搜沿"依赖边"往下传。
   *
   * ★ `blocked` 与 `skipped` 都要处理下游语义：
   * - `skipped`（optional）**不继续传播**，且下游把它当"满足"；
   * - `blocked` **继续传播**，否则只传一层。
   */
  private propagate(run: RunRecord, failedId: string): void {
    const queue: string[] = [failedId]
    while (queue.length > 0) {
      const upstream = queue.shift() as string
      for (const node of run.dependents.get(upstream) ?? []) {
        if (run.states.get(node.id) !== 'pending') continue
        if (this.blockOrSkip(run, node) === 'blocked') queue.push(node.id)
      }
    }
  }

  /** 把节点落成 `blocked` 或 `skipped`（optional），并落事件。 */
  private blockOrSkip(run: RunRecord, node: PlanNode): 'blocked' | 'skipped' {
    const blockedBy = this.blockedBy(run, node)
    const reason = this.blockReason(run, blockedBy)

    if (node.optional === true) {
      this.settle(run, node.id, 'skipped', reason, 0)
      this.emitEvent('plan/node-result', {
        planId: run.planId,
        nodeId: node.id,
        status: 'skipped',
        code: reason,
        durationMs: 0,
        at: this.now(),
      })
      return 'skipped'
    }

    this.move(run, node.id, 'blocked')
    this.emitEvent('plan/node-blocked', {
      planId: run.planId,
      nodeId: node.id,
      blockedBy,
      reason,
      at: this.now(),
    })
    return 'blocked'
  }

  /** 直接上游里处于 failed / blocked / cancelled 的那些（审计要能解释"为什么"）。 */
  private blockedBy(run: RunRecord, node: PlanNode): readonly string[] {
    return node.deps.filter((dep) => {
      const state = run.states.get(dep)
      return state === 'failed' || state === 'blocked' || state === 'cancelled'
    })
  }

  /** 归因：有 failed 就是 `upstream-failed`，否则看 cancelled，剩下的才是 `upstream-blocked`。 */
  private blockReason(
    run: RunRecord,
    blockedBy: readonly string[],
  ): 'upstream-failed' | 'upstream-blocked' | 'upstream-cancelled' {
    const states = blockedBy.map((dep) => run.states.get(dep))
    if (states.includes('failed')) return 'upstream-failed'
    if (states.includes('cancelled')) return 'upstream-cancelled'
    return 'upstream-blocked'
  }

  /** 依赖是否满足：★ `skipped` 算满足（optional 的容忍要传给下游）。 */
  private depsSatisfied(run: RunRecord, node: PlanNode): boolean {
    return node.deps.every((dep) => {
      const state = run.states.get(dep)
      return state === 'succeeded' || state === 'skipped'
    })
  }

  /** 取消后剩余节点一律 `cancelled`（不是 `pending`：留在 pending 会让计数对不上）。 */
  private cancelRemaining(run: RunRecord): void {
    for (const nodeId of run.order) {
      const state = run.states.get(nodeId)
      if (state === 'pending' || state === 'ready' || state === 'running') {
        this.settle(run, nodeId, 'cancelled', 'plan-aborted', 0)
      }
    }
  }

  /** 收尾：判定 status、落 `plan/aborted` + `plan/completed`、留存快照。 */
  private finish(run: RunRecord): PlanRunSummary {
    const counts = this.counts(run)
    // ★ blocked 也算失败：否则全被 block 的计划会报 "计划完成"
    const status: Exclude<PlanRunStatus, 'running'> =
      run.abortReason !== undefined
        ? 'aborted'
        : counts.failed > 0 || counts.blocked > 0
          ? 'failed'
          : 'succeeded'

    const at = this.now()
    const durationMs = at - run.startedAt

    if (run.abortReason !== undefined) {
      this.emitEvent('plan/aborted', {
        planId: run.planId,
        reason: run.abortReason,
        ...(run.abortedAtNode === undefined ? {} : { atNode: run.abortedAtNode }),
        at,
      })
    }

    run.status = status
    run.finishedAt = at
    this.emitEvent('plan/completed', {
      planId: run.planId,
      status,
      total: counts.total,
      succeeded: counts.succeeded,
      failed: counts.failed,
      blocked: counts.blocked,
      skipped: counts.skipped,
      cancelled: counts.cancelled,
      durationMs,
      at,
    })

    const snapshot = this.snapshotOf(run)
    if (this.shouldPersist(snapshot)) this.finished.set(run.planId, snapshot)
    else this.finished.delete(run.planId)

    return {
      planId: run.planId,
      digest: run.digest,
      dryRun: run.dryRun,
      status,
      total: counts.total,
      succeeded: counts.succeeded,
      failed: counts.failed,
      blocked: counts.blocked,
      skipped: counts.skipped,
      cancelled: counts.cancelled,
      durationMs,
    }
  }

  private counts(run: RunRecord): RunCounts {
    const tally = { succeeded: 0, failed: 0, blocked: 0, skipped: 0, cancelled: 0 }
    for (const state of run.states.values()) {
      switch (state) {
        case 'succeeded':
        case 'blocked':
        case 'skipped':
        case 'cancelled':
          tally[state] += 1
          break
        case 'failed':
          tally.failed += 1
          break
        case 'incident':
          // ★ `incident` 记进 `failed` 桶，**不是漏掉**。两个不变量同时压在这里：
          //   ① `plan/completed` 的"五个计数之和 = total"（载荷冻结，没有 incident 字段）；
          //   ② `finish()` 按 counts 推 status，漏掉它会让"一个节点外部不可用"的计划报 succeeded。
          tally.failed += 1
          break
        default:
          // pending / ready / running：还没落定，不计入任何桶（收尾时不该还有这些，见 cancelRemaining）
          break
      }
    }
    return { total: run.states.size, ...tally }
  }

  private snapshotOf(run: RunRecord): PlanRunSnapshot {
    const nodes: PlanNodeSnapshot[] = run.order.map((nodeId) => {
      const code = run.codes.get(nodeId)
      const durationMs = run.durations.get(nodeId)
      return {
        nodeId,
        tool: run.nodes.get(nodeId)?.tool ?? '',
        ordinal: run.ordinal.get(nodeId) ?? 0,
        state: run.states.get(nodeId) ?? 'pending',
        ...(code === undefined ? {} : { code }),
        ...(durationMs === undefined ? {} : { durationMs }),
      }
    })
    return {
      planId: run.planId,
      digest: run.digest,
      dryRun: run.dryRun,
      status: run.status,
      nodes,
      startedAt: run.startedAt,
      ...(run.finishedAt === undefined ? {} : { finishedAt: run.finishedAt }),
      ...(run.abortReason === undefined ? {} : { abortReason: run.abortReason }),
    }
  }

  private move(run: RunRecord, nodeId: string, to: PlanNodeState): void {
    const from = run.states.get(nodeId) ?? 'pending'
    run.states.set(nodeId, transition(from, to))
  }

  private settle(
    run: RunRecord,
    nodeId: string,
    state: PlanNodeState,
    code: string | undefined,
    durationMs: number,
  ): void {
    this.move(run, nodeId, state)
    if (code !== undefined) run.codes.set(nodeId, code)
    run.durations.set(nodeId, durationMs)
  }

  private requestAbort(run: RunRecord, reason: PlanAbortReason): void {
    if (run.controller.signal.aborted) return
    run.abortReason = reason
    run.abortedAtNode = run.currentNode
    run.controller.abort(reason)
  }

  /**
   * 唯一的发射口：**事件名只能是字面量**，载荷由 `PlanEventData<T>` 在编译期收窄。
   *
   * 字段叫 `sink` 而不是 `emit`：门禁 `verify-event-modes` 按**方法名**判"是否动态派发事件"
   * （它看不到类型），叫 `this.emit(type, …)` 会被判成"动态事件名"——那是误报，
   * 但改成让门禁认类型比改个名字贵得多。真正的字面量校验在
   * `scripts/verify-plan-events.ts` 里逐条对账（每条 `emitEvent('plan/…')`）。
   */
  private emitEvent<T extends PlanEventType>(type: T, data: PlanEventData<T>): void {
    this.sink(type, data)
  }
}

/** 边数（`Deps` 的总和，含重复依赖——配置面上限就是按条目数算）。 */
function edgesOf(nodes: readonly PlanNode[]): number {
  return nodes.reduce((sum, node) => sum + node.deps.length, 0)
}

/**
 * 计划身份摘要：canonical JSON 的 sha256 **前 16 字节**（32 hex）。
 *
 * `meta` 不参与：它是展示字段（标题 / 发起人），改标题不是"新计划"。
 * 参与的是 `planId` + `nodes`（含 args / deps / optional / idempotencyKey）。
 */
export function planDigest(plan: Plan): string {
  return sha256Hex(canonicalJson({ planId: plan.planId, nodes: plan.nodes })).slice(0, 32)
}

/** 一次重放的结果（`resume()` 的全部判据都来自这里）。 */
export interface PlanReplay {
  /** 是否见过该 `planId` 的 `plan/created`（false = 连原身份都取不到）。 */
  readonly sawCreated: boolean
  /** 最后一个运行窗口的身份摘要（`plan/created` / `plan/resumed`）；没有窗口时 undefined。 */
  readonly digest: string | undefined
  /**
   * 节点 → 上次落定的状态。
   *
   * **跨窗口累积、后写覆盖先写**：同一 `planId` 被 `run()` 跑过两次时，第二次的结论覆盖第一次；
   * 第二次没碰到的节点保留第一次的结论（这正是"接着上次跑"要的语义）。
   */
  readonly states: ReadonlyMap<string, PlanNodeState>
  /** 最后一个运行窗口是否已收尾（`plan/completed` / `plan/aborted`）。 */
  readonly closed: boolean
  /** 最后那个 `plan/completed` 声明的终态节点数（`total - cancelled`）；aborted 收尾时缺省。 */
  readonly expectedTerminals: number | undefined
  /**
   * 节点 → 历史 `plan/node-started` 次数（**跨窗口累计**，含首次运行）。
   *
   * 用途只有一个：给 `callId` 的第 3 段（attempt）提供跨窗口的自增基线。
   * 不数它的话，`resume(from: X)` 重跑 X 会生成与首次**完全相同**的 callId
   * （`${planId}#X#1`），而票据 ID 按 callId 派生 —— 撞号意味着第二次执行
   * 复用第一张票据的账本行，审批与审计都会指向错误的执行。
   */
  readonly starts: ReadonlyMap<string, number>
  /**
   * 节点 → 历史 `failed` 次数（**跨窗口累计**，含首次运行）。
   *
   * 与 `states` 的区别：`states` 是"现在是什么状态"（后写覆盖），这里是"失败过几次"（只增不减）。
   * 一个节点可能失败 3 次后成功：`states` 是 `succeeded`，`failures` 是 3。
   */
  readonly failures: ReadonlyMap<string, number>
}

/**
 * 从会话事件重建"上次跑到了哪"（**纯函数**：不读时钟、不写事件、不改入参）。
 *
 * ## 为什么必须同时读 `node-result` 与 `node-blocked`
 *
 * `engine.blockOrSkip()` 里，非 `optional` 的节点被上游卡住时**只**落 `plan/node-blocked`，
 * **不**落 `node-result`。只重放 `node-result` 会漏掉全部 blocked 节点——而 blocked 恰好是
 * 续跑时要"重置为 pending"的那一类，漏掉它们等于把半张图当成没跑过之外的状态。
 *
 * ## 为什么"完整"不能只比节点个数
 *
 * `plan/created` 的 `nodes` 是**个数**不是清单；被 abort 的 run 天然不满员（剩余节点记
 * `cancelled`，而 `cancelRemaining()` **不落**任何 per-node 事件）。所以判据是：
 * ① 有没有 `plan/created`；② digest 对不对；③ 最后窗口有没有收尾；④ 收尾时
 * "重放到的终态数"是否够 `total - cancelled`。
 */
export function replayPlan(
  history: readonly PlanEventRecord[],
  planId: string,
): PlanReplay {
  const states = new Map<string, PlanNodeState>()
  const failures = new Map<string, number>()
  const starts = new Map<string, number>()
  let sawCreated = false
  let digest: string | undefined
  let closed = false
  let expectedTerminals: number | undefined

  for (const event of history) {
    // 只认 plan 域：同一会话里混着 tool/call、approval/* 与其它计划的 plan/*
    if (!event.type.startsWith('plan/')) continue
    const data = recordOf(event.data)
    if (data === undefined || data['planId'] !== planId) continue

    switch (event.type) {
      case 'plan/created':
        sawCreated = true
        digest = stringOf(data, 'digest') ?? digest
        closed = false
        expectedTerminals = undefined
        break
      case 'plan/resumed':
        // 续跑也是一个新窗口的起点：它之后必须再有收尾事件才算闭合
        digest = stringOf(data, 'digest') ?? digest
        closed = false
        expectedTerminals = undefined
        break
      case 'plan/node-started': {
        const nodeId = stringOf(data, 'nodeId')
        if (nodeId !== undefined) {
          states.set(nodeId, 'running')
          // 只增不减：这是 callId 里 attempt 段的跨窗口基线（见 `PlanReplay.starts`）
          starts.set(nodeId, (starts.get(nodeId) ?? 0) + 1)
        }
        break
      }
      case 'plan/node-result': {
        const nodeId = stringOf(data, 'nodeId')
        const status = stringOf(data, 'status')
        if (
          nodeId !== undefined &&
          (status === 'succeeded' || status === 'failed' || status === 'skipped')
        ) {
          // ★ **先看 code 再看 status**（`nodeStateFromResult` 是唯一还原口）：
          //   `incident` 在载荷里是 `failed`，认错会让它在 resume 里停在 failed 档（不重跑）。
          const state = nodeStateFromResult(status, stringOf(data, 'code'))
          states.set(nodeId, state)
          // 失败次数只增不减：后面成功了也不回退（它确实失败过那么多次）
          //
          // ★ `incident` **不计数**：外部不可用不是"这个节点不行"，
          //   把它算进来，一次基础设施抖动就会提前打满 `maxNodeAttempts`。
          if (state === 'failed') failures.set(nodeId, (failures.get(nodeId) ?? 0) + 1)
        }
        break
      }
      case 'plan/node-blocked': {
        // 三值之外的第四种落点：blocked 只在这里出现
        const nodeId = stringOf(data, 'nodeId')
        if (nodeId !== undefined) states.set(nodeId, 'blocked')
        break
      }
      case 'plan/completed': {
        closed = true
        const total = numberOf(data, 'total')
        const cancelled = numberOf(data, 'cancelled')
        expectedTerminals =
          total !== undefined && cancelled !== undefined ? total - cancelled : undefined
        break
      }
      case 'plan/aborted':
        // 引擎在 abort 时先落 aborted 再落 completed，所以这个分支的 expectedTerminals
        // 通常会被紧随其后的 completed 覆盖；单独出现时（HALT 路径是反序）不做终态核对。
        closed = true
        expectedTerminals = undefined
        break
      default:
        // 未知 / 未来的 plan 事件（`plan/node-waiting` 就在这里）：不参与状态重建。
        // node-waiting 只回答"等了多久"，节点状态由随后的 node-result 决定——
        // 让重放去读 `waitedMs` 会造出第二份"等待"事实，而没有消费方。
        break
    }
  }

  return { sawCreated, digest, states, closed, expectedTerminals, failures, starts }
}

/** 终态节点数（`plan/completed` 的 `total - cancelled` 就是它）。 */
function countTerminals(states: ReadonlyMap<string, PlanNodeState>): number {
  let count = 0
  for (const state of states.values()) if (TERMINAL_STATES.has(state)) count += 1
  return count
}

/** 事件载荷 → 普通对象；不是对象（`null` / 数组 / 原始值）一律 undefined。 */
function recordOf(data: unknown): Record<string, unknown> | undefined {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return undefined
  return data as Record<string, unknown>
}

/** 按运行期类型取字符串字段（**不 `as` 断言**：事件可能来自 JSONL 回放）。 */
function stringOf(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key]
  return typeof value === 'string' ? value : undefined
}

function numberOf(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key]
  return typeof value === 'number' ? value : undefined
}
