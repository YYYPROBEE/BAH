/**
 * 插件清单擦除：`validateComposition` 这类可选钩子必须在擦除后仍然保留。
 *
 * 为什么值得单独钉：跨插件组合校验（plan 预算 vs 票据 TTL）读的是清单里那份函数，
 * 擦除时若漏搬，行级校验照常通过、组合约束却**静默消失**——没有任何运行期症状。
 */

import { describe, expect, it } from 'vitest'

import { toAnyHostPlugin, type ValidatedRow } from './index.ts'

const composition = (rows: readonly ValidatedRow[]): void => {
  void rows
}

const plugin = { name: 'fx:erase', apply: () => undefined }

describe('toAnyHostPlugin', () => {
  it('保留 validateComposition（不是只搬 id/plugin/validate）', () => {
    const any = toAnyHostPlugin({
      id: 'fx:erase',
      plugin,
      validate: () => ({ ok: true }),
      validateComposition: composition,
    })

    expect(any.id).toBe('fx:erase')
    expect(any.validateComposition).toBe(composition)
  })

  it('对已擦除形态幂等：二次擦除不丢钩子', () => {
    const once = toAnyHostPlugin({
      id: 'fx:erase',
      plugin,
      validate: () => ({ ok: true }),
      validateComposition: composition,
    })

    expect(toAnyHostPlugin(once).validateComposition).toBe(composition)
  })
})
