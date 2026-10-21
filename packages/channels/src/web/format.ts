/**
 * 渠道侧的确定性格式化（无 locale 依赖）。
 *
 * 为什么不用 `Intl`：同一份会话在不同机器上必须渲染出**逐字相同**的帧，
 * 否则浏览器快照门禁（两次渲染 diff=0）会在不同时区的 CI 上有假红。
 */

/** 分 → `¥1,234.56`（与 `@bah/bank` 的 `formatYuan` 同口径，渠道不重算业务规则）。 */
export function formatCents(cents: number): string {
  const sign = cents < 0 ? '-' : ''
  const abs = Math.abs(Math.round(cents))
  const yuan = String(Math.floor(abs / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  return `${sign}¥${yuan}.${String(abs % 100).padStart(2, '0')}`
}

/** 元（可能是小数）→ 分；非正数 / 非有限数返回 `undefined`。 */
export function yuanToCents(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return undefined
  return Math.round((value + Number.EPSILON) * 100)
}

/** epoch ms → `HH:MM:SS`（UTC；帧是纯数据，不在渠道里算本地时区）。 */
export function timeText(at: number): string {
  const iso = new Date(at).toISOString()
  return iso.slice(11, 19)
}

/** 长 ID → 短码（`ticket:call-1` → `call-1`；审计面板与工具卡对照用）。 */
export function shortId(id: string, max = 24): string {
  const tail = id.includes(':') ? id.slice(id.lastIndexOf(':') + 1) : id
  return tail.length <= max ? tail : `…${tail.slice(tail.length - max)}`
}
