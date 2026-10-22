/**
 * 「普通对象」判定——被脱敏、展平、深拷贝三处共用。
 *
 * 单独成文件而不是各写一遍：这三处对「什么算对象」的口径必须完全一致，
 * 否则会出现「展平时当叶子、脱敏时当容器」的裂缝。
 *
 * 判据是**原型**而不是 `typeof`：`Date` / `Map` / 类实例的 `typeof` 也是 `'object'`，
 * 按 `typeof` 判会把它们当成空容器（`Object.entries(new Date())` 是 `[]`），
 * 数据被静默吃成 `{}`。`Object.create(null)` 原型为 null，仍算普通对象。
 */

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object') return false
  if (Array.isArray(value)) return false
  const proto = Object.getPrototypeOf(value) as object | null
  return proto === Object.prototype || proto === null
}
