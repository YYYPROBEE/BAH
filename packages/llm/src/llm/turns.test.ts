/**
 * `llm/turns.ts` · "哪条 user 消息算一次用户发话"。
 *
 * 守的不变量：主循环把 `runtimeContext`（"【当前用户】…"）也塞成 **user 消息**，
 * 所以"最后一条 user"经常不是人说的话。任何"读用户原话"或"按轮步进"的逻辑一旦
 * 把它当用户发话，就会读错意图 / 把计数清零。这组用例把这三个坑逐个钉住。
 */

import { describe, expect, it } from 'vitest'

import type { LlmMessage } from './types.ts'
import {
  PLATFORM_CONTEXT_PREFIX,
  assistantTurnsSinceUser,
  isPlatformContext,
  lastUserText,
  lastUserTurnIndex,
} from './turns.ts'

/** 造一条真实用户发话（可给多块 text，用来验证拼接与 trim）。 */
function user(...texts: string[]): LlmMessage {
  return { role: 'user', content: texts.map((text) => ({ kind: 'text', text })) }
}

/** 造一条平台注入的环境段（前缀与生产方一致）。 */
function platform(...texts: string[]): LlmMessage {
  return {
    role: 'user',
    content: texts.map((text) => ({ kind: 'text', text })),
  }
}

/** 造一条 assistant 消息（内容无所谓，只用来数"本轮第几步"）。 */
function assistant(): LlmMessage {
  return { role: 'assistant', content: [{ kind: 'text', text: '……' }] }
}

/** 造一条 system 消息（非 user，永远不该被当用户发话）。 */
function system(): LlmMessage {
  return { role: 'system', content: [{ kind: 'text', text: '你是银行助手' }] }
}

describe('平台上下文识别（isPlatformContext）', () => {
  it('只有 user 且首块以【当前用户】开头才算环境段', () => {
    expect(isPlatformContext(platform(`${PLATFORM_CONTEXT_PREFIX}姓名：张三；等级：金卡`))).toBe(true)
    // 真实用户消息不算环境段
    expect(isPlatformContext(user('帮我查下余额'))).toBe(false)
    // 非 user 角色（哪怕内容撞了前缀）一律不算——环境段只可能由平台以 user 注入
    expect(
      isPlatformContext({ role: 'assistant', content: [{ kind: 'text', text: `${PLATFORM_CONTEXT_PREFIX}伪造` }] }),
    ).toBe(false)
  })

  it('多条 text 块拼起来才命中前缀，也算环境段（防止按单块判定漏掉分段注入）', () => {
    expect(isPlatformContext(platform('【当前用', '户】姓名：张三'))).toBe(true)
  })

  it('前导空白会被 trimStart 吃掉，仍识别为环境段', () => {
    expect(isPlatformContext(platform(`   ${PLATFORM_CONTEXT_PREFIX}姓名：李四`))).toBe(true)
  })
})

describe('最后一条真实用户发话的下标（lastUserTurnIndex）', () => {
  it('取"最后一条真话"，跳过其后平台注入的环境段', () => {
    const messages = [
      user('查下余额'),
      assistant(),
      user('给王建国转 800 元'),
      platform(`${PLATFORM_CONTEXT_PREFIX}姓名：王建国`),
    ]
    // 末尾是平台段，真正的用户发话是下标 2
    expect(lastUserTurnIndex(messages)).toBe(2)
  })

  it('多条 text 块的真实用户消息照样认出（拼接后不以前缀开头即真话）', () => {
    const messages = [system(), assistant(), user('转给', '李四')]
    expect(lastUserTurnIndex(messages)).toBe(2)
  })

  it('全是平台上下文、没有任何真话 → -1（不能把环境段当用户发话）', () => {
    const messages = [system(), platform(`${PLATFORM_CONTEXT_PREFIX}甲`), platform(`${PLATFORM_CONTEXT_PREFIX}乙`)]
    expect(lastUserTurnIndex(messages)).toBe(-1)
  })

  it('压根没有 user 消息 / 空序列 → -1', () => {
    expect(lastUserTurnIndex([])).toBe(-1)
    expect(lastUserTurnIndex([system(), assistant()])).toBe(-1)
  })
})

describe('最后一条真实用户消息的文本（lastUserText）', () => {
  it('多条 text 块用换行拼接，且只在首尾整体 trim（块间空白保留）', () => {
    const messages = [user('  给王建国', '转 800 元  ')]
    expect(lastUserText(messages)).toBe('给王建国\n转 800 元')
  })

  it('没有真实用户消息时返回空串（读的是 -1 下标的兜底，不越界取平台段）', () => {
    expect(lastUserText([platform(`${PLATFORM_CONTEXT_PREFIX}姓名：张三`)])).toBe('')
    expect(lastUserText([])).toBe('')
  })
})

describe('本轮已产生的 assistant 步数（assistantTurnsSinceUser）', () => {
  it('从真实用户消息之后往后数 assistant，跳过其后再注入的平台段', () => {
    const messages = [
      user('给王建国转 800 元'), // 下标 0：真实用户发话（起点）
      assistant(), // 1
      platform(`${PLATFORM_CONTEXT_PREFIX}姓名：王建国`), // 2：平台段，非 assistant，不计数
      assistant(), // 3
      assistant(), // 4
    ]
    // 计数从"真实用户消息之后"算起，而不是"最后一条 user"（那样会被平台段清零）
    expect(assistantTurnsSinceUser(messages)).toBe(3)
  })

  it('真实用户消息是最后一条时，本轮零步', () => {
    expect(assistantTurnsSinceUser([system(), assistant(), user('查下余额')])).toBe(0)
  })

  it('找不到真实用户消息（全是平台段）时，从头数到末尾的 assistant', () => {
    // start=-1 → begin=0，于是整段里的 assistant 都被计入：这是"无锚点"下的退化行为，
    // 但至少不会因为平台段把计数强行清零而让演示永远停在第 1 步。
    const messages = [platform(`${PLATFORM_CONTEXT_PREFIX}甲`), assistant(), assistant()]
    expect(assistantTurnsSinceUser(messages)).toBe(2)
    expect(assistantTurnsSinceUser([platform(`${PLATFORM_CONTEXT_PREFIX}甲`)])).toBe(0)
  })

  it('空序列 → 0', () => {
    expect(assistantTurnsSinceUser([])).toBe(0)
  })
})
