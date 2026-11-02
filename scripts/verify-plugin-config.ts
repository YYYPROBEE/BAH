/**
 * 门禁：组合配置的三方一致。
 *
 * 依据：「verify-plugin-config：bah.yml 引用的插件必须在依赖清单中」。
 * 阶段 6 把它从骨架版升级为**真实校验**，检查的是四份数据彼此不矛盾：
 *
 * ```text
 * 根 bah.yml ──声明──▶ bundle 名
 *      │                  │ 必须同时出现在
 *      ▼                  ▼
 * packages/cli/package.json（bah.profile.bundles，发行面）
 *      │                  │ 且目录里真的有 index.ts
 *      ▼                  ▼
 * packages/cli/bundles/<name>/ ──行里的 use──▶ packages/host 的依赖清单（HOST_PLUGINS）
 *      ▲                                            ▲
 *      └──────── profiles/<p>/profile.yml + patch.yml（行里的 use 也必须命中）
 * ```
 *
 * 为什么必须门禁：patch 文件是纯数据，写错一个 `use` 不会在编辑期报错，
 * 只会在启动时炸；这条门禁把"启动时炸"提前到提交前。
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join, relative } from 'node:path'
import { pathToFileURL } from 'node:url'

import { parse } from 'yaml'

import { isMainModule, runStandalone, type Gate, type GateResult } from './gate-lib.ts'

/** bundle 数据目录。 */
const BUNDLE_DIR = join('packages', 'cli', 'bundles')

/** profile 数据目录。 */
const PROFILE_DIR = 'profiles'

/** 一行 patch / bundle 行（结构校验用；语义校验由运行时的合并器负责）。 */
interface Row {
  readonly id?: unknown
  readonly use?: unknown
  readonly config?: unknown
}

/** 读 YAML 文件；解析失败返回错误文案。 */
function readYaml(path: string): { ok: true; value: unknown } | { ok: false; error: string } {
  try {
    return { ok: true, value: parse(readFileSync(path, 'utf8')) as unknown }
  } catch (error) {
    return { ok: false, error: `${path} 不是合法 YAML：${error instanceof Error ? error.message : String(error)}` }
  }
}

/** 断言对象。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 读字符串数组（不合法返回 `undefined`）。 */
function stringArray(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value)) return undefined
  if (value.some((item) => typeof item !== 'string' || item.length === 0)) return undefined
  return value as readonly string[]
}

/** 校验一个 patch 文件的行集合，返回问题清单。 */
function checkRows(
  path: string,
  rows: unknown,
  catalog: ReadonlySet<string>,
  where: string,
): string[] {
  if (!Array.isArray(rows)) return [`${path}：${where} 必须是数组`]
  const findings: string[] = []
  const seen = new Set<string>()

  for (const [index, item] of (rows as Row[]).entries()) {
    const at = `${path}（第 ${index + 1} 行）`
    if (!isRecord(item)) {
      findings.push(`${at}：行必须是对象`)
      continue
    }
    const unknown = Object.keys(item).filter((key) => !['id', 'use', 'config'].includes(key))
    if (unknown.length > 0) findings.push(`${at}：未知键 ${unknown.join(', ')}（只允许 id / use / config）`)

    const id = item['id']
    if (typeof id !== 'string' || id.trim().length === 0) {
      findings.push(`${at}：缺少 id（patch 靠 id 定位）`)
      continue
    }
    if (seen.has(id)) findings.push(`${at}：同一层内 id ${id} 重复`)
    seen.add(id)

    const config = item['config']
    if (config !== undefined && !isRecord(config)) findings.push(`${at}：config 必须是对象`)

    const use = item['use']
    if (use !== undefined) {
      if (typeof use !== 'string' || use.length === 0) {
        findings.push(`${at}：use 必须是非空字符串`)
      } else if (!catalog.has(use)) {
        findings.push(`${at}：use 指向的插件 ${use} 不在依赖清单中（packages/host 的 HOST_PLUGINS）`)
      }
    }
  }

  return findings
}

