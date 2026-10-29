/**
 * 工具契约注册表（W03 阶段二的注入接缝）。
 *
 * ## 为什么要一个服务，而不是把 `argsSchema` 加到 `ToolDefinition`
 *
 * 宪法 **R-1** 冻结了 `packages/core/src/api.ts`：不能给 `ToolDefinition` 加字段。
 * 而 `pipeline.ts` 只拿得到 `ToolDefinition`——它必须从别处知道"这个工具的契约是什么"。
 *
 * 三条不能走的路：
 * - 改 core → 违 R-1；
 * - runtime 直接 import `@bah/bank` → 违包图（领域层不许反向依赖，`runtime` 是底层）；
 * - 让 bank 把契约塞进 `ToolDefinition` 的自定义字段 → TS 结构类型下可行但等于绕开契约面。
 *
 * 正解：**runtime 只定义端口，宿主注入实现**。
 * `@bah/bank` 在 `bank-tools.ts` 里把自己的 specs 包成 `ToolContractSource` 提供进来，
 * runtime 全程不认识 bank。
 *
 * ## 缺省行为：不校验
 *
 * 没提供服务的 profile（例如纯内核测试）→ `findToolContracts` 返回 `undefined` → 管线跳过校验。
 * 这是**有意的向后兼容**：既有 1616 例不该因为"没装 bank"而变红。
 * 反过来说：**任何一个跑银行工具的 profile 都必须显式提供本服务**，否则等于校验没通电。
 */

import { defineService } from '@bah/core'

import type { Context, Disposer, ServiceKey } from '@bah/core'
import type { ToolContract, ToolContractViolation } from '@bah/util'
import { validateAgainstSchema } from '@bah/util'

/**
 * 一个工具契约的来源。
 *
 * 只要求一个同步 `get`：契约是**静态声明**（编译期就定了），不需要异步。
 */
export interface ToolContractSource {
  /** 按工具名取契约；没有契约返回 `undefined`（= 该工具不做运行时校验）。 */
  get(name: string): ToolContract | undefined
}

/** 契约注册表服务键。 */
export const TOOL_CONTRACTS: ServiceKey<ToolContractSource> =
  defineService<ToolContractSource>('runtime:tool-contracts')

/**
 * 取契约来源；未提供时返回 `undefined`（调用方据此跳过校验）。
 *
 * 为什么用 `try/catch` 而不是 `ctx.has()`：`Context` 只暴露 `get`（未提供时抛错），
 * 仓里已有的 `trySentry()` 也是这个写法（`host/boot/plugins/web.ts`）。
 * 这是**既成惯例**，不是偷懒。
 */
export function findToolContracts(ctx: Context): ToolContractSource | undefined {
  try {
    return ctx.get(TOOL_CONTRACTS)
  } catch {
    return undefined
  }
}

/** 一个 Context 上已登记的来源（叠加在同一个服务实例里）。 */
interface ContractAggregate {
  readonly sources: ToolContractSource[]
  readonly view: ToolContractSource
}

/**
 * 按 Context 记聚合器。
 *
 * WHY 不让第二个提供者自己 `ctx.provide`：服务注册表对重复 provide 抛
 * `service-conflict`。契约天然是**多来源的并集**（银行工具一份、意图平面一份、
 * 以后的插件各一份），把「谁是唯一提供者」交给装配顺序是一种隐性契约。
 * 聚合后：第一个提供者建服务，后续提供者只往数组里加，`get` 按登记序取首个命中。
 */
const AGGREGATES = new WeakMap<Context, ContractAggregate>()

/** 幂等的一次性回调（`Disposer` 会被 `ctx.effect` 的回滚重复调用）。 */
function once(fn: () => void): Disposer {
  let done = false
  return () => {
    if (done) return
    done = true
    fn()
  }
}

/**
 * 提供契约来源（宿主插件用）；返回注销句柄，配合 `ctx.effect` 做卸载回滚。
 *
 * 可重复调用：同一 Context 上的多个来源会被聚合，后登记者不覆盖先登记者。
 */
export function provideToolContracts(
  ctx: Context,
  source: ToolContractSource,
): Disposer {
  const existing = AGGREGATES.get(ctx)
  if (existing !== undefined) {
    existing.sources.push(source)
    return once(() => {
      const index = existing.sources.indexOf(source)
      if (index >= 0) existing.sources.splice(index, 1)
    })
  }

  const sources: ToolContractSource[] = [source]
  const aggregate: ContractAggregate = {
    sources,
    view: {
      get(name: string) {
        for (const candidate of sources) {
          const contract = candidate.get(name)
          if (contract !== undefined) return contract
        }
        return undefined
      },
    },
  }
  AGGREGATES.set(ctx, aggregate)
  const disposeService = ctx.provide(TOOL_CONTRACTS, aggregate.view)
  return once(() => {
    disposeService()
    AGGREGATES.delete(ctx)
  })
}

/**
 * 校验入参。
 *
 * @returns 违规项；无契约或无违规返回 `undefined`
 */
export function checkToolArgs(
  source: ToolContractSource | undefined,
  name: string,
  args: Readonly<Record<string, unknown>>,
): ToolContractViolation | undefined {
  const contract = source?.get(name)
  if (contract === undefined) return undefined
  return validateAgainstSchema(contract.argsSchema, args, 'args')
}

/**
 * 校验出参。
 *
 * 出参不合格的"成功"是最危险的形状：模型会拿着假数据继续决策，
 * 而审计里只看得到一条成功的 `tool/result`。
 */
export function checkToolResult(
  source: ToolContractSource | undefined,
  name: string,
  payload: unknown,
): ToolContractViolation | undefined {
  const contract = source?.get(name)
  if (contract === undefined) return undefined
  return validateAgainstSchema(contract.resultSchema, payload, 'result')
}
