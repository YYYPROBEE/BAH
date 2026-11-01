/**
 * 审计链 JSONL 读写面的缺口用例（`chain/chain-file.ts`）。
 *
 * 缺口来源：逐文件 100% 名单只钉了 `chain/audit-report.ts`，本文件的**读侧判决**在
 * 2026-10-31 缺口扫描里实测零覆盖——而 `bah audit` 与运营侧 `audit-decisions` 都直接
 * 吃这两个入口（`read` / `readAll` / `pathOf`）。四条纪律各钉一条：
 *
 * 1. 尾行半写**只容忍最后一行**：丢弃 + 告警一次，完整行照常读出；
 * 2. 中间行不是合法链记录 ⇒ **fail-loud** 并指出行号，不得退化成"丢弃 + 告警"
 *    （把日志读歪比停下来更贵）；空行不是损坏，不能被同一条判决误杀；
 * 3. `sagaId` 是路径片段：越界写法在读侧与写侧一律拒绝；
 * 4. 缺省 `fsync = true` 的落盘口径（Windows 上以 `r+` 打开，只读 fd 会 EPERM）。
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { captureThrown } from '@bah/test-support'
import { afterEach, describe, expect, it } from 'vitest'

import { ChainFile, createSagaAudit } from './index.ts'

import type { ChainRecord } from './index.ts'

const cleanup: string[] = []

afterEach(() => {
  for (const dir of cleanup.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function root(): string {
  const dir = mkdtempSync(join(tmpdir(), 'bah-chain-file-'))
  cleanup.push(dir)
  return dir
}

/** 与 `chain.test.ts` 同口径的建链夹具（读侧用例不需要真落盘，逐条 fsync 关掉）。 */
function audit(dir: string): ReturnType<typeof createSagaAudit> {
  return createSagaAudit({
    now: () => 1_000,
    rootDir: join(dir, 'audit'),
    fsync: false,
    warn: () => undefined,
    signedTypes: [],
  })
}

function fileOf(dir: string, warn?: (message: string) => void): ChainFile {
  return new ChainFile({ rootDir: join(dir, 'audit'), fsync: false, warn: warn ?? (() => undefined) })
}

/** 落 n 条完整记录，返回链文件路径。 */
function seed(dir: string, sagaId: string, count: number): string {
  const chain = audit(dir)
  for (let index = 1; index <= count; index += 1) {
    chain.append(sagaId, 'saga/created', { sagaId, marker: index })
  }
  return join(dir, 'audit', sagaId, 'audit.jsonl')
}

function linesOf(path: string): string[] {
  return readFileSync(path, 'utf8').split('\n').filter((line) => line.length > 0)
}

describe('链文件 · 尾行截断容忍', () => {
  it('半写的最后一行丢弃并告警一次，前面的完整行照常读出', () => {
    const dir = root()
    const path = seed(dir, 's1', 3)
    // 模拟写入进程掉电：最后一行只落了一半 JSON
    writeFileSync(path, `${readFileSync(path, 'utf8')}{"s":"s1","q":4,"t":"saga/`, 'utf8')

    const warnings: string[] = []
    const rows = fileOf(dir, (message) => warnings.push(message)).read('s1')
    expect(rows.map((row) => row.q)).toEqual([1, 2, 3])
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('丢弃截断的链尾行')
    expect(warnings[0]).toContain(path)
  })

  it('容忍只针对最后一行：损坏的第二行必须 fail-loud，而不是再丢弃一次', () => {
    const dir = root()
    const path = seed(dir, 's1', 3)
    const lines = linesOf(path)
    lines[1] = '{"hello":"world"}'
    writeFileSync(path, `${lines.join('\n')}\n`, 'utf8')

    const warnings: string[] = []
    const error = captureThrown(() => fileOf(dir, (message) => warnings.push(message)).read('s1'))
    expect(error.code).toBe('chain-line-invalid')
    expect(error.detail).toMatchObject({ line: 2 })
    // 反向断言：中间行损坏不走"告警 + 跳过"这条宽容路径
    expect(warnings).toHaveLength(0)
  })

  it('空行按跳过处理，不能被"中间行损坏"判决误杀', () => {
    const dir = root()
    const path = seed(dir, 's1', 3)
    const lines = linesOf(path)
    lines.splice(1, 0, '')
    writeFileSync(path, `${lines.join('\n')}\n`, 'utf8')

    const warnings: string[] = []
    expect(fileOf(dir, (message) => warnings.push(message)).read('s1').map((row) => row.q)).toEqual([1, 2, 3])
    expect(warnings).toHaveLength(0)
  })
})