const gate: Gate = {
  name: 'plugin-config',

  async run(root): Promise<GateResult> {
    const findings: string[] = []
    const notes: string[] = []

    // ① 根清单
    const manifestPath = join(root, 'bah.yml')
    if (!existsSync(manifestPath)) {
      return {
        ok: false,
        findings: ['缺少根 bah.yml（profile.default 与随包 bundle 清单的唯一来源）'],
        notes: [],
      }
    }

    const parsedManifest = readYaml(manifestPath)
    if (!parsedManifest.ok) return { ok: false, findings: [parsedManifest.error], notes: [] }
    if (!isRecord(parsedManifest.value)) {
      return { ok: false, findings: ['bah.yml：顶层必须是对象'], notes: [] }
    }
    const unknownManifestKeys = Object.keys(parsedManifest.value).filter((key) => key !== 'profile')
    if (unknownManifestKeys.length > 0) {
      findings.push(`bah.yml：未知键 ${unknownManifestKeys.join(', ')}（只允许 profile）`)
    }
    const manifestProfile = parsedManifest.value['profile']
    const manifestBundles = isRecord(manifestProfile) ? stringArray(manifestProfile['bundles']) : undefined
    if (manifestBundles === undefined) {
      findings.push('bah.yml：profile.bundles 必须是非空字符串数组')
    }
    const defaultProfile = isRecord(manifestProfile) ? manifestProfile['default'] : undefined
    if (defaultProfile !== undefined && (typeof defaultProfile !== 'string' || defaultProfile.length === 0)) {
      findings.push('bah.yml：profile.default 必须是非空字符串')
    }

    // ② 发行面：packages/cli/package.json 的 bah.profile.bundles
    const cliManifestPath = join(root, 'packages', 'cli', 'package.json')
    let declared: readonly string[] = []
    if (!existsSync(cliManifestPath)) {
      findings.push('缺少 packages/cli/package.json（bundle 的发行面声明在这里）')
    } else {
      try {
        const cliManifest = JSON.parse(readFileSync(cliManifestPath, 'utf8')) as unknown
        const bah = isRecord(cliManifest) ? cliManifest['bah'] : undefined
        const profile = isRecord(bah) ? bah['profile'] : undefined
        const bundles = isRecord(profile) ? stringArray(profile['bundles']) : undefined
        if (bundles === undefined) {
          findings.push('packages/cli/package.json：缺少 bah.profile.bundles（非空字符串数组）')
        } else {
          declared = bundles
        }
      } catch (error) {
        findings.push(
          `packages/cli/package.json 不是合法 JSON：${error instanceof Error ? error.message : String(error)}`,
        )
      }
    }

    // ③ 依赖清单（插件实现）——patch 的 use 必须落在这里
    const catalog = await loadCatalog(root, findings)

    // ④ 三方一致：bah.yml ↔ package.json ↔ 目录
    for (const name of manifestBundles ?? []) {
      if (!declared.includes(name)) {
        findings.push(`bah.yml 引用了未在 packages/cli/package.json 声明的 bundle：'${name}'`)
      }
      if (!existsSync(join(root, BUNDLE_DIR, name, 'index.ts'))) {
        findings.push(`bundle '${name}' 缺少入口：${BUNDLE_DIR}/${name}/index.ts`)
      }
    }
    for (const name of declared) {
      if (manifestBundles !== undefined && !manifestBundles.includes(name)) {
        findings.push(`packages/cli 声明了 bundle '${name}'，但根 bah.yml 的 profile.bundles 没列它`)
      }
    }

    // ⑤ bundle 行里的 use 必须在依赖清单中
    for (const name of declared) {
      const entry = join(root, BUNDLE_DIR, name, 'index.ts')
      if (!existsSync(entry)) continue
      const loaded = await importBundle(entry)
      if (typeof loaded === 'string') {
        findings.push(loaded)
        continue
      }
      const exported = loaded['bundle']
      if (!isRecord(exported) || !Array.isArray(exported['rows'])) {
        findings.push(`${relative(root, entry)}：必须导出 { bundle: { name, rows } }`)
        continue
      }
      if (exported['name'] !== name) {
        findings.push(`${relative(root, entry)}：导出的 name '${String(exported['name'])}' 与目录名 '${name}' 不一致`)
      }
      findings.push(...checkRows(relative(root, entry), exported['rows'], catalog, 'rows'))
    }

    // ⑥ profile 清单 + patch 层
    const profileNames = listProfileDirs(root)
    let patchFiles = 0
    for (const name of profileNames) {
      const profilePath = join(root, PROFILE_DIR, name, 'profile.yml')
      if (!existsSync(profilePath)) continue // 占位目录：插件线落地，本阶段允许留空

      const parsed = readYaml(profilePath)
      if (!parsed.ok) {
        findings.push(parsed.error)
        continue
      }
      if (!isRecord(parsed.value)) {
        findings.push(`${profilePath}：顶层必须是对象`)
        continue
      }
      const keys = Object.keys(parsed.value).filter(
        (key) => !['name', 'bundles', 'patch', 'hmr'].includes(key),
      )
      if (keys.length > 0) findings.push(`${profilePath}：未知键 ${keys.join(', ')}`)

      if (parsed.value['name'] !== undefined && parsed.value['name'] !== name) {
        findings.push(`${profilePath}：name 必须与目录名 '${name}' 一致`)
      }
      const bundles = stringArray(parsed.value['bundles'])
      if (bundles === undefined || bundles.length === 0) {
        findings.push(`${profilePath}：bundles 必须是非空字符串数组`)
      } else {
        for (const bundle of bundles) {
          if (!declared.includes(bundle)) {
            findings.push(`${profilePath}：引用了未声明的 bundle '${bundle}'`)
          }
        }
      }
      if (parsed.value['hmr'] !== undefined && typeof parsed.value['hmr'] !== 'boolean') {
        findings.push(`${profilePath}：hmr 必须是布尔`)
      }

      const patch = parsed.value['patch']
      if (patch !== undefined) {
        if (typeof patch !== 'string' || patch.length === 0) {
          findings.push(`${profilePath}：patch 必须是非空字符串（相对 profile 目录）`)
        } else {
          const patchPath = join(root, PROFILE_DIR, name, patch)
          patchFiles += 1
          if (!existsSync(patchPath)) {
            findings.push(`${profilePath}：patch 文件不存在：${relative(root, patchPath)}`)
          } else {
            const parsedPatch = readYaml(patchPath)
            if (!parsedPatch.ok) findings.push(parsedPatch.error)
            else findings.push(...checkRows(relative(root, patchPath), parsedPatch.value ?? [], catalog, 'patch 行'))
          }
        }
      }
    }

    notes.push(`已校验 ${manifestBundles?.length ?? 0} 个 bah.yml bundle、${declared.length} 个发行面 bundle、${catalog.size} 个插件实现`)
    notes.push(`已校验 ${profileNames.length} 个 profile 目录、${patchFiles} 个 profile patch 文件`)
    if (profileNames.filter((name) => !existsSync(join(root, PROFILE_DIR, name, 'profile.yml'))).length > 0) {
      notes.push('部分 profile 目录只有占位（无 profile.yml）：渠道 profile 属插件线 13–15，本阶段允许留空')
    }

    return { ok: findings.length === 0, findings, notes }
  },
}

