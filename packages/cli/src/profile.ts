/**
 * profile 解析器（施工单 06 §5 第 1 步）。
 *
 * 三层概念里的"数据面"全在这里：profile 清单（`profiles/<name>/profile.yml`）、
 * 四层 patch 的文件读取与校验。boot 侧只接收**已解析的行**，不碰文件系统。
 *
 * 校验纪律（施工单 06 §4）：未知键、类型错误、引用了不存在的文件 → 载入即抛
 * （`bah-boot: ` 前缀），绝不静默回退。
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'

import { describeThrown } from '@bah/core'
import { bootError, normalizeRow } from '@bah/host'

import type { ConfigLayer, PluginRow, ProfileSummary } from '@bah/host'
import { parse } from 'yaml'

/** profile 目录下的清单文件名。 */
const PROFILE_MANIFEST = 'profile.yml'

/** home patch 的文件名（施工单 06 §1：项目里叫 `bah.patch.yml`）。 */
export const HOME_PATCH_FILE = 'bah.patch.yml'

/** 解析后的 profile。 */
export interface ProfileDefinition extends ProfileSummary {
  /** profile 目录的绝对路径。 */
  readonly dir: string
  /** profile patch 文件的绝对路径（清单里没写 patch 时为 `undefined`）。 */
  readonly patchFile?: string
}

/** `readLayers` 的产物：层内容 + 真实读过的文件（HMR 要监听它们）。 */
export interface LayersResult {
  readonly layers: readonly ConfigLayer[]
  readonly files: readonly string[]
}

/** `readLayers` 的选项。 */
export interface LayerOptions {
  /** home patch 目录（`--home` / `$BAH_HOME` / `~/.bah`）。 */
  readonly home: string
  /** `--patch` overlay 文件（按书写顺序，后写的在外层）。 */
  readonly overlays: readonly string[]
}

/**
 * 读项目清单 `bah.yml` 的默认 profile。
 *
 * @returns 没写 `profile.default` 时 `undefined`
 * @throws `BahError('invalid-manifest')` 结构不对
 */
export function readDefaultProfile(root: string): string | undefined {
  const path = join(root, 'bah.yml')
  if (!existsSync(path)) return undefined
  const doc = parseYaml(path)
  const manifest = expectObject(doc, 'bah.yml')
  rejectUnknown(manifest, ['profile'], 'bah.yml')
  const profile = manifest['profile'] === undefined ? undefined : expectObject(manifest['profile'], 'bah.yml.profile')
  if (profile === undefined) return undefined
  rejectUnknown(profile, ['default', 'bundles'], 'bah.yml.profile')
  const value = profile['default']
  if (value === undefined) return undefined
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw bootError('invalid-manifest', 'bah.yml 的 profile.default 必须是非空字符串', { path })
  }
  return value.trim()
}

/**
 * 读 `bah.yml` 声明的 bundle 清单（`verify-plugin-config` 同款检查的运行时版本）。
 *
 * @throws `BahError('invalid-manifest')` 结构不对
 */
export function readManifestBundles(root: string): readonly string[] {
  const path = join(root, 'bah.yml')
  if (!existsSync(path)) return []
  const doc = parseYaml(path)
  const manifest = expectObject(doc, 'bah.yml')
  const profile = manifest['profile'] === undefined ? undefined : expectObject(manifest['profile'], 'bah.yml.profile')
  if (profile === undefined) return []
  const bundles = profile['bundles']
  if (bundles === undefined) return []
  return expectStringArray(bundles, 'bah.yml.profile.bundles')
}

/**
 * 读一个 profile。
 *
 * @throws `BahError('unknown-profile')` 目录不存在
 * @throws `BahError('profile-not-implemented')` 只有占位目录（无 profile.yml）
 * @throws `BahError('invalid-manifest')` 清单结构不对
 */
