/**
 * 流式分片装配（施工单 05 §1 + §2.1 第 1 步）。
 *
 * 核心不变量：**工具参数只能在 `block-end` 时整体 parse**。分片阶段拿到的永远是半截 JSON，
 * 提前 parse 必然失败——这是"参数格式漂移"风险点最容易被写错的地方。
 *
 * 坏 JSON **不在这里抛错**：装配器只负责如实标注 `parseError`，如何补（回灌 + 修复重试一次）
 * 属 `repair.ts` 的三级防线（施工单 05 §2.3）。装配器抛错只用于**协议自身不一致**
 * （同一 index 混用块类型、流没有 `finish` 收尾）。
 */

import { BahError, assertNever } from '@bah/util'

import type {
  AssembledStream,
  AssembledToolCall,
  CallUsage,
  ContentBlock,
  FinishReason,
  StreamChunk,
} from './types.ts'

/** 零用量（provider 没报 usage 时的缺省值）。 */
const ZERO_USAGE: CallUsage = { input: 0, output: 0 }

/** 组装一个块索引 → 内容块的累积器。 */
interface Slot {
  kind: 'text' | 'reasoning' | 'tool-call'
  text: string
  id?: string
  name?: string
}

export class StreamAssembler {
  /** 尚未 `block-end` 的块：index → 累积器（插入顺序即出现顺序）。 */
  private readonly open = new Map<number, Slot>()

  /** 已闭合的块（最终按 index 升序产出）。 */
  private readonly closed = new Map<number, Slot>()

  private usage: CallUsage | undefined

  private reason: FinishReason | undefined

  /** 吃一片（`finish()` 之前可任意次）。 */
  push(chunk: StreamChunk): void {
    switch (chunk.kind) {
      // 切块标记本身不携带数据：真正的类型由第一个 delta 决定（provider 不保证顺序）
      case 'block-start':
        return

      case 'text-delta':
        this.extend(chunk.index, 'text', chunk.text)
        return

      case 'reasoning-delta':
        this.extend(chunk.index, 'reasoning', chunk.text)
        return

      case 'tool-call-delta':
        this.extendToolCall(chunk)
        return

      case 'block-end':
        this.close(chunk.index)
        return

      // provider 可能分多次报（OpenAI 兼容形态通常只报一次）：取各字段最大值，
      // 对"最终总量"与"增量叠加"两种形态都成立，且不会重复累加。
      case 'usage':
        this.usage = {
          input: Math.max(this.usage?.input ?? 0, chunk.input),
          output: Math.max(this.usage?.output ?? 0, chunk.output),
        }
        return

      case 'finish':
        this.reason = chunk.reason
        return

      default:
        assertNever(chunk, 'llm-stream-chunk')
    }
  }

  /**
   * 收尾：闭合残留块（容忍 provider 漏发 `block-end`）并产出完整结果。
   *
   * @throws `BahError('llm-stream-unfinished')` 流没有 `finish` 收尾（半截流不能当真结果）
   * @throws `BahError('llm-chunk-conflict')` 同一块索引混用两种内容类型
   */
  finish(): AssembledStream {
    // 漏发 block-end 时按"已收到的分片"收尾：provider 千差万别，半截流比整条丢弃更可审计
    for (const index of [...this.open.keys()]) this.close(index)

    if (this.reason === undefined) {
      throw new BahError(
        'llm-stream-unfinished',
        'llm: 流没有 finish 收尾（半截流不能当成完整结果，请检查 provider 或重试）',
      )
    }

    const indexes = [...this.closed.keys()].sort((left, right) => left - right)
    const content: ContentBlock[] = []
    const toolCalls: AssembledToolCall[] = []

    for (const index of indexes) {
      const slot = this.closed.get(index)
      if (slot === undefined) continue
      content.push(toBlock(index, slot))
      const call = toToolCall(index, slot)
      if (call !== undefined) toolCalls.push(call)
    }

    return {
      content,
      toolCalls,
      finishReason: this.reason,
      usage: this.usage ?? ZERO_USAGE,
    }
  }

