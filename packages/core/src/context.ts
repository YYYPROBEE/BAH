/**
 * 插件运行环境 `BahContext`。
 *
 * 一个 `BahContext` 就是一个应用实例：插件集合 + 服务注册表 + 事件源 + 作用域。
 * 插件想要的一切都取自 ctx —— 内核不认识任何具体服务（按键寻址）。
 *
 * 生命周期三段：
 * `install`（插件 `apply`，可 inject 等待服务）→ `start`（就绪）→ `ready`；
 * `dispose(reason)` 逆序回滚全部 effect（桶间逆序，桶内也逆序）。
 *
 * 设计约束：`services` / `waiting` / `disposers` 都是私有结构，`get` 是服务取用的唯一入口；
 * 测试只通过公开 API 验证行为。
 */

import { BahError, logJson } from '@bah/util'

import type {
  AgentScope,
  BahEventMap,
  Context,
  Disposer,
  EffectDisposer,
  ErasedPlugin,
  EventMode,
  EventName,
  Events,
  Listener,
  PluginV2,
  ServiceKey,
} from './api.ts'
import { coreError, describeThrown } from './errors.ts'
import { BahEvents } from './events.ts'
import { describeUnresolved, erasePlugin, findInjectCycle, resolveConfig } from './plugin.ts'
import { BahScope, createIsolate } from './scope.ts'
import { ServiceRegistry } from './service.ts'
import {
  once,
  type ContributionBucket,
  type EffectEntry,
  type PluginRecord,
  type RawListener,
} from './types.ts'

/** Context 生命周期状态（对应的 install → start → ready 三段）。 */
export type ContextPhase = 'idle' | 'installing' | 'ready' | 'disposed'

/**
 * 事件源门面：把 `on` 的贡献记到**当前归属者**名下（dispose 时随插件一起回滚），
 * 并在 `parallel` 上装「install 阶段禁止广播」的守卫。
 *
 * 事件源本体（注册表 + 派发）是 `BahEvents`，全应用一份；门面只负责归属与生命周期守卫。
 */
class OwnedEvents implements Events {
  constructor(
    private readonly context: BahContext,
    private readonly source: BahEvents,
  ) {}

  on<K extends EventName>(name: K, listener: Listener<K>): Disposer
  on(name: string, listener: RawListener, mode: EventMode): Disposer
  on(name: string, listener: RawListener, mode?: EventMode): Disposer {
    return this.context.effect(this.source.register(name, listener, mode))
  }

  emit<K extends EventName>(name: K, payload: BahEventMap[K]): void {
    this.source.emit(name, payload)
  }

  emitIsolated<K extends EventName>(
    name: K,
    payload: BahEventMap[K],
    onError?: (error: unknown, event: K) => void,
  ): void {
    this.source.emitIsolated(name, payload, onError)
  }

  serial<K extends EventName>(name: K, payload: BahEventMap[K]): Promise<void> {
    return this.source.serial(name, payload)
  }

  parallel<K extends EventName>(name: K, payload: BahEventMap[K]): Promise<void> {
    this.context.assertParallelAllowed(name)
    return this.source.parallel(name, payload)
  }

  waterfall<K extends EventName>(name: K, value: BahEventMap[K]): Promise<BahEventMap[K]> {
    return this.source.waterfall(name, value)
  }

  bail<K extends EventName>(name: K, value: BahEventMap[K]): Promise<BahEventMap[K] | undefined> {
    return this.source.bail(name, value)
  }
}

/**
 * 回滚失败的上报载荷（`context/rollback-failed` 事件载荷，**稳定契约，只增不改**）。
 *
 * 只放标量：监听器若在回滚中途再登记 effect，等于把「往已回滚的桶里塞清理」引回来。
 */
export interface RollbackFailure {
  /** 贡献桶名（插件名或 `core:kernel`）。 */
  readonly bucket: string
  /** 条目身份，形如 `bank:saga#7`。 */
  readonly effect: string
  /** 理由码：`BahError` 原样透传，非结构化抛出统一为 `disposer-failed`。 */
  readonly code: string
  /** 可读理由（禁止静默吞错）。 */
  readonly message: string
}

