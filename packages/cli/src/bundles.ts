/**
 * bundle 加载（施工单 06 §2：bundle 声明在 `package.json` 的 `bah` 字段）。
 *
 * 一个 bundle = `packages/cli/bundles/<name>/` 目录 + 它导出的 `bundle` 对象
 * （`{ name, rows }`）。patch 文件只写 `use`，实现由 `@bah/host` 的依赖清单给出——
 * **bundle 目录里没有插件代码**，只有"有哪些行"这份数据。
 *
 * 为什么加载要动态 import：bundle 是**数据 + 声明**，随包发布，不能被 CLI 在编译期写死；
 * 同时这也让 `verify-plugin-config` 门禁能用同一份加载器做静态核对。
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { describeThrown } from '@bah/core'
import { bootError } from '@bah/host'

import type { Bundle, PluginRow } from '@bah/host'

/** bundle 目录（施工单 01 §6 规定的 `packages/cli/bundles/<name>/`）。 */
export function bundleDir(root: string, name: string): string {
  return join(root, 'packages', 'cli', 'bundles', name)
}

/**
 * 读 `@bah/cli` 的 `package.json` 里声明的 bundle 清单（依赖清单的"发行面"）。
 *
 * @returns 没声明时返回空数组
 */
export function declaredBundles(root: string): readonly string[] {
  const path = join(root, 'packages', 'cli', 'package.json')
  if (!existsSync(path)) return []
  let manifest: unknown
  try {
    // 去 BOM：Windows 记事本存出来的 JSON 带 BOM，`JSON.parse` 会直接拒
    const text = readFileSync(path, 'utf8')
    manifest = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text) as unknown
  } catch (error) {
    throw bootError('invalid-bundle', `${path} 不是合法 JSON：${describeThrown(error)}`, { path })
  }
  if (typeof manifest !== 'object' || manifest === null) return []
  const bah = (manifest as Record<string, unknown>)['bah']
  if (typeof bah !== 'object' || bah === null) return []
  const profile = (bah as Record<string, unknown>)['profile']
  if (typeof profile !== 'object' || profile === null) return []
  const bundles = (profile as Record<string, unknown>)['bundles']
  if (!Array.isArray(bundles)) return []
  return bundles.filter((item): item is string => typeof item === 'string')
}

/**
 * 加载一组 bundle（顺序 = profile 声明顺序）。
 *
 * @throws `BahError('undeclared-bundle')` bundle 未在 `@bah/cli` 的依赖清单里声明
 * @throws `BahError('unknown-bundle')` 目录里没有 `index.ts`
 * @throws `BahError('invalid-bundle')` 导出的形状不对
 */
export async function loadBundles(
  root: string,
  names: readonly string[],
): Promise<readonly Bundle[]> {
  const declared = declaredBundles(root)
  return Promise.all(
    names.map(async (name) => {
      if (!declared.includes(name)) {
        throw bootError(
          'undeclared-bundle',
          `bundle '${name}' 未在 packages/cli/package.json 的 bah.profile.bundles 里声明（已声明：${declared.join('、') || '无'}）`,
          { bundle: name, declared },
        )
      }
      return loadBundle(root, name)
    }),
  )
}

/**
 * 加载单个 bundle。
 *
 * @throws `BahError('unknown-bundle')` 目录或 `index.ts` 不存在
 * @throws `BahError('invalid-bundle')` 导出的 `bundle` 形状不对
 */
export async function loadBundle(root: string, name: string): Promise<Bundle> {
  const dir = bundleDir(root, name)
  const entry = join(dir, 'index.ts')
  if (!existsSync(entry)) {
    throw bootError('unknown-bundle', `bundle '${name}' 不存在：${entry} 缺失`, { bundle: name, entry })
  }
  const module: unknown = await import(pathToFileURL(entry).href)
  return readBundle(module, name)
}

/**
 * 从模块导出里取出 `bundle` 并校验它与目录名一致。
 *
 * @throws `BahError('invalid-bundle')` 形状不对 / 名字不一致
 */
export function readBundle(module: unknown, name: string): Bundle {
  const exported =
    typeof module === 'object' && module !== null ? (module as Record<string, unknown>)['bundle'] : undefined
  if (typeof exported !== 'object' || exported === null) {
    throw bootError('invalid-bundle', `bundle '${name}' 的 index.ts 必须导出 bundle 对象`, { bundle: name })
  }
  const record = exported as Record<string, unknown>
  if (record['name'] !== name) {
    throw bootError(
      'invalid-bundle',
      `bundle '${name}' 导出的 name 是 '${String(record['name'])}'，与目录名不一致`,
      { bundle: name, exported: record['name'] },
    )
  }
  const rows = record['rows']
  if (!Array.isArray(rows) || rows.length === 0) {
    throw bootError('invalid-bundle', `bundle '${name}' 的 rows 必须是非空数组`, { bundle: name })
  }
  // 行的**结构**校验在合并器（`normalizeRow`）里统一做：这里只挡"不是数组"和"空组合"
  return { name, rows: rows as readonly PluginRow[] }
}
