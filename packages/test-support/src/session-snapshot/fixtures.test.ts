/**
 * 快照 fixture 选择器自测（临时目录里造文件，断言组 / 代次 / 冲突处理）。
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { captureThrown } from '../assertions/index.ts'
import { parseSnapshotName, selectSnapshot } from './fixtures.ts'

let dir = ''

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'bah-snap-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

/** 造一个空 fixture 文件。 */
const touch = (file: string): void => {
  writeFileSync(join(dir, file), '{}\n')
}

describe('parseSnapshotName', () => {
  it('按 session[.序号][.vN].jsonl 解析（缺省代次为 0）', () => {
    expect(parseSnapshotName('session.jsonl')).toMatchObject({ seq: undefined, version: 0 })
    expect(parseSnapshotName('session.v2.jsonl')).toMatchObject({ seq: undefined, version: 2 })
    expect(parseSnapshotName('session.1.jsonl')).toMatchObject({ seq: 1, version: 0 })
    expect(parseSnapshotName('session.12.v3.jsonl')).toMatchObject({ seq: 12, version: 3 })
  })

  it('非 fixture 文件一律忽略', () => {
    for (const file of [
      'README.md',
      'session.txt',
      'session.v1.json',
      'other.jsonl',
      'session.x.jsonl',
      'session.1.v.jsonl',
    ]) {
      expect(parseSnapshotName(file)).toBeUndefined()
    }
  })
})

describe('selectSnapshot', () => {
  it('同组取最高代', () => {
    touch('session.jsonl')
    touch('session.v2.jsonl')
    touch('session.v1.jsonl')

    const fixture = selectSnapshot(dir)

    expect(fixture.file).toBe('session.v2.jsonl')
    expect(fixture.version).toBe(2)
    expect(fixture.path).toBe(join(dir, 'session.v2.jsonl'))
  })

  it('parent 与 child 是两组，各自取最高代', () => {
    touch('session.v1.jsonl')
    touch('session.v5.jsonl')
    touch('session.1.v2.jsonl')
    touch('session.1.v4.jsonl')

    expect(selectSnapshot(dir).version).toBe(5)
    expect(selectSnapshot(dir, { seq: 1 }).file).toBe('session.1.v4.jsonl')
  })

  it('该组为空 → snapshot-missing', () => {
    touch('session.1.jsonl')

    const error = captureThrown(() => selectSnapshot(dir))

    expect(error.code).toBe('snapshot-missing')
    expect(error.message).toContain('parent')
  })

  it('同组最高代重复 → snapshot-conflict（fixture 冲突必须人工处理）', () => {
    // 同一目录不会出现同名文件，所以冲突来自「代次写法并列」：v2 与 v02 都解析成第 2 代
    touch('session.v2.jsonl')
    touch('session.v02.jsonl')

    const error = captureThrown(() => selectSnapshot(dir))

    expect(error.code).toBe('snapshot-conflict')
    expect(error.message).toContain('session.v02.jsonl')
  })
})