/**
 * 内核 Context 实现。
 *
 * 除 `Context` 契约外只多一个 `use()`：插件注册入口（插件装配属内核自身职责，
 * 放进冻结的 `api.ts` 会破坏已签审的接缝面）。
 */
export class BahContext implements Context {
  readonly events: Events
  readonly scope: AgentScope

  /** 事件源本体（与门面共享同一份注册表）。 */
  private readonly source = new BahEvents()

  /** 服务注册表 + waiting 队列。 */
  private readonly services = new ServiceRegistry()

  /** 作用域注册表（`scope` 字段是同一实例的接口视图）。 */
  private readonly scopeRegistry = new BahScope()

  /** 已注册插件，数组顺序 = 注册顺序。 */
  private readonly plugins: PluginRecord[] = []

  /** 内核自身名下的贡献（`start` 之后由调用方登记的 effect 落这里）。 */
  private readonly kernel: ContributionBucket = { name: 'core:kernel', effects: [] }

  /** 当前贡献归属者：install 期间 = 正在安装的插件，其余时刻 = 内核。 */
  private owner: ContributionBucket = this.kernel

  private currentPhase: ContextPhase = 'idle'

  /** effect 身份序号（只增不减）：回滚失败上报的身份必须稳定且可区分。 */
  private effectSeq = 0

  constructor() {
    this.events = new OwnedEvents(this, this.source)
    this.scope = this.scopeRegistry
  }

  /** 生命周期状态（审计与门禁用）。 */
  get phase(): ContextPhase {
    return this.currentPhase
  }

  /**
   * 注册插件（install 入口）。
   *
   * 配置在**载入时**同步校验，失败即抛；
   * 同名插件按「后者覆盖前者」处理：前者的贡献立即回滚。
   *
   * 返回 Promise 的原因：应用已 `ready` 时注册要立刻跑 `apply`（可能异步），
   * 而配置错误的抛出**仍是同步的**——「载入即抛」不能让调用方漏掉。
   */
  use<P>(plugin: PluginV2<P>, config?: P): Promise<this> {
    return this.useErased(erasePlugin(plugin), config)
  }

  /**
   * 注册一个已擦除配置类型的插件（内部装配面使用；调用方需先完成配置校验）。
   */
  useErased(plugin: ErasedPlugin, config?: unknown): Promise<this> {
    if (this.currentPhase === 'disposed' || this.currentPhase === 'installing') {
      throw coreError(
        'plugin-late-registration',
        `应用已进入 ${this.currentPhase} 状态，不允许再注册插件`,
        { phase: this.currentPhase, plugin: plugin.name },
      )
    }
    const resolved = resolveConfig(plugin, config)
    const existing = this.plugins.findIndex((record) => record.name === plugin.name)
    if (existing >= 0) {
      const [replaced] = this.plugins.splice(existing, 1)
      rollback(replaced!, 'plugin-replaced', this.reportRollbackFailure)
    }
    const record: PluginRecord = {
      name: plugin.name,
      plugin,
      config: resolved,
      inject: plugin.inject ?? [],
      effects: [],
      installed: false,
    }
    this.plugins.push(record)
    if (this.currentPhase === 'idle') return Promise.resolve(this)
    return this.installLate(record)
  }

  /**
   * 推进到起始态：install（逐个 `apply`，`inject` 未就绪则挂起）→ start → ready。
   *
   * 任一插件 `apply` 失败 → 整个应用 fail-loud：回滚全部贡献并置 `disposed`。
   */
  async start(): Promise<void> {
    if (this.currentPhase === 'ready') return
    if (this.currentPhase === 'disposed') {
      throw coreError('context-disposed', '应用已 dispose，不能再次 start')
    }
    if (this.currentPhase === 'installing') {
      throw coreError('context-installing', 'start 不允许重入（上一次 start 尚未完成）')
    }
    this.currentPhase = 'installing'
    try {
      await this.installAll()
    } catch (error) {
      await this.dispose('start-failed')
      throw error
    }
    this.currentPhase = 'ready'
  }

