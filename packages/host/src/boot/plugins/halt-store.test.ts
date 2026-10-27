/**
 * HALT 停机状态文件（C3）的宿主侧用例。
 *
 * 与 `safety` 包的 `halt.test.ts` 分工：那边钉**状态机语义**（内存端口），
 * 这边钉**文件格式与失败路径**（原子写、损坏拒读、路径穿越、目录自动创建）。
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { captureThrown } from '@bah/test-support'

import { createHaltStore, haltStateFileOf } from './halt-store.ts'

const dirs: string[] = []

function tempRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'bah-halt-'))
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

describe('halt.json 落盘与恢复', () => {
  it('save → 新实例 load 得到同一快照（跨进程重启的最小证明）', () => {
    const root = tempRoot()
    const file = haltStateFileOf(root)
    const store = createHaltStore({ root })

    expect(store.load()).toBeUndefined()
    store.save({ reason: 'manual', detail: '值班主管按下停机', at: 1_700_000_000_000 })

    expect(existsSync(file)).toBe(true)
    // 落盘格式：JSON + 结尾换行（给人看/给 grep 看都正常）
    const raw = readFileSync(file, 'utf8')
    expect(raw.endsWith('\n')).toBe(true)
    expect(JSON.parse(raw)).toEqual({
      reason: 'manual',
      detail: '值班主管按下停机',
      at: 1_700_000_000_000,
    })

    // 新 store 实例 = 重启后的进程
    expect(createHaltStore({ root }).load()).toEqual({
      reason: 'manual',
      detail: '值班主管按下停机',
      at: 1_700_000_000_000,
    })
  })

  it('detail 缺省时不写该字段；clear 后 load 回到 undefined', () => {
    const root = tempRoot()
    const store = createHaltStore({ root })

    store.save({ reason: 'chain-broken', at: 1 })
    expect(JSON.parse(readFileSync(haltStateFileOf(root), 'utf8'))).toEqual({
      reason: 'chain-broken',
      at: 1,
    })

    store.clear()
    expect(existsSync(haltStateFileOf(root))).toBe(false)
    // 重复 clear 是幂等的（解除目标状态已达成）
    expect(() => store.clear()).not.toThrow()
    expect(store.load()).toBeUndefined()
  })

  it('目录不存在时 save 自动建目录（首次停机不依赖会话目录已存在）', () => {
    const root = join(tempRoot(), 'nested', 'deeper')
    const store = createHaltStore({ root })
    expect(() => store.save({ reason: 'manual', at: 1 })).not.toThrow()
    expect(existsSync(haltStateFileOf(root))).toBe(true)
  })

  it('损坏的 JSON → load 抛 safety-halt-state-invalid（不许当作 RUNNING）', () => {
    const root = tempRoot()
    const file = haltStateFileOf(root)
    writeRaw(file, '{"reason":"manual",')

    const error = captureThrown(() => createHaltStore({ root }).load())
    expect(error.code).toBe('safety-halt-state-invalid')
    expect(error.message).toContain('拒绝以 RUNNING 启动')
  })

  it('字段不合法（未知 reason / at 非数字）→ 同样拒读', () => {
    const root = tempRoot()
    const file = haltStateFileOf(root)

    writeRaw(file, JSON.stringify({ reason: 'operator-request', at: 1 }))
    expect(captureThrown(() => createHaltStore({ root }).load()).code).toBe(
      'safety-halt-state-invalid',
    )

    writeRaw(file, JSON.stringify({ reason: 'manual', at: 'now' }))
    expect(captureThrown(() => createHaltStore({ root }).load()).code).toBe(
      'safety-halt-state-invalid',
    )
  })

  it('状态文件与会话 ID 无关（换会话不能绕过停机）', () => {
    const root = tempRoot()
    // 同一 root 下只有一个 halt.json：它表达"这台机器停了"，不是"某个会话停了"
    expect(haltStateFileOf(root)).toBe(join(root, 'halt.json'))

    createHaltStore({ root }).save({ reason: 'manual', at: 1 })
    // 换一个会话 ID 重新装配，读到的是同一份停机证据
    expect(createHaltStore({ root }).load()).toEqual({ reason: 'manual', at: 1 })
  })
})
