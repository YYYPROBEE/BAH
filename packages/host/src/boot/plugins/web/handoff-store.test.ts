/**
 * 接管状态文件（HO-1）的宿主侧用例。
 *
 * 与 `handoff.test.ts` 分工：那边钉**状态机语义**（内存端口），这边钉
 * **文件格式与失败路径**（原子写、损坏拒读、路径穿越、会话目录自动创建）。
 */

import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { captureThrown } from '@bah/test-support'

import { createHandoffStore, handoffStateFileOf, type HandoffSnapshot } from './handoff-store.ts'

const dirs: string[] = []

function tempRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'bah-handoff-store-'))
  dirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** 直接写原始字节（造损坏文件用；目录不存在时先建）。 */
function writeRaw(file: string, body: string): void {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, body, 'utf8')
}

const SNAPSHOT: HandoffSnapshot = { at: 1_700_000_000_000, lastSeq: 42, reason: '客户要求人工' }

describe('T-01 未写过 → load() 返回 undefined', () => {
  it('不抛错（从未接管是正常路径）', () => {
    const root = tempRoot()
    const store = createHandoffStore({ root, sessionId: 's-1' })
    expect(store.load()).toBeUndefined()
    // 构造与 load 都不该创建目录（构造期不写盘）
    expect(existsSync(join(root, 's-1'))).toBe(false)
  })
})

describe('T-02 save → load 往返字段全等', () => {
  it('含可选字段（operator / warnedAt）', () => {
    const root = tempRoot()
    const store = createHandoffStore({ root, sessionId: 's-1' })
    const full: HandoffSnapshot = { ...SNAPSHOT, operator: '坐席小周', warnedAt: 1_700_000_180_000 }
    store.save(full)
    expect(createHandoffStore({ root, sessionId: 's-1' }).load()).toEqual(full)
  })

  it('不含可选字段时不写多余键（文件可读）', () => {
    const root = tempRoot()
    const store = createHandoffStore({ root, sessionId: 's-1' })
    store.save(SNAPSHOT)
    const parsed = JSON.parse(readFileSync(handoffStateFileOf(root, 's-1'), 'utf8')) as Record<string, unknown>
    expect(Object.keys(parsed).sort()).toEqual(['at', 'lastSeq', 'reason'])
    expect(createHandoffStore({ root, sessionId: 's-1' }).load()).toEqual(SNAPSHOT)
  })
})

describe('T-03 原子写：只留 handoff.json，无 .tmp 残留', () => {
  it('save 后目录里只有 handoff.json', () => {
    const root = tempRoot()
    const store = createHandoffStore({ root, sessionId: 's-1' })
    store.save(SNAPSHOT)
    expect(readdirSync(join(root, 's-1'))).toEqual(['handoff.json'])
    expect(readFileSync(handoffStateFileOf(root, 's-1'), 'utf8').endsWith('\n')).toBe(true)
  })
})

describe('T-04 损坏文件拒绝静默恢复', () => {
  it('{"active":"yes"} → handoff-state-invalid（不是 undefined）', () => {
    const root = tempRoot()
    const file = handoffStateFileOf(root, 's-1')
    writeRaw(file, '{"active":"yes"}')
    const error = captureThrown(() => createHandoffStore({ root, sessionId: 's-1' }).load())
    expect((error as { code?: string }).code).toBe('handoff-state-invalid')
  })

  it('不是合法 JSON → handoff-state-invalid', () => {
    const root = tempRoot()
    writeRaw(handoffStateFileOf(root, 's-1'), '{oops')
    const error = captureThrown(() => createHandoffStore({ root, sessionId: 's-1' }).load())
    expect((error as { code?: string }).code).toBe('handoff-state-invalid')
  })
})

