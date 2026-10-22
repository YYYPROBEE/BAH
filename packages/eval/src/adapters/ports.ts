/**
 * agent 侧接缝的结构化端口（**鸭子类型，不 import @bah/***）。
 *
 * 为什么不 import `@bah/core` 的 `Events`：一旦 import，评测包就有了 workspace 依赖，
 * 会牵动 `pnpm-lock.yaml`、根 tsconfig 的 project references、以及测试面的别名解析
 * ——三处都在 M0 的目录白名单之外（§5「冻结只读」）。
 *
 * 结构化端口把耦合面压到「一个方法的形状」，代价是接线处需要一次
 * `as unknown as EventSourcePort`（M1 落地，见汇报偏差列表第 4 条）。
 *
 * 形状与 `packages/core/src/events.ts` 的 `BahEvents.on(name, listener) => Disposer` 对齐：
 * 返回的 disposer 即「注册即可逆」的注销句柄（AGENTS.md 编码纪律 1）。
 */

/** 瀑布链的交还函数；不调它 = 短路（AGENTS.md 编码纪律 2：除有意拥有判决外必须调）。 */
export type SeamNext = (value: unknown) => Promise<unknown>

/** 接缝监听器：`emit` / `serial` / `waterfall` 共用同一形状。 */
export type SeamListener = (payload: unknown, next: SeamNext) => unknown

/** 事件源的最小面：只要能注册并拿回 disposer。 */
export interface EventSourcePort {
  on(name: string, listener: SeamListener): () => void
}

/**
 * 状态读取端口（TSD/FRS 的 S₀ / Send）。
 *
 * **只读**是硬约束（00 §1：评测包不写 agent 状态）。签名里没有写入口，
 * 从类型上就堵死「评测器为了判定顺手改一下状态」这条错路。
 */
export type StateReader = () => Readonly<Record<string, unknown>> | Promise<Readonly<Record<string, unknown>>>
