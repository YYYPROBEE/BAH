/**
 * @bah/util · brand —— 跨边界不透明 ID 的品牌类型（施工单 00 §10）。
 *
 * 纯类型构造：只在类型层存在，运行时不产生任何值。
 */

declare const brand: unique symbol

/**
 * 跨边界不透明 ID。
 *
 * `Branded<'session-id'>` 与 `Branded<'ticket-id'>` 在类型层互不兼容，
 * 即使底层都是 `string`——防止会话 ID 误传给票据参数。
 */
export type Branded<Name extends string, Base = string> = Base & {
  readonly [brand]: Name
}
