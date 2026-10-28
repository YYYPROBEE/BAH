/**
 * `bah audit --tenant`（租户与鉴权 01 · TA-15 配套）。
 *
 * 租户化之后链在 `<dir>/<tenant>/` 下。审计命令必须显式拼租户——
 * 不拼的话 `discover(dir)` 扫的是 `<tenant>/` 这一层，一个 `audit.jsonl` 都找不到，
 * 于是"没有断链"（而实际上一条都没看）。这条用例就是钉住那个静默失败。
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { createSagaAudit } from '@bah/persistence'

import { runAudit } from './audit.ts'

const dirs: string[] = []
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'bah-audit-tenant-'))
  dirs.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** 在 <dir>/<tenant>/<saga>/ 下造一条链。 */
function makeChain(dir: string, tenant: string, sagaId: string): void {
  const writer = createSagaAudit({
    now: () => 1_700_000_000_000,
    rootDir: join(dir, tenant),
    fsync: false,
    signedTypes: [],
    warn: () => undefined,
  })
  writer.append(sagaId, 'saga/created', { sagaId })
}

async function run(dir: string, argv: readonly string[]): Promise<{ code: number; out: string; err: string }> {
  const out: string[] = []
  const err: string[] = []
  const code = await runAudit(argv, { out: (line) => out.push(line), err: (line) => err.push(line) }, {
    root: dir,
  })
  return { code, out: out.join('\n'), err: err.join('\n') }
}

describe('bah audit --tenant', () => {
  it('TA-15-5 --tenant acme 在只有 demo 的根上 → 非 0 + 明确说"该租户没有链"', async () => {
    const dir = tempDir()
    makeChain(dir, 'demo', 's-demo')

    const result = await run(dir, ['--dir', '.', '--tenant', 'acme', '--no-signature', '--no-projection'])
    expect(result.code).toBe(2)
    expect(result.err).toContain('该租户没有链')
    // 不许静默输出空表（那会被读成"审计通过"）
    expect(result.out).not.toContain('结论：通过')
  })

  it('TA-15-6 --tenant demo 能找到 demo 租户的链', async () => {
    const dir = tempDir()
    makeChain(dir, 'demo', 's-demo')
    makeChain(dir, 'acme', 's-acme')

    const result = await run(dir, ['--dir', '.', '--tenant', 'demo', '--no-signature', '--format', 'json'])
    const report = JSON.parse(result.out) as { dir: string; chains: { sagaId: string }[] }
    expect(report.chains.map((entry) => entry.sagaId)).toEqual(['s-demo'])
    expect(report.dir).toBe(join(dir, 'demo'))
  })

  it('TA-15-7 非法租户 ID → 用法错误（退出码 2，且不落到别的目录）', async () => {
    const dir = tempDir()
    makeChain(dir, 'demo', 's-demo')
    const result = await run(dir, ['--dir', '.', '--tenant', '../x'])
    expect(result.code).toBe(2)
    expect(result.err).toContain('不是合法租户 ID')
  })
})
