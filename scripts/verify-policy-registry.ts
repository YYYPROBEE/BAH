/**
 * 门禁：策略 registry / runtime-state / rollout 链（03 §7.4）。
 *
 * 六条判据：
 * 1. `policies/registry.json` schema 合法；每个条目目录存在、摘要与现场一致；
 * 2. `active` / `canary` / `history` 指向的版本都在 registry 里；
 * 3. `runtime-state.json` 若存在：schema、percent 0–10000、epoch 正整数；
 *    且 active / canary / history 不得指向 demo bundle；
 * 4. rollout 链 `policies/policy-rollout/audit.jsonl` 连续（存在才查；gitignore 是预期）；
 * 5. semver：handle 必须是 `name/semver`，目录与 manifest 一致（编译器已查）；
 * 6. `fixtures/` 不得进入 registry；`runtime-state.json` 不得被 git 跟踪；
 * 7. 生产 profile 的 `policy:rules.active` 不得指向 demo（YAML 解析，内联/block 两种写法都查）。
 *
 * 负控：把坏 registry / 坏 state / demo 激活样本喂给同一组纯函数，必须报错。
 */

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'

import { parse } from 'yaml'

import { BANK_TOOL_NAME_SET } from '../packages/bank/src/tools/specs.ts'
import { loadBundle, loadRuleBundle } from '../packages/policy/src/load.ts'
import { describePolicyError } from '../packages/policy/src/errors.ts'

import { isMainModule, runStandalone, walk, type Gate, type GateResult } from './gate-lib.ts'
import { verifyRollout } from './policy-admin-lib.ts'

const REGISTRY_API = 'bah.policy.registry/v1'
const STATE_API = 'bah.policy.runtime-state/v1'
const HANDLE_PATTERN = /^[a-z0-9][a-z0-9-]*\/\d+\.\d+\.\d+$/
const SEMVER = /^\d+\.\d+\.\d+$/

const POLICY_KINDS = ['bank.tier', 'sentry.rules'] as const

interface Entry {
  readonly kind?: string
  readonly path: string
  readonly semanticDigest: string
  readonly sourceDigest: string
  readonly engine: string
  readonly installedAt: number
  readonly demo?: boolean
}

