import { describe, expect, it } from 'vitest'

import { flattenSagaProjection, flattenState } from '../../src/adapters/flattenState.ts'

describe('嵌套状态展平', () => {
  it('SagaProjection 展平为可写进金标的点分键', () => {
    const flat = flattenSagaProjection({
      sagaId: 'saga-1',
      state: 'committed',
      steps: {
        reserve: { state: 'done', attempts: 1 },
        commit: { state: 'done', attempts: 1 },
      },
    })

    expect(flat).toEqual({
      sagaId: 'saga-1',
      state: 'committed',
      'steps.reserve.state': 'done',
      'steps.reserve.attempts': 1,
      'steps.commit.state': 'done',
      'steps.commit.attempts': 1,
    })
  })

  it('数组作为叶子整体保留（TSD 用等价集合比较它）', () => {
    const flat = flattenState({ tags: ['a', 'b'], 'nested.list': [1, 2] })
    expect(flat).toEqual({ tags: ['a', 'b'], 'nested.list': [1, 2] })
  })

  it('undefined 键被跳过（有无键与值为 undefined 在 JSON 里不可区分）', () => {
    const flat = flattenState({ a: 1, b: undefined })
    expect(flat).toEqual({ a: 1 })
    expect('b' in flat).toBe(false)
  })

  it('空对象保留为叶子（表达「这里本来有内容但没了」）', () => {
    const flat = flattenState({ steps: {} })
    expect(flat).toEqual({ steps: {} })
  })

  it('日期等非普通对象作叶子保留（不当空容器展平）', () => {
    const date = new Date('2026-10-22T00:00:00.000Z')
    const flat = flattenState({ at: date, nested: { at: date } })

    expect(flat['at']).toBe(date)
    expect(flat['nested.at']).toBe(date)
  })

  it('顶层不是对象时返回空表', () => {
    expect(flattenState(null)).toEqual({})
    expect(flattenState('x')).toEqual({})
    expect(flattenState([1, 2])).toEqual({})
  })

  it('分隔符可配置', () => {
    expect(flattenState({ a: { b: 1 } }, { separator: '/' })).toEqual({ 'a/b': 1 })
  })
})
