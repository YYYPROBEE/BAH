/**
 * 口令哈希（租户与鉴权 02 · TA-21）。
 *
 * 判据：同口令两次哈希不同（盐随机）但都能验；改一个字符 false；截断/坏串 false 且不抛；
 * dummy 校验恒 false（"用户不存在"与"口令错"靠它抹平耗时差）。
 */

import { describe, expect, it } from 'vitest'

import { DUMMY_HASH, hashPassword, parseEncodedHash, verifyPassword, verifyAgainstDummy } from './password.ts'

const PLAIN = 'demo1234'

describe('hashPassword / verifyPassword', () => {
  it('TA-21-1 往返：同口令不同盐 → 两个编码串都能验过', async () => {
    const first = await hashPassword(PLAIN)
    const second = await hashPassword(PLAIN)
    expect(first).not.toBe(second)
    expect(first.startsWith('scrypt$')).toBe(true)
    expect(await verifyPassword(PLAIN, first)).toBe(true)
    expect(await verifyPassword(PLAIN, second)).toBe(true)
  })

  it('TA-21-2 固定盐 → 确定性（测试可注入）', async () => {
    const salt = Buffer.alloc(16, 7)
    const first = await hashPassword(PLAIN, {}, salt)
    const second = await hashPassword(PLAIN, {}, salt)
    expect(first).toBe(second)
  })

  it('TA-21-3 改一个字符 / 换口令 → false', async () => {
    const encoded = await hashPassword(PLAIN)
    expect(await verifyPassword('demo1235', encoded)).toBe(false)
    expect(await verifyPassword('', encoded)).toBe(false)
  })

  it('TA-21-4 坏编码串 → false 且不抛（坏目录不该把登录打成 500）', async () => {
    for (const bad of ['', 'plaintext', 'scrypt$16384$8$1$only4parts', 'scrypt$x$8$1$aa$bb', DUMMY_HASH.slice(0, 30)]) {
      expect(await verifyPassword(PLAIN, bad), bad).toBe(false)
    }
    expect(parseEncodedHash('scrypt$16384$8$1$aa$bb')).toBeDefined()
    expect(parseEncodedHash('md5$1$2$3$aa$bb')).toBeUndefined()
  })

  it('TA-21-5 dummy 恒 false（用户不存在时的耗时同形路径）', async () => {
    expect(await verifyAgainstDummy(PLAIN)).toBe(false)
    expect(await verifyAgainstDummy('whatever')).toBe(false)
    expect(await verifyPassword(PLAIN, DUMMY_HASH)).toBe(false)
  })

  it('TA-21-6 真实校验与 dummy 校验同量级（耗时同形的判据；5 次采样）', async () => {
    const encoded = await hashPassword(PLAIN)
    const measure = async (run: () => Promise<unknown>, times: number): Promise<number[]> => {
      const samples: number[] = []
      for (let index = 0; index < times; index += 1) {
        const start = process.hrtime.bigint()
        await run()
        samples.push(Number(process.hrtime.bigint() - start) / 1e6)
      }
      return samples
    }
    const median = (values: number[]): number =>
      [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)] ?? 0

    const real = await measure(() => verifyPassword(PLAIN, encoded), 5)
    const dummy = await measure(() => verifyAgainstDummy(PLAIN), 5)
    const p50 = median(real)
    const p95 = Math.max(...real)
    console.log(`[TA-21-6] scrypt 单次验证耗时 p50=${p50.toFixed(1)}ms p95=${p95.toFixed(1)}ms（${String(real.length)} 次采样）`)
    // "> 1ms" 防的是"根本没算"（恒真断言 `> 0` 在计时器坏掉时也会绿）；
    // 同量级判据（5 倍以内）防的是"用户不存在时跳过了 scrypt"——那会变成用户枚举器。
    expect(p50).toBeGreaterThan(1)
    expect(p95).toBeLessThan(2000)
    const ratio = Math.max(median(real), median(dummy)) / Math.min(median(real), median(dummy))
    expect(ratio).toBeLessThan(5)
  })
})
