/**
 * base bundle · `bank:saga-bridge`：把 Saga 协调器接到**主循环的工具执行面**上。
 *
 * ## 为什么需要这个插件
 *
 * `bank:saga` 只装配了底座（时钟 / 幂等 / 模板 / 三道闸 / 收敛 job / `saga/tick` 派发点），
 * 它自己**从不调用** `planSaga` / `runSaga`——协调器在那儿，但没有任何一笔业务走进去。
 * 结果是 Saga 的能力（前向状态机、预写、幂等预占、未知态探诊、DLQ 升级、启动恢复）
 * 全停在"代码在、路径不在"。本插件补的就是这一段接线。
 *
 * ## 为什么挂在 `tools/execute` 而不是改主循环
 *
 * `ToolPipeline.execute` 的第 ⑤ 段已经是**环绕式 waterfall**（`runtime/src/tools/pipeline.ts:328-341`），
 * 注释写明"外层包裹由 `tools/execute` listener 提供"。选它有三个硬理由：
 *
 * 1. **位置正确**：它在第 ③ 段（`tools/pre-execute` 三级判定 + 审批票据）**之后**。
 *    于是"人点了批准"只发生一次、票据只核销一次，saga 的每一步不会被重新审批；
 *    挂在 pre-execute 之前则会变成"先排计划、再被拒"的假事务。
 * 2. **不动内核**：`@bah/saga` 是宿主层插件，`packages/runtime` 不得反向依赖它
 *    （`verify-package-graph` 会拦）。走事件接缝，runtime 完全不知道 saga 的存在。
 * 3. **可关**：`enabled: false` 就退回原路径，不需要回滚代码。
 *
 * ## 一笔转账为什么是"两步"
 *
 * `transfer_preview`（试算 + 风控预检，只读）→ `transfer_create`（扣款，写）。
 * 两步有真实拓扑依赖，DAG 因此不是摆设：预检失败时第二步根本不进入 `READY`。
 * 单步 saga 也能跑，但图上只有一个节点，没有信息量。
 *
 * ## 三条必须写死的边界（不要在演示里越过）
 *
 * - **`maxAttempts` 必须是 1**（见 base bundle 本行的配置）：幂等键只存在于
 *   `saga_step.idempotency_key`，**没有传给银行核心**；重试一次就是真的多扣一次钱。
 *   核心支持请求级幂等键之后才允许开重试。
 * - **补偿只到"决策"为止**：`MockBankCore` 没有冲正接口（`packages/bank/src/core` 里的
 *   `refund` 是**交易分类**，不是可调用操作），所以本插件不注入 `CompensationDeps`。
 *   按 `runSaga` 的契约，失败步骤只 CAS 到 `COMPENSATING` 而**不假装补偿成功**。
 * - **sub-step 不继承 turn 的取消信号**：`tools/execute` 的包裹函数只拿到 `call`，
 *   拿不到 turn 的 `AbortSignal`。这里给一个永不过期的信号，并接受"turn 被取消后
 *   已进入的中段步骤仍会跑完"——这比伪造取消（半途中断会让状态停在 `CALLING`）安全。
 */

import { createHash, randomUUID } from 'node:crypto'

import { makeKey, makeNonce, parseSagaSettings, planSaga, runSaga, SAGA_CLOCK } from '@bah/saga'
import { SESSION_SERVICE, TOOLS_SERVICE } from '@bah/runtime'
import { BahError } from '@bah/util'

import type { PlannedStep, SagaSettings, SideEffectClass } from '@bah/saga'
import type { ToolCallInput, ToolRegistry } from '@bah/runtime'

import type { HostPlugin } from '../../plugin-manager/index.ts'
import {
  bootError,
  readBoolean,
  readPositiveInteger,
  readStringArray,
  rejectUnknownKeys,
} from '../config.ts'

/** 一步的计划素材（`args` 由配方函数从模型入参派生）。 */
interface StepSpec {
  readonly stepId: string
  readonly toolName: string
  readonly sideEffectClass: SideEffectClass
  readonly deps: readonly string[]
  readonly args: Readonly<Record<string, unknown>>
}

/**
 * 工具名 → 编排配方。
 *
 * **只登记有真实拓扑依赖的组合**。没登记的写工具一律直通（不进 saga）——
 * 编不出来就别编："一步 saga"在图上无法与普通调用区分，只会让 DAG 失真。
 */
