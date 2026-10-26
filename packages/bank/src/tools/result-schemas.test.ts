/**
 * 出参契约表的**完备性**检查（W03）。
 *
 * 为什么要有这个文件：`result-schemas.ts` 是出参形状的唯一真相源，
 * 但它是一张 `Partial<Record<...>>`——**少写一个工具，TypeScript 不会报错，运行时静默跳过校验**。
 * 这类"漏了就无声"的缺口只能靠清单测试兜住。
 *
 * 四条断言对应四种漏法：
 * 1. 漏写某个工具 → 第 1 条红；
 * 2. 写了空气（非 object 根）→ 第 2 条红；
 * 3. 表里混进不存在的工具名（改名后残留）→ 第 3 条红；
 * 4. 表里多出一个不是工具名的键 → 同第 3 条。
 */

import { describe, expect, it } from 'vitest'

import { BANK_RESULT_SCHEMAS } from './result-schemas.ts'
import { BANK_TOOL_NAMES } from './specs.ts'

describe('出参契约表完备性', () => {
  it('14 个工具一个不少（漏写 = 静默不校验）', () => {
    const missing = BANK_TOOL_NAMES.filter((name) => BANK_RESULT_SCHEMAS[name] === undefined)
    expect(missing, `这些工具没有出参契约：${missing.join(', ')}`).toEqual([])
  })

  it('每份契约都是 object 根（否则连"是不是对象"都验不了）', () => {
    for (const name of BANK_TOOL_NAMES) {
      const schema = BANK_RESULT_SCHEMAS[name]
      expect(schema?.type, `${name} 的 type 不是 object`).toBe('object')
    }
  })

  it('表里没有多余键（改名/删工具后的残留会在这里暴露）', () => {
    const known = new Set<string>(BANK_TOOL_NAMES)
    const extra = Object.keys(BANK_RESULT_SCHEMAS).filter((key) => !known.has(key))
    expect(extra, `表里有非工具名键：${extra.join(', ')}`).toEqual([])
  })

  it('每份契约都至少声明一个 required（空契约等于没校验，属自欺）', () => {
    for (const name of BANK_TOOL_NAMES) {
      const required = BANK_RESULT_SCHEMAS[name]?.required
      expect(Array.isArray(required) && required.length > 0, `${name} 没有 required`).toBe(true)
    }
  })
})