/** 读依赖清单里的插件 id 集合。 */
async function loadCatalog(root: string, findings: string[]): Promise<ReadonlySet<string>> {
  const entry = join(root, 'packages', 'host', 'src', 'boot', 'plugins', 'index.ts')
  if (!existsSync(entry)) {
    findings.push(`缺少依赖清单：${entry}`)
    return new Set()
  }
  const loaded = await importModule(entry)
  if (typeof loaded === 'string') {
    findings.push(loaded)
    return new Set()
  }
  const plugins = loaded['HOST_PLUGINS']
  if (!Array.isArray(plugins)) {
    findings.push(`${entry}：必须导出 HOST_PLUGINS 数组`)
    return new Set()
  }
  const ids = new Set<string>()
  for (const plugin of plugins as { id?: unknown }[]) {
    if (typeof plugin.id !== 'string') {
      findings.push(`${entry}：HOST_PLUGINS 里有插件缺少 id`)
      continue
    }
    ids.add(plugin.id)
  }
  return ids
}

/** 动态 import 一个模块；失败返回错误文案。 */
async function importModule(entry: string): Promise<Record<string, unknown> | string> {
  try {
    const module: unknown = await import(pathToFileURL(entry).href)
    if (!isRecord(module)) return `${entry}：模块导出形状异常`
    return module
  } catch (error) {
    return `${entry}：无法加载（${error instanceof Error ? error.message : String(error)}）`
  }
}

/** 动态 import 一个 bundle 模块。 */
async function importBundle(entry: string): Promise<Record<string, unknown> | string> {
  return importModule(entry)
}

/** 列出 profiles/ 下的目录名（排序，输出稳定）。 */
function listProfileDirs(root: string): readonly string[] {
  const dir = join(root, PROFILE_DIR)
  if (!existsSync(dir)) return []
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
}

export { gate }

if (isMainModule(import.meta.url)) {
  await runStandalone(gate)
}
