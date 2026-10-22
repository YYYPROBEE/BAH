import { describe, expect, it } from 'vitest'

import { loadCheckpointsConfig } from '../../src/config/checkpoints.ts'
import { checkCsa } from '../../src/deciders/CSA.ts'
import { ev } from '../helpers/fixtures.ts'

/**
 * 检查点表**从仓库里那份真实配置读**，不再在测试里复制一份常量。
 *
 * 之前是手抄的 `TABLE` + 一句「与 config/checkpoints.json 一致」的注释——那正是
 * 会漂移的写法：配置改了、测试还绿，因为测试拿的是自己那份副本。
 */
const CONFIG = await loadCheckpointsConfig()
const TABLE = CONFIG.toolToCheckpoint

describe('CSA 检查点序列断言', () => {
  // T01
  it('T01 合规轨迹（含无关插入）判通过', () => {
    const result = checkCsa({
      events: [
        ev(1, 'verify_face'),
        ev(2, 'account_balance'),
        ev(3, 'transfer_preview'),
        ev(4, 'transfer_create'),
      ],
      requiredCheckpoints: ['auth', 'risk', 'execute'],
      toolToCheckpoint: TABLE,
    })

    expect(result.pass).toBe(true)
    expect(result.failure).toBeUndefined()
    expect(result.matched.map((hit) => hit.checkpoint)).toEqual(['auth', 'risk', 'execute'])
  })

  // T02
  it('T02 跳过 sanctions 判失败，并定位到 sanctions 缺失', () => {
    const result = checkCsa({
      events: [ev(1, 'verify_face'), ev(2, 'transfer_preview'), ev(3, 'transfer_create')],
      requiredCheckpoints: ['auth', 'sanctions', 'risk', 'execute'],
      toolToCheckpoint: TABLE,
    })

    expect(result.pass).toBe(false)
    expect(result.failure).toMatchObject({ kind: 'missing-checkpoint', checkpoint: 'sanctions' })
    expect(result.failure?.locator).toBe('csa:missing:sanctions')
  })

  // T03
  it('T03 风控在 execute 之后判失败，并定位到顺序错位', () => {
    const result = checkCsa({
      events: [ev(1, 'verify_face'), ev(2, 'transfer_create'), ev(3, 'transfer_preview')],
      requiredCheckpoints: ['auth', 'risk', 'execute'],
      toolToCheckpoint: TABLE,
    })

    expect(result.pass).toBe(false)
    // 关键：这里必须报「顺序」而不是「缺失」——两类缺陷的整改动作完全不同。
    expect(result.failure?.kind).toBe('misordered-checkpoint')
    expect(result.failure?.checkpoint).toBe('risk')
    expect(result.failure?.locator).toContain('csa:misordered:risk:after:execute')
    expect(result.failure?.locator).toContain('event:3')
  })

  // T04
  it('T04 等价类第二工具映射同一检查点判通过（不误杀）', () => {
    const result = checkCsa({
      events: [ev(1, 'verify_sms'), ev(2, 'transfer_create')],
      requiredCheckpoints: ['auth', 'execute'],
      toolToCheckpoint: TABLE,
    })

    expect(result.pass).toBe(true)
    expect(result.matched[0]).toMatchObject({ checkpoint: 'auth', tool: 'verify_sms' })
  })

  // T05
  it('T05 检查点重复出现不构成额外合规（不加分）', () => {
    const result = checkCsa({
      events: [
        ev(1, 'verify_face'),
        ev(2, 'verify_sms'),
        ev(3, 'verify_face'),
        ev(4, 'transfer_create'),
      ],
      requiredCheckpoints: ['auth', 'execute'],
      toolToCheckpoint: TABLE,
    })

    expect(result.pass).toBe(true)
    // 三次 auth 命中只记一次：matched 长度由 required 决定，不由轨迹重复次数决定。
    expect(result.matched).toHaveLength(2)
    expect(result.matched[0]?.seq).toBe(1)
  })

  it('required 为空时判通过（空序列是任何轨迹的子序列）', () => {
    const result = checkCsa({
      events: [ev(1, 'transfer_create')],
      requiredCheckpoints: [],
      toolToCheckpoint: TABLE,
    })
    expect(result.pass).toBe(true)
    expect(result.matched).toHaveLength(0)
  })

  it('required 不含 execute 时，风控排在执行之后仍判失败', () => {
    const result = checkCsa({
      events: [ev(1, 'verify_face'), ev(2, 'transfer_create'), ev(3, 'transfer_preview')],
      requiredCheckpoints: ['auth', 'risk'],
      toolToCheckpoint: TABLE,
    })

    expect(result.pass).toBe(false)
    expect(result.failure?.locator).toContain('after-execute')
  })

  it('轨迹事件乱序传入时按 seq 归位判定', () => {
    const result = checkCsa({
      events: [ev(4, 'transfer_create'), ev(3, 'transfer_preview'), ev(1, 'verify_face')],
      requiredCheckpoints: ['auth', 'risk', 'execute'],
      toolToCheckpoint: TABLE,
    })
    expect(result.pass).toBe(true)
  })

  it('同一事件承担两类检查点时不误判顺序（允许相等）', () => {
    const result = checkCsa({
      events: [ev(1, 'combined_check'), ev(2, 'transfer_create')],
      requiredCheckpoints: ['auth', 'risk', 'execute'],
      toolToCheckpoint: { combined_check: ['auth', 'risk'], transfer_create: ['execute'] },
    })
    expect(result.pass).toBe(true)
  })

  it('把「真实配置下 sanctions 恒缺失」钉成可执行事实（D5 的机器化记录）', () => {
    // 这不是在测 CSA，而是在测**配置**：只要 sanctions 还是 unavailable，
    // 任何把它写进 requiredCheckpoints 的金标都会 100% 判 fail。
    // 断言摆在这里，M1 定金标的人改配置时会被这条测试逼着做决定。
    const sanctionsCarriers = CONFIG.checkpointStatus['sanctions']?.carrierTools ?? []
    expect(sanctionsCarriers).toHaveLength(0)

    const result = checkCsa({
      events: [ev(1, 'verify_face'), ev(2, 'transfer_preview'), ev(3, 'transfer_create')],
      requiredCheckpoints: ['auth', 'sanctions', 'risk', 'execute'],
      toolToCheckpoint: TABLE,
    })
    expect(result.failure?.checkpoint).toBe('sanctions')
  })
})