const gate: Gate = {
  name: 'policy-registry',

  async run(root): Promise<GateResult> {
    const findings: string[] = []
    const notes: string[] = []
    const toolNames = [...BANK_TOOL_NAME_SET]

    const registryPath = join(root, 'policies/registry.json')
    const registry = readRegistry(registryPath, findings)
    if (registry === undefined) return { ok: false, findings, notes }

    for (const [handle, entry] of registry) {
      const rel = entry.path.replace(/\\/g, '/').replace(/^\.\//, '')
      if (entry.demo === true && !rel.startsWith('policies/demo/')) {
        findings.push(`registry ${handle}: demo: true 只允许放在 policies/demo/ 下（防止生产规则自称演示绕过门禁）`)
      }
      if (!HANDLE_PATTERN.test(handle)) {
        findings.push(`registry ${handle}: handle 必须是 name/semver（例：bank-tier/1.0.0）`)
      }
      const abs = resolve(root, rel)
      if (!isInside(root, abs, 'policies')) {
        findings.push(`registry ${handle}: path ${rel} 不在 policies/ 下（禁止越界）`)
        continue
      }
      if (rel.includes('/fixtures/')) {
        findings.push(`registry ${handle}: fixtures 不得进入 registry`)
        continue
      }
      if (!existsSync(abs)) {
        findings.push(`registry ${handle}: 目录不存在（${rel}）`)
        continue
      }
      const [name = '', version = ''] = handle.split('/')
      if (!SEMVER.test(version)) {
        findings.push(`registry ${handle}: version 不是 semver`)
      }
      if (!rel.endsWith(`${name}/${version}`)) {
        findings.push(`registry ${handle}: path 与 handle 不一致（${rel}）`)
      }
      try {
        const result =
          entry.kind === 'sentry.rules'
            ? loadRuleBundle({ dir: abs, toolNames: [], verifyLock: true })
            : loadBundle({ dir: abs, toolNames, verifyLock: true, withCorpus: false })
        const descriptor = result.compiled.descriptor
        if (entry.semanticDigest !== descriptor.semanticDigest) {
          findings.push(`registry ${handle}: semanticDigest 与现场不符`)
        }
        if (entry.sourceDigest !== descriptor.sourceDigest) {
          findings.push(`registry ${handle}: sourceDigest 与现场不符`)
        }
        if (entry.engine !== descriptor.engineVersion) {
          findings.push(`registry ${handle}: engine ${entry.engine} 与编译器 ${descriptor.engineVersion} 不符`)
        }
        if (descriptor.handle !== handle) {
          findings.push(`registry ${handle}: manifest handle 是 ${descriptor.handle}`)
        }
      } catch (error) {
        const described = describePolicyError(error)
        findings.push(`registry ${handle}: 编译失败 ${described.code} —— ${described.message}`)
      }
    }
    notes.push(`registry ${String(registry.size)} 个版本：目录/摘要/engine/handle 逐条核对`)

    // demo bundle 只允许通过快照 overlay 或本地演练 state 使用；生产 profile / runtime-state 都不许激活。
    const demoHandles = new Set(
      [...registry.entries()]
        .filter(([, entry]) => entry.demo === true)
        .map(([handle]) => handle),
    )

    const statePath = join(root, 'policies/runtime-state.json')
    if (existsSync(statePath)) {
      const state = readState(statePath, findings)
      if (state !== undefined) {
        for (const finding of stateFindings(state, new Set(registry.keys()), demoHandles)) {
          findings.push(finding)
        }
        notes.push('runtime-state：active/canary/history 指向的版本均在 registry 内且不是 demo')
      }
    } else {
      notes.push('runtime-state.json 不存在（预期：用部署默认 active）')
    }

    const chainPath = join(root, 'policies/policy-rollout/audit.jsonl')
    if (existsSync(chainPath)) {
      try {
        const rollout = verifyRollout(join(root, 'policies'))
        if (!rollout.ok) {
          findings.push(`rollout 链在第 ${String(rollout.brokenAt ?? '?')} 条断开（${String(rollout.rows)} 行）`)
        }
        notes.push(`rollout 链 ${String(rollout.rows)} 行连续`)
      } catch (error) {
        findings.push(`rollout 链校验失败：${error instanceof Error ? error.message : String(error)}`)
      }
    } else {
      notes.push('rollout 链不存在（预期：只在 promote/rollback 后出现，且不入库）')
    }

    const ignored = readFileSync(join(root, '.gitignore'), 'utf8')
    for (const expected of ['policies/runtime-state.json', 'policies/policy-rollout/']) {
      if (!ignored.includes(expected)) findings.push(`.gitignore 缺 ${expected}`)
    }

    // 生产 profile 不得把 `policy:rules.active` 指向 demo bundle（demo 只能通过快照 overlay/本地 state 演练）。
    for (const file of walk(root, ['profiles'], (name) => name === 'patch.yml')) {
      const rel = relative(root, file).replace(/\\/g, '/')
      for (const finding of demoProfileFindings(rel, readFileSync(file, 'utf8'), demoHandles)) {
        findings.push(finding)
      }
    }
    const tracked = isTracked(root, 'policies/runtime-state.json')
    if (tracked === true) findings.push('policies/runtime-state.json 被 git 跟踪（运行时状态不得入库）')
    if (tracked === undefined) notes.push('git 不可用：跳过 runtime-state 跟踪检查')

    // 未登记的 bundle 目录：不允许"藏在 policies/ 下但不进 registry"绕过一致性检查。
    const dirs = walk(root, ['policies'], (name) => name === 'bundle.yml')
      .map((file) => relative(root, file).replace(/\\/g, '/').replace(/\/bundle\.yml$/, ''))
      .filter((dir) => !dir.includes('/fixtures/'))
    const registered = new Set([...registry.values()].map((entry) => entry.path.replace(/\\/g, '/')))
    const orphans = dirs.filter((dir) => !registered.has(dir))
    for (const dir of orphans) {
      findings.push(`${dir}: bundle 未登记 registry（先 policy:install；否则一致性/等价门禁看不到它）`)
    }

    // 负控：坏 registry / 坏 state / demo 激活必须被同一组纯函数抓住。
    // 特别覆盖 block 风格的 YAML——旧实现只认内联 `active: { bank.tier: ... }`，
    // 把 active 写成多行就能绕过"生产 profile 不得指向 demo"。
    const syntheticDemo = new Set(['bank-tier-demo/1.1.0'])
    const negatives = [
      registryShapeFindings({ apiVersion: 'wrong' }),
      stateFindings(
        { apiVersion: STATE_API, assignments: { 'bank.tier': { active: 'missing/9.9.9', canary: { version: 'missing/9.9.9', percent: 20_000, epoch: 0 } } } },
        new Set(registry.keys()),
        new Set(),
      ),
      demoProfileFindings(
        'profiles/synthetic/patch.yml',
        '- id: policy:rules\n  config:\n    active:\n      bank.tier: bank-tier-demo/1.1.0\n',
        syntheticDemo,
      ),
      stateFindings(
        {
          apiVersion: STATE_API,
          assignments: {
            'bank.tier': {
              active: 'bank-tier/1.0.0',
              canary: { version: 'bank-tier-demo/1.1.0', percent: 500, epoch: 1 },
            },
          },
        },
        new Set([...registry.keys(), 'bank-tier-demo/1.1.0']),
        syntheticDemo,
      ),
    ]
    if (negatives.some((hits) => hits.length === 0)) {
      findings.push('负控失败：坏 registry / 坏 state / demo 激活至少有一项没有被识别')
    }

    return { ok: findings.length === 0, findings, notes }
  },
}

/** 读 registry；形状错误全部落 findings。 */
function readRegistry(path: string, findings: string[]): Map<string, Entry> | undefined {
  if (!existsSync(path)) {
    findings.push('缺 policies/registry.json')
    return undefined
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    findings.push('policies/registry.json: 不是合法 JSON')
    return undefined
  }
  for (const finding of registryShapeFindings(parsed)) findings.push(finding)
  const entries = new Map<string, Entry>()
  const kinds = (parsed as { kinds?: unknown }).kinds
  if (typeof kinds !== 'object' || kinds === null) return entries
  for (const [kind, value] of Object.entries(kinds)) {
    if (!(POLICY_KINDS as readonly string[]).includes(kind)) {
      findings.push(`registry: 未知 kind ${kind}（v1 只认 ${POLICY_KINDS.join(' / ')}）`)
    }
    const versions = (value as { versions?: unknown }).versions
    if (typeof versions !== 'object' || versions === null) continue
    for (const [handle, raw] of Object.entries(versions)) {
      const entry = raw as Partial<Entry> & { demo?: unknown }
      entries.set(handle, {
        kind,
        path: String(entry.path),
        semanticDigest: String(entry.semanticDigest),
        sourceDigest: String(entry.sourceDigest),
        engine: String(entry.engine),
        installedAt: Number(entry.installedAt),
        ...(entry.demo === true ? { demo: true } : {}),
      })
    }
  }
  return entries
}

/** registry 的形状检查（纯函数；负控复用）。 */
function registryShapeFindings(parsed: unknown): string[] {
  const findings: string[] = []
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return ['registry: 根节点必须是对象']
  }
  const record = parsed as Record<string, unknown>
  if (record['apiVersion'] !== REGISTRY_API) {
    findings.push(`registry: apiVersion 必须是 ${REGISTRY_API}`)
  }
  const kinds = record['kinds']
  if (typeof kinds !== 'object' || kinds === null || Array.isArray(kinds)) {
    findings.push('registry: kinds 必须是对象')
    return findings
  }
  for (const [kind, value] of Object.entries(kinds)) {
    if (!(POLICY_KINDS as readonly string[]).includes(kind)) {
      findings.push(`registry: 未知 kind ${kind}`)
    }
    const versions = (value as { versions?: unknown }).versions
    if (typeof versions !== 'object' || versions === null || Array.isArray(versions)) {
      findings.push(`registry: kinds.${kind}.versions 必须是对象`)
      continue
    }
    const typed = versions as Record<string, unknown>
    if (Object.keys(typed).length === 0) findings.push(`registry: kinds.${kind}.versions 不能为空`)
    for (const [handle, entry] of Object.entries(typed)) {
      if (!HANDLE_PATTERN.test(handle)) findings.push(`registry ${handle}: handle 必须是 name/semver`)
      if (typeof entry !== 'object' || entry === null) {
        findings.push(`registry ${handle}: 条目必须是对象`)
        continue
      }
      const item = entry as Record<string, unknown>
      for (const key of ['path', 'semanticDigest', 'sourceDigest', 'engine'] as const) {
        if (typeof item[key] !== 'string' || item[key].length === 0) {
          findings.push(`registry ${handle}: ${key} 必须是非空字符串`)
        }
      }
      if (typeof item['semanticDigest'] === 'string' && !/^[0-9a-f]{64}$/.test(item['semanticDigest'])) {
        findings.push(`registry ${handle}: semanticDigest 必须是 64 位小写 hex`)
      }
      if (typeof item['sourceDigest'] === 'string' && !/^[0-9a-f]{64}$/.test(item['sourceDigest'])) {
        findings.push(`registry ${handle}: sourceDigest 必须是 64 位小写 hex`)
      }
      if (typeof item['installedAt'] !== 'number' || !Number.isInteger(item['installedAt']) || item['installedAt'] <= 0) {
        findings.push(`registry ${handle}: installedAt 必须是正整数`)
      }
      if (item['demo'] !== undefined && typeof item['demo'] !== 'boolean') {
        findings.push(`registry ${handle}: demo 必须是布尔值`)
      }
    }
  }
  return findings
}

