/**
 * 配置读取的唯一实现面（错误码/前缀由调用方通过 `fail` 注入）。
 *
 * 之前 host / safety / saga / bank / cli 各有一份 `readBoolean` /
 * `readPositiveInteger` / `readEnum` / `rejectUnknownKeys`；参数顺序与默认值语义
 * 已经出现漂移。这里只保留"怎么判定"，"报什么错"仍属各包契约。
 */

/** 失败出口：必须抛错（返回类型 `never` 让控制流收窄）。 */
export type ConfigFailure = (
  message: string,
  detail: Readonly<Record<string, unknown>>,
) => never

/** 拒绝未声明键（`allowed` 为空时文案给出"无"）。 */
export function rejectUnknownConfigKeys(
  record: Readonly<Record<string, unknown>>,
  allowed: readonly string[],
  where: string,
  fail: ConfigFailure,
): void {
  const unknown = Object.keys(record).filter((key) => !allowed.includes(key))
  if (unknown.length === 0) return
  fail(
    `${where} 出现未知配置键：${unknown.join(', ')}（可写：${allowed.join(' / ')}${allowed.length === 0 ? '无' : ''}）`,
    { where, unknown },
  )
}

/** 拼接错误定位（空 `where` 时只写键名）。 */
function locate(where: string, key: string): string {
  return where.length === 0 ? key : `${where}.${key}`
}

/** 读布尔；`nullAsUndefined` 用于兼容 JSON/YAML 的 `null` 缺省写法。 */
export function readConfigBoolean(
  record: Readonly<Record<string, unknown>>,
  key: string,
  where: string,
  fallback: boolean,
  fail: ConfigFailure,
  options: { readonly nullAsUndefined?: boolean } = {},
): boolean {
  const value = record[key]
  if (value === undefined || (options.nullAsUndefined === true && value === null)) return fallback
  if (typeof value !== 'boolean') {
    fail(`${locate(where, key)} 必须是布尔（收到 ${String(value)}）`, { where, key, value })
  }
  return value
}

/** 读正整数；未写返回 `fallback`（可显式传 `undefined`）。 */
export function readConfigPositiveInteger(
  record: Readonly<Record<string, unknown>>,
  key: string,
  where: string,
  fallback: number | undefined,
  fail: ConfigFailure,
): number | undefined {
  const value = record[key]
  if (value === undefined) return fallback
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    fail(`${locate(where, key)} 必须是正整数（收到 ${String(value)}）`, { where, key, value })
  }
  return value
}

/** 读枚举；`fallback` 可为 `undefined`（未写即缺省）。 */
export function readConfigEnum<T extends string>(
  record: Readonly<Record<string, unknown>>,
  key: string,
  where: string,
  allowed: readonly T[],
  fallback: T | undefined,
  fail: ConfigFailure,
): T | undefined {
  const value = record[key]
  if (value === undefined) return fallback
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) {
    fail(`${locate(where, key)} 只能是 ${allowed.join(' / ')}（收到 ${String(value)}）`, {
      where,
      key,
      allowed,
      value,
    })
  }
  return value as T
}
