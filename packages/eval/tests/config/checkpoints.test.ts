import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  CheckpointConfigError,
  isCheckpointAvailable,
  isIrreversibleFrom,
  loadCheckpointsConfig,
  parseCheckpointsConfig,
} from '../../src/config/checkpoints.ts'
import { dropRunsDir, makeRunsDir } from '../helpers/fixtures.ts'

/** 一份最小合法配置（各用例按需覆盖单个字段）。 */
const BASE = {
  schemaVersion: 'test-v0',
  toolToCheckpoint: { verify_face: ['auth'], transfer_create: ['execute'] },
  checkpointStatus: {
    auth: { status: 'available', carrierTools: ['verify_face'] },
    execute: { status: 'available', carrierTools: ['transfer_create'] },
  },
  snapshotTools: ['transfer_create'],
}

describe('检查点配置加载', () => {
  it('仓库里那份真实配置能被加载并通过校验', async () => {
    const config = await loadCheckpointsConfig()

    expect(config.schemaVersion).toBe('checkpoints-v0.1')
    expect(config.toolToCheckpoint['verify_face']).toEqual(['auth'])
    expect(config.toolToCheckpoint['transfer_preview']).toEqual(['risk'])
    expect(config.snapshotTools).toContain('transfer_create')
  })

  it('真实配置里 sanctions 被标记为无载体（M1 定金标前必须看到这一条）', async () => {
    const config = await loadCheckpointsConfig()
    expect(isCheckpointAvailable(config, 'sanctions')).toBe(false)
    expect(config.checkpointStatus['sanctions']?.reason).toBeTruthy()
  })

  it('由配置派生「不可逆」判定，白名单只有一处来源', async () => {
    const config = parseCheckpointsConfig(BASE)
    const isIrreversible = isIrreversibleFrom(config)

    expect(isIrreversible('transfer_create')).toBe(true)
    expect(isIrreversible('verify_face')).toBe(false)
    expect(isIrreversible('')).toBe(false)
  })

  it('校验通过后保留 policyRef / note / reason 等可选字段', () => {
    const config = parseCheckpointsConfig({
      ...BASE,
      policyRef: 'ADR-001',
      note: '备注',
      checkpointStatus: {
        ...BASE.checkpointStatus,
        risk: { status: 'unavailable', carrierTools: [], reason: '无载体' },
      },
    })

    expect(config.policyRef).toBe('ADR-001')
    expect(config.note).toBe('备注')
    expect(config.checkpointStatus['risk']?.reason).toBe('无载体')
  })
})

describe('检查点配置校验（错就抛，且给理由码）', () => {
  const expectReject = (raw: unknown, pattern: RegExp): void => {
    let caught: unknown
    try {
      parseCheckpointsConfig(raw)
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(CheckpointConfigError)
    expect((caught as CheckpointConfigError).code).toBe('checkpoints-config-invalid')
    expect((caught as Error).message).toMatch(pattern)
  }

  it('根节点不是对象', () => {
    expectReject('nope', /根节点必须是对象/)
  })

  it('schemaVersion 缺失', () => {
    expectReject({ ...BASE, schemaVersion: '' }, /schemaVersion 必须是非空字符串/)
  })

  it('toolToCheckpoint 的值必须是非空数组', () => {
    expectReject({ ...BASE, toolToCheckpoint: { verify_face: [] } }, /必须是非空数组/)
  })

  it('toolToCheckpoint 本身不是对象', () => {
    expectReject({ ...BASE, toolToCheckpoint: [] }, /toolToCheckpoint 必须是对象/)
  })

  it('checkpointStatus 本身不是对象', () => {
    expectReject({ ...BASE, checkpointStatus: 'nope' }, /checkpointStatus 必须是对象/)
  })

  it('checkpointStatus 的条目必须是对象', () => {
    expectReject(
      { ...BASE, checkpointStatus: { auth: 'available', execute: BASE.checkpointStatus.execute } },
      /checkpointStatus.auth 必须是对象/,
    )
  })

  it('检查点拼错（sanction 少个 s）会被拦下', () => {
    expectReject(
      { ...BASE, toolToCheckpoint: { verify_face: ['sanction'] } },
      /含非法检查点 "sanction"/,
    )
  })

  it('状态取值只能是 available / unavailable', () => {
    expectReject(
      {
        ...BASE,
        checkpointStatus: { auth: { status: 'maybe', carrierTools: [] }, execute: BASE.checkpointStatus.execute },
      },
      /只能是 available \/ unavailable/,
    )
  })

  it('carrierTools 必须是字符串数组', () => {
    expectReject(
      {
        ...BASE,
        checkpointStatus: { auth: { status: 'available', carrierTools: [1] }, execute: BASE.checkpointStatus.execute },
      },
      /carrierTools 必须是字符串数组/,
    )
  })

  it('snapshotTools 必须是字符串数组', () => {
    expectReject({ ...BASE, snapshotTools: 'transfer_create' }, /snapshotTools 必须是字符串数组/)
  })

  it('被工具声明但缺状态的检查点（交叉校验）', () => {
    expectReject(
      {
        ...BASE,
        checkpointStatus: { execute: BASE.checkpointStatus.execute },
      },
      /检查点 auth 被工具声明，但 checkpointStatus 里没有它的状态/,
    )
  })

  it('标 unavailable 却仍被工具映射——矛盾配置必须拦下', () => {
    // 这正是 sanctions 那个坑的机器化防线：一旦有人给它接上工具却忘了改状态，
    // 判定器会永远报「缺失」，而人以为是模型没做。
    expectReject(
      {
        ...BASE,
        checkpointStatus: {
          ...BASE.checkpointStatus,
          sanctions: { status: 'unavailable', carrierTools: [], reason: '无载体' },
        },
        toolToCheckpoint: { ...BASE.toolToCheckpoint, check_sanctions: ['sanctions'] },
      },
      /标为 unavailable，却仍被工具映射到/,
    )
  })

  it('标 unavailable 必须写 reason', () => {
    expectReject(
      {
        ...BASE,
        checkpointStatus: {
          ...BASE.checkpointStatus,
          risk: { status: 'unavailable', carrierTools: [] },
        },
      },
      /标 unavailable 必须写 reason/,
    )
  })

  it('非法检查点作为 checkpointStatus 的键同样被拦下', () => {
    expectReject(
      {
        ...BASE,
        checkpointStatus: { ...BASE.checkpointStatus, sanction: { status: 'available', carrierTools: [] } },
      },
      /checkpointStatus.sanction 不是合法检查点/,
    )
  })

  it('JSON 解析失败给出可读理由', async () => {
    const dir = await makeRunsDir()
    try {
      const path = join(dir, 'broken.json')
      await writeFile(path, '{ not json', 'utf8')
      await expect(loadCheckpointsConfig(path)).rejects.toThrow(/JSON 解析失败/)
    } finally {
      await dropRunsDir(dir)
    }
  })

  it('文件不存在时如实抛（不吞成默认配置）', async () => {
    await expect(loadCheckpointsConfig('/definitely/not/here.json')).rejects.toThrow(/ENOENT|no such file/i)
  })
})
