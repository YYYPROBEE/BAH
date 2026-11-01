/**
 * 事实库的三个窄访问器（`factVersionOf` / `asRelation` / `asKind`）。
 *
 * 它们是**不可信入参进入事实域的唯一闸门**：`asRelation` / `asKind` 把外部字符串收窄成
 * 封闭联合，收窄失败必须返回 `undefined` 而不是把未知值放进去。`factVersionOf` 是
 * `fact-unchanged` 条件的 expected 侧——版本读错，窗口复验就会拿错基准放行。
 */

import { describe, expect, it } from 'vitest'

import { asKind, asRelation, createFactStore, factVersionOf } from './store.ts'

/** 确定性 id 分配器（与生产夹具同口径）。 */
function makeStore() {
  let next = 0
  return createFactStore({ nextId: () => `f-${String((next += 1))}` })
}

describe('事实域访问器', () => {
  it('asRelation：白名单内的字符串收窄，其余 undefined', () => {
    expect(asRelation('spouse')).toBe('spouse')
    expect(asRelation('friend')).toBeUndefined()
    expect(asRelation('')).toBeUndefined()
  })

  it('asKind：白名单内的字符串收窄，其余 undefined', () => {
    expect(asKind('birthday')).toBe('birthday')
    expect(asKind('meeting')).toBeUndefined()
    expect(asKind('')).toBeUndefined()
  })

  it('factVersionOf：未知事实 undefined，已记住的事实返回当前版本', () => {
    const store = makeStore()
    expect(factVersionOf(store, 'f-missing')).toBeUndefined()

    const fact = store.remember(
      { person: '妈妈', relation: 'parent', kind: 'birthday', date: '1965-03-02' },
      1_700_000_000_000,
      1,
    )
    expect(factVersionOf(store, fact.factId)).toBe(fact.version)
  })
})
