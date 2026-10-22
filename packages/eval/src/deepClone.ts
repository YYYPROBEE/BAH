/**
 * 深拷贝（只处理 JSON 面数据）。
 *
 * 为什么不用 `structuredClone`：它对函数 / Symbol / 类实例会直接抛错，而状态快照的
 * 输入来自业务侧，形状不完全可控——一个不可预测的抛错点会把「取快照」变成 episode
 * 的致命路径。这里改成「认识的深拷、不认识的原样保留」，行为可预测。
 *
 * 为什么要深拷：`flattenState` 对数组和空对象**保留原引用**（它们是叶子值）。
 * 快照只做 `{...state}` 的浅拷贝时，后续对数组的 push 会直接改掉已取的历史快照——
 * 证据链被就地篡改，而且看不出痕迹。
 */

import { isPlainObject } from './plainObject.ts'

/** 递归复制普通对象 / 数组 / Date；其他值（函数、类实例等）原样返回。 */
export function deepClone<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((item: unknown) => deepClone(item)) as T
  }

  if (value instanceof Date) {
    return new Date(value.getTime()) as T
  }

  if (isPlainObject(value)) {
    const output: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value)) {
      output[key] = deepClone(item)
    }
    return output as T
  }

  return value
}
