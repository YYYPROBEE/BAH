/**
 * 扁平 span → 森林。
 *
 * **返回的是森林，不是一棵树**，而且这不是妥协是事实：`POST /api/turn` 只做入队就返回 202，
 * turn 由常驻 driver 在另一条微任务链上跑。两者时间重叠但**没有调用栈关系**，
 * 强行画成父子就是伪造"这个 turn 是那个 HTTP 请求同步算出来的"。
 *
 * 唯一的例外是 headless（`agent.send()` 同步驱动），那时可以只有 `turn` 一棵根。
 *
 * 健壮性：父 span 被采样丢掉时**提升为根**并标 `attributes.orphan = true`，绝不抛——
 * 观测面不该因为"少一条记录"就整页打不开。
 */

import type { SpanId } from './ids.ts'
import { durationMsOf, type TelemetrySpan } from './span.ts'

export interface SpanNode {
  readonly span: TelemetrySpan
  readonly depth: number
  readonly children: readonly SpanNode[]
  /**
   * 自身耗时：`durationMs - Σ(子 span 与自身时间窗相交的部分)`。
   *
   * 未闭合（`endMs === null`）时返回 `null`——**不是 0**。
   */
  readonly selfMs: number | null
}

/** 建树中间态（`span` 可能被替换成"标了 orphan 的副本"）。 */
interface RawNode {
  span: TelemetrySpan
  readonly children: RawNode[]
}

const compare = (a: RawNode, b: RawNode): number => {
  if (a.span.startMs !== b.span.startMs) return a.span.startMs - b.span.startMs
  return a.span.spanId < b.span.spanId ? -1 : a.span.spanId > b.span.spanId ? 1 : 0
}

/** 把扁平 span 建成森林（多根）。 */
export function buildForest(spans: readonly TelemetrySpan[]): SpanNode[] {
  const nodes = new Map<SpanId, RawNode>()
  // 先建全部节点，再连边：一遍 interleaved 会漏"子先出现、父后出现"的顺序。
  for (const span of spans) nodes.set(span.spanId, { span, children: [] })

  const roots: RawNode[] = []
  for (const span of spans) {
    const node = nodes.get(span.spanId) as RawNode
    const parentId = span.parentSpanId
    if (parentId === null) {
      roots.push(node)
      continue
    }
    const parent = nodes.get(parentId)
    if (parent === undefined) {
      // 父被采样掉了（或本就没有父）：提升为根并标注，不许静默变成"普通根"。
      node.span = { ...span, attributes: Object.freeze({ ...span.attributes, orphan: true }) }
      roots.push(node)
      continue
    }
    parent.children.push(node)
  }

  const materialize = (node: RawNode, depth: number): SpanNode => {
    const children = [...node.children].sort(compare).map((child) => materialize(child, depth + 1))
    const duration = durationMsOf(node.span)
    let selfMs: number | null = null
    if (duration !== null) {
      selfMs = duration
      for (const child of children) selfMs -= overlapMs(node.span, child.span)
      if (selfMs < 0) selfMs = 0
    }
    return { span: node.span, depth, children, selfMs }
  }

  return [...roots].sort(compare).map((root) => materialize(root, 0))
}

/** 子 span 与父 span 时间窗的重叠（未闭合的子按"到父结束"算）。 */
function overlapMs(parent: TelemetrySpan, child: TelemetrySpan): number {
  const parentEnd = parent.endMs ?? parent.startMs
  const childEnd = child.endMs ?? parentEnd
  const start = Math.max(parent.startMs, child.startMs)
  const end = Math.min(parentEnd, childEnd)
  return end > start ? end - start : 0
}

/**
 * 关键路径：从某个根到叶子里**累计时长最大**的一条。
 *
 * 并列时取先遍历到的那条（遍历顺序已被全序钉住），保证同一份输入永远同一条路径——否则 UI 会闪。
 * 返回从根到叶的 spanId 列表；空输入返回 `[]`。
 */
export function criticalPath(spans: readonly TelemetrySpan[]): readonly SpanId[] {
  if (spans.length === 0) return []
  const forest = buildForest(spans)
  let best: SpanId[] = []
  let bestCost = -1

  const walk = (node: SpanNode, path: readonly SpanId[], cost: number): void => {
    const nextCost = cost + (durationMsOf(node.span) ?? 0)
    const nextPath = [...path, node.span.spanId]
    if (node.children.length === 0) {
      if (nextCost > bestCost) {
        bestCost = nextCost
        best = nextPath
      }
      return
    }
    for (const child of node.children) walk(child, nextPath, nextCost)
  }

  for (const root of forest) walk(root, [], 0)
  return best
}
