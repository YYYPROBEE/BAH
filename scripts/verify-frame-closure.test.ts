import { describe, expect, it } from 'vitest'

import { checkFrameClosure, frameKindsOf, type FrameClosureInput } from './verify-frame-closure.ts'

/** 最小可用的 frames.ts 样本（两条帧：一个齐全、一个用来做坏样本）。 */
const FRAMES = `
export interface AlphaFrame {
  readonly kind: 'alpha'
  readonly seq: number
}

export interface BetaFrame {
  readonly kind: 'beta'
  readonly seq: number
}

export type WebFrame =
  | AlphaFrame
  | BetaFrame

export interface NotAFrame {
  readonly kind: 'step'
}
`

function input(overrides: Partial<FrameClosureInput> = {}): FrameClosureInput {
  return {
    framesSource: FRAMES,
    projectSource: "kind: 'alpha'\nkind: 'beta'",
    desktopSources: { 'apps/web/src/views/a.js': "'alpha' 'beta'" },
    mobileSources: { 'apps/web/src/mobile/a.js': "'alpha' 'beta'" },
    docSource: '`alpha` `beta`',
    ...overrides,
  }
}

describe('verify-frame-closure（反例自测：坏样本必须红）', () => {
  it('解析只认 WebFrame 联合成员（DagNode 的 step 不算帧）', () => {
    expect(frameKindsOf(FRAMES)).toEqual(['alpha', 'beta'])
  })

  it('四条判据齐全的样本 ⇒ 绿', () => {
    expect(checkFrameClosure(input()).ok).toBe(true)
  })

  it('I-F1：声明了但没有投影分支 ⇒ 红', () => {
    const result = checkFrameClosure(input({ projectSource: "kind: 'alpha'" }))
    expect(result.ok).toBe(false)
    expect(result.findings.join('\n')).toContain("I-F1 frames.ts 声明了 'beta'")
  })

  it('I-F2：桌面端没有消费者 ⇒ 红', () => {
    const result = checkFrameClosure(input({ desktopSources: { 'apps/web/src/views/a.js': "'alpha'" } }))
    expect(result.ok).toBe(false)
    expect(result.findings.join('\n')).toContain("I-F2 'beta'")
  })

  it('I-F3：移动端没有消费者且未登记理由 ⇒ 红', () => {
    const result = checkFrameClosure(input({ mobileSources: {} }))
    expect(result.ok).toBe(false)
    expect(result.findings.join('\n')).toContain("I-F3 'alpha'")
  })

  it('I-F4：文档缺条目 ⇒ 红', () => {
    const result = checkFrameClosure(input({ docSource: '`alpha`' }))
    expect(result.ok).toBe(false)
    expect(result.findings.join('\n')).toContain("I-F4")
  })

  it('解析不到任何帧 ⇒ 红（"没扫到"不能当"通过"）', () => {
    const result = checkFrameClosure(input({ framesSource: 'export const x = 1' }))
    expect(result.ok).toBe(false)
  })
})
