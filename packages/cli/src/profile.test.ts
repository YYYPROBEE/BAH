/**
 * profile 解析器与 bundle 加载（施工单 06 §5 第 1 步 / §6 的 T-PRF-001~005 数据面）。
 *
 * 全部用临时目录里的真文件：这一层的 bug 几乎都在"文件存在与否 / 路径怎么拼"上，
 * mock 掉 fs 会把最容易错的地方测掉。
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { captureThrown } from '@bah/test-support'
import { describe, expect, it } from 'vitest'

import { declaredBundles, loadBundle, loadBundles, readBundle } from './bundles.ts'
import {
  listProfiles,
  parsePatch,
  readDefaultProfile,
  readLayers,
  readManifestBundles,
  readPatchFile,
  readProfile,
  relativeTo,
} from './profile.ts'

/** 仓库根（本文件在 `packages/cli/src/`）。 */
const repoRoot = fileURLToPath(new URL('../../../', import.meta.url))

/** 写一个文件（自动建父目录）。 */
function write(root: string, path: string, content: string): void {
  const full = join(root, path)
  mkdirSync(join(full, '..'), { recursive: true })
  writeFileSync(full, content, 'utf8')
}

/** 在临时目录里搭一个最小仓库。 */
function makeRepo(): string {
  const root = mkdtempSync(join(tmpdir(), 'bah-cli-'))
  write(root, 'bah.yml', 'profile:\n  default: ok\n  bundles: [base]\n')
  write(root, 'packages/cli/package.json', JSON.stringify({ name: '@bah/cli', bah: { profile: { bundles: ['base', 'ghost'] } } }))
  write(
    root,
    'packages/cli/bundles/base/index.ts',
    "export const bundle = { name: 'base', rows: [{ id: 'core:session' }] }\n",
  )
  write(
    root,
    'profiles/ok/profile.yml',
    'name: ok\nbundles: [base]\npatch: ./patch.yml\nhmr: false\n',
  )
  write(root, 'profiles/ok/patch.yml', '- id: core:session\n  config: {}\n')
  write(root, 'profiles/empty/.gitkeep', '')
  write(root, 'profiles/namemismatch/profile.yml', 'name: other\nbundles: [base]\n')
  write(root, 'profiles/nobundles/profile.yml', 'bundles: []\n')
  write(root, 'profiles/nopatch/profile.yml', 'bundles: [base]\npatch: ./missing.yml\n')
  write(root, 'profiles/badpatchtype/profile.yml', 'bundles: [base]\npatch: 42\n')
  write(root, 'profiles/badbundletype/profile.yml', 'bundles: base\n')
  write(root, 'profiles/unknownkey/profile.yml', 'bundles: [base]\nnope: 1\n')
  write(root, 'profiles/badhmr/profile.yml', 'bundles: [base]\nhmr: yes please\n')
  write(root, 'home/bah.patch.yml', '- id: core:session\n  config: { hot: true }\n')
  write(root, 'overlay.yml', '- id: core:session\n  config: { overlay: true }\n')
  return root
}

