/**
 * SSE 文本流解析。
 *
 * WHY 手写：网关只消费宿主 SSE 的两种事件（`frame` 与心跳注释），
 * 引 `eventsource` 会带一条第三方依赖（02 §1 零依赖），而 `EventSource` 在 Node 里不可用。
 *
 * 纪律：解析必须是**纯函数**（buffer 进、事件 + 剩余出），否则"断线重连后帧错位"
 * 这类问题只能靠线上观察。
 */

import type { WebFrame } from '@bah/channels'

/** 一个 SSE 事件（`event` 名 + 已拼接的 `data`）。 */
export interface SseEvent {
  readonly event: string
  readonly data: string
}

/** 解析结果：完整事件 + 未闭合的剩余文本。 */
export interface SseParseResult {
  readonly events: readonly SseEvent[]
  readonly rest: string
}

/** 解析一块 SSE 文本（按空行分帧）。 */
export function parseSseBuffer(buffer: string): SseParseResult {
  // CRLF 归一：Windows 上的中间代理可能改写换行，帧边界必须是 `\n\n`
  const normalized = buffer.replace(/\r\n/g, '\n')
  const blocks = normalized.split('\n\n')
  const rest = blocks.pop() ?? ''
  const events: SseEvent[] = []
  for (const block of blocks) {
    const parsed = parseBlock(block)
    if (parsed !== undefined) events.push(parsed)
  }
  return { events, rest }
}

/** 解析单个事件块（注释行忽略；多行 `data:` 用 `\n` 拼接）。 */
function parseBlock(block: string): SseEvent | undefined {
  let event = 'message'
  const data: string[] = []
  for (const line of block.split('\n')) {
    if (line.startsWith(':')) continue
    if (line.startsWith('event:')) {
      event = line.slice('event:'.length).trim()
      continue
    }
    if (line.startsWith('data:')) {
      // SSE 规范：`data:` 后允许一个前导空格，不算内容
      data.push(line.slice('data:'.length).replace(/^ /, ''))
    }
  }
  if (data.length === 0) return undefined
  return { event, data: data.join('\n') }
}

/**
 * 把一个 `frame` 事件解成 `WebFrame`。
 *
 * 非法 JSON / 缺 `kind` 一律 `undefined`（丢弃而不是抛）：网关面对的是自己子进程的输出，
 * 但"半截帧"（进程被 SIGKILL 时）不应该把整条链路打断。
 */
export function frameOfEvent(event: SseEvent): WebFrame | undefined {
  if (event.event !== 'frame') return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(event.data) as unknown
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined
  const kind = (parsed as { kind?: unknown }).kind
  if (typeof kind !== 'string' || kind.length === 0) return undefined
  return parsed as WebFrame
}
