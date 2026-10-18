/**
 * 事件五模式（施工单 02 §3 / §4）。
 *
 * 本文件只提供**机制**：监听器注册表 + 五种派发。事件表本身（哪些事件、各自什么 mode）
 * 由施工单 04 §6 冻结为接缝总表，届时 `verify-event-modes` 门禁比对「声明 mode」与「派发点」。
 *
 * 五种模式语义：
 * - `emit`：单向通知，不 await、不返回值（记账类）
 * - `serial`：顺序 await 每个监听器（有顺序依赖的处理）
 * - `parallel`：`Promise.all` 并发，全部完成才返回（广播类副作用）
 * - `waterfall`：链式传值，`next()` 显式交还，不调 `next()` 即短路（默认拦截器形态）
 * - `bail`：首个非 `undefined` 返回即短路（竞争裁决）
 */

import type {
  BahEventMap,
  Disposer,
  EventMode,
  EventName,
  Events,
  Listener,
  WaterfallNext,
} from './api.ts'
import { coreError } from './errors.ts'
import { once, type ListenerEntry, type RawListener } from './types.ts'

/** 瀑布链长上限（施工单 02 §4 第 3 条）：超出即抛，防手误写出自循环。 */
export const MAX_WATERFALL_DEPTH = 32

/**
 * `emit` / `serial` / `parallel` / `bail` 的监听器不参与链式交还，
 * 统一喂一个透传 `next`：监听器误调也不会炸，且不改变派发语义。
 */
const PASSTHROUGH_NEXT: WaterfallNext<unknown> = async (value) => value

/**
 * 事件源：注册表 + 五模式派发。
 *
 * 派发按**注册顺序**执行；同一事件的监听器若声明了互不相同的 mode，直接在派发前抛错
 * （mode 是公开契约，声明与实际派发点不一致必须 fail-loud，不许静默跳过）。
 */
export class BahEvents implements Events {
  /** 事件名 → 监听器集合（`Set` 的插入顺序 = 注册顺序 = 派发顺序）。 */
  private readonly table = new Map<string, Set<ListenerEntry>>()

  on<K extends EventName>(name: K, listener: Listener<K>): Disposer
  on(name: string, listener: RawListener, mode: EventMode): Disposer
  on(name: string, listener: RawListener, mode?: EventMode): Disposer {
    return this.register(name, listener, mode)
  }

  /**
   * 登记监听器并返回注销句柄（`on` 的实现体）。
   *
   * 与 `on` 的区别只是不过载：门面（Context 的 `events`）需要用「可能缺省」的 mode 调它，
   * 以便把贡献记到插件名下。派发语义完全相同。
   */
  register(name: string, listener: RawListener, mode?: EventMode): Disposer {
    const entries = this.table.get(name) ?? new Set<ListenerEntry>()
    const entry: ListenerEntry = { mode, listener }
    entries.add(entry)
    this.table.set(name, entries)
    return once(() => {
      // 幂等由 once 保证；摘掉最后一条就删表项，保证事件表不残留空集合
      entries.delete(entry)
      if (entries.size === 0) this.table.delete(name)
    })
  }

  /**
   * 单向通知：同步调用每个监听器，**不 await**、不返回值。
   *
   * @mode emit —— 记账类（`session/event`、`tools/result`）
   */
  emit<K extends EventName>(name: K, payload: BahEventMap[K]): void {
    for (const entry of this.select(name, 'emit')) entry.listener(payload, PASSTHROUGH_NEXT)
  }

  /**
   * 顺序 await 每个监听器，顺序与注册一致。
   *
   * @mode serial —— 有顺序依赖的处理（`agent/turn-stopping`）
   */
  async serial<K extends EventName>(name: K, payload: BahEventMap[K]): Promise<void> {
    for (const entry of this.select(name, 'serial')) {
      await entry.listener(payload, PASSTHROUGH_NEXT)
    }
  }

  /**
   * `Promise.all` 并发，全部完成才返回。
   *
   * @mode parallel —— 广播类副作用
   */
  async parallel<K extends EventName>(name: K, payload: BahEventMap[K]): Promise<void> {
    const pending = this.select(name, 'parallel').map(
      async (entry) => entry.listener(payload, PASSTHROUGH_NEXT),
    )
    await Promise.all(pending)
  }

  /**
   * 链式传值：每个 handler 显式 `next()` 交还，返回最终（可能被改写的）值。
   *
   * 精确语义（施工单 02 §4 逐条）：步进按注册顺序同步推进、handler 内部可 await、
   * 不调 `next()` 的 handler 拥有该判决（后续 handler 不再执行），链长上限 32 级。
   *
   * @mode waterfall —— 默认拦截器形态（请求 / 响应 / 判决）
   */
  async waterfall<K extends EventName>(name: K, value: BahEventMap[K]): Promise<BahEventMap[K]> {
    const entries = this.select(name, 'waterfall')
    const final = await stepChain(entries, name, 0, value)
    return final as BahEventMap[K]
  }

  /**
   * 首个非 `undefined` 返回即短路；无裁决时返回 `undefined`。
   *
   * @mode bail —— 竞争裁决
   */
  async bail<K extends EventName>(
    name: K,
    value: BahEventMap[K],
  ): Promise<BahEventMap[K] | undefined> {
    for (const entry of this.select(name, 'bail')) {
      const verdict = await entry.listener(value, PASSTHROUGH_NEXT)
      if (verdict !== undefined) return verdict as BahEventMap[K]
    }
    return undefined
  }

  /**
   * 取某事件在本模式下的监听器。
   *
   * 注册时声明了 mode 的监听器必须与派发模式一致：不一致说明「声明与实际派发点分叉」，
   * 属于接缝错误，直接在产生任何副作用之前抛错。
   */
  private select(name: string, mode: EventMode): readonly ListenerEntry[] {
    const registered = this.table.get(name)
    if (!registered) return []
    const entries = [...registered]
    for (const entry of entries) {
      if (entry.mode === undefined || entry.mode === mode) continue
      throw coreError(
        'event-mode-mismatch',
        `事件 ${name} 的监听器声明为 ${entry.mode}，不能按 ${mode} 派发`,
        { event: name, declared: entry.mode, dispatched: mode },
      )
    }
    return entries
  }
}

/**
 * 瀑布步进：从第 `index` 级开始，把 `current` 交给该级 handler。
 *
 * 返回值规则（施工单 02 §4）：handler 的返回值就是本级的处理结果；
 * `next(v)` 返回下游链的结果，因此「交还控制权」写成 `return next(v)` 即透传并可改写。
 *
 * @param entries 该事件的全部监听器（已按注册顺序）
 * @param name 事件名（错误信息用）
 * @param index 当前级数（0 起），达到上限即抛
 * @param current 当前值
 */
async function stepChain(
  entries: readonly ListenerEntry[],
  name: string,
  index: number,
  current: unknown,
): Promise<unknown> {
  if (index >= MAX_WATERFALL_DEPTH) {
    throw coreError(
      'waterfall-too-deep',
      `事件 ${name} 的瀑布超过 ${MAX_WATERFALL_DEPTH} 级（疑似自循环）`,
      { event: name, limit: MAX_WATERFALL_DEPTH },
    )
  }
  const entry = entries[index]
  if (!entry) return current
  return entry.listener(current, (nextValue) => stepChain(entries, name, index + 1, nextValue))
}