describe('T-05 lastSeq 必须是非负整数', () => {
  it('-1 → handoff-state-invalid', () => {
    const root = tempRoot()
    writeRaw(handoffStateFileOf(root, 's-1'), JSON.stringify({ ...SNAPSHOT, lastSeq: -1 }))
    const error = captureThrown(() => createHandoffStore({ root, sessionId: 's-1' }).load())
    expect((error as { code?: string }).code).toBe('handoff-state-invalid')
  })

  it('1.5 → handoff-state-invalid', () => {
    const root = tempRoot()
    writeRaw(handoffStateFileOf(root, 's-1'), JSON.stringify({ ...SNAPSHOT, lastSeq: 1.5 }))
    const error = captureThrown(() => createHandoffStore({ root, sessionId: 's-1' }).load())
    expect((error as { code?: string }).code).toBe('handoff-state-invalid')
  })
})

describe('T-06 clear 幂等', () => {
  it('两次 clear 都不抛（ENOENT 静默）', () => {
    const root = tempRoot()
    const store = createHandoffStore({ root, sessionId: 's-1' })
    store.save(SNAPSHOT)
    store.clear()
    expect(store.load()).toBeUndefined()
    expect(() => store.clear()).not.toThrow()
  })
})

describe('路径安全与目录创建', () => {
  it('非法 sessionId → invalid-path-segment（不拼出 ../）', () => {
    const root = tempRoot()
    const error = captureThrown(() => handoffStateFileOf(root, '../etc'))
    expect((error as { code?: string }).code).toBe('invalid-path-segment')
  })

  it('save 才创建会话目录（根目录不存在也能建）', () => {
    const root = join(tempRoot(), 'nested-root')
    const store = createHandoffStore({ root, sessionId: 's-1' })
    store.save(SNAPSHOT)
    expect(existsSync(handoffStateFileOf(root, 's-1'))).toBe(true)
  })
})

describe('IO 失败路径（I6 / I7 的负面）', () => {
  it('handoff.json 是目录 → load 抛 handoff-state-unreadable（不当作未接管）', () => {
    const root = tempRoot()
    mkdirSync(handoffStateFileOf(root, 's-1'), { recursive: true })
    const error = captureThrown(() => createHandoffStore({ root, sessionId: 's-1' }).load())
    expect((error as { code?: string }).code).toBe('handoff-state-unreadable')
  })

  it('目标是目录 → save 抛 handoff-state-unwritable（且不留 .tmp）', () => {
    const root = tempRoot()
    const file = handoffStateFileOf(root, 's-1')
    mkdirSync(file, { recursive: true })
    const store = createHandoffStore({ root, sessionId: 's-1' })
    const error = captureThrown(() => store.save(SNAPSHOT))
    expect((error as { code?: string }).code).toBe('handoff-state-unwritable')
    expect(existsSync(`${file}.tmp`)).toBe(false)
  })

  it('clear 目标是目录 → handoff-state-unwritable（不假装交回成功）', () => {
    const root = tempRoot()
    const file = handoffStateFileOf(root, 's-1')
    mkdirSync(file, { recursive: true })
    const store = createHandoffStore({ root, sessionId: 's-1' })
    const error = captureThrown(() => store.clear())
    expect((error as { code?: string }).code).toBe('handoff-state-unwritable')
  })
})

describe('字段校验逐项 fail-loud', () => {
  const bad = (value: unknown): void => {
    const root = tempRoot()
    writeRaw(handoffStateFileOf(root, 's-1'), JSON.stringify(value))
    const error = captureThrown(() => createHandoffStore({ root, sessionId: 's-1' }).load())
    expect((error as { code?: string }).code).toBe('handoff-state-invalid')
  }

  it('顶层不是对象 / at 非有限数 / reason 非串 / operator 非串 / warnedAt 非有限数', () => {
    bad([])
    bad({ ...SNAPSHOT, at: 'x' })
    bad({ ...SNAPSHOT, reason: 1 })
    bad({ ...SNAPSHOT, operator: 1 })
    bad({ ...SNAPSHOT, warnedAt: 'x' })
  })
})
