/**
 * "哪条 user 消息算一次用户发话"——模型适配器与离线路由共用的判定。
 *
 * ## 为什么需要它
 *
 * 主循环会把 `runtimeContext`（"【当前用户】姓名：张三；等级：金卡"）作为 **user 消息**
 * 注入上下文，且每个 step 都可能出现。于是"最后一条 user 消息"经常不是用户说的话，
 * 而是平台自己塞的环境段。任何"读用户原话"的逻辑（意图路由、按轮步进）都会因此读错。
 *
 * 这个文件只做一件事：把"平台注入的上下文"与"用户真的说了话"分开。
 */

import type { LlmMessage } from './types.ts'

/**
 * 平台注入的环境段前缀（生产方在 `packages/runtime/src/system-prompt/sections.ts`）。
 *
 * 放这里而不是 import runtime：依赖方向是 runtime → llm，反向 import 会成环。
 * 漂移由 runtime 侧一条用例守住（断言生产出的文本确实以此开头）。
 */
export const PLATFORM_CONTEXT_PREFIX = '【当前用户】'

/** 该消息是否是平台注入的环境段（而不是用户原话）。 */
export function isPlatformContext(message: LlmMessage): boolean {
  if (message.role !== 'user') return false
  const texts: string[] = []
  for (const block of message.content) {
    if (block.kind === 'text') texts.push(block.text)
  }
  return texts.join('').trimStart().startsWith(PLATFORM_CONTEXT_PREFIX)
}

/**
 * 最后一条"真的用户发话"的下标（没有则 -1）。
 *
 * @param messages 完整消息序列
 */
export function lastUserTurnIndex(messages: readonly LlmMessage[]): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message?.role !== 'user') continue
    if (isPlatformContext(message)) continue
    return index
  }
  return -1
}

/** 最后一条真实用户消息的文本（多条 text 块用换行拼接；没有则空串）。 */
export function lastUserText(messages: readonly LlmMessage[]): string {
  const index = lastUserTurnIndex(messages)
  if (index < 0) return ''
  const texts: string[] = []
  for (const block of messages[index]!.content) {
    if (block.kind === 'text') texts.push(block.text)
  }
  return texts.join('\n').trim()
}

/**
 * 本 turn 已经产生了几条 assistant 消息（从最后一条真实用户消息往后数）。
 *
 * 必须从"真实用户消息"算起：平台上下文也是 user，若按"最后一条 user"分段，
 * 每个 step 都会把计数清零，模型会永远停在第 1 步。
 */
export function assistantTurnsSinceUser(messages: readonly LlmMessage[]): number {
  const start = lastUserTurnIndex(messages)
  const begin = start < 0 ? 0 : start + 1
  let count = 0
  for (let index = begin; index < messages.length; index += 1) {
    if (messages[index]?.role === 'assistant') count += 1
  }
  return count
}