describe('链文件 · sagaId 的路径安全', () => {
  it('越界写法在读侧与写侧一律拒绝，合法写法解析后仍在链根之内', () => {
    const dir = root()
    seed(dir, 's1', 1)
    const file = fileOf(dir)
    const row = file.read('s1')[0] as ChainRecord

    for (const bad of ['..', '../escape', '..\\..\\escape', 'a/b', 'a\\b', 'a..b', '', '.hidden', '-lead', 'a b']) {
      expect(captureThrown(() => file.pathOf(bad)).code).toBe('saga-id-invalid')
      expect(captureThrown(() => file.read(bad)).code).toBe('saga-id-invalid')
      expect(captureThrown(() => file.append(bad, row)).code).toBe('saga-id-invalid')
    }

    const rootDir = join(dir, 'audit')
    for (const good of ['s1', 's-1', 's:1', 's_1', 's.1', 'S9']) {
      expect(file.pathOf(good)).toBe(join(rootDir, good, 'audit.jsonl'))
    }
    // 被拒绝的名字没有在工作目录里留下任何东西
    expect(existsSync(join(dir, 'escape'))).toBe(false)
    expect(existsSync(join(rootDir, '..', 'escape'))).toBe(false)
  })

  it('内存链（不给 rootDir）的 pathOf 只做校验、返回空串', () => {
    const file = new ChainFile({ fsync: false })
    expect(file.pathOf('s1')).toBe('')
    expect(captureThrown(() => file.pathOf('../escape')).code).toBe('saga-id-invalid')
  })
})

describe('链文件 · 根目录扫描与内存链', () => {
  it('readAll 只收带 audit.jsonl 的目录；根下的杂项文件与空目录不炸扫描', () => {
    const dir = root()
    const rootDir = join(dir, 'audit')
    seed(dir, 's2', 1)
    seed(dir, 's1', 2)
    writeFileSync(join(rootDir, 'stray.txt'), 'not a chain', 'utf8')
    mkdirSync(join(rootDir, 'notachain'), { recursive: true })

    const rows = fileOf(dir).readAll()
    expect(rows.map((row) => `${row.s}#${String(row.q)}`)).toEqual(['s1#1', 's1#2', 's2#1'])
  })

  it('内存链按行内 sagaId 过滤读回，readAll 与文件链同一套 (sagaId, seq) 稳定序', () => {
    const dir = root()
    seed(dir, 'b', 1)
    seed(dir, 'a', 2)
    const rows = fileOf(dir).readAll()
    expect(rows.map((row) => `${row.s}#${String(row.q)}`)).toEqual(['a#1', 'a#2', 'b#1'])

    const memory = new ChainFile({ fsync: false })
    for (const row of rows) memory.append(row.s, row)
    expect(memory.read('a').map((row) => `${row.s}#${String(row.q)}`)).toEqual(['a#1', 'a#2'])
    expect(memory.read('b')).toHaveLength(1)
    expect(memory.readAll().map((row) => `${row.s}#${String(row.q)}`)).toEqual(['a#1', 'a#2', 'b#1'])
  })
})

describe('链文件 · 落盘口径', () => {
  it('缺省 fsync = true 时 append 仍完整落盘（Windows 上以 r+ 打开，不得 EPERM）', () => {
    const dir = root()
    // 刻意不传 fsync / warn：走库默认口径。既有测试与全部装配位都显式传 fsync: false，
    // 这条路径此前没有任何用例证明它真的能落盘。
    const durable = createSagaAudit({ now: () => 1_000, rootDir: join(dir, 'audit'), signedTypes: [] })
    expect(() => durable.append('s-durable', 'saga/created', { sagaId: 's-durable' })).not.toThrow()

    const path = join(dir, 'audit', 's-durable', 'audit.jsonl')
    expect(statSync(path).size).toBeGreaterThan(0)
    expect(durable.verify('s-durable')).toEqual({ ok: true })
    expect(fileOf(dir).read('s-durable').map((row) => row.q)).toEqual([1])
  })
})
