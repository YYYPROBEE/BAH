/**
 * 会话事件的**编译期**契约断言（运行期只做一次触发器断言）。
 *
 * 背景（PROGRESS R27）：core 的 `SessionEventMap` 仍带字符串索引签名（阶段 1 冻结面），
 * 所以「拼错事件名」在 core 层面拦不住。runtime 侧用两道闸补上：
 *
 * 1. **编译期**：`SessionSink.append<S extends SessionEventType>` 把 S 收窄成
 *    `SESSION_EVENT_TYPES` 的联合 —— 拼错即编译失败（下面的 `@ts-expect-error` 钉住这一点）；
 * 2. **门禁期**：`verify-session-events` 校验「字面量事件名必须在表内」，
 *    覆盖 `ctx.events.<mode>('x')` 这类没法在类型层收窄的派发点（core 的 `EventName` 仍是 string）。
 *
 * 下面的闭包**故意写错**：若有人把 `append` 放宽成 `string`，`@ts-expect-error` 会变成
 * 「unused」错误，`pnpm typecheck` 直接红——这正是我们要的守卫。
 */

import { describe, expect, it } from 'vitest'

import type { SessionApi } from './service.ts'

describe('会话事件的编译期契约', () => {
  it('拼错事件名 / 载荷形状不符 → 编译期即失败（断言见闭包）', () => {
    const assertions = (session: SessionApi): void => {
      // 拼错的事件名
      // @ts-expect-error 'ghost/event' 不在 SESSION_EVENT_TYPES 里
      session.append('ghost/event', {})

      // 载荷形状必须与键匹配（turn/start 的 turn 是 number）
      // @ts-expect-error turn 必须是 number
      session.append('turn/start', { turn: '第一轮' })

      // 键对了但载荷缺必填字段
      // @ts-expect-error 缺 turn
      session.append('turn/start', {})
    }

    // 闭包本身不执行（执行会真的调用内核）；这里只证明它被类型系统检查过
    expect(typeof assertions).toBe('function')
  })
})
