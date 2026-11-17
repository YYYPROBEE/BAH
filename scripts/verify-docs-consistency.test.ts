/**
 * 文档一致性门禁的**判据回归**（C1）。
 *
 * 2026-11-15 修过两处漏网：`pnpm gate                 # 44/44` 因"gate 后 8 字符"
 * 窗口太窄一路绿；放宽窗口后又必须避免把"这条门禁的局限：判据 1/2"当成通过数。
 * 这里用临时根目录喂最小事实块，钉住正反两面：
 * 1. 远距离 `N/N` 仍会命中；
 * 2. `N 项` 与表格写法都按当前门禁数放行；
 * 3. 中文隔断的"判据 1/2"不误报。
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { gate } from './verify-docs-consistency.ts'

const FACTS = `# facts

<!-- facts:sources:start -->
gates=53
tools=30
tests_main_files=455
tests_main_cases=5283
snapshot_files=14
snapshot_cases=64
<!-- facts:sources:end -->
`

/** 最小仓库根：只放事实块与一份 README，避免其它对外材料干扰判据。 */
async function runWith(readme: string): Promise<Awaited<ReturnType<typeof gate.run>>> {
  const root = mkdtempSync(join(tmpdir(), 'bah-docs-consistency-'))
  try {
    mkdirSync(join(root, 'docs'), { recursive: true })
    writeFileSync(join(root, 'docs/facts-sources.md'), FACTS)
    writeFileSync(join(root, 'README.md'), `# 演示\n\n${readme}\n`)
    return await gate.run(root)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

describe('docs-consistency 门禁判据', () => {
  it('远距离写法 `pnpm gate # 7/7` 仍会被抓（旧 8 字符窗口的回归）', async () => {
    const result = await runWith('pnpm gate                 # 7/7\n')
    expect(result.ok).toBe(false)
    expect(result.findings.some((finding) => finding.includes('门禁写成 7/7'))).toBe(true)
  })

  it('`N 项` 与表格 `N/N` 都按当前门禁数放行', async () => {
    const result = await runWith('| 门禁 | 53/53 |\n\npnpm gate（53 项）\n')
    expect(result.findings).toEqual([])
    expect(result.ok).toBe(true)
  })

  it('中文隔断的"判据 1/2"不被误当成门禁通过数', async () => {
    const result = await runWith('这条门禁的局限：判据 1/2。\n')
    expect(result.findings).toEqual([])
    expect(result.ok).toBe(true)
  })
})
