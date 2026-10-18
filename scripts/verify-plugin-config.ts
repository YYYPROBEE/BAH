/**
 * 门禁：`bah.yml` 里引用的 bundle 必须真实存在（施工单 01 §6，M0 骨架版）。
 *
 * 依据：施工单 01 §6「verify-plugin-config：bah.yml 引用的插件必须在依赖清单中」。
 * M0 阶段 `bah.yml` 还没创建（施工单 06 才落地），因此目标不存在时按骨架规则通过并注明 TODO。
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { parse } from 'yaml'

import { isMainModule, runStandalone, type Gate } from './gate-lib.ts'

/** bundle 数据目录：施工单 01 §6 规定为 `packages/cli/bundles/<name>/`。 */
const BUNDLE_DIR = join('packages', 'cli', 'bundles')

const gate: Gate = {
  name: 'plugin-config',

  async run(root) {
    const manifestPath = join(root, 'bah.yml')

    if (!existsSync(manifestPath)) {
      return {
        ok: true,
        findings: [],
        notes: [
          'bah.yml 尚未创建（施工单 06 才落地），按骨架规则通过。',
          'TODO(施工单 06)：profile → bundle → 插件依赖的三方校验 + 未知配置键 fail-loud 校验。',
        ],
      }
    }

    const bundles = readBundleNames(manifestPath)
    if (bundles === undefined) {
      return {
        ok: false,
        findings: [
          'bah.yml 存在但读不出 profile.bundles（应为字符串或 {name} 对象数组）；按 fail-loud 纪律拒绝静默通过（施工单 00 §9）。',
        ],
        notes: [],
      }
    }

    const findings: string[] = []
    for (const name of bundles) {
      if (!existsSync(join(root, BUNDLE_DIR, name))) {
        findings.push(`bah.yml 引用了不存在的 bundle：'${name}'（期望目录 ${BUNDLE_DIR}/${name}/）`)
      }
    }

    return {
      ok: findings.length === 0,
      findings,
      notes: [
        `已校验 ${bundles.length} 个 bundle 引用`,
        'TODO(施工单 06)：补「插件 manifest 是否在依赖清单中」的校验。',
      ],
    }
  },
}

/**
 * 从 bah.yml 读出 bundle 名列表。
 *
 * 兼容两种书写位置：顶层 `profile.bundles` 与 `bah.profile.bundles`。
 * 读不出结构时返回 `undefined`（由调用方按 fail-loud 处理）。
 */
function readBundleNames(manifestPath: string): string[] | undefined {
  let parsed: unknown
  try {
    parsed = parse(readFileSync(manifestPath, 'utf8'))
  } catch {
    return undefined
  }

  const profile = pick(parsed, 'profile') ?? pick(pick(parsed, 'bah'), 'profile')
  const bundles = pick(profile, 'bundles')
  if (!Array.isArray(bundles)) return undefined

  const names: string[] = []
  for (const entry of bundles) {
    if (typeof entry === 'string') {
      names.push(entry)
      continue
    }
    const name = pick(entry, 'name')
    if (typeof name !== 'string') return undefined
    names.push(name)
  }
  return names
}

/** 安全取属性：非对象 / 非字符串键一律返回 `undefined`。 */
function pick(value: unknown, key: string): unknown {
  if (!isRecord(value)) return undefined
  return value[key]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

export { gate }

if (isMainModule(import.meta.url)) {
  await runStandalone(gate)
}
