/**
 * 服务接缝：按键寻址 + waiting 队列。
 *
 * 内核不认识任何具体服务：跨包只认 `ServiceKey`（运行时就是 `id` 字符串），
 * 插件靠 `inject: ['bank:model']` 声明依赖，靠 `ctx.get(key)` 同步取实例。
 */

import type { Disposer, ServiceKey, ServiceSeam } from './api.ts'
import { coreError } from './errors.ts'
import { once } from './types.ts'

/**
 * 服务键构造器。
 *
 * `id` 是运行时键，必须与插件 `inject` 数组里的字符串逐字一致；
 * 空名会让 `inject` 永远等不到，属 misconfiguration，载入即抛。
 */
export function defineService<T>(name: string): ServiceKey<T> {
  if (name.length === 0) {
    throw coreError('invalid-service-key', '服务键名不能为空（inject 将永远等不到它）')
  }
  return { id: name }
}

/**
 * 服务注册表 + waiting 队列。
 *
 * - `provide` 同名 key 重复注册属 misconfiguration（抛错），注销后可以再次 provide；
 * - `whenReady` 是 waiting 队列的读口：未就绪则**挂起**，就绪后以实例 resolve；
 * - `get` 未注册即抛错（fail-loud），绝不返回 `undefined`。
 */
export class ServiceRegistry implements ServiceSeam {
  /** 已注册服务：`key.id` → 实例（键的类型在取用处还原）。 */
  private readonly entries = new Map<string, unknown>()

  /** waiting 队列：`key.id` → 尚未就绪的等待者。 */
  private readonly waiting = new Map<string, Array<(instance: unknown) => void>>()

  provide<T>(key: ServiceKey<T>, instance: T): Disposer {
    if (this.entries.has(key.id)) {
      throw coreError(
        'service-conflict',
        `服务 ${key.id} 已注册，注销前不允许重复 provide`,
        { service: key.id },
      )
    }
    this.entries.set(key.id, instance)
    this.release(key.id, instance)
    return once(() => {
      this.entries.delete(key.id)
    })
  }

  whenReady<T>(key: ServiceKey<T>): Promise<T> {
    if (this.entries.has(key.id)) return Promise.resolve(this.read<T>(key.id))
    return new Promise<T>((resolve) => {
      const waiters = this.waiting.get(key.id) ?? []
      waiters.push(resolve as (instance: unknown) => void)
      this.waiting.set(key.id, waiters)
    })
  }

  get<T>(key: ServiceKey<T>): T {
    if (!this.entries.has(key.id)) {
      throw coreError(
        'service-missing',
        `服务 ${key.id} 未注册：get 不返回 undefined，请用 whenReady 等待或声明 inject`,
        { service: key.id },
      )
    }
    return this.read<T>(key.id)
  }

  /** 服务是否已就绪（install 阶段判定 `inject` 依赖用）。 */
  has(id: string): boolean {
    return this.entries.has(id)
  }

  /**
   * 取出实例。
   *
   * 注册表按 `unknown` 存储（运行时不携带类型），这里是**唯一**的类型还原点：
   * 取用方按键声明的 `T` 收窄，与 `Map` 的类型擦除一一对应。
   */
  private read<T>(id: string): T {
    return this.entries.get(id) as T
  }

  /** 就绪后清空该 key 的等待队列（等待者全部 resolve，随后队列删除）。 */
  private release(id: string, instance: unknown): void {
    const waiters = this.waiting.get(id)
    if (!waiters) return
    this.waiting.delete(id)
    for (const resolve of waiters) resolve(instance)
  }
}
