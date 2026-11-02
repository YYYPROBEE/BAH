/**
 * 审计对账的两条"目录租户 vs 链行租户"判据（租户与鉴权 01 · TA-15 的续集）。
 *
 * 为什么这两条必须有用例：把某个租户的整条链目录搬到另一个租户目录下，
 * **字节不变 ⇒ 哈希链依旧连续、签名依旧有效**——所有"链没断"的检查都会说通过。
 * 唯一能发现这件事的就是逐行比对 `row.tenant` 与目录租户。
 * 这条判据此前一次都没被执行过（本文件是它的第一次），等于隔离性的最后一道对账是纸糊的。
 *
 * 另一半钉的是"目录存在但里面一条链都没有"：`discover()` 返回空时必须显式报错，
 * 不能输出空表让人读成"审计通过"（AR-01 警告的静默失败形态）。
 */

import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { createSagaAudit } from '@bah/persistence'

import { runAudit } from './audit.ts'

const NOW = 1_700_000_000_000

const dirs: string[] = []
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'bah-audit-xtenant-'))
  dirs.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/**
 * 造一条链，并把**行自述的租户**与**落盘目录的租户**分开给。
 *
 * `rowTenant ≠ dirTenant` 就是"文件被搬错目录"的实物形态（真实事故里是先写错、
 * 后来人工挪目录，链本身没被改过一个字节）。
 */
function makeChain(dir: string, dirTenant: string, rowTenant: string | undefined, sagaId: string): void {
  const writer = createSagaAudit({
    now: () => NOW,
    rootDir: join(dir, dirTenant),
    fsync: false,
    signedTypes: [],
    warn: () => undefined,
    ...(rowTenant === undefined ? {} : { tenant: rowTenant }),
  })
  writer.append(sagaId, 'saga/created', { sagaId })
  writer.append(sagaId, 'tool/call', { callId: 'c-1', name: 'account_balance' })
}

async function run(
  dir: string,
  argv: readonly string[],
): Promise<{ code: number; out: string; err: string }> {
  const out: string[] = []
  const err: string[] = []
  const code = await runAudit(
    argv,
    { out: (line) => out.push(line), err: (line) => err.push(line) },
    { root: dir },
  )
  return { code, out: out.join('\n'), err: err.join('\n') }
}

describe('链行租户 ↔ 目录租户对账', () => {
  it('整条链被搬进别的租户目录：哈希链仍连续，但对账必须红并指到具体行', async () => {
    const dir = tempDir()
    // 行里写的是 acme，文件躺在 demo 目录下
    makeChain(dir, 'demo', 'acme', 's-moved')

    const result = await run(dir, [
      '--dir',
      '.',
      '--tenant',
      'demo',
      '--no-signature',
      '--no-projection',
    ])

    expect(result.code).not.toBe(0)
    expect(result.err + result.out).toContain('链行租户 acme ≠ 目录租户 demo')
    expect(result.err + result.out).toContain('s-moved#1')
    // 不能只说"通过"：链本身确实没断，这正是单靠连续性查不出来的原因
    expect(result.out).not.toContain('结论：通过')
  })

  it('同租户正常落盘 ⇒ 对账不误伤（判据不是"凡是带租户的行都报错"）', async () => {
    const dir = tempDir()
    makeChain(dir, 'demo', 'demo', 's-ok')

    const result = await run(dir, ['--dir', '.', '--tenant', 'demo', '--no-signature', '--no-projection'])

    expect(result.err + result.out).not.toContain('≠ 目录租户')
  })

  it('历史行没有 tenant 字段 ⇒ 跳过对账（旧数据不算搬错）', async () => {
    const dir = tempDir()
    makeChain(dir, 'demo', undefined, 's-legacy')

    const result = await run(dir, ['--dir', '.', '--tenant', 'demo', '--no-signature', '--no-projection'])

    expect(result.err + result.out).not.toContain('≠ 目录租户')
  })

  it('租户目录存在但下面没有 audit.jsonl ⇒ 退出码 2 并说"下没有 audit.jsonl"', async () => {
    const dir = tempDir()
    // 只有空目录：`discover()` 扫得到目录名但取不到链，此前这条消息分支从未执行
    mkdirSync(join(dir, 'demo'), { recursive: true })

    const result = await run(dir, ['--dir', '.', '--tenant', 'demo', '--no-signature', '--no-projection'])

    expect(result.code).toBe(2)
    expect(result.err).toContain('该租户没有链：demo')
    expect(result.err).toContain('下没有 audit.jsonl')
    expect(result.out).not.toContain('结论：通过')
  })
})
