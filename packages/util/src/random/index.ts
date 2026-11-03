/**
 * seeded 伪随机（mulberry32， / ）。
 *
 * 为什么放在 `@bah/util`：仿真银行的造数（07）与快照夹具（12）必须共享**同一个**随机源——
 * `scenario.json` 里录下的 `randomSeed` 要能重放出 bank-forge 的同一套账户与交易，
 * 否则"回放确定性"只是各自实现恰好相似。
 *
 * 纪律：凡是要上快照或要能复现的造数，一律从这里取随机；业务代码禁用 `Math.random()`。
 */

/**
 * 建一个确定性伪随机生成器（mulberry32）。
 *
 * 同一种子逐位一致、跨平台稳定；输出落在 `[0, 1)`。
 *
 * @param seed 32 位种子（会话号 / 场景号等固定值）
 * @returns 每次调用返回一个 `[0, 1)` 的数
 */
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let value = state
    value = Math.imul(value ^ (value >>> 15), value | 1)
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61)
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296
  }
}
