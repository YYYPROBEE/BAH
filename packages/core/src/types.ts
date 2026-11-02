/**
 * 内核内部类型与小工具。
 *
 * 这里只放「内核自己用、不属于公开契约」的东西：注册表条目、贡献桶、幂等封装。
 * 公开契约一律在 `api.ts`（本阶段只读），实现细节不许回流到那份文件。
 */

import type {
  Disposer,
  EffectDisposer,
  ErasedPlugin,
  EventMode,
  PluginName,
  WaterfallNext,
} from './api.ts'

/**
 * 无类型约束的监听器形状（注册表内部按 `unknown` 存，类型在派发点按键声明还原）。
 *
 * 五种模式共用同一形状：`emit` / `serial` / `parallel` 的监听器忽略 `next`；
 * `waterfall` / `bail` 的监听器用 `next` 交还控制权。
 */
export type RawListener = (payload: unknown, next: WaterfallNext<unknown>) => unknown

/** 监听器注册条目；`mode` 缺省表示「不限定派发模式」。 */
export interface ListenerEntry {
  readonly mode?: EventMode
  readonly listener: RawListener
}

/** 一次 `effect()` 的登记条目。 */
export interface EffectEntry {
  /**
   * 稳定身份：`<桶名>#<序号>`，序号来自 Context 的单调计数器。
   *
   * 回滚失败时要能指认「是谁的清理炸了」；不用数组下标——`effects` 会因提前撤销
   * 与重排变化，下标不稳定，上报出去的身份必须稳定。
   */
  readonly id: string
  readonly disposer: EffectDisposer
  /** 是否已执行：disposer 必须幂等。 */
  done: boolean
}

/**
 * 贡献桶：一个插件（或内核自身）名下的 effect 集合。
 *
 * dispose 时**桶内逆序、桶间也逆序**回滚，保证「后注册先撤销」。
 */
export interface ContributionBucket {
  readonly name: PluginName
  readonly effects: EffectEntry[]
}

/** 插件记录：注册时校验配置，install 阶段执行 `apply`。 */
export interface PluginRecord extends ContributionBucket {
  /** 插件本体；配置类型在注册时已擦除，`resolveConfig` 是唯一校验入口。 */
  readonly plugin: ErasedPlugin
  /** 已按 schema 校验并补默认值的配置。 */
  readonly config: unknown
  /** 依赖的服务名（`ServiceKey.id`），install 前逐一等待就绪。 */
  readonly inject: readonly string[]
  /** `apply` 是否已成功执行。 */
  installed: boolean
}

/** 幂等封装：重复调用只执行一次。 */
export function once(dispose: Disposer): Disposer {
  let done = false
  return () => {
    if (done) return
    done = true
    dispose()
  }
}
