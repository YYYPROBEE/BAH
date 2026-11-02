/**
 * 单 agent 作用域与键屏蔽代理。
 *
 * - `scope`：单 agent 的键值注册原语，随所属 Context dispose 自动清理；
 * - `isolate`：**只做键屏蔽**——事件与贡献共享父级，仅 `get` 被屏蔽。
 *   多渠道差异一律用 profile 组合解决，不做多 realm 复杂隔离。
 */

import type { AgentScope, Context, Disposer, EffectDisposer, Events, ServiceKey } from './api.ts'
import { coreError } from './errors.ts'
import { once } from './types.ts'

/** 作用域注册表：键值原语，`clear()` 由 Context dispose 调用。 */
export class BahScope implements AgentScope {
  /** `key.id` → 值（键的类型在取用处还原）。 */
  private readonly values = new Map<string, unknown>()

  set<T>(key: ServiceKey<T>, value: T): Disposer {
    this.values.set(key.id, value)
    return once(() => {
      this.values.delete(key.id)
    })
  }

  get<T>(key: ServiceKey<T>): T | undefined {
    return this.values.get(key.id) as T | undefined
  }

  /** 清空全部作用域值（Context dispose 时调用，保证「随 Context 自动清理」）。 */
  clear(): void {
    this.values.clear()
  }
}

/**
 * 键屏蔽代理：事件与贡献共享父级，仅屏蔽指定服务键的 `get`。
 *
 * 嵌套 `isolate` 会逐层叠加屏蔽集合（每层只检查自己那组键，其余委托父级）。
 */
class IsolatedContext implements Context {
  readonly events: Events
  readonly scope: AgentScope

  constructor(
    private readonly parent: Context,
    private readonly hidden: ReadonlySet<string>,
  ) {
    // 事件与贡献共享父级：同一个事件源、同一个作用域注册表
    this.events = parent.events
    this.scope = parent.scope
  }

  get<T>(key: ServiceKey<T>): T {
    if (this.hidden.has(key.id)) {
      throw coreError('service-isolated', `服务 ${key.id} 已被 isolate 屏蔽`, { service: key.id })
    }
    return this.parent.get(key)
  }

  provide<T>(key: ServiceKey<T>, instance: T): Disposer {
    return this.parent.provide(key, instance)
  }

  whenReady<T>(key: ServiceKey<T>): Promise<T> {
    return this.parent.whenReady(key)
  }

  effect(disposer: EffectDisposer): Disposer {
    return this.parent.effect(disposer)
  }

  start(): Promise<void> {
    return this.parent.start()
  }

  dispose(reason?: string): Promise<void> {
    return this.parent.dispose(reason)
  }

  isolate(...keys: ServiceKey<unknown>[]): Context {
    return createIsolate(this, new Set(keys.map((key) => key.id)))
  }
}

/** 构造键屏蔽代理（`Context.isolate` 的实现）。 */
export function createIsolate(parent: Context, hidden: ReadonlySet<string>): Context {
  return new IsolatedContext(parent, hidden)
}