export function readProfile(root: string, name: string): ProfileDefinition {
  const dir = join(root, 'profiles', name)
  if (!existsSync(dir)) {
    throw bootError(
      'unknown-profile',
      `未知 profile '${name}'（已落地：${listProfiles(root).join('、') || '无'}）`,
      { profile: name },
    )
  }
  const manifestPath = join(dir, PROFILE_MANIFEST)
  if (!existsSync(manifestPath)) {
    throw bootError(
      'profile-not-implemented',
      `profile '${name}' 只有占位目录：${PROFILE_MANIFEST} 未落地（渠道 profile 属插件线 13–15）`,
      { profile: name, dir },
    )
  }

  const manifest = expectObject(parseYaml(manifestPath), manifestPath)
  rejectUnknown(manifest, ['name', 'bundles', 'patch', 'hmr'], manifestPath)

  const declaredName = manifest['name']
  if (declaredName !== undefined && declaredName !== name) {
    throw bootError(
      'invalid-manifest',
      `${manifestPath} 的 name 是 '${String(declaredName)}'，与目录名 '${name}' 不一致`,
      { name, declared: declaredName },
    )
  }

  const bundles = expectStringArray(manifest['bundles'], `${manifestPath} 的 bundles`)
  if (bundles.length === 0) {
    throw bootError('invalid-manifest', `${manifestPath} 的 bundles 不能为空（profile 至少要叠加一个 bundle）`, { name })
  }

  const hmr = readBoolean(manifest['hmr'], `${manifestPath} 的 hmr`, true)

  const patch = manifest['patch']
  let patchFile: string | undefined
  if (patch !== undefined) {
    if (typeof patch !== 'string' || patch.trim().length === 0) {
      throw bootError('invalid-manifest', `${manifestPath} 的 patch 必须是非空字符串（相对 profile 目录）`, { name })
    }
    patchFile = resolve(dir, patch.trim())
    if (!existsSync(patchFile)) {
      throw bootError('patch-missing', `${manifestPath} 指向的 patch 文件不存在：${patchFile}`, { name, patchFile })
    }
  }

  return { name, bundles, hmr, dir, ...(patchFile === undefined ? {} : { patchFile }) }
}

/**
 * 读四层里的三层（bundle 层由 `bundles.ts` 提供）。
 *
 * 层序（后层覆盖前层）：profile patch → home patch → `--patch` overlay。
 *
 * @throws `BahError('patch-missing')` overlay 文件不存在（写了却读不到 = 配置错）
 * @throws `BahError('invalid-patch')` 文件结构不对
 */
export function readLayers(
  root: string,
  profile: ProfileDefinition,
  options: LayerOptions,
): LayersResult {
  const layers: ConfigLayer[] = []
  const files: string[] = []

  if (profile.patchFile !== undefined) {
    const from = relativeTo(root, profile.patchFile)
    layers.push({ layer: 'profile-patch', from, rows: readPatchFile(profile.patchFile) })
    files.push(profile.patchFile)
  }

  const homePatch = join(options.home, HOME_PATCH_FILE)
  if (existsSync(homePatch)) {
    layers.push({ layer: 'home-patch', from: homePatch, rows: readPatchFile(homePatch) })
    files.push(homePatch)
  }

  for (const overlay of options.overlays) {
    const path = isAbsolute(overlay) ? overlay : resolve(root, overlay)
    if (!existsSync(path)) {
      throw bootError('patch-missing', `--patch 指向的文件不存在：${overlay}`, { overlay })
    }
    layers.push({ layer: 'overlay', from: relativeTo(root, path), rows: readPatchFile(path) })
    files.push(path)
  }

  return { layers, files }
}

/**
 * 读一个 patch 文件（YAML 数组）。
 *
 * @throws `BahError('invalid-patch')` 结构不对
 */
export function readPatchFile(path: string): readonly PluginRow[] {
  return parsePatch(parseYaml(path), path)
}

