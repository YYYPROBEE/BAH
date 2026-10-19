/**
 * 参数指纹（银行票据五绑定的一项）。
 *
 * 为什么本包自带一份而不是复用 `@bah/runtime` 的 `fingerprintOf`：
 * 工具族不依赖运行时包（插件线 → 运行时的反向依赖会让包层次变乱），而票据的
 * 参数绑定只需要「同一份参数得到同一个指纹」。算法与运行时保持一致：
 * 工具名 + 键序无关的 JSON 序列化。
 */

/** 参数指纹：`工具名:稳定 JSON`。 */
export function fingerprintOf(name: string, args: Readonly<Record<string, unknown>>): string {
  return `${name}:${stableStringify(args)}`
}

/** 键序无关的 JSON 序列化（只处理 JSON 可表达的形态）。 */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value) ?? 'null'
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(',')}]`
  }
  const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) =>
    left < right ? -1 : left > right ? 1 : 0,
  )
  const body = entries
    .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`)
    .join(',')
  return `{${body}}`
}
