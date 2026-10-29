import { describe, expect, it } from 'vitest'

import { BahError } from '@bah/util'

import { MAX_CANDIDATES, MANUAL_CHOICE, buildChoices, validateLabel } from './candidates.ts'

function codeOf(fn: () => unknown): string {
  try {
    fn()
  } catch (error) {
    return (error as BahError).code
  }
  throw new Error('期望抛错但没有')
}

const candidates = [
  { label: '张伟（同事）', value: 'payee:zhang-col' },
  { label: '张伟（房东）', value: 'payee:zhang-land' },
  { label: '王建国', value: 'payee:wang' },
  { label: '李四', value: 'payee:li' },
]

describe('候选构造（TC-INT-25～28）', () => {
  it('TC-INT-25 同 value 去重，业务候选 1 + manual', () => {
    const choices = buildChoices([
      { label: '王建国', value: 'p1' },
      { label: '王建国（同事）', value: 'p1' },
    ])
    expect(choices).toHaveLength(2)
    expect(choices[0]?.label).toBe('王建国')
    expect(choices[1]).toEqual(MANUAL_CHOICE)
  })

  it('TC-INT-26 上限 3 + manual，且与输入序无关', () => {
    const forward = buildChoices(candidates)
    const backward = buildChoices([...candidates].reverse())
    expect(forward).toHaveLength(4)
    expect(forward).toEqual(backward)
    expect(forward.at(-1)).toEqual(MANUAL_CHOICE)
    expect(forward.slice(0, MAX_CANDIDATES)).toHaveLength(3)
  })

  it('TC-INT-26 排序按 value 码点升序', () => {
    const choices = buildChoices(candidates)
    expect(choices.map((choice) => choice.value)).toEqual([
      'payee:li',
      'payee:wang',
      'payee:zhang-col',
      '__manual__',
    ])
  })

  it('TC-INT-27 空候选 fail-loud（不静默开放式）', () => {
    expect(codeOf(() => buildChoices([]))).toBe('prompt-no-candidates')
  })

  it('TC-INT-28 label 过长 fail-loud，不静默截断', () => {
    expect(codeOf(() => buildChoices([{ label: '一二三四五六七八九十一二三四五六七八九十一', value: 'v' }]))).toBe(
      'prompt-choice-invalid',
    )
  })

  it('TC-INT-28 label 含控制字符或尖括号 fail-loud', () => {
    expect(codeOf(() => buildChoices([{ label: '张\n伟', value: 'v1' }]))).toBe('prompt-choice-invalid')
    expect(codeOf(() => buildChoices([{ label: '<img onerror=1>', value: 'v2' }]))).toBe(
      'prompt-choice-invalid',
    )
  })

  it('空 label fail-loud', () => {
    expect(codeOf(() => buildChoices([{ label: '', value: 'v' }]))).toBe('prompt-choice-invalid')
  })

  it('恰好 20 字通过（边界含于上限）', () => {
    const label = '一二三四五六七八九十一二三四五六七八九十'
    expect(() => validateLabel(label)).not.toThrow()
    expect(buildChoices([{ label, value: 'v' }])[0]?.label).toBe(label)
  })
})