const RECIPES: Readonly<Record<string, (call: ToolCallInput) => readonly StepSpec[]>> = {
  transfer_create: (call) => {
    // 预检只吃模型给的 amount / payee / remark；`when` / `idempotencyKey` 属执行语义，
    // 不进试算（否则"定时转账"这种当前会被拒的用法会在预检阶段先被判合法）。
    const previewArgs: Record<string, unknown> = {}
    for (const key of ['amount', 'payee', 'remark'] as const) {
      const value = call.args[key]
      if (value !== undefined) previewArgs[key] = value
    }
    return [
      {
        stepId: 'preview',
        toolName: 'transfer_preview',
        sideEffectClass: 'NONE',
        deps: [],
        args: previewArgs,
      },
      {
        stepId: 'execute',
        toolName: 'transfer_create',
        sideEffectClass: 'EXTERNAL_UNDOABLE',
        deps: ['preview'],
        args: call.args,
      },
    ]
  },
}

/** `bank:saga-bridge` 的配置。 */
export interface SagaBridgeSettings {
  /** 总开关：`false` 时本插件只校验不接管（等价于没装）。 */
  readonly enabled: boolean
  /** 走 saga 的工具名（必须在 `RECIPES` 里有配方，否则启动即失败）。 */
  readonly eligible: readonly string[]
  /** `saga/tick` 发射间隔（毫秒）；**不写 = 不发射**（只测正向编排，不跑收敛 job）。 */
  readonly tickIntervalMs: number
  /** 协调器设置（与 `bank:saga` 同一个解析面）。 */
  readonly saga: SagaSettings
}

const WHERE = 'bank:saga-bridge'

/** 永不过期的取消信号（见文件头第 3 条边界）。 */
const NEVER_ABORT = new AbortController().signal

