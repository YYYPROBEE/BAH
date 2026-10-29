/**
 * 迁移脚本的口径用例（租户与鉴权 01 · TA-12-2）。
 *
 * 这条用例要证明三件事：**只搬会话目录**（不碰 saga 库与无关键名目录）、
 * **不覆盖**（目标已存在就跳过）、**幂等**（跑两次第二次 0 项）。
 * 迁移脚本是最容易"看起来成功"的那种脚本：搬错位置不会报错，只会让审计少几条链。
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { applyMigration, planMigration, renderPlan } from './migrate-tenant-layout.ts'

/** 建一个临时部署根，用完删。 */
const roots: string[] = []
function tempRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'bah-tenant-migrate-'))
  roots.push(dir)
  return dir
}

/** 造一个"旧式平铺会话目录"，里面放一个标记文件。 */
function sessionDir(root: string, name: string, file: 'session.jsonl' | 'audit.jsonl' = 'session.jsonl'): void {
  mkdirSync(join(root, name), { recursive: true })
  writeFileSync(join(root, name, file), '{}\n', 'utf8')
}

afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('planMigration', () => {
  it('TA-12-2 只挑"直接含 session.jsonl 或 audit.jsonl"的目录', () => {
    const root = tempRoot()
    sessionDir(root, 's-a')
    sessionDir(root, 's-b', 'audit.jsonl')
    // 以下三个都不该被搬：普通文件、无关键名目录、空目录
    writeFileSync(join(root, 'saga.sqlite'), '', 'utf8')
    mkdirSync(join(root, 'notes'), { recursive: true })
    writeFileSync(join(root, 'notes', 'README.md'), '# 说明\n', 'utf8')
    mkdirSync(join(root, 'empty'), { recursive: true })

    const plan = planMigration(root, 'demo')
    expect(plan.entries.map((entry) => entry.name)).toEqual(['s-a', 's-b'])
    expect(plan.entries.every((entry) => entry.action === 'move')).toBe(true)
    expect(plan.entries[0]?.to).toBe(join(root, 'demo', 's-a'))
  })

  it('TA-12-3 目标已存在 → skip-exists（不覆盖，也不假装搬了）', () => {
    const root = tempRoot()
    sessionDir(root, 's-dup')
    mkdirSync(join(root, 'demo', 's-dup'), { recursive: true })
    writeFileSync(join(root, 'demo', 's-dup', 'session.jsonl'), '{"kept":true}\n', 'utf8')

    const plan = planMigration(root, 'demo')
    expect(plan.entries).toHaveLength(1)
    expect(plan.entries[0]?.action).toBe('skip-exists')
    expect(renderPlan(plan)).toContain('跳过（目标已存在，不覆盖）')

    const result = applyMigration(plan)
    expect(result).toEqual({ moved: 0, skipped: 1 })
    // 原目标的内容没被覆盖
    expect(existsSync(join(root, 's-dup'))).toBe(true)
  })

  it('TA-12-4 根不存在 → 空计划（不抛：首次部署没有 sessions/ 是正常的）', () => {
    expect(planMigration(join(tempRoot(), 'nope'), 'demo').entries).toEqual([])
  })

  it('TA-12-5 非法租户 ID 直接拒（迁移脚本也要过租户字符集）', () => {
    expect(() => planMigration(tempRoot(), '../etc')).toThrow(/非法租户 ID/)
  })
})

describe('applyMigration', () => {
  it('TA-12-6 幂等：跑两次，第二次 moved=0（目录已经不在根上）', () => {
    const root = tempRoot()
    sessionDir(root, 's-a')
    sessionDir(root, 's-b')

    const first = applyMigration(planMigration(root, 'demo'))
    expect(first).toEqual({ moved: 2, skipped: 0 })
    expect(existsSync(join(root, 'demo', 's-a', 'session.jsonl'))).toBe(true)
    expect(existsSync(join(root, 's-b'))).toBe(false)

    const second = applyMigration(planMigration(root, 'demo'))
    expect(second).toEqual({ moved: 0, skipped: 0 })
  })

  it('TA-12-7 不碰 saga 库与 anchors.json（它们在部署根上，不按租户分库）', () => {
    const root = tempRoot()
    writeFileSync(join(root, 'saga.sqlite'), 'sqlite', 'utf8')
    writeFileSync(join(root, 'anchors.json'), '{}\n', 'utf8')
    sessionDir(root, 's-a')

    applyMigration(planMigration(root, 'demo'))
    expect(existsSync(join(root, 'saga.sqlite'))).toBe(true)
    expect(existsSync(join(root, 'anchors.json'))).toBe(true)
    expect(existsSync(join(root, 'demo', 'saga.sqlite'))).toBe(false)
  })
})
