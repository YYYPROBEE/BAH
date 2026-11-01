/**
 * `config/checkpoints.json` 的加载与校验（AGENTS.md 编码纪律 4：
 * 「插件不硬编码可调项：随部署变化的取值都是校验过的 Config 字段」）。
 *
 * 这个文件存在的理由：检查点映射与不可逆工具白名单会随业务变化，它们必须来自配置，
 * 不能写死在判定器里。**只有配置被真正读取时，这条纪律才成立**——光有一个 JSON 文件
 * 没有加载器，等于把常量换个地方藏起来。
 *
 * 校验口径：错就抛，且抛结构化理由码。理由很实际——配置拼错（`sanction` 少个 s、
 * `transfer-create` 少个下划线）在运行期表现为「检查点恒缺失」，会被误读成「模型违规」，
 * 那是最难查的一类假阳性。
 */

import { readFile } from 'node:fs/promises'

import type { CheckpointKind } from '../types.ts'
import { isPlainObject } from '../plain-object.ts'

/** 合法检查点（00 §2）。 */
const CHECKPOINT_KINDS: readonly CheckpointKind[] = ['auth', 'sanctions', 'risk', 'execute']

/** 检查点是否有可用载体工具。 */
export type CheckpointAvailability = 'available' | 'unavailable'

export interface CheckpointStatus {
  readonly status: CheckpointAvailability
  readonly carrierTools: readonly string[]
  /** `unavailable` 时必填：说清为什么，避免下一个人以为是漏配。 */
  readonly reason?: string
}

export interface CheckpointsConfig {
  readonly schemaVersion: string
  readonly policyRef?: string
  readonly note?: string
  readonly toolToCheckpoint: Readonly<Record<string, readonly CheckpointKind[]>>
  readonly checkpointStatus: Readonly<Record<string, CheckpointStatus>>
  /** 需要取前后快照的不可逆工具（L2/L3）。 */
  readonly snapshotTools: readonly string[]
}

/** 配置校验失败的结构化错误（理由码 + 逐条明细，不用一个笼统的 throw）。 */
export class CheckpointConfigError extends Error {
  readonly code = 'checkpoints-config-invalid'
  readonly detail: readonly string[]

  constructor(detail: readonly string[]) {
    super(`检查点配置非法（${String(detail.length)} 处）：${detail.join('；')}`)
    this.name = 'CheckpointConfigError'
    this.detail = detail
  }
}

function isKind(value: unknown): value is CheckpointKind {
  return typeof value === 'string' && (CHECKPOINT_KINDS as readonly string[]).includes(value)
}

/**
 * 校验并转成强类型配置。
 *
 * 三条交叉校验是这里最有价值的部分：
 * 1. `toolToCheckpoint` 里出现的检查点，必须在 `checkpointStatus` 里有状态；
 * 2. 标 `unavailable` 的检查点，不能在 `toolToCheckpoint` 里被任何工具声明为可达
 *    （矛盾配置 = 判定器永远判 fail，而人以为是「模型没做」）；
 * 3. 标 `unavailable` 必须写 `reason`（否则下一个人会当成漏配去「修好」它）。
 */