/** 内容摘要（幂等/审计只认摘要，不认原文）。 */
function digestOf(payload: unknown): string {
  let text: string
  try {
    text = JSON.stringify(payload) ?? String(payload)
  } catch {
    text = String(payload)
  }
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/** 抛错 → 结构化码（保留工具自己的 `BahError.code`，否则退到 `tool-failed`）。 */
function codeOf(error: unknown): string {
  return error instanceof BahError ? error.code : 'tool-failed'
}

export const sagaBridgePlugin: HostPlugin<SagaBridgeSettings> = {
  id: 'bank:saga-bridge',

  plugin: {
    name: 'bank:saga-bridge',
    apply(ctx, settings) {
      if (!settings.enabled) return

      // 懒解析：事件监听只在真的有工具调用时才需要这些服务。apply 期硬取会把
      // "行顺序"变成隐性契约，而换行顺序不该让系统起不来。
      const registry = (): ToolRegistry => ctx.get(TOOLS_SERVICE)
      const sessionId = (): string => ctx.get(SESSION_SERVICE).sessionId

      /** 直接取工具定义执行：**不**经过七段管线（审批已在最外层发生过一次）。 */
      const executeTool = async (
        name: string,
        args: Readonly<Record<string, unknown>>,
        callId: string,
      ): Promise<unknown> =>
        registry().get(name).execute(args, {
          sessionId: sessionId() as never,
          callId,
          signal: NEVER_ABORT,
        })

      const runSagaFor = async (call: ToolCallInput): Promise<unknown> => {
        const recipe = RECIPES[call.name]
        if (recipe === undefined) return undefined
        const specs = recipe(call)
        const sagaId = `saga-${randomUUID()}`
        let lastPayload: unknown
        let failure: { code: string } | undefined

        // `saga_step.step_id` 是**全局主键**（不是 `(saga_id, step_id)` 复合键）：
        // 固定名字（`preview` / `execute`）会在第二次运行时撞上历史行，
        // 报 `UNIQUE constraint failed: saga_step.step_id`——而第一次跑因为表是空的会"成功"，
        // 所以这个坑只在**第二次**才现形。配方里的 `stepId` 只是本地名，落库前必须换成
        // 全局唯一值；`topologyDeps` 也要跟着换。
        const localToGlobal = new Map<string, string>()
        const planned: PlannedStep[] = specs.map((spec, index) => {
          const stepId = `st-${randomUUID()}`
          localToGlobal.set(spec.stepId, stepId)
          const nonce = makeNonce()
          const deps = spec.deps.map((dep) => {
            const global = localToGlobal.get(dep)
            // 配方必须按拓扑序书写、且依赖只能指向**前面**的步骤；否则计划期就失败，
            // 而不是留给运行期去发现一条指向不存在步骤的边。
            if (global === undefined) {
              throw new BahError('recipe-invalid', `saga 配方依赖顺序错误：${spec.stepId} 依赖未定义的 ${dep}`, {
                recipe: call.name,
                step: spec.stepId,
                dep,
              })
            }
            return global
          })
          return {
            stepId,
            seqNo: index + 1,
            toolName: spec.toolName,
            endpoint: `tool://${spec.toolName}`,
            sideEffectClass: spec.sideEffectClass,
            idemKey: makeKey('FWD', sagaId, stepId, nonce),
            nonce,
            topologyDeps: deps,
            // 单步预算：预检是纯读，5s 足够；写步骤的实际超时由沙箱/核心把守，
            // 这里只是计划期的名义预算（协调器 SLA 另有 softSlaMs / hardSlaMs 兜底）。
            deadlineMs: 5_000,
          }
        })

        const lastStepId = planned[planned.length - 1]!.stepId

        planSaga(
          ctx,
          {
            sagaId,
            businessType: call.name.toUpperCase(),
            traceId: `${sessionId()}:${call.callId}`,
            timeoutBudgetMs: settings.saga.softSlaMs,
            initiator: sessionId(),
            steps: planned,
          },
          settings.saga,
        )

        await runSaga(ctx, sagaId, {
          settings: settings.saga,
          dispatch: async (step) => {
            // 回查配方：`step.stepId` 已是全局唯一值，靠 `localToGlobal` 反查本地名。
            const spec = specs.find((item) => localToGlobal.get(item.stepId) === step.stepId)
            if (spec === undefined) {
              failure = { code: 'recipe-missing' }
              return { kind: 'err', code: 'recipe-missing' }
            }
            try {
              const payload = await executeTool(spec.toolName, spec.args, call.callId)
              // 外层工具的结果必须是**最后一步**的产出（预检的返回值不能顶包扣款结果）
              if (step.stepId === lastStepId) lastPayload = payload
              return { kind: 'ok', responseDigest: digestOf(payload) }
            } catch (error) {
              const code = codeOf(error)
              failure = { code }
              return { kind: 'err', code }
            }
          },
        })

        if (failure !== undefined) {
          // 不吞：外层管线要把这次调用记成 `isError`，模型下一 step 才能自愈。
          throw new BahError('saga-step-failed', `saga 编排失败：${failure.code}（saga ${sagaId}）`, {
            sagaId,
            code: failure.code,
          })
        }
        return lastPayload
      }

      // ① 主接线：包裹执行函数；非 eligible 工具原样透传给内层 `run`。
      ctx.effect(
        ctx.events.on('tools/execute', async (run, next) => {
          const wrapped = async (call: ToolCallInput): Promise<unknown> => {
            if (!settings.eligible.includes(call.name)) return run(call)
            return runSagaFor(call)
          }
          return next(wrapped)
        }),
      )

      // ② `saga/tick` 发射点：`installTick` 只登记了"收到事件就派发"，
      //    全仓此前没有第二个发射者 → janitor / recon / anchor 三个 job 永不执行。
      //    定时器必须 unref：否则 CLI 跑完一个 turn 进程退不掉。
      if (settings.tickIntervalMs > 0) {
        const tick = (): void => {
          // 必须用 `serial`：事件在 `saga/src/seams.ts:239` 声明为 serial 模式，
          // `verify-event-modes` 会逐条比对派发方式（改 emit 直接考试不及格）。
          // 三种 job 串行跑，避免 janitor 与 recon 同一条事务上交错。
          void ctx.events
            .serial('saga/tick', {
              now: ctx.get(SAGA_CLOCK).now(),
              dueJobs: ['janitor', 'recon', 'anchor'],
            })
            .catch((error: unknown) => {
              // 定时器里抛错没人接：只能落 stderr；job 自身失败另有告警汇。
              console.error(`bah-saga-bridge: tick-failed: ${codeOf(error)}`)
            })
        }
        const timer = setInterval(tick, settings.tickIntervalMs)
        timer.unref?.()
        ctx.effect(() => clearInterval(timer))
      }
    },
  },

  validate(config) {
    rejectUnknownKeys(config, ['enabled', 'eligible', 'tickIntervalMs', 'saga'], WHERE)

    const eligible = readStringArray(config, 'eligible', WHERE) ?? ['transfer_create']
    for (const name of eligible) {
      if (RECIPES[name] === undefined) {
        // fail-loud：静默把"写了但没配方"的工具降级成直通，等于让配置说谎。
        throw bootError(
          'invalid-config',
          `${WHERE}.eligible: ${name} 没有编排配方（可选：${Object.keys(RECIPES).join(' / ')}）`,
          { where: WHERE, tool: name },
        )
      }
    }

    const rawSaga = config['saga']
    const saga = parseSagaSettings(
      rawSaga === undefined || rawSaga === null ? {} : (rawSaga as Readonly<Record<string, unknown>>),
    )

    return {
      enabled: readBoolean(config, 'enabled', WHERE, true),
      eligible,
      // 缺省 0 = 不装定时器。写 0 会被 `readPositiveInteger` 拒（它要求 > 0），
      // 所以"关掉 tick"的正确写法是**不写这个键**。
      tickIntervalMs: readPositiveInteger(config, 'tickIntervalMs', WHERE) ?? 0,
      saga,
    }
  },
}

/** 供测试直接引用配方（避免测试复制一份编排逻辑）。 */
export const SAGA_BRIDGE_RECIPES = RECIPES