  /** 追加文本类分片；同一 index 换类型属协议不一致。 */
  private extend(index: number, kind: 'text' | 'reasoning', text: string): void {
    const slot = this.slotOf(index, kind)
    slot.text += text
  }

  /** 追加工具调用分片（id / name 只在首个分片出现，后续分片沿用）。 */
  private extendToolCall(chunk: Extract<StreamChunk, { kind: 'tool-call-delta' }>): void {
    const slot = this.slotOf(chunk.index, 'tool-call')
    if (chunk.id !== undefined) slot.id = chunk.id
    if (chunk.name !== undefined) slot.name = chunk.name
    if (chunk.argsText !== undefined) slot.text += chunk.argsText
  }

  /** 取（或建）该索引的累积器，并校验类型一致性。 */
  private slotOf(index: number, kind: Slot['kind']): Slot {
    const existing = this.open.get(index)
    if (existing === undefined) {
      const created: Slot = { kind, text: '' }
      this.open.set(index, created)
      return created
    }
    if (existing.kind !== kind) {
      throw new BahError(
        'llm-chunk-conflict',
        `llm: 块 ${index} 先按 ${existing.kind} 累积，又收到 ${kind} 分片（provider 协议不一致）`,
        { index, declared: existing.kind, actual: kind },
      )
    }
    return existing
  }

  /** 闭合一个块（不存在则忽略：`block-end` 可能为未出现的空块）。 */
  private close(index: number): void {
    const slot = this.open.get(index)
    if (slot === undefined) return
    this.open.delete(index)
    this.closed.set(index, slot)
  }
}

/**
 * 吃完整条流并装配。
 *
 * @throws `BahError('llm-stream-unfinished')` 流没有 `finish`
 */
export async function assembleStream(
  chunks: AsyncIterable<StreamChunk>,
): Promise<AssembledStream> {
  const assembler = new StreamAssembler()
  for await (const chunk of chunks) assembler.push(chunk)
  return assembler.finish()
}

/** 累积器 → 内容块。 */
function toBlock(index: number, slot: Slot): ContentBlock {
  switch (slot.kind) {
    case 'text':
      return { kind: 'text', text: slot.text }
    case 'reasoning':
      return { kind: 'reasoning', text: slot.text }
    case 'tool-call': {
      const parsed = parseArgumentsText(slot.text)
      return {
        kind: 'tool-call',
        id: callIdOf(index, slot.id),
        name: nameOf(slot.name),
        // 坏 JSON 时保留原文（交给 repair），不静默当空对象
        args: parsed.args ?? slot.text,
      }
    }
    default:
      // `Slot` 是同一接口上的字面量属性（不是判别联合的对象成员），故收尾取属性而非对象本身
      return assertNever(slot.kind, 'stream-slot')
  }
}

/** 累积器 → 工具调用视图（非工具块返回 `undefined`）。 */
function toToolCall(index: number, slot: Slot): AssembledToolCall | undefined {
  if (slot.kind !== 'tool-call') return undefined
  const parsed = parseArgumentsText(slot.text)
  const call: AssembledToolCall = {
    callId: callIdOf(index, slot.id),
    name: nameOf(slot.name),
    argsText: slot.text,
    ...(parsed.args === undefined ? {} : { args: parsed.args }),
    ...(parsed.error === undefined ? {} : { parseError: parsed.error }),
  }
  return call
}

/** 参数文本 → 对象；空文本视为无参（`{}`）。坏 JSON 只标注，不抛错。 */
export function parseArgumentsText(
  text: string,
): { args?: Readonly<Record<string, unknown>>; error?: string } {
  const raw = text.trim()
  if (raw === '') return { args: {} }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    return { error: `参数不是合法 JSON：${reason}` }
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { error: '参数不是 JSON 对象（工具参数必须以 object 为根）' }
  }
  return { args: parsed as Readonly<Record<string, unknown>> }
}

/** 调用 ID 缺省值：provider 没给 id 时按块序号派生，保证日志内唯一且确定性。 */
function callIdOf(index: number, id: string | undefined): string {
  return id ?? `call-${index}`
}

/** 工具名缺省值（provider 漏报 name 时如实标注，不猜）。 */
function nameOf(name: string | undefined): string {
  return name ?? '<unnamed>'
}