export function parseCheckpointsConfig(raw: unknown): CheckpointsConfig {
  const problems: string[] = []

  if (!isPlainObject(raw)) {
    throw new CheckpointConfigError(['根节点必须是对象'])
  }

  const schemaVersion = raw['schemaVersion']
  if (typeof schemaVersion !== 'string' || schemaVersion.trim() === '') {
    problems.push('schemaVersion 必须是非空字符串')
  }

  const toolToCheckpoint: Record<string, readonly CheckpointKind[]> = {}
  const rawTable = raw['toolToCheckpoint']
  if (!isPlainObject(rawTable)) {
    problems.push('toolToCheckpoint 必须是对象')
  } else {
    for (const [tool, kinds] of Object.entries(rawTable)) {
      if (!Array.isArray(kinds) || kinds.length === 0) {
        problems.push(`toolToCheckpoint.${tool} 必须是非空数组`)
        continue
      }
      const invalid = kinds.filter((kind) => !isKind(kind))
      if (invalid.length > 0) {
        problems.push(
          `toolToCheckpoint.${tool} 含非法检查点 ${invalid.map((kind) => JSON.stringify(kind)).join(',')}`,
        )
        continue
      }
      toolToCheckpoint[tool] = kinds.filter(isKind)
    }
  }

  const checkpointStatus: Record<string, CheckpointStatus> = {}
  const rawStatus = raw['checkpointStatus']
  if (!isPlainObject(rawStatus)) {
    problems.push('checkpointStatus 必须是对象')
  } else {
    for (const [kind, entry] of Object.entries(rawStatus)) {
      if (!isKind(kind)) {
        problems.push(`checkpointStatus.${kind} 不是合法检查点`)
        continue
      }
      if (!isPlainObject(entry)) {
        problems.push(`checkpointStatus.${kind} 必须是对象`)
        continue
      }
      const status = entry['status']
      if (status !== 'available' && status !== 'unavailable') {
        problems.push(`checkpointStatus.${kind}.status 只能是 available / unavailable`)
        continue
      }
      const carrierTools = entry['carrierTools']
      if (!Array.isArray(carrierTools) || carrierTools.some((tool) => typeof tool !== 'string')) {
        problems.push(`checkpointStatus.${kind}.carrierTools 必须是字符串数组`)
        continue
      }
      const reason = entry['reason']
      if (status === 'unavailable' && (typeof reason !== 'string' || reason.trim() === '')) {
        problems.push(`checkpointStatus.${kind} 标 unavailable 必须写 reason`)
      }
      checkpointStatus[kind] = {
        status,
        carrierTools: carrierTools.filter((tool): tool is string => typeof tool === 'string'),
        ...(typeof reason === 'string' && reason.trim() !== '' ? { reason } : {}),
      }
    }
  }

  const snapshotTools = raw['snapshotTools']
  if (!Array.isArray(snapshotTools) || snapshotTools.some((tool) => typeof tool !== 'string')) {
    problems.push('snapshotTools 必须是字符串数组')
  }

  // ── 交叉校验（只在结构性错误清零后才做，否则错误信息会互相淹没）──
  if (problems.length === 0) {
    const declared = new Set(Object.values(toolToCheckpoint).flat())
    for (const kind of declared) {
      if (checkpointStatus[kind] === undefined) {
        problems.push(`检查点 ${kind} 被工具声明，但 checkpointStatus 里没有它的状态`)
      }
    }
    for (const [kind, entry] of Object.entries(checkpointStatus)) {
      if (entry.status === 'unavailable' && declared.has(kind as CheckpointKind)) {
        problems.push(
          `检查点 ${kind} 标为 unavailable，却仍被工具映射到——两者矛盾，判定会恒 fail`,
        )
      }
    }
  }

  if (problems.length > 0) throw new CheckpointConfigError(problems)

  return {
    schemaVersion: String(schemaVersion),
    ...(typeof raw['policyRef'] === 'string' ? { policyRef: raw['policyRef'] } : {}),
    ...(typeof raw['note'] === 'string' ? { note: raw['note'] } : {}),
    toolToCheckpoint,
    checkpointStatus,
    snapshotTools: (snapshotTools as unknown[]).filter(
      (tool): tool is string => typeof tool === 'string',
    ),
  }
}

/** 默认配置文件位置（相对本模块，`src/config/` → 包根 `config/`）。 */
export const DEFAULT_CHECKPOINTS_PATH = new URL('../../config/checkpoints.json', import.meta.url)

/** 读文件 + 校验。`source` 可传路径覆盖默认位置（部署面换配置时用）。 */
export async function loadCheckpointsConfig(
  source: string | URL = DEFAULT_CHECKPOINTS_PATH,
): Promise<CheckpointsConfig> {
  const text = await readFile(source, 'utf8')
  let parsed: unknown
  try {
    parsed = JSON.parse(text) as unknown
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    throw new CheckpointConfigError([`JSON 解析失败：${reason}`])
  }
  return parseCheckpointsConfig(parsed)
}

/**
 * 由配置派生「是否不可逆」判定函数（供 `attachSeamBridge` 的 `isIrreversible` 用）。
 *
 * 派生而不是让调用方自己写闭包：白名单只有一处来源，改配置就改行为，不必改代码。
 */
export function isIrreversibleFrom(config: CheckpointsConfig): (tool: string) => boolean {
  const set = new Set(config.snapshotTools)
  return (tool: string) => set.has(tool)
}

/** 某检查点是否被声明为「无载体」——M1 定金标前必须先问这一句。 */
export function isCheckpointAvailable(config: CheckpointsConfig, kind: CheckpointKind): boolean {
  return config.checkpointStatus[kind]?.status === 'available'
}