/** 读 runtime-state；形状错误落 findings。 */
function readState(path: string, findings: string[]): Record<string, unknown> | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    findings.push('policies/runtime-state.json: 不是合法 JSON')
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    findings.push('runtime-state: 根节点必须是对象')
    return undefined
  }
  const record = parsed as Record<string, unknown>
  if (record['apiVersion'] !== STATE_API) findings.push(`runtime-state: apiVersion 必须是 ${STATE_API}`)
  if (typeof record['assignments'] !== 'object' || record['assignments'] === null) {
    findings.push('runtime-state: assignments 必须是对象')
    return undefined
  }
  return record
}

/** state 的语义检查（纯函数；负控复用）。 */
function stateFindings(
  state: Record<string, unknown>,
  handles: ReadonlySet<string>,
  demoHandles: ReadonlySet<string>,
): string[] {
  const findings: string[] = []
  if (state['apiVersion'] !== STATE_API) findings.push(`runtime-state: apiVersion 必须是 ${STATE_API}`)
  const assignments = state['assignments']
  if (typeof assignments !== 'object' || assignments === null || Array.isArray(assignments)) {
    return [...findings, 'runtime-state: assignments 必须是对象']
  }
  for (const [kind, raw] of Object.entries(assignments)) {
    if (kind !== 'bank.tier') findings.push(`runtime-state: 未知 kind ${kind}`)
    if (typeof raw !== 'object' || raw === null) {
      findings.push(`runtime-state ${kind}: 分配必须是对象`)
      continue
    }
    const assignment = raw as Record<string, unknown>
    if (typeof assignment['active'] !== 'string') {
      findings.push(`runtime-state ${kind}: active 必须是字符串`)
    } else {
      if (!handles.has(assignment['active'])) {
        findings.push(`runtime-state ${kind}: active ${assignment['active']} 不在 registry`)
      } else if (demoHandles.has(assignment['active'])) {
        findings.push(`runtime-state ${kind}: active ${assignment['active']} 是 demo bundle（demo 不是生产真相源）`)
      }
    }
    if (assignment['canary'] === undefined) continue
    if (typeof assignment['canary'] !== 'object' || assignment['canary'] === null) {
      findings.push(`runtime-state ${kind}: canary 必须是对象`)
      continue
    }
    const canary = assignment['canary'] as Record<string, unknown>
    if (typeof canary['version'] !== 'string' || !handles.has(canary['version'])) {
      findings.push(`runtime-state ${kind}: canary.version 不在 registry`)
    } else if (demoHandles.has(canary['version'])) {
      findings.push(`runtime-state ${kind}: canary.version ${canary['version']} 是 demo bundle（demo 不是生产真相源）`)
    }
    if (
      typeof canary['percent'] !== 'number' ||
      !Number.isInteger(canary['percent']) ||
      canary['percent'] < 0 ||
      canary['percent'] > 10_000
    ) {
      findings.push(`runtime-state ${kind}: canary.percent 必须是 [0, 10000] 的整数`)
    }
    if (
      typeof canary['epoch'] !== 'number' ||
      !Number.isInteger(canary['epoch']) ||
      canary['epoch'] < 1
    ) {
      findings.push(`runtime-state ${kind}: canary.epoch 必须是正整数`)
    }
    if (canary['sessions'] !== undefined) {
      if (
        !Array.isArray(canary['sessions']) ||
        canary['sessions'].some((item) => typeof item !== 'string' || item.length === 0)
      ) {
        findings.push(`runtime-state ${kind}: canary.sessions 必须是非空字符串数组`)
      }
    }
  }
  const history = state['history']
  if (history !== undefined) {
    if (!Array.isArray(history)) {
      findings.push('runtime-state: history 必须是数组')
    } else {
      for (const [index, raw] of history.entries()) {
        if (typeof raw !== 'object' || raw === null) {
          findings.push(`runtime-state history[${String(index)}]: 必须是对象`)
          continue
        }
        const item = raw as Record<string, unknown>
        for (const key of ['from', 'to'] as const) {
          if (typeof item[key] !== 'string' || !handles.has(item[key])) {
            findings.push(`runtime-state history[${String(index)}]: ${key} 不在 registry`)
          } else if (demoHandles.has(item[key])) {
            findings.push(
              `runtime-state history[${String(index)}]: ${key} ${item[key]} 是 demo bundle（demo 不是生产真相源）`,
            )
          }
        }
        if (item['action'] !== 'promote' && item['action'] !== 'rollback') {
          findings.push(`runtime-state history[${String(index)}]: action 必须是 promote/rollback`)
        }
        if (
          typeof item['percent'] !== 'number' ||
          !Number.isInteger(item['percent']) ||
          item['percent'] < 0 ||
          item['percent'] > 10_000
        ) {
          findings.push(`runtime-state history[${String(index)}]: percent 必须是 [0, 10000] 的整数`)
        }
        if (
          typeof item['epoch'] !== 'number' ||
          !Number.isInteger(item['epoch']) ||
          item['epoch'] < 1
        ) {
          findings.push(`runtime-state history[${String(index)}]: epoch 必须是正整数`)
        }
      }
    }
  }
  return findings
}