describe('profile 清单', () => {
  it('读默认 profile 与 bundle 声明', () => {
    const root = makeRepo()
    try {
      expect(readDefaultProfile(root)).toBe('ok')
      expect(readManifestBundles(root)).toEqual(['base'])
      expect(declaredBundles(root)).toEqual(['base', 'ghost'])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('没有 bah.yml 时：默认 profile 与 bundle 声明都为空（不报错）', () => {
    const root = mkdtempSync(join(tmpdir(), 'bah-cli-'))
    try {
      expect(readDefaultProfile(root)).toBeUndefined()
      expect(readManifestBundles(root)).toEqual([])
      expect(declaredBundles(root)).toEqual([])
      expect(listProfiles(root)).toEqual([])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('bah.yml 结构不对：载入即抛', () => {
    const root = mkdtempSync(join(tmpdir(), 'bah-cli-'))
    try {
      write(root, 'bah.yml', 'profile:\n  default: 42\n')
      expect(captureThrown(() => readDefaultProfile(root)).code).toBe('invalid-manifest')
      write(root, 'bah.yml', 'profile: [1, 2]\n')
      expect(captureThrown(() => readDefaultProfile(root)).code).toBe('invalid-manifest')
      write(root, 'bah.yml', 'nope: 1\n')
      expect(captureThrown(() => readDefaultProfile(root)).code).toBe('unknown-key')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('listProfiles 只列有 profile.yml 的目录', () => {
    const root = makeRepo()
    try {
      expect(listProfiles(root)).toEqual([
        'badbundletype',
        'badhmr',
        'badpatchtype',
        'namemismatch',
        'nobundles',
        'nopatch',
        'ok',
        'unknownkey',
      ])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('合法 profile：bundles / patch 绝对路径 / hmr', () => {
    const root = makeRepo()
    try {
      const profile = readProfile(root, 'ok')
      expect(profile.name).toBe('ok')
      expect(profile.bundles).toEqual(['base'])
      expect(profile.hmr).toBe(false)
      expect(profile.patchFile).toBe(join(root, 'profiles', 'ok', 'patch.yml'))
      expect(profile.dir).toBe(join(root, 'profiles', 'ok'))
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('未知 profile / 占位目录 / 名字不符 / 空 bundles / patch 缺失 / 未知键 / hmr 非法 都载入即抛', () => {
    const root = makeRepo()
    try {
      expect(captureThrown(() => readProfile(root, 'nope')).code).toBe('unknown-profile')
      expect(captureThrown(() => readProfile(root, 'empty')).code).toBe('profile-not-implemented')
      expect(captureThrown(() => readProfile(root, 'namemismatch')).code).toBe('invalid-manifest')
      expect(captureThrown(() => readProfile(root, 'nobundles')).code).toBe('invalid-manifest')
      expect(captureThrown(() => readProfile(root, 'nopatch')).code).toBe('patch-missing')
      expect(captureThrown(() => readProfile(root, 'badpatchtype')).code).toBe('invalid-manifest')
      expect(captureThrown(() => readProfile(root, 'badbundletype')).code).toBe('invalid-manifest')
      expect(captureThrown(() => readProfile(root, 'unknownkey')).code).toBe('unknown-key')
      expect(captureThrown(() => readProfile(root, 'badhmr')).code).toBe('invalid-manifest')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('patch 层读取', () => {
  it('三层按层序返回：profile patch → home patch → overlay', () => {
    const root = makeRepo()
    try {
      const profile = readProfile(root, 'ok')
      const { layers, files } = readLayers(root, profile, {
        home: join(root, 'home'),
        overlays: [join(root, 'overlay.yml')],
      })

      expect(layers.map((item) => item.layer)).toEqual(['profile-patch', 'home-patch', 'overlay'])
      expect(layers.map((item) => item.from)).toEqual([
        'profiles/ok/patch.yml',
        join(root, 'home', 'bah.patch.yml'),
        'overlay.yml',
      ])
      expect(layers[1]?.rows[0]?.config).toEqual({ hot: true })
      expect(files).toHaveLength(3)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('没有 profile patch / home patch 时只剩有的那层；overlay 文件不存在即抛', () => {
    const root = makeRepo()
    try {
      const profile = readProfile(root, 'ok')
      expect(
        readLayers(root, { ...profile, patchFile: undefined }, { home: join(root, 'nowhere'), overlays: [] }),
      ).toEqual({ layers: [], files: [] })
      expect(
        captureThrown(() =>
          readLayers(root, profile, { home: join(root, 'nowhere'), overlays: ['ghost.yml'] }),
        ).code,
      ).toBe('patch-missing')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('空 patch 文件 = 空层（合法的"这层什么都没写"）', () => {
    const root = mkdtempSync(join(tmpdir(), 'bah-cli-'))
    try {
      write(root, 'empty.yml', '')
      expect(readPatchFile(join(root, 'empty.yml'))).toEqual([])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('parsePatch：顶层不是数组 / 行缺 id / 未知键 / config 非对象 都载入即抛', () => {
    expect(captureThrown(() => parsePatch({ id: 'x' }, 'p.yml')).code).toBe('invalid-patch')
    expect(captureThrown(() => parsePatch([{ config: {} }], 'p.yml')).code).toBe('invalid-patch')
    expect(captureThrown(() => parsePatch([{ id: 'x', nope: 1 }], 'p.yml')).code).toBe('unknown-key')
    expect(captureThrown(() => parsePatch([{ id: 'x', config: 'nope' }], 'p.yml')).code).toBe(
      'invalid-patch',
    )
    // 错误里带"第几行"，排障时不用数行
    expect(captureThrown(() => parsePatch([{ config: {} }], 'p.yml')).message).toContain('第 1 行')
    // id / use 会被 trim
    expect(parsePatch([{ id: ' x ', use: ' y ' }], 'p.yml')).toEqual([{ id: 'x', use: 'y' }])
  })

  it('YAML 语法错误 → invalid-yaml（而不是 yaml 库的原始异常）', () => {
    const root = mkdtempSync(join(tmpdir(), 'bah-cli-'))
    try {
      write(root, 'broken.yml', 'a: [1, 2\n')
      expect(captureThrown(() => readPatchFile(join(root, 'broken.yml'))).code).toBe('invalid-yaml')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('带 BOM 的 patch / package.json 也能读（Windows 记事本会写 BOM）', () => {
    const root = mkdtempSync(join(tmpdir(), 'bah-cli-'))
    try {
      write(root, 'bom.yml', '\uFEFF- id: core:session\n')
      expect(readPatchFile(join(root, 'bom.yml'))).toHaveLength(1)

      write(root, 'packages/cli/package.json', `\uFEFF${JSON.stringify({ bah: { profile: { bundles: ['base'] } } })}`)
      expect(declaredBundles(root)).toEqual(['base'])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('relativeTo：仓内给相对路径（统一 /），仓外给绝对路径', () => {
    expect(relativeTo(repoRoot, join(repoRoot, 'profiles', 'headless', 'patch.yml'))).toBe(
      'profiles/headless/patch.yml',
    )
    expect(relativeTo(repoRoot, repoRoot)).toBe('.')
    expect(relativeTo(repoRoot, join(tmpdir(), 'outside.yml'))).toContain('outside.yml')
  })
})

describe('bundle 加载', () => {
  it('加载临时仓库里的 bundle', async () => {
    const root = makeRepo()
    try {
      const bundle = await loadBundle(root, 'base')
      expect(bundle).toEqual({ name: 'base', rows: [{ id: 'core:session' }] })
      expect(await loadBundles(root, ['base'])).toHaveLength(1)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('未声明的 bundle / 目录缺失 / 空 rows / 名字不符 都载入即抛', async () => {
    const root = makeRepo()
    try {
      expect(captureThrown(() => readBundle({}, 'base')).code).toBe('invalid-bundle')
      expect(captureThrown(() => readBundle({ bundle: { name: 'other', rows: [{}] } }, 'base')).code).toBe(
        'invalid-bundle',
      )
      expect(captureThrown(() => readBundle({ bundle: { name: 'base', rows: [] } }, 'base')).code).toBe(
        'invalid-bundle',
      )
      await expect(loadBundles(root, ['undeclared'])).rejects.toMatchObject({ code: 'undeclared-bundle' })
      await expect(loadBundle(root, 'ghost')).rejects.toMatchObject({ code: 'unknown-bundle' })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('包的 package.json 坏了：invalid-bundle', () => {
    const root = mkdtempSync(join(tmpdir(), 'bah-cli-'))
    try {
      write(root, 'packages/cli/package.json', '{ not json')
      expect(captureThrown(() => declaredBundles(root)).code).toBe('invalid-bundle')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('真实仓库：base bundle 可加载，声明清单与之一致', async () => {
    expect(declaredBundles(repoRoot)).toEqual(['base'])
    const bundle = await loadBundle(repoRoot, 'base')
    expect(bundle.name).toBe('base')
    expect(bundle.rows.map((row) => row.id)).toContain('core:session')
  })
})
