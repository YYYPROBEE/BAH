/**
 * 拉取式缓存的时间边界（02 单 §2.13）。
 *
 * push 不可用时结果进缓存，用户发 `0` 取回。两条必须在用例里钉住：
 * 1. **过期即空**：TTL 之后不能再把几小时前的结果当"本轮结果"发出去；
 * 2. **边界不提前**：恰好等于 TTL 仍算有效（判据是"超过"，不是"达到"）。
 *
 * 时钟由注入的 `nowMs` 驱动，不依赖真实时间。
 */

import { describe, expect, it } from 'vitest'

import { createPullStore } from '../src/bridge/outbound.ts'
import { PULL_TTL_MS } from '../src/config.ts'

/** 可推进的假时钟。 */
function clock(start = 1_793_000_000_000): { nowMs: () => number; advance(ms: number): void } {
  let now = start
  return {
    nowMs: () => now,
    advance(ms: number): void {
      now += ms
    },
  }
}

describe('拉取式缓存 TTL', () => {
  it('TTL 内可取回；恰好等于 TTL 仍有效；超过一秒即过期并清掉该会话', () => {
    const time = clock()
    const pull = createPullStore({ nowMs: time.nowMs })
    pull.put('k-1', '余额 1000 元')

    time.advance(PULL_TTL_MS)
    expect(pull.latest('k-1')).toBe('余额 1000 元')

    time.advance(1)
    expect(pull.latest('k-1')).toBeUndefined()
    expect(pull.size()).toBe(0)
  })

  it('过期只影响该会话；另一会话的未过期结果照旧可取', () => {
    const time = clock()
    const pull = createPullStore({ nowMs: time.nowMs })
    pull.put('k-old', '昨天的结果')
    time.advance(PULL_TTL_MS + 1)
    pull.put('k-new', '本轮的结果')

    expect(pull.latest('k-old')).toBeUndefined()
    expect(pull.latest('k-new')).toBe('本轮的结果')
    expect(pull.size()).toBe(1)
  })
})
