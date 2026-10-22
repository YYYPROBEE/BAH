/**
 * 嵌套状态 → 扁平键值（TSD/FRS 的输入形态）。
 *
 * 为什么需要这一层：BAH 的权威状态是 `SagaProjection = { sagaId, state, steps }`（嵌套），
 * 而 §4.3 的 TSD 要的是「扁平键值状态快照」。展平规则必须是**确定性且可逆推**的，
 * 否则「键变了」这件事在报告里说不清是哪一层变的。
 *
 * 规则（刻意保守，只展平普通对象）：
 * - 普通对象 → 递归，键路径用 `.` 连接（`steps.s1.state`）
 * - 数组 → 整体作为叶子值（TSD 的「等价集合」比较正是为它准备的）
 * - `undefined` → 跳过该键（有无键与「键值为 undefined」在 JSON 里无法区分，
 *   强行写入会制造假变更）
 * - null / 基本类型 → 叶子值
 *
 * 不展平的代价说明：数组内部的元素变化会被 TSD 当成「整个数组变了」，定位串只到
 * 数组这一级。这是取舍——数组一旦按索引展平，插入一个元素就会让后面所有键整体位移，
 * 报告会变成几十条噪音，比「数组变了」更难读。
 */

import type { FlatState } from '../types.ts'
import { isPlainObject } from '../plainObject.ts'

export interface FlattenOptions {
  /** 键分隔符，缺省 `.`。 */
  readonly separator?: string
}

function walk(
  value: unknown,
  prefix: string,
  separator: string,
  output: Record<string, unknown>,
): void {
  if (value === undefined) return

  if (isPlainObject(value)) {
    const entries = Object.entries(value)
    // 空对象保留为一个叶子值：它能表达「这里本来该有内容但没了」，
    // 直接跳过会让 `steps` 从有到空的变化消失。
    if (entries.length === 0) {
      output[prefix] = {}
      return
    }
    for (const [key, item] of entries) {
      const path = prefix === '' ? key : `${prefix}${separator}${key}`
      walk(item, path, separator, output)
    }
    return
  }

  output[prefix] = value
}

/** 展平任意嵌套状态。顶层不是对象时返回空表（状态快照必须是对象）。 */
export function flattenState(input: unknown, options: FlattenOptions = {}): FlatState {
  if (!isPlainObject(input)) return {}
  const output: Record<string, unknown> = {}
  walk(input, '', options.separator ?? '.', output)
  return output
}

/**
 * `SagaProjection` 展平（业务语义别名）。
 *
 * 产出的键形如：`sagaId`、`state`、`steps.<stepId>.state`、`steps.<stepId>.<其他字段>`。
 * 之所以不改成 `saga.state` 前缀：M1 金标的 `mustChange` 要手写这些键，
 * 多一层前缀只会让金标更难写、更易错。
 */
export function flattenSagaProjection(projection: unknown): FlatState {
  return flattenState(projection)
}