/**
 * 把 YAML 文档解析成行集合。
 *
 * 空文件 = 空数组（合法的"这层什么都没写"）。每一行只允许 `id` / `use` / `config`。
 *
 * @throws `BahError('invalid-patch')` 顶层不是数组 / 行结构不对
 */
export function parsePatch(doc: unknown, from: string): readonly PluginRow[] {
  if (doc === null || doc === undefined) return []
  if (!Array.isArray(doc)) {
    throw bootError('invalid-patch', `${from} 必须是 patch 行的数组（收到 ${typeof doc}）`, { from })
  }
  return doc.map((item, index) => {
    const where = `${from} 第 ${index + 1} 行`
    const record = expectObject(item, where)
    rejectUnknown(record, ['id', 'use', 'config'], where)
    const row: PluginRow = {
      id: typeof record['id'] === 'string' ? record['id'] : '',
      ...(record['use'] === undefined ? {} : { use: record['use'] as string }),
      ...(record['config'] === undefined ? {} : { config: record['config'] as Readonly<Record<string, unknown>> }),
    }
    try {
      return normalizeRow(row, where)
    } catch (error) {
      // 行校验的错误由 host 提供（同一份语义）；这里补上"哪一行"的位置信息
      throw bootError(
        'invalid-patch',
        `${where}：${describeThrown(error).replace(/^bah-boot: /, '')}`,
        { from, index },
      )
    }
  })
}

/** 列出已落地（有 profile.yml）的 profile 名。 */
export function listProfiles(root: string): readonly string[] {
  const dir = join(root, 'profiles')
  if (!existsSync(dir)) return []
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(dir, entry.name, PROFILE_MANIFEST)))
    .map((entry) => entry.name)
    .sort()
}

/** 读文本文件并去掉 UTF-8 BOM（Windows 记事本默认会写 BOM，YAML 解析器会因此报错）。 */
function readText(path: string): string {
  const text = readFileSync(path, 'utf8')
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
}

/** 读 YAML 文件（解析失败给结构化错误，而不是 yaml 的原始异常）。 */
function parseYaml(path: string): unknown {
  try {
    return parse(readText(path)) as unknown
  } catch (error) {
    throw bootError('invalid-yaml', `${path} 不是合法 YAML：${describeThrown(error)}`, { path })
  }
}

/** 断言对象。 */
function expectObject(value: unknown, where: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw bootError('invalid-manifest', `${where} 必须是对象`, { where })
  }
  return value as Record<string, unknown>
}

/** 拒绝未声明的键。 */
function rejectUnknown(record: Record<string, unknown>, allowed: readonly string[], where: string): void {
  const unknown = Object.keys(record).filter((key) => !allowed.includes(key))
  if (unknown.length === 0) return
  throw bootError(
    'unknown-key',
    `${where} 出现未知键：${unknown.join(', ')}（可写：${allowed.join(' / ')}）`,
    { where, unknown },
  )
}

/** 断言字符串数组（非空成员）。 */
function expectStringArray(value: unknown, where: string): readonly string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || item.length === 0)) {
    throw bootError('invalid-manifest', `${where} 必须是非空字符串数组`, { where })
  }
  return [...(value as string[])]
}

/** 读布尔（未写取 fallback）。 */
function readBoolean(value: unknown, where: string, fallback: boolean): boolean {
  if (value === undefined) return fallback
  if (typeof value !== 'boolean') {
    throw bootError('invalid-manifest', `${where} 必须是布尔（收到 ${String(value)}）`, { where })
  }
  return value
}

/** 相对仓库根的展示路径（dump / 错误文案用；不在仓内时给绝对路径，统一用 `/`）。 */
export function relativeTo(root: string, path: string): string {
  const rel = relative(resolve(root), resolve(path))
  if (rel.length === 0) return '.'
  if (rel.startsWith('..') || isAbsolute(rel)) return path.split(sep).join('/')
  return rel.split(sep).join('/')
}
