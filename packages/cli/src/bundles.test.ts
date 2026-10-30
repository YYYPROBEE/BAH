/**
 * bundle 入口的 `.ts` → `.js` 回退（桌面端 03 / T-DTB-010）。
 *
 * ## 这条回退为什么必须存在
 *
 * 打包后的桌面端**没有 TS loader**：`loadBundles()` 要 `import(.../bundles/base/index.ts)`，
 * 而 `resources/app` 里只有构建期编出来的 `index.js`。没有回退 ⇒ 桌面端启动直接
 * `unknown-bundle`（03 §9.2 的对抗项之一）。
 *
 * ## 这条回退的边界（同等重要）
 *
 * **`.ts` 优先**。两份同时存在时必须用 `.ts`，否则"改了代码没生效"会变成常态：
 * 本机开发跑起上一次打包的产物，而所有门禁与用例都是绿的。
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { bundleDir, loadBundle } from './bundles.ts'

/** 造一个临时仓库，只放 bundle 目录（`loadBundle` 不需要别的东西）。 */
function makeRepo(): string {
  const root = mkdtempSync(join(tmpdir(), 'bah-bundles-'))
  mkdirSync(join(root, 'packages', 'cli', 'bundles'), { recursive: true })
  return root
}

/** 往临时仓库写一个 bundle 入口。 */
function writeEntry(root: string, name: string, file: 'index.ts' | 'index.js', body: string): void {
  const dir = join(bundleDir(root, name))
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, file), body, 'utf8')
}

/** 合法 bundle 的源码（ESM，`loadBundle` 用 file:// 动态 import）。 */
function bundleSource(name: string, firstRow: string): string {
  return `export const bundle = { name: '${name}', rows: [{ id: '${firstRow}' }] }\n`
}

describe('loadBundle 的入口回退（T-DTB-010）', () => {
  it('只有 index.ts 时走 .ts（仓库内现状，行为一字不变）', async () => {
    const root = makeRepo()
    try {
      writeEntry(root, 'onlyts', 'index.ts', bundleSource('onlyts', 'core:session'))
      const bundle = await loadBundle(root, 'onlyts')
      expect(bundle.rows).toEqual([{ id: 'core:session' }])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('只有 index.js 时可加载（打包后的形态）', async () => {
    const root = makeRepo()
    try {
      writeEntry(root, 'onlyjs', 'index.js', bundleSource('onlyjs', 'core:tools'))
      const bundle = await loadBundle(root, 'onlyjs')
      expect(bundle.name).toBe('onlyjs')
      expect(bundle.rows).toEqual([{ id: 'core:tools' }])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('两份都在时 **.ts 胜出**（否则会静默跑上一次打包的产物）', async () => {
    const root = makeRepo()
    try {
      writeEntry(root, 'both', 'index.ts', bundleSource('both', 'from-typescript'))
      writeEntry(root, 'both', 'index.js', bundleSource('both', 'from-javascript'))
      const bundle = await loadBundle(root, 'both')
      expect(bundle.rows).toEqual([{ id: 'from-typescript' }])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('两份都没有：unknown-bundle，且错误里同时列出两个候选路径', async () => {
    const root = makeRepo()
    try {
      mkdirSync(join(bundleDir(root, 'ghost')), { recursive: true })
      const error = await loadBundle(root, 'ghost').then(
        () => undefined,
        (reason: unknown) => reason as Error & { code?: string },
      )
      expect(error?.code).toBe('unknown-bundle')
      // 两个候选路径都要在错误里：现场排障第一句话就是"到底找的是哪个文件"
      expect(error?.message).toContain('index.ts')
      expect(error?.message).toContain('index.js')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('index.js 里导出形状不对：仍按 invalid-bundle 处理（回退不改校验）', async () => {
    const root = makeRepo()
    try {
      writeEntry(root, 'shape', 'index.js', "export const bundle = { name: 'other', rows: [{}] }\n")
      const error = await loadBundle(root, 'shape').then(
        () => undefined,
        (reason: unknown) => reason as Error & { code?: string },
      )
      expect(error?.code).toBe('invalid-bundle')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
