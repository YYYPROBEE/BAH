/**
 * 适当性闸门的边界（唯一规则的 5 个方向）。
 *
 * 相等放行、超一级拒绝是两个最容易写反的边界：写反了要么全放行，要么把 R3 客户
 * 自己等级的产品也挡掉。这里逐条钉住。
 */

import { describe, expect, it } from 'vitest'

import { checkSuitability } from './suitability.ts'

describe('checkSuitability（适当性）', () => {
  it('R1 客户 × R1 产品：允许（相等放行）', () => {
    expect(checkSuitability({ customerRisk: 'R1', productRisk: 'R1' })).toEqual({ allow: true })
  })

  it('R2 客户 × R2 产品：允许（相等放行）', () => {
    expect(checkSuitability({ customerRisk: 'R2', productRisk: 'R2' })).toEqual({ allow: true })
  })

  it('R2 客户 × R3 产品：拒绝（超一级）', () => {
    const verdict = checkSuitability({ customerRisk: 'R2', productRisk: 'R3' })
    expect(verdict.allow).toBe(false)
    if (verdict.allow) return
    expect(verdict.code).toBe('suitability-mismatch')
    expect(verdict.reason).toContain('R2')
    expect(verdict.reason).toContain('R3')
  })

  it('R5 客户 × R5 产品：允许（最高等级相等）', () => {
    expect(checkSuitability({ customerRisk: 'R5', productRisk: 'R5' })).toEqual({ allow: true })
  })

  it('R1 客户 × R5 产品：拒绝（跨全谱）', () => {
    const verdict = checkSuitability({ customerRisk: 'R1', productRisk: 'R5' })
    expect(verdict.allow).toBe(false)
    if (verdict.allow) return
    expect(verdict.code).toBe('suitability-mismatch')
    expect(verdict.reason).toContain('R1')
    expect(verdict.reason).toContain('R5')
  })

  it('R3 客户 × R4 产品：拒绝（演示主路径的相邻等级也挡）', () => {
    expect(checkSuitability({ customerRisk: 'R3', productRisk: 'R4' }).allow).toBe(false)
  })
})
