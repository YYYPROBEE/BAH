import { describe, expect, it } from 'vitest'

import { buildVerdict, isUndecidable } from '../src/verdict.ts'
import { allPass } from './helpers/fixtures.ts'

describe('Verdict 五分量合取', () => {
  it('五分量全通过时 strictPass 为 true 且无首失败', () => {
    const verdict = buildVerdict({ episodeId: 'ep-1', components: allPass() })
    expect(verdict.strictPass).toBe(true)
    expect(verdict.firstFailure).toBeUndefined()
  })

  // T15
  it('T15 ACR fail 但其余全 pass：strictPass=false', () => {
    const verdict = buildVerdict({
      episodeId: 'ep-1',
      components: { ...allPass(), ACR: false },
      locators: { ACR: 'psa:transfer_create.amount=60000:max[max=50000]' },
    })

    expect(verdict.strictPass).toBe(false)
    expect(verdict.components.DSR).toBe(true)
    expect(verdict.firstFailure).toEqual({
      component: 'ACR',
      locator: 'psa:transfer_create.amount=60000:max[max=50000]',
    })
  })

  it('未给定位时用 <component>:unspecified 兜底（不留空串）', () => {
    const verdict = buildVerdict({ episodeId: 'ep-1', components: { ...allPass(), TSC: false } })
    expect(verdict.firstFailure).toEqual({ component: 'TSC', locator: 'TSC:unspecified' })
  })

  it('首失败按合规优先顺序挑，而不是按对象键顺序', () => {
    const verdict = buildVerdict({
      episodeId: 'ep-1',
      components: { DSR: false, PCR: true, ACR: false, TSC: false, SPR: false },
    })
    // ACR 在 COMPONENT_ORDER 最前：报告第一眼该看到「越权」，而不是「结果不对」。
    expect(verdict.firstFailure?.component).toBe('ACR')
  })

  it('undecidable 一律按不通过处理（红线 3：禁止默认通过）', () => {
    const verdict = buildVerdict({
      episodeId: 'ep-1',
      components: { ...allPass(), TSC: 'undecidable' },
    })

    expect(verdict.strictPass).toBe(false)
    expect(verdict.firstFailure?.component).toBe('TSC')
    expect(isUndecidable(verdict)).toBe(true)
  })

  it('undecidableReason 只在传入时出现', () => {
    const plain = buildVerdict({ episodeId: 'ep-1', components: allPass() })
    expect(plain.undecidableReason).toBeUndefined()

    const flagged = buildVerdict({
      episodeId: 'ep-1',
      components: allPass(),
      undecidableReason: '证据链不完整',
    })
    expect(flagged.undecidableReason).toBe('证据链不完整')
  })

  it('isUndecidable 对全通过 / 全失败均为 false', () => {
    expect(isUndecidable(buildVerdict({ episodeId: 'ep-1', components: allPass() }))).toBe(false)
    expect(
      isUndecidable(
        buildVerdict({
          episodeId: 'ep-1',
          components: { DSR: false, PCR: false, ACR: false, TSC: false, SPR: false },
        }),
      ),
    ).toBe(false)
  })
})