/**
 * `patch.yml` 的 `policy:rules.active` 是否指向 demo bundle。
 *
 * 为什么用 YAML 解析而不是正则：`active: { bank.tier: x }` 与
 * `active:\n  bank.tier: x` 是同一份配置；只认内联写法会被 block 风格绕过。
 */
function demoProfileFindings(
  rel: string,
  text: string,
  demoHandles: ReadonlySet<string>,
): string[] {
  let rows: unknown
  try {
    rows = parse(text) as unknown
  } catch (error) {
    return [`${rel}: 不是合法 YAML（${error instanceof Error ? error.message : String(error)}）`]
  }
  if (!Array.isArray(rows)) return [`${rel}: patch 必须是数组`]
  const findings: string[] = []
  for (const [index, raw] of rows.entries()) {
    if (!isRecord(raw) || raw['id'] !== 'policy:rules') continue
    const config = isRecord(raw['config']) ? raw['config'] : undefined
    const active = config?.['active']
    if (!isRecord(active)) continue
    for (const [kind, handle] of Object.entries(active)) {
      if (typeof handle !== 'string' || !demoHandles.has(handle)) continue
      findings.push(
        `${rel}（第 ${String(index + 1)} 行）: 生产 profile 的 policy:rules.active.${kind} 指向 demo bundle ${handle}（demo 不是生产真相源）`,
      )
    }
  }
  return findings
}

/** 对象判定（YAML 解析结果是 unknown）。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 路径是否在 root 的某个前缀目录内（防 `..` 与绝对路径逃逸）。 */
function isInside(root: string, abs: string, prefix: string): boolean {
  const base = resolve(root, prefix)
  return abs === base || abs.startsWith(`${base}${sep}`)
}

/** 文件是否被 git 跟踪；git 不可用返回 undefined。 */
function isTracked(root: string, rel: string): boolean | undefined {
  try {
    execFileSync('git', ['ls-files', '--error-unmatch', '--', rel], { cwd: root, stdio: 'ignore' })
    return true
  } catch (error) {
    const status = (error as { status?: number }).status
    if (status === 1) return false
    return undefined
  }
}

if (isMainModule(import.meta.url)) await runStandalone(gate)

export { gate }