  /**
   * 逆序回滚全部贡献；`reason` 透传给每个 disposer。
   *
   * 回滚**不因单个 disposer 抛错而中断**（C9）：失败逐个上报后继续，最后保证作用域表已清空。
   * 否则一个坏插件能拖住全应用（含其它插件的清理与 `scope` 的释放）。
   */
  async dispose(reason?: string): Promise<void> {
    if (this.currentPhase === 'disposed') return
    this.currentPhase = 'disposed'
    try {
      for (const record of [...this.plugins].reverse()) {
        rollback(record, reason, this.reportRollbackFailure)
      }
      rollback(this.kernel, reason, this.reportRollbackFailure)
    } finally {
      // 第二道保险，不是唯一保险：上报器自己已经兜住了异常，所以当前路径下 rollback
      // 不会抛（去掉本行实测用例仍全绿）。留着是因为将来若有人在 rollback 里加出新的
      // 抛出点，泄漏 `scope` 的代价比多一层 try 大得多。
      this.scopeRegistry.clear()
    }
  }

  /**
   * 登记一次可逆贡献：挂到**当前归属者**名下，dispose 时逆序执行并收到原因。
   *
   * 返回的 disposer 用于提前撤销；撤销后不会在 dispose 阶段重复执行（幂等）。
   *
   * `disposed` 之后一律拒绝：允许登记等于允许把清理登记到一个**已经回滚过**的桶，
   * 那个 disposer 永远不会执行——比抛错更糟，它静默泄漏（C9）。
   */
  effect(disposer: EffectDisposer): Disposer {
    if (this.currentPhase === 'disposed') {
      throw coreError(
        'effect-after-dispose',
        '应用已 dispose，不能再登记 effect（该清理永远不会被执行）',
        { bucket: this.owner.name },
      )
    }
    const bucket = this.owner
    const entry: EffectEntry = {
      id: `${bucket.name}#${++this.effectSeq}`,
      disposer,
      done: false,
    }
    bucket.effects.push(entry)
    return once(() => {
      if (entry.done) return
      entry.done = true
      disposer()
    })
  }

  /** 注册服务实例（同时登记为本插件贡献：插件被回滚时服务一起撤销）。 */
  provide<T>(key: ServiceKey<T>, instance: T): Disposer {
    return this.effect(this.services.provide(key, instance))
  }

  whenReady<T>(key: ServiceKey<T>): Promise<T> {
    return this.services.whenReady(key)
  }

  /** 服务 getter：未注册即抛错，绝不返回 `undefined`。 */
  get<T>(key: ServiceKey<T>): T {
    return this.services.get(key)
  }

  /** 键屏蔽代理：事件与贡献共享父级，仅屏蔽指定服务键。 */
  isolate(...keys: ServiceKey<unknown>[]): Context {
    return createIsolate(this, new Set(keys.map((key) => key.id)))
  }

  /**
   * 广播守卫：install 阶段监听器集合尚未完整，`parallel` 必须 fail-loud
   * 。
   */
  assertParallelAllowed(name: string): void {
    if (this.currentPhase !== 'installing') return
    throw coreError(
      'listeners-incomplete',
      `有监听器未完成：install 阶段（插件 ${this.owner.name} 的 apply 内）不允许 parallel 广播「${name}」，请在 start 完成后再派发`,
      { plugin: this.owner.name, event: name },
    )
  }

  /**
   * 回滚失败的上报器：把一次 disposer 失败交给 `context/rollback-failed` 的观察者。
   *
   * 用 `emitIsolated` 而不是 `emit`：回滚期间一个坏监听器抛错，会重新把「回滚中断」
   * 引回来——那正是本卡的靶子。上报器自己也可能失败（监听器声明了与派发不一致的
   * mode 时 `select()` 会在派发前抛），所以整段再套一层 `try/catch`：只留痕，不再抛。
   * 抛出去等于让「上报失败」升级成「清理中断」，比不报更糟。
   */
  private readonly reportRollbackFailure = (failure: RollbackFailure): void => {
    try {
      this.source.emitIsolated('context/rollback-failed', failure, (error) => {
        logJson('error', 'core.rollback-listener-failed', { reason: describeThrown(error) })
      })
    } catch (error) {
      logJson('error', 'core.rollback-report-failed', { reason: describeThrown(error) })
    }
  }

