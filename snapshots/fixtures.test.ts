/**
 * snapshot 面冒烟：验证「快照通道」本身可用。
 *
 * 这一面在阶段 7 之前没有可回放的会话（record/replay harness 属阶段 7），
 * 但 fixture 的**命名与代次选择**是纯文件逻辑，现在就能验证：
 * 配置能加载、`@bah/test-support` 能解析、临时目录里造 fixture 能选出最高代。
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { parseSnapshotName, selectSnapshot } from '@bah/test-support'

let dir = ''

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'bah-snapshot-face-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

/** 造一个 fixture 文件（内容留空：本用例只验选择逻辑）。 */
const touch = (file: string): void => {
  writeFileSync(join(dir, file), '{}\n')
}

describe('快照回放面', () => {
  it('能从快照面选出一个 fixture 的最高代', () => {
    touch('session.v1.jsonl')
    touch('session.v2.jsonl')
    touch('session.1.v7.jsonl')

    const fixture = selectSnapshot(dir)

    expect(fixture.file).toBe('session.v2.jsonl')
    expect(fixture.path).toBe(join(dir, 'session.v2.jsonl'))
    expect(parseSnapshotName('session.1.v7.jsonl')).toMatchObject({ seq: 1, version: 7 })
  })

  it('目录里没有 fixture 时 fail-loud，而不是静默跳过', () => {
    expect(() => selectSnapshot(dir)).toThrow(/没有 parent 快照/)
  })
})
