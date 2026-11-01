/**
 * 端口预分配的重试语义。
 *
 * 为什么单测这个：子进程是 fail-loud 的（端口被占 = 启动失败），网关靠
 * `reservePortWithRetry` 换号重试把"启动瞬间的端口冲突"吸收掉。重试路径此前
 * 没有用例——失败一次就放弃、或把非 Error 值原样抛出，都会把可恢复冲突变成启动失败。
 */

import { describe, expect, it } from 'vitest'

import { PORT_RETRY_LIMIT, reservePortWithRetry } from '../src/session/port.ts'

describe('reservePortWithRetry：端口冲突时的换号重试', () => {
  it('首次成功即返回，不做多余尝试', async () => {
    let attempts = 0
    const port = await reservePortWithRetry(async () => {
      attempts += 1
      return 41_000
    })
    expect(port).toBe(41_000)
    expect(attempts).toBe(1)
  })

  it('前两次冲突、第三次成功 ⇒ 返回第三个端口（确实换号重试）', async () => {
    const seen: number[] = []
    const ports = [41_001, 41_002, 41_003]
    const port = await reservePortWithRetry(async () => {
      const next = ports[seen.length] as number
      seen.push(next)
      if (seen.length < 3) throw new Error(`EADDRINUSE:${String(next)}`)
      return next
    })
    expect(port).toBe(41_003)
    expect(seen).toEqual([41_001, 41_002, 41_003])
  })

  it('连续失败到上限 ⇒ 抛出最后一次错误（不会无限重试）', async () => {
    let attempts = 0
    await expect(
      reservePortWithRetry(async () => {
        attempts += 1
        throw new Error(`EADDRINUSE-${String(attempts)}`)
      }),
    ).rejects.toThrow(`EADDRINUSE-${String(PORT_RETRY_LIMIT)}`)
    expect(attempts).toBe(PORT_RETRY_LIMIT)
  })

  it('非 Error 抛出 ⇒ 换算成 im-port-exhausted，不把裸值往上抛', async () => {
    await expect(
      reservePortWithRetry(async () => {
        throw 'busy'
      }, 1),
    ).rejects.toThrow('im-port-exhausted')
  })
})