  /** 逐轮安装：一轮里可推进的插件全部装上，一轮毫无进展即判定死锁。 */
  private async installAll(): Promise<void> {
    const pending = this.plugins.filter((record) => !record.installed)
    while (pending.length > 0) {
      const before = pending.length
      for (let index = 0; index < pending.length; index += 1) {
        const record = pending[index]!
        if (!record.inject.every((id) => this.services.has(id))) continue
        pending.splice(index, 1)
        index -= 1
        await this.install(record)
      }
      if (pending.length === before) throw this.injectDeadlock(pending)
    }
  }

  /**
   * 执行单个插件的 `apply`：归属临时切到该插件，失败统一包装成 `bah-core: ` 错误。
   *
   * 已结构化的内核错误（`BahError`，如广播守卫、服务冲突）**原样上抛**：它们自带理由码与
   * 插件名，再包一层只会把 `code` 埋掉。
   */
  private async install(record: PluginRecord): Promise<void> {
    const previous = this.owner
    this.owner = record
    try {
      await record.plugin.apply(this, record.config)
      record.installed = true
    } catch (error) {
      if (error instanceof BahError) throw error
      throw coreError(
        'plugin-failed',
        `插件 ${record.name} 的 apply 失败：${describeThrown(error)}`,
        { plugin: record.name, cause: error },
      )
    } finally {
      this.owner = previous
    }
  }

  /**
   * 应用已 `ready` 后再注册插件：立刻安装；失败则撤掉该记录并回滚它的贡献。
   *
   * `inject` 依赖同样要先就绪——运行期不许绕过等待（否则插件拿到半初始化的服务）。
   */
  private async installLate(record: PluginRecord): Promise<this> {
    try {
      if (!record.inject.every((id) => this.services.has(id))) {
        throw this.injectDeadlock([record])
      }
      await this.install(record)
    } catch (error) {
      const index = this.plugins.indexOf(record)
      if (index >= 0) this.plugins.splice(index, 1)
      rollback(record, 'install-failed', this.reportRollbackFailure)
      throw error
    }
    return this
  }

  /** 死锁判定：成环打印环路径，否则打印每个插件的未就绪依赖。 */
  private injectDeadlock(pending: readonly PluginRecord[]): BahError {
    const cycle = findInjectCycle(pending)
    const waiting = describeUnresolved(pending, (id) => this.services.has(id))
    if (cycle) {
      return coreError('inject-deadlock', `服务等待成环：${cycle.join(' → ')}`, { cycle, waiting })
    }
    return coreError('inject-deadlock', `服务依赖无法满足：${waiting}`, { waiting })
  }
}

/**
 * 逆序执行桶内尚未执行的 disposer。
 *
 * `reason` 原样透传给每个 disposer；
 * 已提前撤销（`done`）的条目跳过，保证「撤销后不重复执行」。
 *
 * **单个 disposer 抛错不中断本桶**（C9）：失败交给 `onFailure` 逐个上报后继续。
 * 中断会让「一个坏插件」拖住全应用——其它插件与服务注册都还挂在后面的条目上。
 */
function rollback(
  bucket: ContributionBucket,
  reason?: string,
  onFailure?: (failure: RollbackFailure) => void,
): void {
  for (const entry of [...bucket.effects].reverse()) {
    if (entry.done) continue
    entry.done = true
    try {
      entry.disposer(reason)
    } catch (error) {
      onFailure?.({
        bucket: bucket.name,
        effect: entry.id,
        code: error instanceof BahError ? error.code : 'disposer-failed',
        message: describeThrown(error),
      })
    }
  }
}

/** 建一个应用实例（插件集合 + 服务 + 事件源 + 作用域）。 */
export function createContext(): BahContext {
  return new BahContext()
}
