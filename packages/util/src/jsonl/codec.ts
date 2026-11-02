/**
 * JSONL 行协议原语。
 *
 * 为什么放在 `@bah/util`：会话日志有**两个**读写方——运行时的 `@bah/persistence` 与
 * 测试夹具 `@bah/test-support`。两者不能互相依赖（project reference 会成环），
 * 但格式必须只有一份实现，否则「夹具与真后端同构」就退化成口头承诺。
 *
 * 边界：这里只管「一行 JSON」与「header 的判别标签」，不碰会话语义、不分配 `seq`、不做分代。
 * 尾行截断的**处置策略**也不在这里：运行时容忍并告警，快照夹具 fail-loud。
 */

/** header 行的判别标签（持久化后端与快照夹具共用）。 */
export const SESSION_LOG_HEADER_KIND = 'bah-session-header'

/** 一行 JSON 解出来的对象形状。 */
export type JsonLineObject = Readonly<Record<string, unknown>>

/** header 行的字段（不含判别标签）。 */
export interface SessionHeaderFields {
  readonly sessionId: string
  /** 逻辑格式版本；reader 遇到比自己新的版本必须拒绝打开。 */
  readonly formatVersion: number
  /** 创建时刻（epoch ms）。 */
  readonly createdAt: number
  /** 业务元数据（渠道、场景、父会话等，落账后不可改）。 */
  readonly meta?: Readonly<Record<string, unknown>>
}

/** 值 → 一行 JSON（不追加换行）。 */
export function encodeJsonLine(value: unknown): string {
  return JSON.stringify(value)
}

/** header 字段 → 一行 JSON（补上判别标签）。 */
export function encodeSessionHeaderLine(header: SessionHeaderFields): string {
  return encodeJsonLine({ kind: SESSION_LOG_HEADER_KIND, ...header })
}

/** 一行 JSON → 值；坏 JSON 返回 `undefined`（「坏」的处置交给调用方）。 */
export function parseJsonValue(text: string): unknown {
  try {
    return JSON.parse(text) as unknown
  } catch {
    return undefined
  }
}

/** 一行 JSON → 普通对象；坏 JSON / 数组 / 标量一律 `undefined`。 */
export function parseJsonObject(text: string): JsonLineObject | undefined {
  const value = parseJsonValue(text)
  return isJsonObject(value) ? value : undefined
}

/**
 * 一行 JSON → header 行；判别标签不命中也返回 `undefined`。
 *
 * 字段是否齐全由调用方决定：持久化后端要读"旧代"的字段，快照夹具要求 `sessionId` 必填。
 */
export function parseSessionHeaderLine(text: string): JsonLineObject | undefined {
  const value = parseJsonObject(text)
  return value !== undefined && value['kind'] === SESSION_LOG_HEADER_KIND ? value : undefined
}

/**
 * 按行切分（CRLF 容忍），丢掉末尾空串。
 *
 * 尾部半写行**保留**：是否把最后一行当"截断"由调用方判断（见 `isLastNonEmptyLine`）。
 */
export function splitLogLines(text: string): string[] {
  const lines = text.split(/\r?\n/)
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  return lines
}

/** 下标之后是否再没有非空行（判定"尾行"，供尾截断容忍策略使用）。 */
export function isLastNonEmptyLine(lines: readonly string[], index: number): boolean {
  for (let next = index + 1; next < lines.length; next += 1) {
    const line = lines[next]
    if (line !== undefined && line.length > 0) return false
  }
  return true
}

function isJsonObject(value: unknown): value is JsonLineObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
